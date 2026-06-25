// Shared scan logic used by the CLI (audit.mjs) and the web server (server.mjs).
import LinqAPIV3 from '@linqapp/sdk';

export const HARD_CAP = 500; // never page more than this many messages for one chat
export const PAGE_LIMIT = 100; // request the largest page size to cut round-trips
export const DEFAULT_CONCURRENCY = 12; // chats counted in parallel
export const TEXT_BUDGET = 16000; // max chars of message text kept per chat for search

// Pull searchable text out of a message's parts (text values, link urls, media filenames).
function messageText(message) {
  const parts = message.parts ?? [];
  const out = [];
  for (const p of parts) {
    if (p.type === 'text' || p.type === 'link') { if (p.value) out.push(p.value); }
    else if (p.type === 'media' && p.filename) out.push(p.filename);
  }
  return out.join(' ');
}

export function createClient(apiKey) {
  return new LinqAPIV3({ apiKey });
}

// Run `worker` over items with bounded concurrency, in input order-agnostic fashion.
async function pool(items, concurrency, worker, isCancelled) {
  let i = 0;
  async function run() {
    while (i < items.length) {
      if (isCancelled?.()) return;
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

// Drain the paginated chat list into an array (fast: ~100 chats per request).
async function listAllChats(client, from, isCancelled) {
  const out = [];
  const params = from ? { from, limit: PAGE_LIMIT } : { limit: PAGE_LIMIT };
  for await (const chat of client.chats.listChats(params)) {
    if (isCancelled?.()) break;
    out.push(chat);
  }
  return out;
}

export function describeChat(chat) {
  if (chat.display_name) return chat.display_name;
  const handles = (chat.handles ?? []).map((h) => h.handle ?? h.value ?? '?');
  return handles.join(', ') || chat.id;
}

// A chat matches when its counts are under the active thresholds.
function passes(total, us, { totalMax, usMax, mode }) {
  const totalOk = totalMax == null ? null : total < totalMax;
  const usOk = usMax == null ? null : us < usMax;
  const active = [totalOk, usOk].filter((v) => v !== null);
  if (active.length === 0) return false;
  return mode === 'any' ? active.some(Boolean) : active.every(Boolean);
}

// Counts only grow, so once a "< threshold" condition is false it stays false.
// Stop paging once the chat can never match.
function canStillPass(total, us, { totalMax, usMax, mode }) {
  const totalAlive = totalMax == null ? null : total < totalMax;
  const usAlive = usMax == null ? null : us < usMax;
  const active = [totalAlive, usAlive].filter((v) => v !== null);
  return mode === 'any' ? active.some(Boolean) : active.every(Boolean);
}

async function countChat(client, chatId, opts, isCancelled) {
  let total = 0;
  let us = 0;
  for await (const message of client.chats.messages.list(chatId, { limit: PAGE_LIMIT })) {
    if (isCancelled?.()) return { total, us, exhaustive: false };
    total += 1;
    if (message.is_from_me) us += 1;
    if (total >= HARD_CAP || !canStillPass(total, us, opts)) {
      return { total, us, exhaustive: false };
    }
  }
  return { total, us, exhaustive: true };
}

export function filterSummary({ totalMax, usMax, mode }) {
  const parts = [];
  if (totalMax != null) parts.push(`total < ${totalMax}`);
  if (usMax != null) parts.push(`from-us < ${usMax}`);
  return parts.join(mode === 'any' ? ' OR ' : ' AND ') || '(no filter)';
}

/**
 * Scan all chats and collect the ones matching the thresholds.
 * @param {object} a
 * @param {LinqAPIV3} a.client
 * @param {number|null} a.totalMax  flag chats with fewer than this many total messages
 * @param {number|null} a.usMax     flag chats with fewer than this many messages from us
 * @param {'all'|'any'} a.mode
 * @param {string} [a.from]         E.164 line filter
 * @param {(p:{scanned:number,flagged:number})=>void} [a.onProgress] called every chat
 * @param {(f:object)=>void} [a.onFlag] called when a chat matches
 * @param {()=>boolean} [a.isCancelled]
 */
export async function scanChats({
  client, totalMax, usMax, mode = 'all', from,
  concurrency = DEFAULT_CONCURRENCY, onProgress, onFlag, isCancelled,
}) {
  const opts = { totalMax, usMax, mode };
  const flagged = [];
  let scanned = 0;

  const list = await listAllChats(client, from, isCancelled);
  await pool(list, concurrency, async (chat) => {
    const { total, us, exhaustive } = await countChat(client, chat.id, opts, isCancelled);
    if (exhaustive && passes(total, us, opts)) {
      const row = {
        id: chat.id,
        name: describeChat(chat),
        us,
        total,
        health: chat.health_status?.status ?? null,
      };
      flagged.push(row);
      onFlag?.(row);
    }
    scanned += 1;
    onProgress?.({ scanned, total: list.length, flagged: flagged.length });
  }, isCancelled);

  flagged.sort((a, b) => a.us - b.us || a.total - b.total);
  return { scanned, flagged, cancelled: isCancelled?.() ?? false };
}

// Count every message in a chat (no early exit), up to `cap`, and collect a bounded
// blob of message text for content search.
async function countChatFull(client, chatId, cap, isCancelled) {
  let total = 0;
  let us = 0;
  let lastActivity = null; // newest message timestamp seen
  const texts = [];
  let textLen = 0;
  for await (const message of client.chats.messages.list(chatId, { limit: PAGE_LIMIT })) {
    if (isCancelled?.()) return { total, us, lastActivity, text: texts.join(' • '), capped: true };
    total += 1;
    if (message.is_from_me) us += 1;
    const ts = message.created_at ?? message.sent_at;
    if (ts && (!lastActivity || ts > lastActivity)) lastActivity = ts;
    if (textLen < TEXT_BUDGET) {
      const t = messageText(message);
      if (t) { texts.push(t); textLen += t.length + 3; }
    }
    if (total >= cap) return { total, us, lastActivity, text: texts.join(' • '), capped: true };
  }
  return { total, us, lastActivity, text: texts.join(' • '), capped: false };
}

/**
 * Collect full stats for every chat (for the dashboard). Streams each chat via onChat.
 *
 * The chat list is drained first (so `onTotal` reports the real count and the progress
 * bar is accurate), then chats are counted with bounded concurrency.
 * @param {object} a
 * @param {LinqAPIV3} a.client
 * @param {string} [a.from]            E.164 line filter
 * @param {number} [a.perChatCap=300]  stop counting a chat after this many messages
 * @param {number} [a.concurrency=8]   chats counted in parallel
 * @param {(total:number)=>void} [a.onTotal]  called once with the chat count
 * @param {(chat:object)=>void} [a.onChat]
 * @param {(p:{scanned:number,total:number})=>void} [a.onProgress]
 * @param {()=>boolean} [a.isCancelled]
 */
export async function scanAllChats({
  client, from, perChatCap = 300, concurrency = DEFAULT_CONCURRENCY,
  onTotal, onChat, onProgress, isCancelled,
}) {
  const list = await listAllChats(client, from, isCancelled);
  onTotal?.(list.length);

  const chats = [];
  let scanned = 0;
  await pool(list, concurrency, async (chat) => {
    const { total, us, lastActivity, text, capped } = await countChatFull(client, chat.id, perChatCap, isCancelled);
    const row = {
      id: chat.id,
      name: describeChat(chat),
      total,
      us,
      them: total - us,
      text,
      capped,
      health: chat.health_status?.status ?? null,
      isGroup: Boolean(chat.is_group),
      service: chat.service ?? null,
      updatedAt: chat.updated_at ?? null,
      createdAt: chat.created_at ?? null,
      lastActivity: lastActivity ?? chat.updated_at ?? null,
    };
    chats.push(row);
    scanned += 1;
    onChat?.(row);
    onProgress?.({ scanned, total: list.length });
  }, isCancelled);

  return { scanned, chats, cancelled: isCancelled?.() ?? false };
}
