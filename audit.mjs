// linq-message-audit — list Linq chats and flag the quiet ones (CLI).
//
// Flags a chat when its message counts fall UNDER the given thresholds
// ("--us 4" = fewer than 4 messages from us).
//
// Usage:
//   LINQ_API_KEY=sk_... node audit.mjs [options]
//
// Options:
//   --total N     Flag chats with FEWER THAN N messages total.
//   --us N        Flag chats with FEWER THAN N messages sent by us (is_from_me).
//                 (aliases: --from-me, --mine)
//   --from E164   Only scan chats on this line, e.g. --from +12025550100.
//   --mode M      When both filters are set: "all" (AND, default) or "any" (OR).
//
// If neither --total nor --us is given, defaults to "--total 3".
// Env equivalents: LINQ_API_KEY (required), FROM, THRESHOLD (=> --total).

import { createClient, scanChats, filterSummary } from './audit-core.mjs';

function parseArgs(argv) {
  const opts = { mode: 'all' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--total': opts.total = Number(next()); break;
      case '--us':
      case '--from-me':
      case '--mine': opts.us = Number(next()); break;
      case '--from': opts.from = next(); break;
      case '--mode': opts.mode = next(); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        console.error(`Unknown option: ${a}`);
        opts.help = true;
    }
  }
  return opts;
}

const HELP = `linq-message-audit — flag chats with very few messages.

  LINQ_API_KEY=sk_... node audit.mjs [--total N] [--us N] [--from +E164] [--mode all|any]

  --total N   flag chats with fewer than N messages total
  --us N      flag chats with fewer than N messages from us
  --from E164 scope to one line
  --mode      combine both filters: all (AND, default) or any (OR)`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }

const apiKey = process.env.LINQ_API_KEY;
if (!apiKey) {
  console.error('Error: LINQ_API_KEY is not set. Run with: LINQ_API_KEY=sk_... node audit.mjs');
  process.exit(1);
}

let totalMax = opts.total ?? (process.env.THRESHOLD ? Number(process.env.THRESHOLD) : undefined);
let usMax = opts.us;
if (totalMax === undefined && usMax === undefined) totalMax = 3;
totalMax = totalMax === undefined ? null : totalMax;
usMax = usMax === undefined ? null : usMax;

for (const [name, v] of [['--total', totalMax], ['--us', usMax]]) {
  if (v != null && (!Number.isFinite(v) || v < 0)) {
    console.error(`Error: ${name} must be a non-negative number.`);
    process.exit(1);
  }
}
if (opts.mode !== 'all' && opts.mode !== 'any') {
  console.error('Error: --mode must be "all" or "any".');
  process.exit(1);
}
const from = (opts.from ?? process.env.FROM)?.trim() || undefined;
const summary = filterSummary({ totalMax, usMax, mode: opts.mode });

async function main() {
  console.error(`Scanning chats${from ? ` from ${from}` : ''}; flagging: ${summary}`);
  const client = createClient(apiKey);
  const { scanned, flagged } = await scanChats({
    client, totalMax, usMax, mode: opts.mode, from,
    onProgress: ({ scanned: s, flagged: f }) => {
      if (s % 25 === 0) console.error(`  ...scanned ${s}, ${f} flagged`);
    },
  });

  console.log(`\nScanned ${scanned} chat(s). ${flagged.length} match [${summary}]:\n`);
  if (flagged.length === 0) { console.log('  (none)'); return; }
  for (const { id, name, us, total, health } of flagged) {
    console.log(`  us=${us} total=${total}  ${id}  ${name}  [${health ?? '—'}]`);
  }
}

main().catch((err) => {
  console.error('\nFailed:', err?.message ?? err);
  if (err?.status) console.error('HTTP status:', err.status);
  process.exit(1);
});
