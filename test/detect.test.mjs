// The claim this file defends: Nearly never lets someone believe they are gated
// when they are not. If another agent drives this repo, attach must say so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, report } from '../scripts/detect.mjs';

const plain = { dim: (s) => s, bold: (s) => s };

function repoWith(...files) {
  const dir = mkdtempSync(join(tmpdir(), 'nearly-detect-'));
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '{}');
  }
  return dir;
}

test('an agent Nearly cannot gate is named out loud', () => {
  const dir = repoWith('.cursor/hooks.json');
  try {
    const out = report(dir, plain);
    assert.match(out, /Cursor/);
    assert.match(out, /not gated/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('several ungated agents are all named, not just the first', () => {
  const dir = repoWith('.cursor/hooks.json', '.agents/hooks.json', '.windsurf/hooks.json');
  try {
    const out = report(dir, plain);
    for (const name of ['Cursor', 'Antigravity', 'Windsurf']) assert.match(out, new RegExp(name));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a repo Nearly fully covers gets no warning at all', () => {
  const dir = repoWith('CLAUDE.md');
  try {
    assert.equal(report(dir, plain), null, 'a covered repo must stay quiet');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Claude Code is the one agent reported as supported', () => {
  const dir = repoWith('CLAUDE.md', '.cursor/hooks.json');
  try {
    const found = detect(dir);
    const cc = found.find((a) => a.id === 'claude-code');
    assert.ok(cc && cc.supported, 'Claude Code is supported');
    assert.equal(found.find((a) => a.id === 'cursor').supported, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detection reads this repo, not the machine', () => {
  const dir = repoWith('.agents/hooks.json');
  try {
    assert.equal(detect(dir).find((a) => a.id === 'antigravity').why, 'configured in this repo');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
