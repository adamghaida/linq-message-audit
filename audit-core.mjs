// Shared scan logic used by the CLI (audit.mjs) and the web server (server.mjs).
import LinqAPIV3 from '@linqapp/sdk';

export const HARD_CAP = 500; // never page more than this many messages for one chat

export function createClient(apiKey) {
  return new LinqAPIV3({ apiKey });
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
  for await (const message of client.chats.messages.list(chatId)) {
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
export async function scanChats({ client, totalMax, usMax, mode = 'all', from, onProgress, onFlag, isCancelled }) {
  const opts = { totalMax, usMax, mode };
  const flagged = [];
  let scanned = 0;

  const listParams = from ? { from } : undefined;
  for await (const chat of client.chats.listChats(listParams)) {
    if (isCancelled?.()) break;
    scanned += 1;
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
    onProgress?.({ scanned, flagged: flagged.length });
  }

  flagged.sort((a, b) => a.us - b.us || a.total - b.total);
  return { scanned, flagged, cancelled: isCancelled?.() ?? false };
}

// Count every message in a chat (no early exit), up to `cap`.
async function countChatFull(client, chatId, cap, isCancelled) {
  let total = 0;
  let us = 0;
  let lastActivity = null; // newest message timestamp seen
  for await (const message of client.chats.messages.list(chatId)) {
    if (isCancelled?.()) return { total, us, lastActivity, capped: true };
    total += 1;
    if (message.is_from_me) us += 1;
    const ts = message.created_at ?? message.sent_at;
    if (ts && (!lastActivity || ts > lastActivity)) lastActivity = ts;
    if (total >= cap) return { total, us, lastActivity, capped: true };
  }
  return { total, us, lastActivity, capped: false };
}

/**
 * Collect full stats for every chat (for the dashboard). Streams each chat via onChat.
 * @param {object} a
 * @param {LinqAPIV3} a.client
 * @param {string} [a.from]            E.164 line filter
 * @param {number} [a.perChatCap=300]  stop counting a chat after this many messages
 * @param {(chat:object)=>void} [a.onChat]
 * @param {(p:{scanned:number})=>void} [a.onProgress]
 * @param {()=>boolean} [a.isCancelled]
 */
export async function scanAllChats({ client, from, perChatCap = 300, onChat, onProgress, isCancelled }) {
  const chats = [];
  let scanned = 0;
  const listParams = from ? { from } : undefined;
  for await (const chat of client.chats.listChats(listParams)) {
    if (isCancelled?.()) break;
    scanned += 1;
    const { total, us, lastActivity, capped } = await countChatFull(client, chat.id, perChatCap, isCancelled);
    const row = {
      id: chat.id,
      name: describeChat(chat),
      total,
      us,
      them: total - us,
      capped,
      health: chat.health_status?.status ?? null,
      isGroup: Boolean(chat.is_group),
      service: chat.service ?? null,
      updatedAt: chat.updated_at ?? null,
      createdAt: chat.created_at ?? null,
      lastActivity: lastActivity ?? chat.updated_at ?? null,
    };
    chats.push(row);
    onChat?.(row);
    onProgress?.({ scanned });
  }
  return { scanned, chats, cancelled: isCancelled?.() ?? false };
}
