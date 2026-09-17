// A newer Nearly meeting an older one.
//
// 0.1.18 wrote a hook into Claude Code's user settings and pointed it at an
// installed 0.1.17. The old copy did not understand the hook, treated every
// session on the machine as one to supervise, and held each of their tool calls
// for two minutes before refusing it — including sessions that had nothing to do
// with any repo Nearly was on for. Each test here is one of the ways that must
// now fail open instead.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 45400 + Math.floor(Math.random() * 300);

let box, home, repo, env, server;

before(async () => {
  box = realpathSync.native(mkdtempSync(join(tmpdir(), 'nearly-mismatch-')));
  home = join(box, 'home');
  repo = join(box, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@x'); git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'seed');

  // An older install: this build's code, minus the one file old builds lack, and
  // saying it is 0.1.17.
  const old = join(home, 'runtime', 'node_modules', 'nearly-cli');
  for (const d of ['bin', 'scripts', 'server']) cpSync(join(root, d), join(old, d), { recursive: true });
  rmSync(join(old, 'scripts', 'outside-hook.mjs'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  writeFileSync(join(old, 'package.json'), JSON.stringify({ ...pkg, version: '0.1.17' }));

  mkdirSync(join(box, 'claude'));
  env = {
    ...process.env, NEARLY_HOME: home, NEARLY_PORT: String(PORT), CLAUDE_CONFIG_DIR: join(box, 'claude'),
    NEARLY_REPOS: join(box, 'repos.json'), NEARLY_RECORDINGS: join(box, 'rec'), NEARLY_CONFIG: join(box, 'config.json'),
    NEARLY_OUTSIDE: join(box, 'outside'), NEARLY_NO_INSTALL: '1', NEARLY_ASK_TIMEOUT_MS: '3000', NO_COLOR: '1',
  };
  mkdirSync(env.NEARLY_RECORDINGS);
  server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { cwd: root, stdio: 'ignore', env });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (server && server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 3000); });
  rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function run(file, args, payload, extra = {}) {
  return new Promise((resolve) => {
    const began = Date.now();
    const p = spawn(process.execPath, [file, ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ out: out.trim(), code, ms: Date.now() - began }));
    p.stdin.end(JSON.stringify(payload));
  });
}
const call = (sid, command, cwd = box) => ({ session_id: sid, tool_use_id: `${sid}-1`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

test('hooks are never pointed at an installed copy older than the nearly writing them', () => {
  const on = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env });
  assert.equal(on.status, 0, on.stderr);
  const local = readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8');
  const user = readFileSync(join(box, 'claude', 'settings.json'), 'utf8');
  assert.doesNotMatch(local, /runtime/, 'the repo hooks point at the older install');
  assert.doesNotMatch(user, /runtime/, 'the user-level hook points at the older install');
  assert.match(user, /outside-hook\.mjs/);
});

test('the user-level hook, run by an install too old to have it, answers nothing and does not block', async () => {
  const oldEntry = join(home, 'runtime', 'node_modules', 'nearly-cli', 'scripts', 'outside-hook.mjs');
  const r = await run(oldEntry, ['pre-tool'], call('stranger-1', 'git log'));
  assert.equal(r.out, '', 'an old install answered for a session it knows nothing about');
  assert.notEqual(r.code, 2, 'exit 2 is how Claude Code is told to block');
});

test('a hook given a flag it does not know stays out of the session', async () => {
  const r = await run(join(root, 'scripts', 'hook.mjs'), ['pre-tool', 'repo', '--from-the-future'], call('future-1', 'npm test', repo));
  assert.equal(r.out, '');
});

test('a hook with no repo name stays out of the session', async () => {
  // Exactly what 0.1.17 saw: `hook pre-tool --outside`, with no name after the event.
  const r = await run(join(root, 'scripts', 'hook.mjs'), ['pre-tool'], call('noname-1', 'npm test', repo));
  assert.equal(r.out, '');
});

test('an attached session is only held for a person when its hook asks for that outright', async () => {
  const body = JSON.stringify({ ...call('plain-1', 'npm run build', repo) });
  const began = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/hooks/pre-tool?attach=repo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const answer = await res.json();
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(Date.now() - began < 2000, 'held with nobody asked to watch');
});

test('nearly pause stops every hook at once, and nearly resume brings it back', async () => {
  const nearly = (c) => spawnSync(process.execPath, [join(root, 'bin', 'nearly.mjs'), c], { encoding: 'utf8', env });
  const hook = join(root, 'scripts', 'hook.mjs');
  try {
    assert.equal(nearly('pause').status, 0);
    const paused = await run(hook, ['pre-tool', 'repo', '--auto'], call('pause-1', 'rm -rf ~', repo));
    assert.equal(paused.out, '', 'a paused Nearly still answered');
  } finally { nearly('resume'); }
  const back = await run(hook, ['pre-tool', 'repo', '--auto'], call('pause-2', 'rm -rf ~', repo));
  assert.match(back.out, /"deny"/, 'resume did not turn the gate back on');
});

test('doctor says so when the user-level hook is the broken form', () => {
  const file = join(box, 'claude', 'settings.json');
  const before = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "${join(home, 'runtime', 'node_modules', 'nearly-cli', 'bin', 'nearly.mjs')}" hook pre-tool --outside` }] }] } }));
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'doctor.mjs'), repo],
      { encoding: 'utf8', timeout: 60_000, env: { ...env, NEARLY_NO_UPDATE: '1' } });
    assert.match(r.stdout, /✗ sessions opened in other folders/);
    assert.match(r.stdout, /nearly pause/);
  } finally { writeFileSync(file, before); }
});
