// Build the docs/ folder that GitHub Pages serves, so recap links in pull
// request comments actually resolve.
//
//   node scripts/publish-pages.mjs [--base https://<user>.github.io/<repo>]
//
// Copies every built recap into docs/recaps/ and writes docs/index.html, an
// index of the sessions on record. Then, once:
//
//   Settings → Pages → Source: "Deploy from a branch", branch main, folder /docs
//
// After that, `node scripts/post-recap.mjs latest --url-base <base>/recaps`
// posts a comment whose link works for anyone who can see the repository.
//
// Zero cost, no server, no account beyond the GitHub one you already have.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storyDir = join(root, 'recaps');
const builtDir = join(root, 'ui', 'recaps');
const docsDir = join(root, 'docs');
const outRecaps = join(docsDir, 'recaps');

const argv = process.argv.slice(2);
const bIdx = argv.indexOf('--base');
const BASE = (bIdx !== -1 ? argv[bIdx + 1] : process.env.RECAP_URL_BASE || '').replace(/\/$/, '');

if (!existsSync(storyDir)) { console.error('no recaps/ yet — run build-recap first'); process.exit(1); }

mkdirSync(outRecaps, { recursive: true });

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

const sessions = [];
for (const f of readdirSync(storyDir).filter((f) => f.endsWith('.json'))) {
  const slug = f.replace(/\.json$/, '');
  const html = join(builtDir, `${slug}.html`);
  if (!existsSync(html)) { console.warn(`skipping ${slug}: no built page`); continue; }
  copyFileSync(html, join(outRecaps, `${slug}.html`));
  const sb = JSON.parse(readFileSync(join(storyDir, f), 'utf8'));
  const cover = sb.scenes.find((s) => s.kind === 'cover');
  const outcome = sb.scenes.find((s) => s.kind === 'outcome');
  sessions.push({
    slug, name: sb.name, branch: sb.branch, date: sb.date, startedAt: sb.startedAt,
    title: cover?.title ?? slug, total: sb.totalS, supervisor: sb.supervisor,
    refused: (outcome?.notDone ?? []).length, kb: Math.round(statSync(html).size / 1024),
  });
}
sessions.sort((a, b) => b.startedAt - a.startedAt);

const rows = sessions.map((s) => `
      <a class="row" href="recaps/${esc(s.slug)}.html">
        <span class="t">${esc(s.title)}</span>
        <span class="m">${esc(s.name)}${s.branch ? ` · ${esc(s.branch)}` : ''} · supervised by ${esc(s.supervisor)}</span>
        <span class="r">${s.refused ? `<b>${s.refused} refused</b>` : 'nothing refused'}</span>
        <span class="d">${esc(s.date)} · ${mmss(s.total)}</span>
      </a>`).join('');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session records · Control Room</title>
<meta name="description" content="What agents did in this repository, including what a human refused.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --bg:#0B0D10; --panel:#111419; --rule:#232830; --rule-soft:#1A1E25;
    --ink:#E6E9ED; --ink-mute:#8A93A0; --ink-faint:#5C6470; --deny:#F87171; --accent:#7DD3FC;
    color-scheme: dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .shell{max-width:900px;margin:0 auto;padding-inline:20px;padding-block:40px 72px;display:flex;flex-direction:column;gap:26px}
  .lbl{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)}
  h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-.015em}
  .lede{margin:0;color:var(--ink-mute);font-size:15px;max-width:62ch}
  .lede b{color:var(--ink);font-weight:500}
  .list{display:flex;flex-direction:column;border:1px solid var(--rule);border-radius:3px;overflow:hidden;background:var(--panel)}
  a.row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:14px 17px;border-bottom:1px solid var(--rule-soft);text-decoration:none;color:inherit}
  a.row:last-child{border-bottom:none}
  a.row:hover{background:var(--bg)}
  a.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .t{font-size:15px;font-weight:500;grid-column:1}
  .m{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-mute);grid-column:1}
  .r{grid-column:2;grid-row:1;text-align:right;font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-faint)}
  .r b{color:var(--deny);font-weight:500}
  .d{grid-column:2;grid-row:2;text-align:right;font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--ink-faint)}
  .empty{padding:24px 17px;color:var(--ink-faint)}
  .foot{color:var(--ink-faint);font-size:12.5px;max-width:74ch}
  @media (max-width:560px){a.row{grid-template-columns:1fr}.r,.d{grid-column:1;text-align:left}}
</style>
</head>
<body>
<div class="shell">
  <div>
    <span class="lbl">Control Room</span>
    <h1>Session records</h1>
  </div>
  <p class="lede">Each entry is the record of one coding-agent session: the task it was given, every action a human held or refused, the changes it made, and anything that was rolled back. <b>A diff tells you what changed. These tell you what nearly happened.</b></p>
  <div class="list">${rows || '<div class="empty">No sessions recorded yet.</div>'}</div>
  <p class="foot">Generated ${new Date().toLocaleString('en-GB')} by the Control Room. Every figure on these pages is computed from the session recordings, not written by a model.</p>
</div>
</body>
</html>
`;

writeFileSync(join(docsDir, 'index.html'), page);
writeFileSync(join(docsDir, '.nojekyll'), '');

console.log(`docs/ built — ${sessions.length} session(s)`);
for (const s of sessions) console.log(`  ${s.slug.padEnd(22)} ${s.refused} refused  ${s.kb} KB`);
console.log('');
if (BASE) {
  console.log(`Index will be at   ${BASE}/`);
  console.log(`Post a recap with  node scripts/post-recap.mjs latest --url-base ${BASE}/recaps`);
} else {
  console.log('Next: commit docs/, then Settings → Pages → branch main, folder /docs.');
  console.log('Then re-run with --base https://<user>.github.io/<repo> for the exact commands.');
}
