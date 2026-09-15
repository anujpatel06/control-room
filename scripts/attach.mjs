// Attach the Control Room to a repo you already work in with Claude Code.
//
//   node scripts/attach.mjs <repo-path> [--name docs]     # install hooks
//   node scripts/attach.mjs <repo-path> --detach          # remove them
//
// Writes hook entries into <repo>/.claude/settings.local.json (the file Claude
// Code keeps out of git) that point every session in that repo at the running
// Control Room server. From then on your normal Claude Code session, in the
// terminal or in VS Code, is gated and recorded like the ones the Control Room
// launches itself, with two differences:
//
//   - nothing is auto-committed in your repo; each turn's diff is recorded instead
//   - Undo is not offered (it is your branch; use git yourself)
//
// If the server is not running, Claude Code treats the hook as a non-blocking
// error and falls back to its own permission prompts. Attach fails open.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 47653;

const argv = process.argv.slice(2);
const repo = resolve(argv.find((a) => !a.startsWith('--')) || '.');
const detach = argv.includes('--detach');
const nameIdx = argv.indexOf('--name');
const name = (nameIdx !== -1 ? argv[nameIdx + 1] : basename(repo)).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'repo';

if (!existsSync(join(repo, '.git'))) {
  console.error(`${repo} is not a git repository`);
  process.exit(1);
}

const dir = join(repo, '.claude');
const file = join(dir, 'settings.local.json');
mkdirSync(dir, { recursive: true });

let settings = {};
if (existsSync(file)) {
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`could not parse ${file}: ${e.message}`); process.exit(1); }
}
settings.hooks = settings.hooks || {};

// Remove anything we installed before, so attach is idempotent and detach is clean.
// Ours are recognised by their URL; no custom keys, so Claude Code's settings schema stays happy.
const ours = (m) => (m?.hooks || []).some((h) => h?.type === 'http' && String(h.url || '').includes(`:${PORT}/hooks/`));
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = (settings.hooks[ev] || []).filter((m) => !ours(m));
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

if (!detach) {
  const url = (ev) => `http://${HOST}:${PORT}/hooks/${ev}?attach=${encodeURIComponent(name)}`;
  const entry = (ev, timeout) => ({ hooks: [{ type: 'http', url: url(ev), timeout }] });
  const add = (event, ev, timeout) => { settings.hooks[event] = [...(settings.hooks[event] || []), entry(ev, timeout)]; };
  add('SessionStart', 'session-start', 10);
  add('UserPromptSubmit', 'prompt', 10);
  add('PreToolUse', 'pre-tool', 180);     // must exceed the server's ASK_TIMEOUT_MS (120 s), which fails closed
  add('PostToolUse', 'post-tool', 10);
  add('Stop', 'stop', 20);
  add('SessionEnd', 'session-end', 30);
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

if (detach) {
  console.log(`Detached. Removed Control Room hooks from ${file}`);
} else {
  console.log(`Attached "${name}" → ${file}`);
  console.log(`Keep the server running (node server/index.mjs), then use Claude Code in ${repo} as usual.`);
  console.log(`Asks appear at http://${HOST}:${PORT}. When the session ends, a recap is built automatically.`);
}
