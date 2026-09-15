// The server that would not go away.
//
// A hook starts the server, and the server outlives the run that started it.
// So after an upgrade — or after a single `npx nearly-cli` — the previous build
// still holds the port and still answers. Its record pages 404 because they
// point into a directory npm has since replaced, and every fix shipped after it
// is invisible, with nothing anywhere explaining why. Reported from a Windows
// machine where an npx-cache server had been squatting for days.
//
// What these hold: that a server from somewhere else is replaced rather than
// talked to, and that it is never replaced out from under a person who is
// mid-decision.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 49200 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;

// Windows keeps a directory busy until every handle inside it is closed, and
// kill() returns long before the process has gone. Wait for the exit, then let
// rmSync retry: without both, cleanup fails on timing alone.
const gone = (p) => (p && p.exitCode === null && !p.killed
  ? new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); setTimeout(r, 3000); })
  : Promise.resolve());
const scrub = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

let impostorRoot, impostor, recordings;

const health = async () => {
  try { return await (await fetch(`${BASE}/health`)).json(); } catch { return null; }
};
const waitFor = async (pred, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

// A second copy of this build, living somewhere else — which is exactly what an
// npx cache is.
before(async () => {
  recordings = mkdtempSync(join(tmpdir(), 'nearly-stale-rec-'));
  impostorRoot = mkdtempSync(join(tmpdir(), 'nearly-impostor-'));
  for (const d of ['server', 'ui']) cpSync(join(root, d), join(impostorRoot, d), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.version = '0.0.1-impostor';
  writeFileSync(join(impostorRoot, 'package.json'), JSON.stringify(pkg));

  impostor = spawn(process.execPath, [join(impostorRoot, 'server', 'index.mjs')], {
    cwd: impostorRoot, stdio: 'ignore',
    env: { ...process.env, NEARLY_PORT: String(PORT), NEARLY_RECORDINGS: recordings,
      NEARLY_REPOS: join(recordings, 'repos.json'), NEARLY_IDLE_EXIT_MS: '0',
      NEARLY_ASK_TIMEOUT_MS: '2000' },
  });
  assert.ok(await waitFor(async () => (await health())?.ok), 'the impostor never started');
});

after(async () => {
  // The launcher starts its replacement detached, so it outlives this file
  // unless it is asked to go — which is the whole subject of these tests.
  try { await fetch(`${BASE}/exit`, { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* already gone */ }
  await gone(impostor);
  for (const d of [impostorRoot, recordings]) scrub(d);
});

const fire = (event, payload) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(root, 'scripts', 'hook.mjs'), event, 'stale-test'], {
    // The replacement server is spawned by the launcher and inherits this, so
    // the held-request test does not have to sit through a real two minutes.
    env: { ...process.env, NEARLY_PORT: String(PORT), NEARLY_RECORDINGS: recordings,
      NEARLY_REPOS: join(recordings, 'repos.json'), NEARLY_ASK_TIMEOUT_MS: '2000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ out: out.trim(), code }));
  p.stdin.end(JSON.stringify(payload));
});

test('a server says which build it is and where it lives', async () => {
  const h = await health();
  assert.equal(h.version, '0.0.1-impostor');
  assert.ok(h.root && h.root !== root, 'a server that cannot be placed cannot be replaced');
});

test('a hook replaces a server from somewhere else rather than talking to it', async () => {
  const sid = `stale-${Date.now()}`;
  await fire('pre-tool', { session_id: sid, cwd: root, tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, tool_use_id: 's1' });
  assert.ok(await waitFor(async () => {
    const h = await health();
    return h && h.root === root;
  }), 'the old build still holds the port, so every upgrade stays invisible');
});

test('and the replacement actually answers', async () => {
  const r = await fire('pre-tool', {
    session_id: `stale2-${Date.now()}`, cwd: root,
    tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 's2',
  });
  assert.match(r.out, /deny/, 'the new server is up but not gating');
});

test('a server is never taken away from someone mid-decision', async () => {
  // Hold a request, then ask that server to stand down. It must refuse: the
  // person deciding would otherwise be handed back to the agent's own prompt.
  const sid = `held-${Date.now()}`;
  const held = fetch(`${BASE}/hooks/pre-tool?attach=held`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sid, cwd: root, tool_name: 'Bash', tool_input: { command: 'held-probe' }, tool_use_id: 'h1' }),
  }).catch(() => null);

  assert.ok(await waitFor(async () => (await health())?.sessions > 0), 'the held session never registered');
  await new Promise((r) => setTimeout(r, 300));

  const r = await fetch(`${BASE}/exit`, { method: 'POST' });
  assert.equal(r.status, 409, 'it agreed to exit while a human was still deciding');
  assert.ok((await r.json()).waiting >= 1);
  assert.ok((await health())?.ok, 'it exited anyway');
  await held;
});

// The case almost everybody is actually in: a server from a build that has no
// /exit, because that is what is already installed. Telling them to run taskkill
// fixes it for whoever reads the message. It has to happen on its own.
//
// The stand-in answers /health and /state exactly as 0.1.7 did, and runs as its
// own process — which is the only way this means anything, because finding the
// process holding a port is most of what is being tested, and reclaim refuses
// to signal itself.
const OLD_SERVER = `
import http from 'node:http';
const [, , port, sessions] = process.argv;
const n = Number(sessions || 0);
http.createServer((q, s) => {
  const j = (o) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
  if (q.url === '/health') return j({ ok: true, sessions: n });
  if (q.url === '/state') return j({
    sessions: n ? [{ id: 'x', pending: [{ id: 'p1' }] }] : [],
    rules: {}, defaults: { Bash: 'ask', Read: 'log' }, askTimeoutMs: 120000,
  });
  s.writeHead(404).end();                      // no /exit, like every build before 0.1.8
}).listen(Number(port), '127.0.0.1', () => console.log('up'));
`;

async function oldServer(port, { sessions = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-old-'));
  const file = join(dir, 'old-server.mjs');
  writeFileSync(file, OLD_SERVER);
  const proc = spawn(process.execPath, [file, String(port), String(sessions)], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => proc.stdout.once('data', r));
  return { proc, dir, stop: () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } scrub(dir); } };
}

test('an idle server too old to be asked is closed anyway', async () => {
  const port = 49400 + Math.floor(Math.random() * 90);
  const old = await oldServer(port);
  try {
    const { reclaim, identify } = await import('../server/reclaim.mjs');
    const base = `http://127.0.0.1:${port}`;
    assert.ok(await identify(base), 'the stand-in did not answer like a Nearly server');

    const r = await reclaim({ port, base, root });
    assert.equal(r.outcome, 'ended', 'an old build that cannot be asked must still go');
    assert.equal(await identify(base), null, 'it is still answering');
    assert.ok(await waitFor(() => old.proc.exitCode !== null || old.proc.signalCode !== null),
      'the process outlived the port');
  } finally { old.stop(); }
});

test('a server in use is never closed, however old it is', async () => {
  // Someone is mid-decision behind it. Ending that server hands their held
  // request back to the agent's own prompt, which is the whole thing this
  // project exists to prevent — and no amount of staleness is worth it.
  const port = 49500 + Math.floor(Math.random() * 90);
  const old = await oldServer(port, { sessions: 1 });
  let killed = false;
  try {
    const { reclaim } = await import('../server/reclaim.mjs');
    const r = await reclaim({
      port, base: `http://127.0.0.1:${port}`, root, kill: () => { killed = true; },
    });
    assert.equal(r.outcome, 'busy');
    assert.equal(killed, false, 'it interrupted somebody');
    assert.equal(old.proc.exitCode, null, 'it ended a server someone was using');
  } finally { old.stop(); }
});

test('something that is not ours on the port is never touched', async () => {
  // The rule that makes killing by port defensible: two independent answers
  // only this server gives. A plain web server on 47653 must be left alone.
  const { createServer } = await import('node:http');
  const port = 49600 + Math.floor(Math.random() * 90);
  const stranger = createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ ok: true, sessions: 3 }));      // /health-shaped by luck
  });
  await new Promise((r) => stranger.listen(port, '127.0.0.1', r));
  let killed = false;
  try {
    const { reclaim, identify } = await import('../server/reclaim.mjs');
    assert.equal(await identify(`http://127.0.0.1:${port}`), null,
      'a lookalike /health was taken as proof on its own');
    const r = await reclaim({ port, base: `http://127.0.0.1:${port}`, root, kill: () => { killed = true; } });
    assert.equal(r.outcome, 'free');
    assert.equal(killed, false, 'it killed a process that was not ours');
  } finally { stranger.closeAllConnections?.(); await new Promise((r) => stranger.close(r)); }
});
