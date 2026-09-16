// Where Nearly installs itself so hooks have something stable to call.
//
// Hooks run on every tool call, so they need a command that is fast, will still
// exist tomorrow, and picks up upgrades. `npm install -g` was supposed to give
// that and failed in two common ways, both silently:
//
//   · Windows: spawning npm.cmd without a shell is refused by every current
//     Node release (the 2024 fix for CVE-2024-27980). So the install failed on
//     every up-to-date Windows machine, every time.
//   · macOS with Node from the official installer: the global prefix is
//     /usr/local, owned by root, so the install fails without sudo.
//
// Either way attach fell back to `npx -y nearly-cli@<version>` in every hook —
// slower on each call, and pinned, so no fix ever reached that repo again. A
// Cursor user was stuck on the exact release that was breaking his editor.
//
// So install into a directory the user always owns. No root, no PATH, no
// global prefix to be wrong about.

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

// Not paths.mjs: from a checkout that resolves to the checkout, and a runtime
// install must live in the user's own space whatever ran it.
export const RUNTIME = join(process.env.NEARLY_HOME || join(homedir(), '.nearly'), 'runtime');
export const ENTRY = join(RUNTIME, 'node_modules', 'nearly-cli', 'bin', 'nearly.mjs');

export const hasRuntime = () => existsSync(ENTRY);

export function isRuntime(root) {
  const rel = resolve(root);
  return rel === resolve(RUNTIME) || rel.startsWith(resolve(RUNTIME) + (process.platform === 'win32' ? '\\' : '/'));
}

// The command a hook runs. Quoted, because a home directory with a space in it
// is ordinary on Windows and would otherwise split into two arguments.
export const runtimeCommand = () => `node ${JSON.stringify(ENTRY)}`;

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Everything that installs Nearly runs inside `npx nearly-cli`, and npx hands its
// own settings to its children as npm_config_* variables. A nested npm install
// inherits them and obeys them — on one machine `allow_scripts` turned a plain
// install into EALLOWSCRIPTS, and on another it will be whatever that person's
// npm config happens to hold. The identical command succeeds with them removed.
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
}

// npm reports a failure as key/value lines (`code`, `syscall`, `path`, `errno`)
// followed by a sentence, and ends almost every one with "A complete log of this
// run can be found in". Showing the last line pointed people at a log file;
// showing the first two showed `code ENOENT — syscall open` and dropped the part
// that says which file. The error code plus npm's own sentence is the answer.
const KEYS = /^(code|syscall|path|errno|dest|spawnargs|signal|cmd|cwd|file|type|stack|A complete log)\b/i;
export function npmError(r) {
  const lines = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const body = (l) => l.replace(/^npm (error|ERR!)\s*/i, '');
  const errs = lines.filter((l) => /^npm (error|ERR!)/i.test(l)).map(body);
  const code = errs.find((l) => /^code\b/i.test(l))?.replace(/^code\s+/i, '');
  const sentence = errs.filter((l) => !KEYS.test(l)).map((l) => l.replace(/^[a-z]+ (?=[A-Z])/, ''))[0];
  const said = [code, sentence].filter(Boolean);
  // Drop the code when the sentence already starts with it.
  if (said.length === 2 && said[1].startsWith(said[0])) said.shift();
  return said.join(' — ') || lines.filter((l) => !/complete log of this run/i.test(l)).pop() || `npm exited ${r.status}`;
}

export function installRuntime(version) {
  try { mkdirSync(RUNTIME, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
  // A tarball or path can stand in for the registry — how the tests install a
  // build that has not been published yet.
  const spec = process.env.NEARLY_INSTALL_SPEC || `nearly-cli@${version}`;
  const r = spawnSync(NPM, ['install', '--prefix', RUNTIME, spec, '--no-save', '--no-fund', '--no-audit', '--loglevel=error'], {
    encoding: 'utf8', timeout: 180_000,
    // Windows will not spawn a .cmd any other way.
    shell: process.platform === 'win32',
    env: cleanEnv(),
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0 || !hasRuntime()) return { ok: false, error: npmError(r) };
  return { ok: true };
}
