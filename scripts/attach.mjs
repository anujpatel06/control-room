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

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { dataRoot } from '../server/paths.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const HOOK = join(root, 'scripts', 'hook.mjs');
const PORT = 47653;

// What the hooks should invoke, in order of preference. This choice decides
// whether upgrading the tool ever reaches the repos it was turned on for.
//
//   1. The command on PATH, if it is this package. Resolved fresh every time a
//      hook fires, so `npm i -g nearly-cli@latest` updates every repo at once
//      and nothing has to be turned on again.
//   2. A pinned npx call, when running from a cache that gets cleared. Pinned on
//      purpose: @latest would check the registry before every single tool call.
//   3. The path on disk, when running from a clone. Stable and fastest.
function pkgVersion() {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; }
  catch { return 'latest'; }
}

// Only trust a `nearly` on PATH if it really is this tool and it will still be
// there tomorrow.
//
// npx puts its own temporary bin first on PATH for the life of the process, so
// during `npx nearly-cli` a naive lookup finds a `nearly` that ceases to exist
// the moment npx exits. Believing it meant writing hooks that call a command
// nobody has, which fail on every tool call, which means no gate at all.
function onPath() {
  const args = process.platform === 'win32' ? ['nearly'] : ['-a', 'nearly'];
  let found = [];
  try {
    found = execFileSync(process.platform === 'win32' ? 'where' : 'which', args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
  } catch { return null; }

  for (const p of found) {
    let resolved = p;
    try { resolved = realpathSync(p); } catch { /* keep the literal path */ }
    if (/[\\/]_npx[\\/]/.test(p) || /[\\/]_npx[\\/]/.test(resolved)) continue;  // vanishes when npx exits
    try {
      const out = execFileSync(p, ['--which'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out) return p;
    } catch { /* not our command; try the next one */ }
  }
  return null;
}

const fromPackage = /[\\/]node_modules[\\/]/.test(root) || /[\\/]_npx[\\/]/.test(root);
const viaNpx = /[\\/]_npx[\\/]/.test(root);

// `npx nearly-cli` should be the whole of it. An npx run is a temporary
// download, so hooks pointing at it would pin a version in a directory npm
// clears, and no fix would ever reach this repo. Install it properly instead,
// once, out loud, so the one command someone types actually leaves them with a
// working tool. --no-install skips it.
function installGlobally() {
  if (!viaNpx || onPath() || argv.includes('--no-install') || process.env.NEARLY_NO_INSTALL === '1') return false;
  process.stdout.write(dim(`  Installing nearly so upgrades reach you… `));
  const r = spawnSync('npm', ['install', '-g', `nearly-cli@${pkgVersion()}`, '--silent', '--no-fund', '--no-audit'],
    { encoding: 'utf8', timeout: 180_000 });
  if (r.status === 0 && onPath()) { console.log('done'); return true; }
  console.log(dim('skipped'));
  console.log(dim('    Running from npx instead. Upgrades will not reach this repo automatically;'));
  console.log(dim('    npm install -g nearly-cli when you want that.'));
  return false;
}
let installed = onPath();
const hookCmd = (ev) => installed
  ? `nearly hook ${ev}`   // verified above to survive this process
  : fromPackage
    ? `npx -y nearly-cli@${pkgVersion()} hook ${ev}`
    : `node ${JSON.stringify(HOOK)} ${ev}`;
const updateNote = installed
  ? 'upgrades reach this repo automatically'
  : fromPackage
    ? `pinned to v${pkgVersion()} — run nearly again here after upgrading`
    : 'running from a checkout — git pull updates it';

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

// Do this before the hooks are written, so they can point at the installed
// command rather than a temporary npx download.
if (!off && installGlobally()) installed = onPath();

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
// An address already configured wins: it was either set deliberately or worked
// out here before, and it survives the project being renamed.
function configured() {
  try {
    const f = join(root, '.nearly.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')).urlBase || null;
  } catch { /* fall through */ }
  return null;
}
const derived = pagesUrl();
const base = process.env.NEARLY_URL_BASE || configured() || derived;
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
console.log(`  ${ok('·')} ${dim(updateNote)}`);
console.log(`  ${ok('·')} ${push.status === 0 ? 'the record is offered when you push' : dim('pre-push hook skipped: ' + (push.stderr || '').trim().split('\n')[0])}`);
if (base) {
  console.log(`  ${ok('·')} records publish to ${base}`);
} else {
  // Only reachable from a clone of the upstream repo, where publishing needs a
  // fork the person actually controls.
  console.log(`  ${ok('·')} ${dim(`records are kept in ${dataRoot.replace(process.env.HOME || '~', '~')}`)}`);
  console.log(`    ${dim('to link them from a pull request, host that folder anywhere and:')}`);
  console.log(`    ${dim('NEARLY_URL_BASE=https://your-host/records nearly')}`);
}
console.log('');
console.log(`  Now just work. Requests that need you appear at ${bold(`http://127.0.0.1:${PORT}`)}`);
console.log(dim('  Nothing to leave running. Turn it off again with --off.'));
console.log('');
