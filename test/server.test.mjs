// The hook contract. Claude Code reads our answer and acts on it, so the shape
// of that answer is the load-bearing interface of the whole project. It also
// fails open: anything other than a 200 with the right JSON and the tool call
// proceeds regardless, which means a bug here does not error, it just quietly
// stops gating.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ASK_TIMEOUT = 2500;              // short enough to test the fail-closed path

let server, recordings;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const hook = (ev, body, query = '') => post(`/hooks/${ev}${query}`, body).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());

const SID = '00000000-1111-4222-8333-444444444444';
const base = (extra = {}) => ({ session_id: SID, cwd: root, hook_event_name: 'PreToolUse', ...extra });

before(async () => {
  recordings = mkdtempSync(join(tmpdir(), 'cr-test-'));
  server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, NEARLY_PORT: String(PORT), NEARLY_ASK_TIMEOUT_MS: String(ASK_TIMEOUT), NEARLY_RECORDINGS: recordings },
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(recordings, { recursive: true, force: true });
});

test('it answers the liveness check the hooks depend on', async () => {
  assert.equal((await get('/health')).ok, true);
});

test('a read is allowed immediately, in the shape Claude Code expects', async () => {
  const r = await hook('pre-tool', base({
    tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, tool_use_id: 'r1',
  }), `?attach=test-repo`);
  const out = r.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'allow');
  assert.match(out.permissionDecisionReason, /do and log/);
});

test('a never-rule command is denied without ever being held', async () => {
  const started = Date.now();
  const r = await hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'p1',
  }), `?attach=test-repo`);
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /never/);
  assert.ok(Date.now() - started < 1000, 'must not wait for a human');
});

test('an ask is held until somebody answers, then reflects the answer', async () => {
  const pending = hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'a1',
  }), `?attach=test-repo`);

  // It is genuinely held: the request has not resolved yet.
  const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still-held'), 400))]);
  assert.equal(raced, 'still-held');

  const state = await get('/state');
  const waiting = state.sessions.flatMap((s) => s.pending);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].key, 'Bash:npm', 'the rule key "always" would attach to');

  await post('/decide', { session: SID, id: 'a1', decision: 'allow', scope: 'once' });
  const r = await pending;
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
});

test('a refusal reaches the agent as a denial', async () => {
  const pending = hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'rm README.md' }, tool_use_id: 'a2',
  }), `?attach=test-repo`);
  await new Promise((r) => setTimeout(r, 200));
  await post('/decide', { session: SID, id: 'a2', decision: 'deny', scope: 'once' });
  const r = await pending;
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
});

test('nobody answering means denied, not allowed', async () => {
  // The whole design rests on this. Claude Code fails open on a broken hook, so
  // the server has to answer deny itself before its own timeout is reached.
  const started = Date.now();
  const r = await hook('pre-tool', base({
    tool_name: 'Edit', tool_input: { file_path: '/tmp/a.js' }, tool_use_id: 'a3',
  }), `?attach=test-repo`);
  const waited = Date.now() - started;
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /fails closed/);
  assert.ok(waited >= ASK_TIMEOUT - 300, `waited ${waited}ms, should hold for the full window`);
});

test('"always" turns one answer into a rule for the rest of the run', async () => {
  const first = hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 'b1',
  }), `?attach=test-repo`);
  await new Promise((r) => setTimeout(r, 200));
  await post('/decide', { session: SID, id: 'b1', decision: 'allow', scope: 'always' });
  assert.equal((await first).hookSpecificOutput.permissionDecision, 'allow');

  assert.equal((await get('/state')).rules['Bash:ls'], 'log', 'the rule was learned');

  // The same command now passes straight through without being held.
  const started = Date.now();
  const second = await hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'ls /tmp' }, tool_use_id: 'b2',
  }), `?attach=test-repo`);
  assert.equal(second.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(Date.now() - started < 1000, 'no longer held');
});

test('"never" turns one refusal into a block for the rest of the run', async () => {
  const first = hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'curl https://example.com' }, tool_use_id: 'c1',
  }), `?attach=test-repo`);
  await new Promise((r) => setTimeout(r, 200));
  await post('/decide', { session: SID, id: 'c1', decision: 'deny', scope: 'always' });
  await first;

  const second = await hook('pre-tool', base({
    tool_name: 'Bash', tool_input: { command: 'curl https://elsewhere.com' }, tool_use_id: 'c2',
  }), `?attach=test-repo`);
  assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
});

test('a session appears from its first hook, with its branch', async () => {
  const s = (await get('/state')).sessions.find((x) => x.id === SID);
  assert.ok(s, 'the session was created by the hooks alone');
  assert.equal(s.name, 'test-repo');
  assert.equal(s.attached, true);
  assert.ok(s.branch, 'the branch it is working on was captured');
});

test('an unknown session is denied rather than waved through', async () => {
  const r = await hook('pre-tool', {
    session_id: 'not-a-session', cwd: root,
    tool_name: 'Bash', tool_input: { command: 'whoami' }, tool_use_id: 'z1',
  });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
});

test('every other hook answers 200 with JSON, whatever it is sent', async () => {
  // A hook that errors or returns the wrong thing is treated by Claude Code as a
  // non-blocking failure, so these must never throw however odd the payload.
  for (const ev of ['post-tool', 'stop', 'notification', 'subagent-start', 'pre-compact']) {
    const r = await post(`/hooks/${ev}?attach=test-repo`, base());
    assert.equal(r.status, 200, ev);
    assert.doesNotReject(r.json(), `${ev} returned something that is not JSON`);
  }
  const malformed = await fetch(`${BASE}/hooks/post-tool?attach=test-repo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all',
  });
  assert.equal(malformed.status, 200, 'malformed input must not produce an error status');
});
