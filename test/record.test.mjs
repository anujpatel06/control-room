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
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
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
    env: { ...process.env, CONTROL_ROOM_RECORDINGS: fixtures, CONTROL_ROOM_OUT: out, CONTROL_ROOM_STORY: story },
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
    env: { ...process.env, CONTROL_ROOM_RECORDINGS: fixtures, CONTROL_ROOM_OUT: out, CONTROL_ROOM_STORY: story },
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
