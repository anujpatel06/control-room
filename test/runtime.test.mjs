// Installing Nearly somewhere a hook can always reach it.
//
// Hooks run on every tool call, so they need a command that exists tomorrow and
// picks up fixes. A global install was supposed to be that, and it failed
// silently in three ways: on every up-to-date Windows machine (npm.cmd will not
// spawn without a shell), on a Mac whose Node owns a root prefix, and — found
// while fixing those — whenever it ran inside npx, because npx's own settings
// leak into a nested npm install. Each fell back to a pinned `npx -y
// nearly-cli@<version>` in every hook, which is slow and never upgrades. A
// Cursor user was stuck on the release breaking his editor because of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmError, cleanEnv } from '../scripts/runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the error shown is the cause, not a pointer to a log file', () => {
  // npm ends almost every failure with "A complete log of this run can be found
  // in …", and that line is what used to be shown as the reason.
  const stderr = [
    'npm error code EALLOWSCRIPTS',
    'npm error --allow-scripts is not allowed in project-scoped installs.',
    'npm error A complete log of this run can be found in: /x/debug.log',
  ].join('\n');
  const said = npmError({ stderr, status: 1 });
  assert.match(said, /EALLOWSCRIPTS/);
  assert.match(said, /allow-scripts is not allowed/);
  assert.doesNotMatch(said, /complete log/);
});

test('a nested install does not inherit the settings of whatever ran it', () => {
  const before = { ...process.env };
  process.env.npm_config_allow_scripts = 'something';
  process.env.npm_command = 'exec';
  process.env.NPM_CONFIG_YES = 'true';
  try {
    const env = cleanEnv();
    assert.equal(Object.keys(env).filter((k) => /^npm_/i.test(k)).length, 0, 'npm settings leaked into the child');
    assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path, 'stripped more than npm settings');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
  }
});

test('it installs into a folder the user owns, even from inside npm', { timeout: 240_000 }, () => {
  // Run under `npm test`, this already has npm_* variables in its environment —
  // the same condition as npx, which is what made the install fail. And on
  // Windows it is the only place npm.cmd is ever actually spawned.
  const home = mkdtempSync(join(tmpdir(), 'nearly-runtime-'));
  const packDir = mkdtempSync(join(tmpdir(), 'nearly-pack-'));
  try {
    const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const pack = spawnSync(NPM, ['pack', '--pack-destination', packDir, '--silent'],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', env: cleanEnv(), timeout: 120_000 });
    assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
    const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
    assert.ok(tgz, 'no tarball was produced');

    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(new URL('../scripts/runtime.mjs', import.meta.url).href)});
      const out = m.installRuntime('0.0.0');
      console.log(JSON.stringify({ ...out, entry: m.ENTRY, has: m.hasRuntime() }));
    `], {
      encoding: 'utf8', timeout: 200_000,
      env: { ...process.env, NEARLY_HOME: home, NEARLY_INSTALL_SPEC: join(packDir, tgz),
        npm_config_allow_scripts: 'something', npm_command: 'exec' },
    });
    const out = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}');
    assert.equal(out.ok, true, `install failed: ${out.error || r.stderr}`);
    assert.ok(out.has && existsSync(out.entry), 'reported success but there is nothing to run');
    assert.ok(out.entry.startsWith(home), `installed outside the user's own folder: ${out.entry}`);
  } finally {
    for (const d of [home, packDir]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
