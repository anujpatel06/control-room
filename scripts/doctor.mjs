// Why is nothing showing up?
//
//   nearly doctor
//
// Everything this project does is a chain: gate the session, record it, build
// the record, find the pull request, post the link. A break anywhere means
// nothing appears, and every step is quiet by design — hooks must never
// interrupt an agent, and a push must never fail over a recap. Quiet is right
// and it is also how somebody ends up staring at an empty pull request with no
// idea which link came apart.
//
// So this walks the chain in order and stops being polite about it.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { paths, dataRoot } from '../server/paths.mjs';
import { ADAPTERS } from '../server/adapters.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repo = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd());
const PORT = Number(process.env.NEARLY_PORT || 47653);

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const blockers = [];
function say(ok, label, detail, fix) {
  const mark = ok === true ? green('✓') : ok === false ? red('✗') : yellow('!');
  console.log(`  ${mark} ${label}${detail ? dim(`  ${detail}`) : ''}`);
  if (ok === false && fix) blockers.push(fix);
}

const git = (args) => {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

console.log('');
console.log(`  ${bold('Nearly')} ${dim(repo)}`);
console.log('');

// 1 — a repo at all
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (!existsSync(join(repo, '.git'))) {
  say(false, 'a git repository', 'this is not one', `cd into the repo you work in, then run nearly`);
} else {
  say(true, 'a git repository', `on ${branch}`);
}

// 2 — which agents are gated here. An agent Nearly cannot see records nothing,
// and that is the single most common reason for an empty pull request.
const gated = ADAPTERS.filter((a) => {
  const f = join(repo, a.config);
  try { return existsSync(f) && /nearly/i.test(readFileSync(f, 'utf8')); } catch { return false; }
});
if (gated.length) say(true, 'agents gated here', gated.map((a) => a.name).join(', '));
else say(false, 'agents gated here', 'none', 'run `nearly` in this repo to turn it on');

// 3 — the server, and whether it is this build
let health = null;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(900) });
  if (r.ok) health = await r.json();
} catch { /* not running is normal: hooks start it */ }
if (!health) {
  say(null, 'server', 'not running — a hook starts it when one fires');
} else {
  let mine = root;
  try { mine = realpathSync(root); } catch { /* compare literally */ }
  const same = health.root === mine;
  let ours = null;
  try { ours = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { /* unknown */ }
  if (same) {
    say(true, 'server', `v${health.version}`);
  } else if (health.version && health.version === ours) {
    // Running this through npx gives a throwaway directory every time, so the
    // paths differ even when the build is identical. Saying "a different
    // install" there is true and useless; the version is what anyone cares
    // about, and a matching one is holding nothing back.
    say(null, 'server', `v${health.version} from another copy of the same version — nothing stale about it`);
  } else {
    say(false, 'server', `an older build is answering${health.version ? ` (v${health.version})` : ''}: ${health.root || 'it does not say where it lives'}`,
      'run `nearly` here — it closes the older server holding the port');
  }
}

// 4 — recordings for this branch, matched the way the record builder matches
// them, so this cannot disagree with it.
const recDir = paths.recordings();
let runs = 0, otherBranches = new Set();
const real = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };
try {
  for (const f of readdirSync(recDir).filter((f) => f.endsWith('.jsonl'))) {
    let created = null;
    for (const line of readFileSync(join(recDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'session' && e.subtype === 'created') { created = e; break; }
      } catch { /* a torn line */ }
    }
    if (!created) continue;
    if (created.worktree && real(created.worktree) !== real(repo)) continue;
    if (created.branch === branch) runs += 1;
    else if (created.branch) otherBranches.add(created.branch);
  }
} catch { /* no recordings directory yet */ }

if (runs) {
  say(true, `sessions recorded on ${branch}`, `${runs}`);
} else {
  say(false, `sessions recorded on ${branch}`, 'none',
    otherBranches.size
      ? `this branch has no recorded sessions. Others do: ${[...otherBranches].join(', ')}. A record only exists for work an agent Nearly gates actually did.`
      : `nothing here has been recorded yet. Nearly only sees the agents it gates — run \`nearly agents\` to see which those are.`);
}

// 5 — the hook that offers the record at push time
const pushHook = join(repo, '.git', 'hooks', 'pre-push');
const hasPush = existsSync(pushHook) && /x-session-record-hook|nearly/i.test((() => {
  try { return readFileSync(pushHook, 'utf8'); } catch { return ''; }
})());
say(hasPush, 'pre-push hook', hasPush ? 'installed' : 'missing', 'run `nearly` here to install it');

// 6 — gh, which is how a pull request is found and commented on. Its absence
// used to be reported as "no pull request yet", which sent people off to raise
// one they already had.
const ghOk = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
if (!ghOk) {
  say(false, 'GitHub CLI (gh)', 'not on PATH',
    'install it from cli.github.com and run `gh auth login` — without it the record cannot be posted to a pull request');
} else {
  const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0;
  say(auth, 'GitHub CLI (gh)', auth ? 'installed and signed in' : 'installed but not signed in', 'run `gh auth login`');
  if (auth) {
    const pr = spawnSync('gh', ['pr', 'view', '--json', 'number,url'], { cwd: repo, encoding: 'utf8' });
    if (pr.status === 0) {
      let url = '';
      try { url = JSON.parse(pr.stdout).url; } catch { /* keep it blank */ }
      say(true, 'open pull request', url);
    } else {
      say(null, 'open pull request', `none for ${branch} — raise one, then push again`);
    }
  }
}

// 7 — where a posted record would point
const urlBase = (() => {
  if (process.env.NEARLY_URL_BASE) return process.env.NEARLY_URL_BASE;
  for (const f of [paths.config(), join(root, '.nearly.json')]) {
    try { if (existsSync(f)) { const u = JSON.parse(readFileSync(f, 'utf8')).urlBase; if (u) return u; } }
    catch { /* try the next */ }
  }
  return null;
})();
say(urlBase ? true : null, 'somewhere to publish records',
  urlBase || `kept in ${dataRoot.replace(process.env.HOME || '~', '~')}, so a comment would have no link to give`);

// 8 — whether a record for this branch exists right now
const slug = `${String(basename(repo)).replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}--${String(branch).replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}`;
const built = join(paths.records(), `${slug}.json`);
say(existsSync(built) ? true : null, 'record built for this branch',
  existsSync(built) ? built : 'not yet — it is built at push time, or by `nearly record`');

console.log('');
if (!blockers.length) {
  console.log(`  ${green('Nothing is in the way.')} ${dim('Work, push, and the record is offered.')}`);
} else {
  console.log(`  ${bold(blockers.length === 1 ? 'One thing is in the way:' : `${blockers.length} things are in the way:`)}`);
  for (const b of blockers) console.log(`    · ${b}`);
}
console.log('');
