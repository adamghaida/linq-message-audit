// Web UI for linq-message-audit.
//   LINQ_API_KEY=sk_... node server.mjs     # then open http://localhost:4178
//
// The API key is read from the environment server-side and never sent to the
// browser. A scan streams live progress to the page over Server-Sent Events.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient, scanChats, scanAllChats, filterSummary } from './audit-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4178);
const ENV_KEY = process.env.LINQ_API_KEY;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleScan(req, res, url) {
  const apiKey = ENV_KEY || url.searchParams.get('key');
  if (!apiKey) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No API key. Start the server with LINQ_API_KEY set, or pass one in the form.' }));
    return;
  }

  const totalMax = num(url.searchParams.get('total'));
  const usMax = num(url.searchParams.get('us'));
  const mode = url.searchParams.get('mode') === 'any' ? 'any' : 'all';
  const from = url.searchParams.get('from')?.trim() || undefined;
  if (totalMax == null && usMax == null) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Set at least one filter (total or from-us).' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const summary = filterSummary({ totalMax, usMax, mode });
  sse(res, 'start', { summary, from: from ?? null });

  try {
    const { scanned, flagged } = await scanChats({
      client: createClient(apiKey),
      totalMax, usMax, mode, from,
      isCancelled: () => cancelled,
      onProgress: (p) => sse(res, 'progress', p),
      onFlag: (row) => sse(res, 'flag', row),
    });
    if (!cancelled) sse(res, 'done', { scanned, flagged: flagged.length, summary });
  } catch (err) {
    if (!cancelled) sse(res, 'error', { message: err?.message ?? String(err), status: err?.status ?? null });
  }
  res.end();
}

async function handleScanAll(req, res, url) {
  const apiKey = ENV_KEY || url.searchParams.get('key');
  if (!apiKey) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No API key. Start the server with LINQ_API_KEY set, or pass one in the form.' }));
    return;
  }
  const from = url.searchParams.get('from')?.trim() || undefined;
  const perChatCap = num(url.searchParams.get('cap')) ?? 300;
  const concurrency = Math.min(20, Math.max(1, num(url.searchParams.get('concurrency')) ?? 12));

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  sse(res, 'start', { from: from ?? null, cap: perChatCap, concurrency });
  try {
    const { scanned } = await scanAllChats({
      client: createClient(apiKey),
      from, perChatCap, concurrency,
      isCancelled: () => cancelled,
      onTotal: (total) => sse(res, 'total', { total }),
      onChat: (row) => sse(res, 'chat', row),
      onProgress: (p) => sse(res, 'progress', p),
    });
    if (!cancelled) sse(res, 'done', { scanned });
  } catch (err) {
    if (!cancelled) sse(res, 'error', { message: err?.message ?? String(err), status: err?.status ?? null });
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/scan-all') return handleScanAll(req, res, url);
  if (url.pathname === '/api/scan') return handleScan(req, res, url);

  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hasEnvKey: Boolean(ENV_KEY) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500).end('index.html missing');
    }
    return;
  }

  res.writeHead(404).end('Not found');
});

server.listen(PORT, () => {
  console.log(`linq-message-audit UI → http://localhost:${PORT}`);
  console.log(ENV_KEY ? 'Using LINQ_API_KEY from environment.' : 'No LINQ_API_KEY in env — enter a key in the page.');
});
