// The failure paths. These are the ones that decide whether a tool survives
// contact with a real team, because each of them fails silently: nothing errors,
// people just quietly stop being recorded, or lose a session and uninstall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// attach remembers the repos it is turned on for, so the dashboard can offer
// them. A test run must not add a dozen temporary directories to that list.
const sandboxed = () => ({ ...process.env, NEARLY_REPOS: join(tmpdir(), `nearly-test-repos-${process.pid}.json`) });
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
  // A loaded CI runner can take well over four seconds to get a node process
  // listening, and this test read a single un-retried fetch as proof the winner
  // had died. It failed on one runner out of six while passing locally every
  // time, which is a test being fragile rather than anything being wrong.
  const health = async () => {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); return r.ok ? await r.json() : null; }
    catch { return null; }
  };
  const settle = async (want, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      const h = await health();
      if (want ? h : !h) return h;
      await new Promise((r) => setTimeout(r, 100));
    }
    return want ? null : true;
  };

  assert.ok(await settle(true), 'the first server never started, so there was no race to lose');
  const second = spawnSync(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NEARLY_PORT: String(port) },
  });
  assert.equal(second.status, 0, 'losing the race is not an error');
  const still = await settle(true);
  assert.ok(still?.ok, 'the winner stopped serving');
  first.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
});

test('turning it on twice does not install anything twice', () => {
  const repo = tempRepo();
  try {
    const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env: sandboxed() });
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
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env: sandboxed() });
    assert.ok(existsSync(join(repo, '.git', 'hooks', 'pre-push')));
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo, '--off'], { encoding: 'utf8', env: sandboxed() });
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

    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env: sandboxed() });
    const on = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(on.permissions, mine.permissions, 'unrelated settings survive');
    assert.ok(on.hooks.Stop.some((m) => m.hooks.some((h) => h.command === 'echo theirs')), 'their hook survives');

    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo, '--off'], { encoding: 'utf8', env: sandboxed() });
    const off = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(off.permissions, mine.permissions);
    assert.ok(off.hooks.Stop.some((m) => m.hooks.some((h) => h.command === 'echo theirs')),
      'turning ours off must not remove theirs');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('it will not attach to something that is not a repository', () => {
  const d = mkdtempSync(join(tmpdir(), 'cr-notrepo-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), d], { encoding: 'utf8', env: sandboxed() });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a git repository/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the push hook never blocks a push, whatever happens', () => {
  const repo = tempRepo();
  try {
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env: sandboxed() });
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
    spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], { encoding: 'utf8', env: sandboxed() });
    const cmd = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'))
      .hooks.PreToolUse[0].hooks[0].command;

    // Whichever form it took, it must not be frozen to a path inside a cache
    // that npm clears, which would break rather than merely go stale.
    assert.doesNotMatch(cmd, /_npx|node_modules\/\.cache/, 'must not point into a disposable cache');
    assert.match(cmd, /nearly hook pre-tool|nearly-cli@\d|hook\.mjs" pre-tool/,
      `unrecognised hook command: ${cmd}`);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('the updater never delays an agent and never fails a command', async () => {
  const mod = join(root, 'scripts', 'update-check.mjs');

  // A hook must never carry a registry lookup or a package install.
  const hookSrc = readFileSync(join(root, 'scripts', 'hook.mjs'), 'utf8');
  assert.doesNotMatch(hookSrc, /update-check|registry\.npmjs|npm.*install/,
    'nothing may sit in front of an action an agent is waiting on');

  // A dead network must not break the command it was attached to.
  const offline = spawnSync(process.execPath, ['--input-type=module', '-e', `
    global.fetch = () => Promise.reject(new Error('offline'));
    const m = await import(${JSON.stringify(pathToFileURL(mod).href)});
    m.applyUpdate(await m.checkForUpdate());
    console.log('survived');
  `.trim()], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /survived/);

  // Turned off means off.
  const off = spawnSync(process.execPath, ['--input-type=module', '-e', `
    global.fetch = () => { throw new Error('should not have been called'); };
    const m = await import(${JSON.stringify(pathToFileURL(mod).href)});
    console.log(JSON.stringify(await m.checkForUpdate()));
  `.trim()], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NEARLY_NO_UPDATE: '1' } });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /null/);
});

test('a major version is announced, never installed behind your back', async () => {
  // Same major, same promises. A gate whose rules may have changed is read
  // before it is trusted, so the install is left to the person.
  const mod = join(root, 'scripts', 'update-check.mjs');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(mod).href)});
    m.applyUpdate({ name: 'nearly-cli', from: '0.9.0', to: '1.0.0', major: true, kind: 'global' });
  `.trim()], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /major version/i, 'it has to say why it stopped');
  assert.match(r.stdout, /npm install -g/, 'and hand over the command');
  assert.doesNotMatch(r.stdout, /Updating Nearly/, 'and must not have run it');
});

test('a failed update says so rather than leaving you to assume', async () => {
  // A global directory this user cannot write to is the common case. Believing
  // you are current when you are not is worse than knowing you are behind.
  const mod = join(root, 'scripts', 'update-check.mjs');
  const fakeBin = mkdtempSync(join(tmpdir(), 'cr-bin-'));
  writeFileSync(join(fakeBin, 'npm'), '#!/bin/sh\nexit 1\n');
  spawnSync('chmod', ['+x', join(fakeBin, 'npm')]);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(mod).href)});
    m.applyUpdate({ name: 'nearly-cli', from: '0.1.0', to: '0.1.1', major: false, kind: 'global' });
  `.trim()], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, 'a failed update must not fail the command');
  assert.match(r.stdout, /could not/i);
  assert.match(r.stdout, /npm install -g/, 'and tells you how to do it yourself');
  rmSync(fakeBin, { recursive: true, force: true });
});

test('an active user actually meets the updater', () => {
  // Turning it on for a repo happens once, and hooks are excluded by design, so
  // if the push path did not carry the check a working user would never hear
  // about a fix no matter how many they were behind.
  const push = readFileSync(join(root, 'scripts', 'push-record.mjs'), 'utf8');
  assert.match(push, /update-check/, 'the push path is where a working user is reachable');

  // And it still must not be able to fail a push.
  assert.match(push, /catch \{[^}]*never worth failing a push/i);
});

test('an upgrade cannot destroy what was recorded', async () => {
  // npm replaces the package directory wholesale on every install, so anything
  // written there is gone after the next upgrade. Recordings are the one thing
  // here that cannot be regenerated: every record, count and refusal is derived
  // from them.
  const mod = join(root, 'server', 'paths.mjs');

  // Installed: everything lands in the user's own directory.
  const installed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(mod).href)});
    console.log(JSON.stringify({ root: m.dataRoot, rec: m.paths.recordings(), fromCheckout: m.fromCheckout }));
  `.trim()], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, NEARLY_HOME: join(tmpdir(), 'nearly-home-test'), NEARLY_RECORDINGS: '', NEARLY_STORY: '', NEARLY_OUT: '' },
  });
  assert.equal(installed.status, 0, installed.stderr);
  const got = JSON.parse(installed.stdout);
  if (!got.fromCheckout) {
    assert.doesNotMatch(got.rec, /node_modules/, 'never inside a directory npm replaces');
  }

  // Whichever it is, no path may sit inside node_modules.
  assert.doesNotMatch(got.rec, /node_modules/);
});

test('a hook is never written to call a command that will not exist', async () => {
  // npx puts its own bin first on PATH for the life of the process. Trusting it
  // meant writing `nearly hook ...` into a repo during an npx run, and that
  // command ceased to exist the moment npx exited: every tool call then failed
  // its hook, which means no gate at all, reported as success.
  const repo = tempRepo();
  const fakeNpx = mkdtempSync(join(tmpdir(), 'cr-_npx-'));
  const npxBin = join(fakeNpx, '_npx', 'abc123');
  mkdirSync(npxBin, { recursive: true });
  writeFileSync(join(npxBin, 'nearly'), '#!/bin/sh\necho "/pretend/pkg"\n');
  spawnSync('chmod', ['+x', join(npxBin, 'nearly')]);

  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], {
      encoding: 'utf8',
      // Only the disappearing shim and the system basics. A real `nearly`
      // installed on the machine running the tests would otherwise be found and
      // correctly trusted, hiding what this is checking.
      env: { ...sandboxed(), PATH: `${npxBin}:/usr/bin:/bin`, NEARLY_NO_INSTALL: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    const cmd = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'))
      .hooks.PreToolUse[0].hooks[0].command;
    assert.doesNotMatch(cmd, /^nearly hook/,
      `wrote a bare command that only exists while npx runs: ${cmd}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fakeNpx, { recursive: true, force: true });
  }
});

test('the first repo on a machine is remembered, with no data directory yet', () => {
  // The cold-install bug: ~/.nearly does not exist the first time anyone runs
  // this, so writing the list failed with ENOENT into a bare catch. Every
  // machine that had ever run Nearly before passed; a brand new one did not,
  // which is the only kind of machine a new user has.
  const repo = tempRepo();
  const home = mkdtempSync(join(tmpdir(), 'nearly-fresh-'));
  const list = join(home, 'never', 'made', 'repos.json');
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo],
      { encoding: 'utf8', env: { ...process.env, NEARLY_REPOS: list } });
    assert.equal(r.status, 0);
    assert.ok(existsSync(list), 'the repo list was never created');
    assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), [repo]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('turning it off forgets the repo again', () => {
  const repo = tempRepo();
  const home = mkdtempSync(join(tmpdir(), 'nearly-fresh-'));
  const list = join(home, 'repos.json');
  const run = (...extra) => spawnSync(process.execPath,
    [join(root, 'scripts', 'attach.mjs'), repo, ...extra],
    { encoding: 'utf8', env: { ...process.env, NEARLY_REPOS: list } });
  try {
    run();
    assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), [repo]);
    run('--off');
    assert.deepEqual(JSON.parse(readFileSync(list, 'utf8')), [], 'a repo turned off is still offered');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('where records publish survives an upgrade', () => {
  // This lived in the package directory, which `npm install -g` replaces
  // wholesale, so the address was lost on every upgrade and the next record
  // went out with no link to it.
  const repo = tempRepo();
  const home = mkdtempSync(join(tmpdir(), 'nearly-cfg-'));
  const cfg = join(home, 'not', 'made', 'yet', 'config.json');
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'attach.mjs'), repo], {
      encoding: 'utf8',
      env: { ...sandboxed(), NEARLY_CONFIG: cfg, NEARLY_URL_BASE: 'https://example.test/records' },
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).urlBase, 'https://example.test/records');
    assert.equal(existsSync(join(root, '.nearly.json')), false,
      'still writing into the package, where the next upgrade deletes it');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('an update found during a push never makes the push wait', async () => {
  // It used to install in the foreground, holding git push for up to two
  // minutes. The first version of the fix also forgot to import spawn — which
  // node --check cannot see, and a try/catch swallowed — so background updates
  // would silently never have happened. This runs the real path.
  //
  // applyUpdate catches its own errors, so "did not throw" proves nothing. The
  // notice is only printed after spawn succeeds; its absence is the failure.
  const { applyUpdate } = await import('../scripts/update-check.mjs');
  const said = [];
  const log = console.log;
  console.log = (...a) => said.push(a.join(' '));
  const started = Date.now();
  try {
    applyUpdate({ name: 'nearly-cli-probe-does-not-exist', from: '0.1.0', to: '9.9.9', kind: 'global', major: false },
      { background: true });
  } finally { console.log = log; }
  assert.ok(Date.now() - started < 1000, 'the push waited on the install');
  assert.ok(said.some((l) => /updating in the background/.test(l)),
    'the background install never started — the spawn failed and was swallowed');
});
