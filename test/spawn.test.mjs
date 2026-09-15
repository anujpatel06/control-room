// Starting an agent from the dashboard.
//
// This is the path that broke on a stranger's Windows machine: the worktree was
// created inside the package — inside the npx cache, even — and branched from a
// hardcoded `main`. Both assumptions hold in a checkout and neither holds after
// `npx nearly-cli`, so the button could only ever fail there, and it failed with
// "fatal: invalid reference: main", which explains nothing to anybody.
//
// What these hold: that the repo is a real one the person chose, that the branch
// starts from where they actually are, that nothing is written into the package,
// and that every way this can go wrong says so in a sentence you can act on.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 49000 + Math.floor(Math.random() * 90);   // clear of resilience.test.mjs, which roams 48000-48899
const BASE = `http://127.0.0.1:${PORT}`;
let server, recordings, workspace;

const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A repo deliberately not on `main`, because that is the case the old code got
// wrong and no fixture called `main` would have caught it.
function repoOnBranch(branch) {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-spawn-'));
  git(dir, ['init', '-q', '-b', branch]);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-qm', 'init']);
  return dir;
}

before(async () => {
  recordings = mkdtempSync(join(tmpdir(), 'nearly-spawn-rec-'));
  workspace = mkdtempSync(join(tmpdir(), 'nearly-spawn-ws-'));
  server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, NEARLY_PORT: String(PORT), NEARLY_RECORDINGS: recordings,
      NEARLY_WORKSPACE: workspace,
      NEARLY_REPOS: join(workspace, 'repos.json'),
      // Everything up to and including the worktree is exercised; the agent
      // itself is not started, so the suite never runs a real one.
      NEARLY_AGENT_CMD: 'nearly-test-no-such-agent' },
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGTERM');
  for (const d of [recordings, workspace]) rmSync(d, { recursive: true, force: true });
});

test('with nothing attached, it says what to do instead of failing at git', async () => {
  const r = await post('/sessions', { name: 'a', prompt: 'do a thing' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No repo to start from/);
  assert.doesNotMatch(r.body.error, /invalid reference/, 'a git error is not an explanation');
});

test('a path that is not a repository is named as such', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-notrepo-'));
  try {
    const r = await post('/sessions', { name: 'b', prompt: 'x', repo: dir });
    assert.match(r.body.error, /not a git repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a repo with no commits is told what it needs, not shown a git error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-empty-'));
  try {
    git(dir, ['init', '-q']);
    const r = await post('/sessions', { name: 'c', prompt: 'x', repo: dir });
    assert.match(r.body.error, /no commits yet/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a repo on master branches from HEAD, not from a branch named main', async () => {
  const repo = repoOnBranch('master');
  try {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const r = await post('/sessions', { name: 'work', prompt: 'x', repo });
    assert.equal(r.status, 200, `start failed: ${JSON.stringify(r.body)}`);
    assert.match(r.body.branch, /^nearly\//, 'the branch carries the current name of the project');

    const wt = r.body.worktree;
    assert.ok(existsSync(wt), 'the worktree was not created');
    assert.equal(git(wt, ['rev-parse', 'HEAD']), head, 'the branch did not start where the person is');

    // The bug that sent this to a stranger: written inside the package, which on
    // that machine was the npx cache.
    assert.ok(wt.startsWith(workspace), `worktree escaped into ${wt}`);
    assert.ok(!wt.startsWith(root), 'a worktree inside the package is deleted by the next upgrade');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a repo given as a relative-looking path is still resolved', async () => {
  const repo = repoOnBranch('trunk');
  try {
    const r = await post('/sessions', { name: 'rel', prompt: 'x', repo: join(repo, '.', '') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
