// Turn on the Nearly for a repo you already work in.
//
//   node scripts/attach.mjs                 # this repo
//   node scripts/attach.mjs ~/code/my-app   # that one
//   node scripts/attach.mjs --off           # turn it off again
//
// One command, once per repo. It installs everything and works out the rest:
//
//   · Claude Code hooks, so every session in this repo is gated and recorded
//     whether you start it in a terminal, in VS Code, or in JetBrains
//   · a git pre-push hook, so the record is offered when the work leaves your
//     machine
//   · where the records are published, read from the Nearly's own remote
//
// There is no server to remember. The hooks start it the first time they need
// it, and if it cannot start, Claude Code falls back to its own prompts and
// nothing breaks.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const HOOK = join(root, 'scripts', 'hook.mjs');
const PORT = 47653;

// Installed from npm, the path to this file sits in a cache that gets cleared,
// so the hooks have to call the published command rather than a path on disk.
// Running from a clone, the path is stable and faster, so use it.
const fromPackage = /[\\/]node_modules[\\/]/.test(root) || /[\\/]_npx[\\/]/.test(root);
const hookCmd = (ev) => fromPackage
  ? `npx -y nearly-cli@${pkgVersion()} hook ${ev}`
  : `node ${JSON.stringify(HOOK)} ${ev}`;
function pkgVersion() {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; }
  catch { return 'latest'; }
}

const argv = process.argv.slice(2);
const off = argv.includes('--off') || argv.includes('--detach');
const repo = resolve(argv.find((a) => !a.startsWith('--')) || process.cwd());
const nameIdx = argv.indexOf('--name');
const name = (nameIdx !== -1 ? argv[nameIdx + 1] : basename(repo))
  .replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'repo';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;

if (!existsSync(join(repo, '.git'))) {
  console.error(`${repo} is not a git repository.`);
  console.error('Run this inside the repo you want recorded, or pass its path.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Claude Code hooks
// ---------------------------------------------------------------------------
const dir = join(repo, '.claude');
const file = join(dir, 'settings.local.json');
mkdirSync(dir, { recursive: true });

let settings = {};
if (existsSync(file)) {
  try { settings = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`Could not read ${file}: ${e.message}`); process.exit(1); }
}
settings.hooks = settings.hooks || {};

// Recognise our own entries by the script they run, so this is safe to re-run
// and leaves anyone else's hooks alone.
const ours = (m) => (m?.hooks || []).some((h) =>
  /nearly/.test(String(h.command || '')) || String(h.command || '').includes(HOOK) ||
  String(h.url || '').includes(`:${PORT}/hooks/`));
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = (settings.hooks[ev] || []).filter((m) => !ours(m));
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

if (!off) {
  const entry = (ev, timeout) => ({
    hooks: [{ type: 'command', command: `${hookCmd(ev)} ${name}`, timeout }],
  });
  const add = (event, ev, timeout) => { settings.hooks[event] = [...(settings.hooks[event] || []), entry(ev, timeout)]; };
  add('SessionStart', 'session-start', 20);
  add('UserPromptSubmit', 'prompt', 20);
  add('PreToolUse', 'pre-tool', 600);   // long enough to hold while a human decides
  add('PostToolUse', 'post-tool', 20);
  add('Stop', 'stop', 30);
  add('SessionEnd', 'session-end', 120);
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

// ---------------------------------------------------------------------------
// git pre-push hook
// ---------------------------------------------------------------------------
const push = spawnSync(process.execPath,
  [join(root, 'scripts', 'install-push-hook.mjs'), repo, ...(off ? ['--remove'] : [])],
  { encoding: 'utf8' });

// ---------------------------------------------------------------------------
// Where the records are published. They are served by the Nearly's own
// GitHub Pages, so read it from the Nearly's remote rather than asking.
// ---------------------------------------------------------------------------
function pagesUrl() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    if (!m) return null;
    // A plain clone of the upstream repo points at somebody else's Pages, where
    // your records will never exist. Publishing needs a fork you control, so
    // say nothing rather than hand out links that 404.
    let upstream = null;
    try { upstream = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository?.url || null; } catch { /* no manifest */ }
    const u = upstream && upstream.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    if (u && u[1].toLowerCase() === m[1].toLowerCase() && u[2].toLowerCase() === m[2].toLowerCase()) return null;
    return `https://${m[1].toLowerCase()}.github.io/${m[2]}/records`;
  } catch { return null; }
}
const base = process.env.NEARLY_URL_BASE || pagesUrl();
if (base && !off) {
  try {
    const cfg = join(root, '.nearly.json');
    const prev = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')) : {};
    writeFileSync(cfg, JSON.stringify({ ...prev, urlBase: base }, null, 2) + '\n');
  } catch { /* the env var still works */ }
}

// ---------------------------------------------------------------------------
console.log('');
if (off) {
  console.log(`${bold('Nearly off')} for ${dim(repo)}`);
  console.log('  Claude Code hooks removed');
  console.log(push.status === 0 ? '  pre-push hook removed' : dim('  pre-push hook was not ours, left alone'));
  console.log('');
  process.exit(0);
}

console.log(`${ok('✓')} ${bold('Nearly is on')} for ${bold(name)}  ${dim(repo)}`);
console.log('');
console.log(`  ${ok('·')} every Claude Code session here is gated and recorded`);
console.log(`  ${ok('·')} ${push.status === 0 ? 'the record is offered when you push' : dim('pre-push hook skipped: ' + (push.stderr || '').trim().split('\n')[0])}`);
console.log(`  ${ok('·')} ${base ? `records publish to ${base}` : dim('records stay on this machine — see “Publish the records” in the README')}`);
console.log('');
console.log(`  Now just work. Requests that need you appear at ${bold(`http://127.0.0.1:${PORT}`)}`);
console.log(dim('  Nothing to leave running. Turn it off again with --off.'));
console.log('');
