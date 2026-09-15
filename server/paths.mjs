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
  repos: () => process.env.NEARLY_REPOS || join(dataRoot, 'repos.json'),
};
