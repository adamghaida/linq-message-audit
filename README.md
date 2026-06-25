# linq-message-audit

Find Linq chats with **very few messages** — overall, or specifically from you (your
own outbound messages). Comes with a CLI and a small live web UI.

Built on the [`@linqapp/sdk`](https://www.npmjs.com/package/@linqapp/sdk) Linq partner API.

## Why

If you blast a lot of one-off chats, the dead ones (you never replied, or barely did)
pile up and can drag down line health. This scans every chat, counts the messages —
splitting out how many were **from you** (`is_from_me`) — and flags the quiet ones.

## Setup

```bash
npm install
export LINQ_API_KEY=linq_...   # your Linq partner key
```

The API key is only ever read from the environment, server-side. It is never written
to disk or sent to the browser.

## Dashboard (web UI)

```bash
npm run serve            # → http://localhost:4178
```

Scan every chat **once** (live progress streamed over Server-Sent Events), then slice
the data in the browser without re-scanning:

- **Metric cards** — total chats, total messages, from us vs. from them, never-replied
  count, reply rate, average messages per chat.
- **Chat health** — stacked breakdown of HEALTHY / AT_RISK / CRITICAL / OPTED_OUT.
- **From-us distribution** — histogram bucketed by how many messages you sent (0–10+).
- **Interactive table** — filter by `from us <`, `total <` (AND/OR), health, free-text
  search, or "never replied"; sort any column; counts that hit the per-chat cap are
  marked. **CSV** exports the current filtered view.

The per-chat cap (default 300) bounds how deep each chat is paged so very active chats
don't make a scan crawl; capped chats are flagged in the table.

## CLI

```bash
node audit.mjs --us 4               # chats with fewer than 4 messages from us
node audit.mjs --total 3           # fewer than 3 messages total
node audit.mjs --us 4 --total 10   # both (AND, default)
node audit.mjs --us 4 --total 10 --mode any   # either (OR)
node audit.mjs --us 4 --from +12025550100     # scope to one line
```

| flag | meaning |
| --- | --- |
| `--us N` (`--from-me`, `--mine`) | flag chats with **fewer than N** messages from us |
| `--total N` | flag chats with **fewer than N** messages total |
| `--from E164` | only scan chats on this line |
| `--mode all\|any` | how to combine `--us` and `--total` (default `all`) |

Output is one row per match, sorted fewest-outbound first:

```
us=0 total=0  0f809ee6-…  +16462494950  [HEALTHY]
us=1 total=8  6f4c4fae-…  someone@example.com  [HEALTHY]
```

## How it works

- `client.chats.listChats()` pages through every chat for the partner key (100 per
  request). The list is drained first so the progress bar is accurate.
- Each chat is counted by paging `client.chats.messages.list(chatId)` (100 per request).
  The threshold CLI scan stops early once a chat can no longer match; the dashboard
  counts up to a per-chat cap.
- Chats are counted **in parallel** (default 12 at a time), which is where most of the
  speed comes from.

## Performance

There is no message-count field on the API, so counts require listing messages, and
each Linq request is ~300–600 ms. The cost is therefore (requests × latency). To keep
it fast:

- **Parallelism** is the big lever — counting chats concurrently took a full ~760-chat
  account from ~2 min down to ~20–40 s. Tune with `--concurrency` (CLI) or the
  **Parallel** field (dashboard), up to 20.
- **100-message pages** cut the number of round-trips per chat ~5×.
- **Per-chat cap** bounds how deep very active chats are paged. Lower it if you only
  care about quiet chats and want a faster scan.

## Files

| file | purpose |
| --- | --- |
| `audit-core.mjs` | shared scan logic (pagination, counting, early-exit) |
| `audit.mjs` | CLI |
| `server.mjs` | HTTP server + SSE live progress |
| `public/index.html` | web UI |

## Note

Scan output (`results-*.txt`, `*.csv`) can contain real contact phone numbers and
emails, so it's git-ignored. Don't commit it.

## License

MIT
