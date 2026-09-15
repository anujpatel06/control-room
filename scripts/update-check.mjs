// Keeping people current, without ever being the reason something broke.
//
// Nearly decides whether `rm -rf` runs. That makes replacing its own code a
// different act from updating a linter, and the design follows from that:
//
//   1. Never in the hook path. Nothing here may sit in front of an action an
//      agent is waiting on. Only commands a person typed reach this file.
//   2. Never across a major version. Same major, same promises: a gate whose
//      rules changed should be read before it is trusted, so a major bump is
//      announced and left for the person to do.
//   3. Never silent about itself. An update that happened without being
//      mentioned is indistinguishable from a compromise.
//   4. Never fatal. No network, a locked global directory, a slow registry:
//      you keep the version you have and lose nothing.
//
// Off with NEARLY_NO_UPDATE=1.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function stampPath() {
  const dir = process.env.XDG_CACHE_HOME || join(homedir() || tmpdir(), '.cache');
  return join(dir, 'nearly', 'last-update-check');
}

const parts = (v) => String(v).split('-')[0].split('.').map(Number);
function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return null;
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

// Updating in place only makes sense for a global install. An npx run is
// ephemeral and a checkout belongs to whoever cloned it.
function installKind() {
  if (/[\\/]_npx[\\/]/.test(root)) return 'npx';
  try {
    const bin = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['nearly'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (bin && realpathSync(bin).includes(`${root}/bin/`)) {
      return existsSync(join(root, '.git')) ? 'clone' : 'global';
    }
  } catch { /* fall through */ }
  return existsSync(join(root, '.git')) ? 'clone' : 'global';
}

export async function checkForUpdate() {
  if (process.env.NEARLY_NO_UPDATE === '1' || !process.stdout.isTTY) return null;
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; }

  const stamp = stampPath();
  try {
    if (existsSync(stamp) && Date.now() - Number(readFileSync(stamp, 'utf8')) < DAY) return null;
  } catch { /* unreadable: check anyway */ }

  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return null;
    const { version } = await res.json();
    try { mkdirSync(dirname(stamp), { recursive: true }); writeFileSync(stamp, String(Date.now())); } catch { /* fine */ }
    if (compare(version, pkg.version) !== 1) return null;
    return {
      name: pkg.name, from: pkg.version, to: version,
      major: parts(version)[0] !== parts(pkg.version)[0],
      kind: installKind(),
    };
  } catch { return null; }
}

export function applyUpdate(u) {
  if (!u) return;

  if (u.major) {
    console.log('');
    console.log(`  ${bold(`Nearly ${u.to} is out`)} ${dim(`(you have ${u.from})`)}`);
    console.log(dim('  A major version, so the rules this gate enforces may have changed.'));
    console.log(dim(`  Read what changed, then: npm install -g ${u.name}@latest`));
    return;
  }

  if (u.kind !== 'global') {
    console.log('');
    console.log(`  ${bold(`Nearly ${u.to} is out`)} ${dim(`(you have ${u.from})`)}`);
    console.log(dim(u.kind === 'clone' ? '  You are running from a checkout: git pull' : `  npm install -g ${u.name}@latest`));
    return;
  }

  process.stdout.write(dim(`  Updating Nearly ${u.from} → ${u.to}… `));
  const r = spawnSync('npm', ['install', '-g', `${u.name}@${u.to}`, '--silent', '--no-fund', '--no-audit'],
    { encoding: 'utf8', timeout: 120_000 });

  if (r.status === 0) {
    console.log('done');
    console.log(dim('  Every repo you turned it on for is now on the new version.'));
  } else {
    // Usually a global directory this user cannot write to. Say so rather than
    // leaving them stale while believing they are current.
    console.log('could not');
    console.log(dim(`  Run it yourself: npm install -g ${u.name}@latest`));
  }
  console.log('');
}
