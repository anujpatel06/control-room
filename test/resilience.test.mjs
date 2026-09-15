// The failure paths. These are the ones that decide whether a tool survives
// contact with a real team, because each of them fails silently: nothing errors,
// people just quietly stop being recorded, or lose a session and uninstall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => 48000 + Math.floor(Math.random() * 900);

function tempRepo() {
  const d = mkdtempSync(join(tmpdir(), 'cr-repo-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
  spawnSync('git', ['config', 'user.email', 't@x'], { cwd: d });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: d });
  spawnSync('sh', ['-c', 'echo x > a.txt'], { cwd: d });
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['commit', '-qm', 'seed'], { cwd: d });
  return d;
}

test('a hook whose server cannot start stays silent and lets the session continue', async () => {
  // Claude Code treats any non-JSON or failing hook as a non-blocking error, so
  // the worst outcome here is losing the recording. Wedging somebody's session
  // would be far worse, and is what this guarantees cannot happen.
  const port = freePort();
  const blocker = createServer(() => {});           // holds the port, answers nothing
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'hook.mjs'), 'pre-tool', 'x'], {
      input: JSON.stringify({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }),
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NEARLY_PORT: String(port) },
    });
    assert.equal(r.status, 0, 'must exit 0 so Claude Code does not treat it as a failure');
    assert.equal(r.stdout.trim(), '', 'silence means "no opinion", which falls back to the normal prompt');
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('a hook starts the server when nothing is listening', async () => {
  const port = freePort();
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'hook.mjs'), 'session-start', 'coldstart'], {
    input: JSON.stringify({ session_id: 'cold-1', cwd: root }),
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NEARLY_PORT: String(port), NEARLY_RECORDINGS: mkdtempSync(join(tmpdir(), 'cr-rec-')) },
  });
  assert.equal(r.status, 0);
  const alive = await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.json()).catch(() => null);
  assert.ok(alive?.ok, 'the server should be up now, started by the hook');
  await fetch(`http://127.0.0.1:${port}/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'cold-1', hard: true }),
  }).catch(() => {});
  // -sTCP:LISTEN matters: without it lsof also matches this process's own client
  // socket to that port, and the cleanup kills the test runner.
  spawnSync('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN | xargs kill 2>/dev/null || true`]);
});

test('two servers racing for the port: the loser stands down quietly', async () => {
  // Hooks start the server on demand, so two tool calls arriving together is
  // ordinary. The loser crashing used to look like a bug in the agent.
  const port = freePort();
  const recs = mkdtempSync(join(tmpdir(), 'cr-rec-'));
  const first = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore', env: { ...process.env, NEARLY_PORT: String(port), NEARLY_RECORDINGS: recs },
  });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* waiting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const second = spawnSync(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NEARLY_PORT: String(port) },
  });
  assert.equal(second.status, 0, 'losing the race is not an error');
  const still = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.ok(still.ok, 'the winner keeps serving');
  first.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
});

test('turning it on twice does not install anything twice', () => {
  const repo = tempRepo();
  try {
    const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const once = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(run().status, 0);
    const twice = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(twice, once, 're-running must be a no-op, not a second copy');
    assert.equal(twice.hooks.PreToolUse.length, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('turning it off removes everything it put there', () => {
  const repo = tempRepo();
  try {
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8' });
    assert.ok(existsSync(join(repo, '.git', 'hooks', 'pre-push')));
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo, '--off'], { encoding: 'utf8' });
    const after = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(after.hooks, undefined, 'no hooks left behind');
    assert.equal(existsSync(join(repo, '.git', 'hooks', 'pre-push')), false, 'no push hook left behind');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('it leaves settings that were already there alone', () => {
  const repo = tempRepo();
  try {
    const f = join(repo, '.claude', 'settings.local.json');
    spawnSync('mkdir', ['-p', join(repo, '.claude')]);
    const mine = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } };
    spawnSync('sh', ['-c', `cat > ${JSON.stringify(f)}`], { input: JSON.stringify(mine) });

    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8' });
    const on = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(on.permissions, mine.permissions, 'unrelated settings survive');
    assert.ok(on.hooks.Stop.some((m) => m.hooks.some((h) => h.command === 'echo theirs')), 'their hook survives');

    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo, '--off'], { encoding: 'utf8' });
    const off = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(off.permissions, mine.permissions);
    assert.ok(off.hooks.Stop.some((m) => m.hooks.some((h) => h.command === 'echo theirs')),
      'turning ours off must not remove theirs');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('it will not attach to something that is not a repository', () => {
  const d = mkdtempSync(join(tmpdir(), 'cr-notrepo-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), d], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a git repository/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the push hook never blocks a push, whatever happens', () => {
  const repo = tempRepo();
  try {
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8' });
    const hook = readFileSync(join(repo, '.git', 'hooks', 'pre-push'), 'utf8');
    assert.match(hook, /\|\| true/, 'failures are swallowed');
    assert.match(hook, /exit 0\s*$/, 'and it always exits 0');

    // A branch with no sessions is the normal case for hand-written work.
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'push-record.mjs'), repo], {
      encoding: 'utf8', timeout: 60_000, input: '',
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr + r.stdout, /no agent sessions recorded/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('hooks resolve the command fresh, so upgrading reaches every repo', () => {
  // The alternative is pinning a version into every repo, which means a user who
  // upgrades keeps running the old code everywhere and has no way to know.
  const repo = tempRepo();
  try {
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8' });
    const cmd = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'))
      .hooks.PreToolUse[0].hooks[0].command;

    // Whichever form it took, it must not be frozen to a path inside a cache
    // that npm clears, which would break rather than merely go stale.
    assert.doesNotMatch(cmd, /_npx|node_modules\/\.cache/, 'must not point into a disposable cache');
    assert.match(cmd, /nearly hook pre-tool|nearly-cli@\d|hook\.mjs" pre-tool/,
      `unrecognised hook command: ${cmd}`);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
