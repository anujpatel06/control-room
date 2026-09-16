// Turn on the Nearly for a repo you already work in.
//
//   node scripts/attach.mjs                 # this repo
//   node scripts/attach.mjs ~/code/my-app   # that one
//   node scripts/attach.mjs --off           # turn it off again
//
// One command, once per repo. It installs everything and works out the rest:
//
//   · hooks for every coding agent this repo is driven by, so sessions are
//     gated and recorded whether you start them in a terminal, in VS Code or in
//     JetBrains. Claude Code always; Cursor, Antigravity, Copilot, Codex, Gemini
//     and Windsurf when the repo shows signs of them, or on --agent=
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
import { dataRoot, paths } from '../server/paths.mjs';
import { choose, installed as agentsOnMachine } from './detect.mjs';
import { ADAPTERS } from '../server/adapters.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const HOOK = join(root, 'scripts', 'hook.mjs');
const PORT = Number(process.env.NEARLY_PORT || 47653);

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
  const r = spawnSync(NPM, ['install', '-g', `nearly-cli@${pkgVersion()}`, '--silent', '--no-fund', '--no-audit'],
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
// A function, not a value: the install below changes the answer, and computing
// it early told a fresh install it was pinned when it was not.
const updateNote = () => installed
  ? 'upgrades reach this repo automatically'
  : fromPackage
    ? `pinned to v${pkgVersion()} — run nearly again here after upgrading`
    : 'running from a checkout — git pull updates it';

const argv = process.argv.slice(2);
const off = argv.includes('--off') || argv.includes('--detach');
// Unattended unless you ask to supervise.
//
// Holding a call for a human only works if a human is looking at the dashboard,
// and nothing tells a new user it exists. So the default used to be: every edit
// silently waits two minutes and is then refused. That made a Cursor session
// unable to write a single file, and turned a fifteen-second task into five
// minutes under auto mode. Two real failures of the same default.
//
// Now the never-rules block with nobody present, everything else is done and
// recorded, and holding for approval is something you turn on while watching.
const supervise = argv.includes('--supervise');
const auto = !supervise;
const repo = resolve(argv.find((a) => !a.startsWith('--')) || process.cwd());
const nameIdx = argv.indexOf('--name');
const name = (nameIdx !== -1 ? argv[nameIdx + 1] : basename(repo))
  .replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'repo';

// npm is a .cmd shim on Windows and Node will not run one through spawn unless
// it is named exactly. Without this, installing and upgrading both fail there.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
// Agent hooks
// ---------------------------------------------------------------------------
// Turning off removes every adapter, not just the ones this repo still shows
// signs of, so nothing is left behind pointing at a command that will not run.
const { chosen, unknown } = off ? { chosen: ADAPTERS, unknown: [] } : choose(repo, argv);
if (unknown.length) {
  console.error(`Unknown agent: ${unknown.join(', ')}`);
  console.error(`Known: ${ADAPTERS.map((a) => a.id).join(', ')}`);
  process.exit(1);
}

const wired = [];
const notes = [];
for (const a of chosen) {
  const cmdFor = (ev) => `${hookCmd(ev)} ${name}`
    + (a.id === 'claude-code' ? '' : ` --adapter=${a.id}`)
    + (auto ? ' --auto' : '');
  try {
    const r = off ? a.uninstall({ repo }) : a.install({ repo, cmdFor, name });
    if (r?.error) { notes.push(`${a.name}: ${r.error}`); continue; }
    if (off ? r?.removed : r?.file) wired.push({ ...a, file: r.file });
    if (r?.note) notes.push(`${a.name}: ${r.note}`);
  } catch (e) {
    // One harness's config being unwritable must not cost you the others.
    notes.push(`${a.name}: ${e.message}`);
  }
}

// Remember this repo, so the dashboard can offer it before anything has run in
// it. A list of paths and nothing else: it is a convenience, and it is rebuilt
// by simply turning Nearly on again.
try {
  const f = paths.repos();
  // On a machine that has never run Nearly, ~/.nearly does not exist yet and
  // this write fails with ENOENT. It used to fail into a bare catch, so the
  // list was silently never created and the dashboard could never offer a repo
  // — invisible on every machine except a genuinely fresh one.
  mkdirSync(dirname(f), { recursive: true });
  let list = [];
  try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first one */ }
  // Prune as we go: a repo that has been moved or deleted is noise in a list
  // whose only job is to offer you somewhere to start.
  list = list.filter((r) => r !== repo && existsSync(join(r, '.git')));
  if (!off) list.unshift(repo);
  writeFileSync(f, JSON.stringify(list.slice(0, 50), null, 2) + '\n');
} catch (e) {
  // Not fatal — the gate does not depend on it — but not silent either.
  notes.push(`could not remember this repo for the dashboard: ${e.message}`);
}

// ---------------------------------------------------------------------------
// A server from somewhere else, already holding the port
// ---------------------------------------------------------------------------
// The server outlives the run that starts it. So a single `npx nearly-cli`, or
// any upgrade, can leave the previous build squatting — answering from a
// directory npm has since replaced, 404ing its own record pages, and making
// every fix since invisible. A hook cannot say any of this out loud; this
// command can, because you are here reading it.
//
// Builds from 0.1.8 stand down when asked. Older ones have no way to be asked,
// so the honest thing is to name the problem and the exact command.
async function checkPort() {
  let mine = root;
  try { mine = realpathSync(root); } catch { /* compare the literal path */ }
  try {
    const { reclaim } = await import('../server/reclaim.mjs');
    return await reclaim({ port: PORT, base: `http://127.0.0.1:${PORT}`, root: mine });
  } catch { return null; }
}
const port = off ? null : await checkPort();

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
  // The legacy path is read, never written: an upgrade destroys it, so the
  // first run after this change is the last chance to carry it forward.
  for (const f of [paths.config(), join(root, '.nearly.json')]) {
    try {
      if (existsSync(f)) {
        const u = JSON.parse(readFileSync(f, 'utf8')).urlBase;
        if (u) return u;
      }
    } catch { /* try the next one */ }
  }
  return null;
}
const derived = pagesUrl();
const base = process.env.NEARLY_URL_BASE || configured() || derived;
if (base && !off) {
  try {
    const cfg = paths.config();
    const prev = existsSync(cfg) ? JSON.parse(readFileSync(cfg, 'utf8')) : {};
    writeFileSync(cfg, JSON.stringify({ ...prev, urlBase: base }, null, 2) + '\n');
  } catch (e) { notes.push(`could not save where records publish: ${e.message}`); }
}

// ---------------------------------------------------------------------------
console.log('');
if (off) {
  console.log(`${bold('Nearly off')} for ${dim(repo)}`);
  console.log(wired.length
    ? `  hooks removed: ${wired.map((a) => a.name).join(', ')}`
    : '  no agent hooks of ours were installed');
  console.log(push.status === 0 ? '  pre-push hook removed' : dim('  pre-push hook was not ours, left alone'));
  console.log('');
  process.exit(0);
}

console.log(`${ok('✓')} ${bold('Nearly is on')} for ${bold(name)}  ${dim(repo)}`);
console.log('');
if (supervise) {
  console.log(`  ${ok('·')} ${bold('supervised')} ${dim(`— risky calls wait for you at http://127.0.0.1:${PORT}`)}`);
  console.log(`    ${dim('keep that page open, or every one of them is refused after two minutes')}`);
} else {
  console.log(`  ${ok('·')} ${dim('destructive commands are blocked; everything else runs and is recorded')}`);
  console.log(`    ${dim('to approve risky calls yourself: nearly --supervise')}`);
}
for (const a of wired) {
  const how = a.verified ? dim(`(${a.verified})`) : dim('(built to their published hook spec, not yet run against a live agent)');
  console.log(`  ${ok('·')} ${a.name} sessions here are gated and recorded ${how}`);
}
console.log(`  ${ok('·')} ${dim(updateNote())}`);
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
for (const n of notes) console.log(`  ${dim('·')} ${dim(n)}`);

if (port?.outcome === 'stood-down' || port?.outcome === 'ended') {
  const from = port.who?.root || 'an older build';
  console.log(`  ${ok('·')} ${dim(`closed an older Nearly server that was holding port ${PORT}`)}`);
  console.log(`    ${dim(from)}`);
} else if (port?.outcome === 'busy') {
  console.log('');
  console.log(`  ${bold('Another Nearly server is on this port and is in use.')}`);
  console.log(dim('  Left it alone. Run this again once it is idle and this build will take over.'));
} else if (port?.outcome === 'stuck') {
  console.log('');
  console.log(`  ${bold(`An older Nearly server is holding port ${PORT} and would not close.`)}`);
  console.log(dim('  Until it goes it answers instead of this one, which is why its record pages'));
  console.log(dim('  404 and why upgrading appears to do nothing.'));
  console.log('');
  console.log(`  ${dim('End it with:')}  ${process.platform === 'win32'
    ? `netstat -ano | findstr :${PORT}   then   taskkill /PID <pid> /F`
    : `lsof -ti:${PORT} -sTCP:LISTEN | xargs kill`}`);
}

// An agent you have on this machine but have not used here is worth a word, and
// nothing more: having it installed is no reason to write files into this repo.
const elsewhere = agentsOnMachine().filter((i) => !wired.some((w) => w.id === i.id));
if (elsewhere.length) {
  console.log('');
  console.log(dim(`  Also installed here: ${elsewhere.map((e) => e.name).join(', ')}.`));
  console.log(dim(`  Nothing in this repo suggests you use them for it, so they were left alone:`));
  console.log(dim(`  nearly --agent=${elsewhere[0].id} turns one on.`));
}

console.log('');
console.log(supervise
  ? `  Now just work. Requests that need you appear at ${bold(`http://127.0.0.1:${PORT}`)}`
  : `  Now just work. Nothing will wait for you.`);
console.log(dim('  Nothing to leave running. Turn it off again with --off.'));
console.log('');
