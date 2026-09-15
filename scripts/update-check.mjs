// Tell somebody a newer version exists. Nothing more than that.
//
// Three rules, because an update notice is the easiest thing in a developer tool
// to make hateful:
//
//   1. Never in the hook path. A registry lookup in front of an agent's tool
//      call would be unforgivable, so this is only ever called from a command a
//      person typed and is already waiting on.
//   2. Never block. One and a half seconds, once a day, and silence on failure.
//      No network, a firewall, an npm outage: you see nothing and lose nothing.
//   3. Never nag. NEARLY_NO_UPDATE_CHECK=1 turns it off for good.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

function stampPath() {
  const dir = process.env.XDG_CACHE_HOME || join(homedir() || tmpdir(), '.cache');
  return join(dir, 'nearly', 'last-update-check');
}

// Compare only the numeric parts; anything unparseable means "say nothing".
function isNewer(a, b) {
  const p = (v) => String(v).split('-')[0].split('.').map(Number);
  const [x, y] = [p(a), p(b)];
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export async function updateCheck() {
  if (process.env.NEARLY_NO_UPDATE_CHECK === '1' || !process.stdout.isTTY) return null;
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; }
  const stamp = stampPath();
  try {
    if (existsSync(stamp) && Date.now() - Number(readFileSync(stamp, 'utf8')) < DAY) return null;
  } catch { /* unreadable stamp: check anyway */ }

  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const { version } = await res.json();
    try { mkdirSync(dirname(stamp), { recursive: true }); writeFileSync(stamp, String(Date.now())); } catch { /* fine */ }
    return isNewer(version, pkg.version) ? { from: pkg.version, to: version, name: pkg.name } : null;
  } catch { return null; }
}

export function printUpdate(u) {
  if (!u) return;
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  console.log('');
  console.log(`  ${bold(`Nearly ${u.to} is out`)} ${dim(`(you have ${u.from})`)}`);
  console.log(`  ${dim(`npm install -g ${u.name}@latest`)}`);
  console.log(dim('  Every repo you turned it on for picks it up; nothing to turn on again.'));
}
