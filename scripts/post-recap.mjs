// Post a session's recap to the pull request for its branch, as a comment.
//
//   node scripts/post-recap.mjs <session-id | latest> [--url-base https://you.github.io/nearly/recaps] [--dry-run]
//
// Uses the GitHub CLI (`gh pr comment`) in the repo the session ran in, so it
// works with whatever account gh is logged in as. Nothing is uploaded: the
// comment carries the computed summary and every narration line as text, plus
// a link to the record page when --url-base (or NEARLY_URL_BASE) says where the
// ui/records folder is hosted. Without a base URL the comment says where the
// file lives locally. --dry-run prints the comment and posts nothing.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const ubIdx = argv.indexOf('--url-base');
const urlBase = (ubIdx !== -1 ? argv[ubIdx + 1] : process.env.NEARLY_URL_BASE || '').replace(/\/$/, '');
const target = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--url-base') || 'latest';

const dir = join(root, 'records');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
if (!files.length) { console.error('no storyboards in records/. Run build-recap first.'); process.exit(1); }
let file;
if (target === 'latest') {
  file = files.map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
} else {
  file = files.find((f) => f === `${target}.json`)                                  // exact slug, e.g. repo--branch
      || files.find((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).id.startsWith(target))  // session id
      || files.find((f) => f.includes(target));                                     // loose match, last resort
}
if (!file) { console.error(`no storyboard for ${target}`); process.exit(1); }

const sb = JSON.parse(readFileSync(join(dir, file), 'utf8'));
const slug = file.replace(/\.json$/, '');
const cover = sb.scenes.find((s) => s.kind === 'cover');
const outcome = sb.scenes.find((s) => s.kind === 'outcome');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

const lines = [];
lines.push(sb.runs > 1
  ? `### Session record for \`${sb.branch}\`: ${cover.title}`
  : `### Session record: ${cover.title}`);
lines.push('');
lines.push(urlBase
  ? `**[Watch the record (${mmss(sb.totalS)})](${urlBase}/${slug}.html)** · ${sb.runs > 1 ? `${sb.runs} agent sessions` : `agent \`${sb.name}\``} · ${sb.model} · ${sb.date}`
  : `Record: \`ui/records/${slug}.html\` in the Nearly checkout (${mmss(sb.totalS)}, not hosted yet) · ${sb.runs > 1 ? `${sb.runs} agent sessions` : `agent \`${sb.name}\``} · ${sb.model} · ${sb.date}`);
lines.push('');
if (outcome?.notDone?.length) {
  lines.push(`> **${outcome.notDone.length} thing${outcome.notDone.length > 1 ? 's' : ''} the agent wanted to do did not happen.** The diff cannot show you this.`);
  lines.push('>');
  for (const n of outcome.notDone) lines.push(`> - \`${n.tool}\` · \`${n.what}\` — ${n.by === 'policy' ? 'blocked by policy' : 'refused by the supervisor'}`);
  lines.push('');
}
lines.push('| ' + cover.stats.map(([k]) => k).join(' | ') + ' |');
lines.push('|' + cover.stats.map(() => '---').join('|') + '|');
lines.push('| ' + cover.stats.map(([, v]) => v).join(' | ') + ' |');
lines.push('');
lines.push('<details><summary>Scene by scene</summary>');
lines.push('');
sb.scenes.forEach((s, i) => { lines.push(`${i + 1}. **${s.kind}** — ${s.narration}`); });
lines.push('');
lines.push('</details>');
lines.push('');
lines.push(`<sub>Every number above was computed from the session recording. ${sb.polished ? 'Sentences were rewritten by a model; facts were not.' : 'No model wrote any of it.'}</sub>`);
// A hidden marker so we can find our own comment again on the next push and
// edit it, instead of stacking a new one on every push until nobody reads any.
const MARKER = '<!-- nearly:session-record -->';
const body = `${MARKER}\n${lines.join('\n')}`;

if (dry) { console.log(body); process.exit(0); }

const cwd = sb.cwd;
if (!cwd) { console.error('storyboard has no repo path; cannot find the pull request'); process.exit(1); }

const gh = (args, opts = {}) => spawnSync('gh', args, { cwd, encoding: 'utf8', ...opts });

// Which pull request, and in which repository
const view = gh(['pr', 'view', '--json', 'number,url']);
if (view.status !== 0) {
  console.error(`no open pull request for this branch in ${cwd}`);
  console.error((view.stderr || view.stdout || '').trim().split('\n')[0]);
  process.exit(1);
}
const { number, url: prUrl } = JSON.parse(view.stdout);
const repoView = gh(['repo', 'view', '--json', 'nameWithOwner']);
const nwo = JSON.parse(repoView.stdout || '{}').nameWithOwner;
if (!nwo) { console.error('could not identify the repository'); process.exit(1); }

const tmp = join(tmpdir(), `recap-comment-${slug}.md`);
writeFileSync(tmp, body);

// Already posted one? Edit it. A branch gets pushed many times, and the reviewer
// should see the current state, not a stack of stale records.
const mine = gh(['api', `repos/${nwo}/issues/${number}/comments`, '--paginate',
                 '--jq', `[.[] | select(.body | contains("${MARKER}")) | .id] | first`]);
const existing = (mine.stdout || '').trim();

let r;
if (existing && existing !== 'null') {
  r = gh(['api', '-X', 'PATCH', `repos/${nwo}/issues/comments/${existing}`,
          '-F', `body=@${tmp}`, '--jq', '.html_url']);
  if (r.status === 0) console.log(`updated ${(r.stdout || '').trim() || prUrl}`);
} else {
  r = gh(['pr', 'comment', String(number), '--body-file', tmp]);
  if (r.status === 0) console.log(`posted ${(r.stdout || '').trim() || prUrl}`);
}
if (r.status !== 0) {
  console.error(`could not ${existing && existing !== 'null' ? 'update' : 'post'} the comment: ${(r.stderr || r.stdout).trim()}`);
  process.exit(1);
}
