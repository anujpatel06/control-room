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
//   · a git pre-push hook, so the record is posted when the work leaves your
//     machine
//   · where the records are published, read from the Nearly's own remote
//   · one hook in Claude Code's user settings, so a session opened in another
//     folder is gated when it works in this repo (--local-only to skip it)
//
// There is no server to remember. The hooks start it the first time they need
// it, and if it cannot start, Claude Code falls back to its own prompts and
// nothing breaks.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { dataRoot, paths } from '../server/paths.mjs';
import { choose, installed as agentsOnMachine } from './detect.mjs';
import { installRuntime, hasRuntime, isRuntime, runtimeCommand, runtimeAtLeast, runtimeVersion, compareVersions, ENTRY } from './runtime.mjs';
import { ADAPTERS } from '../server/adapters.mjs';
import { installOutside, removeOutside, attachedRepos, userSettingsFile } from './outside.mjs';
import { prForBranch } from './pr-state.mjs';
import { postingOff, setPosting } from './posting.mjs';

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
let installedRoot = null;
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
      // And not an older build than this one: hooks written now may need what
      // only this version knows. An older `nearly` on PATH is skipped, not trusted.
      let v = null;
      try { v = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).version; } catch { /* unknown */ }
      if (out && (compareVersions(v, pkgVersion()) ?? -1) >= 0) { installedRoot = out; return p; }
    } catch { /* not our command; try the next one */ }
  }
  return null;
}

const fromPackage = /[\\/]node_modules[\\/]/.test(root) || /[\\/]_npx[\\/]/.test(root);
const viaNpx = /[\\/]_npx[\\/]/.test(root);

// `npx nearly-cli` should be the whole of it. An npx run is a temporary
// download, so hooks pointing at it would pin a version in a directory npm
// clears, and no fix would ever reach this repo.
//
// This used to `npm install -g`, which failed silently on every up-to-date
// Windows machine (Node will not spawn npm.cmd without a shell) and on any Mac
// whose Node came from the official installer (a root-owned prefix). Each fell
// back to a pinned npx call in every hook: slower on every tool call, and stuck
// on that release for good. So it installs into ~/.nearly/runtime instead —
// somewhere the user always owns. --no-install skips it.
function installRuntimeOnce() {
  if (isRuntime(root)) return true;
  if (onPath()) return runtimeAtLeast(pkgVersion());
  // Present and at least this version: use it. Present but older is not "installed"
  // for this purpose — the hooks about to be written may need what it lacks.
  if (runtimeAtLeast(pkgVersion())) return true;
  // A checkout does not install over what someone has; it just will not point
  // hooks at an older copy.
  if (!fromPackage) return false;
  if (argv.includes('--no-install') || process.env.NEARLY_NO_INSTALL === '1') return false;
  const older = hasRuntime() ? runtimeVersion() : null;
  process.stdout.write(dim(older ? `  Updating nearly ${older} → ${pkgVersion()}… ` : '  Installing nearly so upgrades reach you… '));
  const r = installRuntime(pkgVersion());
  if (r.ok) { console.log('done'); return true; }
  console.log(dim('could not'));
  // The reason, in full. "skipped" in grey is how the last version of this
  // left someone pinned to a broken release without ever knowing why.
  console.log(`    ${r.error}`);
  console.log(dim('    Falling back to npx, which is slower on every tool call and will not'));
  console.log(dim('    pick up fixes. Run nearly again here once the problem above is solved.'));
  return false;
}

// Preference, fastest and most durable first:
//   1. a `nearly` on PATH that is really this tool
//   2. the runtime install in ~/.nearly/runtime
//   3. a pinned npx call — works, but slow and never upgrades
//   4. the checkout's own script, for someone developing this
let installed = onPath();
let runtime = runtimeAtLeast(pkgVersion()) || isRuntime(root);
const hookCmd = (ev) => installed
  ? `nearly hook ${ev}`
  : runtime
    ? `${runtimeCommand()} hook ${ev}`
    : fromPackage
      ? `npx -y nearly-cli@${pkgVersion()} hook ${ev}`
      : `node ${JSON.stringify(HOOK)} ${ev}`;
// A function, not a value: the install below changes the answer.
const updateNote = () => (installed || runtime)
  ? 'upgrades reach this repo automatically'
  : fromPackage
    ? `pinned to v${pkgVersion()} — slow, and fixes will not reach it until you run nearly again`
    : 'running from a checkout — git pull updates it';

// Flags take a value either way: `--agent=cursor` or `--agent cursor`. Only the
// first worked, so `nearly --agent cursor` read "cursor" as the repo path and
// said it was not a git repository.
const VALUED = new Set(['--agent', '--name']);
const argv = (() => {
  const raw = process.argv.slice(2), out = [];
  for (let i = 0; i < raw.length; i++) {
    if (VALUED.has(raw[i]) && raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) { out.push(`${raw[i]}=${raw[i + 1]}`); i++; }
    else out.push(raw[i]);
  }
  return out;
})();
const flagValue = (f) => argv.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1);
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
const localOnly = argv.includes('--local-only');
const auto = !supervise;
// The repo is wherever git says its top is. Looking only for a .git folder in
// the current directory rejected every subfolder, which is where people usually
// are when they first try something.
const asked = resolve(argv.find((a) => !a.startsWith('--')) || process.cwd());
const repo = (() => {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: asked, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!top) return asked;
    // Keep the path as it was typed when it already is the top; git hands back
    // the resolved one (/private/var for /var on macOS), which is the same place
    // spelled in a way nobody wrote.
    return realpathSync.native(asked) === realpathSync.native(top) ? asked : resolve(top);
  } catch { return asked; }
})();
const name = (flagValue('--name') ?? basename(repo))
  .replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'repo';

// npm is a .cmd shim on Windows and Node will not run one through spawn unless
// it is named exactly. Without this, installing and upgrading both fail there.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Colour only on a terminal; piped into a file or a CI log it is noise.
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : String(s));
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : String(s));
const ok = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : String(s));

if (!existsSync(join(repo, '.git'))) {
  console.error(`${asked} is not inside a git repository.`);
  console.error('Run this inside the repo you want recorded, or pass its path.');
  process.exit(1);
}

// Do this before the hooks are written, so they can point at the installed
// command rather than a temporary npx download.
if (!off) runtime = installRuntimeOnce();

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

// Leave nothing behind. Turning off used to strip the hooks and keep an empty
// `{}` file and empty `.cursor/ .agents/ .codex/ .gemini/ .windsurf/` folders —
// and the next `nearly` read those folders as signs of use and wired all seven
// agents. Only what is empty goes; nothing of anyone else's is touched, and
// nothing above the repo.
if (off) {
  for (const a of ADAPTERS) {
    const file = join(repo, a.config);
    try {
      if (existsSync(file)) {
        const v = JSON.parse(readFileSync(file, 'utf8'));
        const hollow = v && typeof v === 'object' && Object.entries(v)
          .filter(([k]) => k !== 'version')
          .every(([, x]) => x == null || (typeof x === 'object' && !Object.keys(x).length));
        if (hollow) rmSync(file);
      }
      for (let dir = dirname(file); dir !== repo && dir.startsWith(repo); dir = dirname(dir)) {
        if (!existsSync(dir) || readdirSync(dir).length) break;
        rmdirSync(dir);
      }
    } catch { /* unreadable or busy: leave it */ }
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
// Sessions opened in another folder
// ---------------------------------------------------------------------------
// Claude Code only reads this repo's hooks when a session starts here. The hook
// in its user settings covers the rest, and stays only while some repo still
// has Nearly on. Never from a pinned npx call: that would put a registry lookup
// in front of every tool call in every session on the machine.
if (!off && (argv.includes('--no-post') || argv.includes('--post'))) {
  try { setPosting(repo, argv.includes('--post')); } catch (e) { notes.push(`could not save the posting choice: ${e.message}`); }
}

let reach = null;
const claudeWired = wired.some((a) => a.id === 'claude-code');
if (!off && claudeWired && !localOnly && (installed || runtime || !fromPackage)) {
  try {
    // By path, to a file only this version and later have: see outside-hook.mjs.
    const base = installed ? installedRoot : runtime ? dirname(dirname(ENTRY)) : root;
    reach = installOutside((ev) => `node ${JSON.stringify(join(base, 'scripts', 'outside-hook.mjs'))} ${ev}`);
    if (reach.error) { notes.push(`sessions opened in other folders are not covered: ${reach.error}`); reach = null; }
  } catch (e) { notes.push(`sessions opened in other folders are not covered: ${e.message}`); }
} else if (off || localOnly) {
  try { if (!attachedRepos().length) removeOutside(); } catch { /* leave it: it answers nothing without repos */ }
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
    return await reclaim({ port: PORT, base: `http://127.0.0.1:${PORT}`, root: mine, version: pkgVersion() });
  } catch { return null; }
}
const port = off ? null : await checkPort();

// ---------------------------------------------------------------------------
// git pre-push hook
// ---------------------------------------------------------------------------
const baseCmd = () => installed
  ? 'nearly'
  : runtime
    ? runtimeCommand()
    : fromPackage
      ? `npx -y nearly-cli@${pkgVersion()}`
      : `node ${JSON.stringify(join(root, 'bin', 'nearly.mjs'))}`;
const push = spawnSync(process.execPath,
  [join(root, 'scripts', 'install-push-hook.mjs'), repo, '--cmd', baseCmd(), ...(off ? ['--remove'] : [])],
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
  console.log(dim('  restart any agent session open here; it keeps the hooks it started with'));
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
if (reach) {
  console.log(`  ${ok('·')} Claude Code sessions opened in another folder are gated too, once they work in this repo`);
  console.log(`    ${dim(`a hook in ${userSettingsFile().replace(process.env.HOME || '~', '~')}; it stays silent everywhere else`)}`);
} else if (claudeWired && !off) {
  console.log(`  ${ok('·')} ${dim('only Claude Code sessions started in this folder are gated')}`);
}
// Hooks are read when a session starts. Someone who turns this on and carries on
// in the window they already had is not gated at all, and nothing says so.
if (wired.length) {
  console.log(`  ${bold('·')} ${bold(`restart any ${wired.map((a) => a.name).join(' or ')} session already open`)} ${dim('— hooks are read when a session starts')}`);
}
console.log(`  ${ok('·')} ${dim(updateNote())}`);
if (push.status === 0) {
  // Only sessions from now on are recorded, and the record reaches a pull
  // request on a push. Said here, because the natural thing is to look at a pull
  // request that already exists and wonder where the record is.
  const pr = prForBranch(repo);
  if (postingOff(repo)) {
    console.log(`  ${ok('·')} the record is built on push but not posted ${dim('— nearly --post puts it on the pull request')}`);
  } else if (pr.state === 'open') {
    console.log(`  ${ok('·')} the record is posted to #${pr.number} on your next push ${dim('— sessions from now on; nearly --no-post stops it')}`);
  } else if (pr.state === 'merged' || pr.state === 'closed') {
    console.log(`  ${ok('·')} the record is posted on your next push ${dim(`— #${pr.number} for this branch is ${pr.state}, so open a new pull request first`)}`);
  } else {
    console.log(`  ${ok('·')} the record is posted to the pull request when it is opened, and updated on every push ${dim('— nearly --no-post stops it')}`);
  }
} else {
  // All of it: when a pre-push hook of yours is already there, the lines after
  // the first are the ones that say how to add Nearly to it by hand.
  const said = (push.stderr || '').trim().split('\n').filter(Boolean);
  console.log(`  ${ok('·')} ${dim(`pre-push hook skipped: ${said[0] || 'unknown reason'}`)}`);
  for (const line of said.slice(1)) console.log(`    ${dim(line)}`);
}
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
