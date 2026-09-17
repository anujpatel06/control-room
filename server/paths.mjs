// Where Nearly keeps what it records.
//
// Installed from npm, the package directory is replaced wholesale on every
// upgrade, so anything written there is destroyed by the next `npm install -g`.
// Recordings are the one thing in this project that cannot be regenerated:
// every record, every count, every refusal is derived from them. They belong in
// the user's own space.
//
// Run from a checkout, the checkout is the workspace, which is what a
// contributor expects and what the tests rely on.

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// A checkout has a .git directory; an installed package does not.
export const fromCheckout = existsSync(join(pkgRoot, '.git'));

export const dataRoot = fromCheckout
  ? pkgRoot
  : join(process.env.NEARLY_HOME || join(homedir(), '.nearly'));

// A file, with its directory guaranteed to exist — including when the path came
// from an environment variable, which is where this went wrong the first time:
// the default path was fixed and the override was left to fail on its own.
function dataFile(envVar, name) {
  const f = process.env[envVar] || join(dataRoot, name);
  try { mkdirSync(dirname(f), { recursive: true }); } catch { /* caller will report */ }
  return f;
}

export function dataDir(...parts) {
  const p = join(dataRoot, ...parts);
  try { mkdirSync(p, { recursive: true }); } catch { /* caller will report */ }
  return p;
}

export const paths = {
  recordings: () => process.env.NEARLY_RECORDINGS || dataDir('recordings'),
  records: () => process.env.NEARLY_STORY || dataDir('records'),
  pages: () => process.env.NEARLY_OUT || (fromCheckout ? join(pkgRoot, 'ui', 'records') : dataDir('pages', 'records')),
  docs: () => (fromCheckout ? join(pkgRoot, 'docs') : dataDir('pages')),
  // Worktrees for agents started from the dashboard. Same reasoning as
  // recordings: installed from npm this used to land inside the package — under
  // the npx cache, even — where git has no repository to branch from and an
  // upgrade deletes whatever survived.
  workspace: () => process.env.NEARLY_WORKSPACE || dataDir('workspace'),
  // The repos `nearly` has been turned on for. Kept so the dashboard knows what
  // you work in before any session has run in it — otherwise the only repos it
  // can offer are ones that are already going, which is no help when you are
  // trying to start the first one.
  repos: () => dataFile('NEARLY_REPOS', 'repos.json'),
  // Where records are published, so a pull-request comment can link them. This
  // lived in the package directory, which `npm install -g` replaces wholesale:
  // the address was quietly lost on every upgrade and the next record went out
  // with no link. Same lesson as recordings — anything a person configured
  // belongs in their space, not in ours.
  config: () => dataFile('NEARLY_CONFIG', 'config.json'),
  // Claude Code sessions opened outside a repo that have been gated in it, so the
  // hook can keep gating them without asking the server. See scripts/outside.mjs.
  outside: () => process.env.NEARLY_OUTSIDE || join(dataRoot, 'outside'),
};
