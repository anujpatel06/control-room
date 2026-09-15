// What attach decides to turn on, and what it refuses to assume.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, choose } from '../scripts/detect.mjs';

function repoWith(...files) {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-detect-'));
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '{}');
  }
  return dir;
}
const run = (fn) => { const d = repoWith(...[]); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('a repo configured for Cursor gets the Cursor gate', () => {
  const dir = repoWith('.cursor/hooks.json');
  try {
    assert.ok(detect(dir).some((a) => a.id === 'cursor'));
    assert.ok(choose(dir).chosen.some((a) => a.id === 'cursor'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('several harnesses in one repo all get gated', () => {
  const dir = repoWith('.cursor/hooks.json', '.agents/hooks.json', '.windsurf/hooks.json');
  try {
    const ids = choose(dir).chosen.map((a) => a.id);
    for (const id of ['cursor', 'antigravity', 'windsurf']) assert.ok(ids.includes(id), `${id} missing`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude Code is always on, even in a repo with no sign of it', () => {
  run((dir) => assert.ok(choose(dir).chosen.some((a) => a.id === 'claude-code')));
});

test('a repo with no sign of another agent gets only Claude Code', () => {
  // Writing hook files into someone's project because they happen to have a CLI
  // installed would be presumptuous, and would leave configs they never asked
  // for in their diff.
  run((dir) => assert.deepEqual(choose(dir).chosen.map((a) => a.id), ['claude-code']));
});

test('--agent= picks exactly what was asked for, and nothing else', () => {
  run((dir) => {
    const { chosen } = choose(dir, ['--agent=gemini,codex']);
    assert.deepEqual(chosen.map((a) => a.id).sort(), ['codex', 'gemini']);
  });
});

test('--agent=all means all of them', () => {
  run((dir) => assert.equal(choose(dir, ['--agent=all']).chosen.length, 7));
});

test('a misspelled agent is reported rather than silently skipped', () => {
  run((dir) => {
    const { unknown } = choose(dir, ['--agent=curser']);
    assert.deepEqual(unknown, ['curser'], 'a typo must not quietly gate nothing');
  });
});
