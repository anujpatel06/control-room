// The record's central claim is that every figure on it was computed from the
// session recording rather than written afterwards. These tests hold it to that
// by rebuilding the committed demo recordings and checking the output against
// what those files actually contain.
//
// They run against recordings/demo, which ships with the repo, so they work on a
// fresh clone with no agent, no network and no Claude subscription.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'recordings', 'demo');
let out, story;

// What the recordings actually say, read independently of the builder.
function truth() {
  const runs = readdirSync(fixtures).filter((f) => f.endsWith('.jsonl')).map((f) => ({
    file: f,
    events: readFileSync(join(fixtures, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  }));
  runs.sort((a, b) => a.events[0].at - b.events[0].at);
  const all = runs.flatMap((r) => r.events);
  const decisions = all.filter((e) => e.type === 'decision');
  return {
    runs,
    all,
    branch: runs[0].events.find((e) => e.type === 'session' && e.subtype === 'created').branch,
    repo: runs[0].events.find((e) => e.type === 'session' && e.subtype === 'created').worktree,
    denied: decisions.filter((d) => d.decision === 'deny'),
    byHuman: decisions.filter((d) => d.waitedMs != null),
    prompts: all.filter((e) => e.type === 'prompt'),
  };
}

function build(extra = []) {
  const t = truth();
  const r = spawnSync(process.execPath, [
    join(root, 'scripts', 'build-recap.mjs'),
    '--branch', t.branch, '--repo', t.repo, '--no-audio', ...extra,
  ], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NEARLY_RECORDINGS: fixtures, NEARLY_OUT: out, NEARLY_STORY: story },
  });
  assert.equal(r.status, 0, `build failed: ${r.stderr}`);
  const f = readdirSync(story).find((x) => x.endsWith('.json'));
  return { sb: JSON.parse(readFileSync(join(story, f), 'utf8')), slug: f.replace(/\.json$/, ''), stdout: r.stdout };
}

before(() => {
  out = mkdtempSync(join(tmpdir(), 'cr-out-'));
  story = mkdtempSync(join(tmpdir(), 'cr-story-'));
});
after(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(story, { recursive: true, force: true });
});

test('the fixtures are there, so these tests mean something', () => {
  const t = truth();
  assert.ok(t.runs.length >= 2, 'expected at least two recorded sessions');
  assert.ok(t.denied.length >= 1, 'expected at least one refusal to report on');
});

test('every refusal in the recording reaches the record, and nothing else does', () => {
  const t = truth();
  const { sb } = build();
  const outcome = sb.scenes.find((s) => s.kind === 'outcome');
  assert.equal(outcome.notDone.length, t.denied.length,
    'the count of refused actions must match the recording exactly');

  // And each one is attributed to whoever actually refused it.
  const byPolicy = t.denied.filter((d) => d.tier === 'never').length;
  assert.equal(outcome.notDone.filter((n) => n.by === 'policy').length, byPolicy,
    'policy blocks must not be credited to the human');
});

test('the headline counts are the recording, not a summary of it', () => {
  const t = truth();
  const { sb } = build();
  const stats = Object.fromEntries(sb.scenes.find((s) => s.kind === 'cover').stats.map(([k, v]) => [k, v]));
  assert.equal(stats.Refused, String(t.denied.length));
  assert.equal(Object.entries(stats).find(([k]) => k.startsWith('Asked'))[1], String(t.byHuman.length));
});

test('every instruction given appears, in the order it was given', () => {
  const t = truth();
  const { sb } = build();
  const intents = sb.scenes.filter((s) => s.kind === 'intent');
  assert.equal(intents.length, t.prompts.length, 'one scene per instruction');
  intents.forEach((scene, i) => {
    assert.equal(scene.text, t.prompts[i].text, `instruction ${i + 1} must be verbatim`);
  });
});

test('a branch record merges its sessions oldest first', () => {
  const t = truth();
  const { sb } = build();
  assert.equal(sb.kind, 'branch');
  assert.equal(sb.runs, t.runs.length);
  assert.equal(sb.branch, t.branch);
});

test('the reviewer is never addressed as if they were in the room', () => {
  const { sb } = build();
  const spoken = sb.scenes.map((s) => s.narration).join(' ');
  assert.doesNotMatch(spoken, /\bYou (allowed|said no|undid|refused)\b/,
    'the reviewer did not make these decisions; the supervisor must be named');
  assert.match(spoken, new RegExp(`\\b${sb.supervisor}\\b`), 'the supervisor is named');
});

test('the supervisor still gets the second person when the record is for them', () => {
  const { sb } = build(['--audience', 'supervisor']);
  const spoken = sb.scenes.map((s) => s.narration).join(' ');
  assert.match(spoken, /\byou\b/i);
});

test('the page is self-contained and carries nothing from the machine that built it', () => {
  const { slug } = build();
  const html = readFileSync(join(out, `${slug}.html`), 'utf8');
  assert.doesNotMatch(html, /127\.0\.0\.1|localhost/, 'must work with no server');
  assert.doesNotMatch(html, /\/Users\/|\/home\/[a-z]/, 'must not leak a home directory');
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const u of external) {
    assert.match(u, /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com|[a-z0-9-]+\.github\.io)/,
      `unexpected external dependency: ${u}`);
  }
});

test('it refuses to invent a record for a branch with no sessions', () => {
  const r = spawnSync(process.execPath, [
    join(root, 'scripts', 'build-recap.mjs'), '--branch', 'no-such-branch', '--repo', root, '--no-audio',
  ], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NEARLY_RECORDINGS: fixtures, NEARLY_OUT: out, NEARLY_STORY: story },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no recordings on branch/);
});

test('it says whether a model touched the words', () => {
  const { sb, slug } = build();
  assert.equal(sb.polished, undefined, 'no model ran, so nothing should claim one did');
  const html = readFileSync(join(out, `${slug}.html`), 'utf8');
  assert.ok(existsSync(join(out, `${slug}.html`)));
  assert.match(html, /computed|not written by a model|No model wrote/i);
});

test('the auto-built record reports a link, not a null', async () => {
  // The server scrapes the builder's own output for the path it just wrote.
  // A rename once broke that silently: the record was built, the link was null,
  // and the only symptom was a dead entry in the log.
  const { spawn } = await import('node:child_process');
  const port = 47900 + Math.floor(Math.random() * 90);
  const recs = mkdtempSync(join(tmpdir(), 'cr-live-'));
  const srv = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, NEARLY_PORT: String(port), NEARLY_RECORDINGS: recs, NEARLY_OUT: out, NEARLY_STORY: story },
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* waiting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const sid = '99999999-1111-4222-8333-999999999999';
    const send = (ev, body) => fetch(`http://127.0.0.1:${port}/hooks/${ev}?attach=linktest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await send('prompt', { session_id: sid, cwd: root, prompt: 'do a thing' });
    await send('stop', { session_id: sid, cwd: root, last_assistant_message: 'did the thing' });
    await send('session-end', { session_id: sid, cwd: root, reason: 'other' });

    let href = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const line = readFileSync(join(recs, `${sid}.jsonl`), 'utf8').split('\n')
        .filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'recap');
      if (line) { href = line.href; break; }
    }
    assert.ok(href, 'a record event was never written');
    assert.match(href, /^\/records\/.+\.html$/, `the link must be usable, got ${href}`);
  } finally {
    srv.kill('SIGTERM');
    rmSync(recs, { recursive: true, force: true });
  }
});

test('a repo reached by a symlinked path is still found', async () => {
  // /tmp and /var are symlinks to /private/... on macOS, so the path recorded
  // by the hook and the path passed on the command line spell the same
  // directory differently. String comparison quietly matched nothing.
  const { mkdirSync, symlinkSync, writeFileSync } = await import('node:fs');
  const real = mkdtempSync(join(tmpdir(), 'cr-real-'));
  const recs = mkdtempSync(join(tmpdir(), 'cr-symrec-'));
  const link = join(mkdtempSync(join(tmpdir(), 'cr-link-')), 'via-link');
  symlinkSync(real, link);

  const now = Date.now();
  const sid = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
  const lines = [
    { type: 'session', subtype: 'created', name: 'symtest', branch: 'feat/sym', worktree: real, attached: true, session: sid, at: now },
    { type: 'prompt', text: 'do a thing', session: sid, at: now + 1 },
    { type: 'decision', id: 'x', decision: 'deny', why: 'human deny (once)', scope: 'once', tool: 'Bash', key: 'Bash:rm', waitedMs: 900, input: { command: 'rm x' }, session: sid, at: now + 2 },
    { type: 'session', subtype: 'exited', session: sid, at: now + 3 },
  ];
  writeFileSync(join(recs, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const r = spawnSync(process.execPath, [
    join(root, 'scripts', 'build-recap.mjs'), '--branch', 'feat/sym', '--repo', link, '--no-audio',
  ], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NEARLY_RECORDINGS: recs, NEARLY_OUT: out, NEARLY_STORY: story },
  });
  assert.equal(r.status, 0, `the same directory by another name must still match: ${r.stderr}`);
  assert.match(r.stdout, /1 session/);
});

test('a truncated recording is declared, not papered over', async () => {
  // Recordings are appended to as a session runs, so a crash or a full disk
  // leaves a half-written last line. Dropping it silently would let the page
  // report one refusal when three more were never written down, and a record
  // that overstates its own completeness is worse than no record at all.
  const { writeFileSync, readFileSync: rf } = await import('node:fs');
  const recs = mkdtempSync(join(tmpdir(), 'cr-trunc-'));
  const repo = mkdtempSync(join(tmpdir(), 'cr-trunc-repo-'));
  const sid = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
  const now = Date.now();
  const good = [
    { type: 'session', subtype: 'created', name: 't', branch: 'feat/trunc', worktree: repo, attached: true, session: sid, at: now },
    { type: 'prompt', text: 'go', session: sid, at: now + 1 },
    { type: 'decision', id: 'd1', decision: 'deny', why: 'human deny (once)', scope: 'once', tool: 'Bash', key: 'Bash:rm', waitedMs: 500, input: { command: 'rm a' }, session: sid, at: now + 2 },
  ].map((l) => JSON.stringify(l)).join('\n');
  writeFileSync(join(recs, `${sid}.jsonl`), good + '\n{"type":"decision","id":"d2","deci');

  const r = spawnSync(process.execPath, [
    join(root, 'scripts', 'build-recap.mjs'), '--branch', 'feat/trunc', '--repo', repo, '--no-audio',
  ], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NEARLY_RECORDINGS: recs, NEARLY_OUT: out, NEARLY_STORY: story },
  });
  assert.equal(r.status, 0, 'a damaged recording should still produce what it can');
  assert.match(r.stderr, /unreadable line/i, 'and must say so on the way past');

  const sb = JSON.parse(rf(join(story, 'cr-trunc-repo-'.length ? readdirSync(story).find((f) => f.includes('feat-trunc')) : ''), 'utf8'));
  assert.equal(sb.dropped, 1, 'the count of unreadable lines is carried into the record');
  const html = rf(join(out, `${readdirSync(out).find((f) => f.includes('feat-trunc'))}`), 'utf8');
  assert.match(html, /could not be read/i, 'and the page tells the reviewer');
  assert.match(html, /floor, not a total/i);
});

// A record nobody can open is not a record.
//
// Records used to live inside the package and moved to the user's own directory
// when it turned out that upgrading deleted them. The route serving them kept
// pointing at the package, so from an npm install every record 404'd while
// sitting perfectly well on disk — and it worked from a checkout, which is the
// one place nobody would ever notice. Reported as "the record page 404s", and
// blamed at first on an unrelated stale server.
test('a built record can actually be fetched from the server', async () => {
  const { spawn } = await import('node:child_process');
  const port = 46500 + Math.floor(Math.random() * 90);
  const pages = mkdtempSync(join(tmpdir(), 'cr-pages-'));
  const recs = mkdtempSync(join(tmpdir(), 'cr-serve-'));
  writeFileSync(join(pages, 'demo.html'), '<title>a record</title>');

  const srv = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, NEARLY_PORT: String(port), NEARLY_RECORDINGS: recs,
      NEARLY_OUT: pages, NEARLY_REPOS: join(recs, 'repos.json') },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* waiting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = await fetch(`${base}/records/demo.html`);
    assert.equal(r.status, 200, 'the record is on disk but the server will not serve it');
    assert.match(await r.text(), /a record/);

    // The guard that makes serving a user-writable directory safe.
    const up = await fetch(`${base}/records/..%2f..%2fetc%2fpasswd`);
    assert.equal(up.status, 404, 'it served something outside the records directory');
  } finally {
    srv.kill('SIGTERM');
    for (const d of [pages, recs]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Everything in a record came from an agent. A command is text the agent chose,
// and it ends up inside the page a reviewer opens — which, published to GitHub
// Pages, is on a real origin. The page used `.replace(placeholder, string)`, so
// `$\`` in a command pasted the page's own <head> into the data, broke out of
// the script block and ran agent text as code. Reproduced before fixing: the
// tab retitled itself.
test('text from an agent cannot run as code in the record page', () => {
  const hostile = [
    'echo dollar-amp $& here',
    'echo backtick $` here',
    "echo quote $' here",
    'echo </script><script>document.title="PWNED"</script>',
    'echo <!--<script>',
    'echo <img src=x onerror=document.title="PWNED">',
    `echo ${String.fromCharCode(0x2028)}line${String.fromCharCode(0x2029)}sep`,
  ];
  const dir = mkdtempSync(join(tmpdir(), 'nearly-xss-'));
  const recs = join(dir, 'rec'), pages = join(dir, 'pages'), story = join(dir, 'story');
  for (const d of [recs, pages, story]) mkdirSync(d, { recursive: true });
  const sid = 'aaaaaaaa-1111-4222-8333-444444444444';
  let at = 1789000000000;
  const ev = (e) => JSON.stringify({ ...e, session: sid, at: at++ });
  const lines = [
    ev({ type: 'session', subtype: 'created', name: 'xss', branch: 'feat/x', worktree: dir, attached: true }),
    ev({ type: 'prompt', text: 'tidy up <b>now</b> $`' }),
    ...hostile.map((command, i) => ev({ type: 'decision', id: `t${i}`, decision: 'deny', why: 'never (test)', scope: 'policy', tool: 'Bash', input: { command }, tier: 'never' })),
    ev({ type: 'session', subtype: 'exited', reason: 'other' }),
  ];
  writeFileSync(join(recs, `${sid}.jsonl`), lines.join('\n') + '\n');

  const r = spawnSync(process.execPath, [join(root, 'scripts', 'build-recap.mjs'), sid, '--no-audio'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NEARLY_RECORDINGS: recs, NEARLY_OUT: pages, NEARLY_STORY: story },
  });
  try {
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);
    const file = readdirSync(pages).find((f) => f.endsWith('.html'));
    const html = readFileSync(join(pages, file), 'utf8');
    // \r?: git checks the template out with CRLF on Windows.
    const m = html.match(/const R = (.*);\r?\n/);
    assert.ok(m, 'no record data in the page');

    // Nothing an HTML parser could act on survives inside the script block.
    assert.doesNotMatch(m[1], /[<>]/, 'raw < or > inside the script block');
    // The data parses, and every command reads exactly as the agent wrote it.
    const R = JSON.parse(m[1]);
    const shown = JSON.stringify(R);
    for (const c of hostile) assert.ok(shown.includes(JSON.stringify(c).slice(1, -1)), `rewritten or lost: ${c}`);
    // One script block closes where the template closes it, not earlier.
    assert.equal((html.match(/<\/script>/g) || []).length, (readFileSync(join(root, 'ui', 'recap.template.html'), 'utf8').match(/<\/script>/g) || []).length,
      'an extra </script> means agent text escaped the block');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
