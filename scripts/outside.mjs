// Sessions opened somewhere else.
//
// Claude Code reads a repo's .claude/settings.local.json only when a session is
// started in that repo. Open it one folder up — a parent folder, a monorepo
// root, your home directory — and edit the repo from there, and the repo's hooks
// never run. Nothing was recorded, nothing was refused, and `nearly doctor`,
// which checks the repo, said everything was fine. That was found by the person
// who built this, which is how sure we can be that everyone else will hit it.
//
// So attach also writes one hook into Claude Code's user settings, which every
// session reads. It is silent unless a call touches a repo Nearly is on for:
//
//   - a session started in such a repo already has that repo's own hooks, so
//     this one steps aside;
//   - a call whose working directory or file is inside such a repo is gated and
//     recorded as that repo's, with that repo's own settings (--auto or not);
//   - once a session has been gated this way, the rest of its calls are too —
//     `rm -rf ~` does not mention the repo, and a gate that only looked at the
//     repo's own paths would wave it through;
//   - anything else answers nothing and costs a process start.
//
// The repo's own hook config stays the source of truth. The user-level hook
// holds no list of its own; it reads which repos are on, and how, from the
// repos themselves.

import { readFileSync, existsSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { paths } from '../server/paths.mjs';
import { OURS_RE, isOurs } from '../server/adapters.mjs';

// Claude Code's user settings. CLAUDE_CONFIG_DIR moves them, and is also how the
// tests keep this away from the real file.
export const userSettingsFile = () =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

// The events worth hearing from a session opened elsewhere. SessionStart says
// nothing about where the session will work, so it is left out.
export const OUTSIDE_EVENTS = {
  UserPromptSubmit: 'prompt', PreToolUse: 'pre-tool', PostToolUse: 'post-tool',
  Stop: 'stop', SessionEnd: 'session-end',
};

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// The real path of p, or of its nearest existing parent with the rest appended:
// a file the agent is about to create does not exist yet, and still belongs to
// the repo it is being created in.
export function realish(p) {
  if (!p) return null;
  let abs = resolve(String(p).replace(/^~(?=$|[\\/])/, homedir()));
  const tail = [];
  for (;;) {
    try { return fold(join(realpathSync.native(abs), ...tail.reverse())); }
    catch {
      const up = dirname(abs);
      if (up === abs) return fold(resolve(p));
      tail.push(abs.slice(up.length).replace(/^[\\/]/, ''));
      abs = up;
    }
  }
}

export const inside = (child, parent) =>
  !!child && !!parent && (child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep));

// The repos Nearly is on for with Claude Code, and how each was turned on. A repo
// in the list whose hooks have since been removed by hand is not one.
export function attachedRepos() {
  let list = [];
  try { list = JSON.parse(readFileSync(paths.repos(), 'utf8')); } catch { return []; }
  const out = [];
  for (const repo of Array.isArray(list) ? list : []) {
    let cmd = null;
    try {
      const s = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8').replace(/^\uFEFF/, ''));
      cmd = (s.hooks?.PreToolUse || []).flatMap((e) => e.hooks || []).map((h) => h.command)
        .find((c) => typeof c === 'string' && OURS_RE.test(c));
    } catch { continue; }
    if (!cmd) continue;
    const name = (cmd.match(/\bpre-tool\s+([a-z0-9-]+)/i) || [])[1] || 'repo';
    out.push({ repo, real: realish(repo), name, auto: /\s--auto\b/.test(cmd) });
  }
  return out;
}

// Every path a call names: where it runs, the file it reads or writes, and any
// absolute or home-relative path in a shell command.
function pathsOf(hook) {
  const found = [];
  const i = hook.tool_input || {};
  for (const k of ['file_path', 'path', 'notebook_path']) if (typeof i[k] === 'string') found.push(isAbsolute(i[k]) ? i[k] : resolve(hook.cwd || '.', i[k]));
  if (hook.cwd) found.push(hook.cwd);
  if (typeof i.command === 'string') {
    // Rough on purpose. Reading a path that is not one costs a gated call at
    // worst; missing one that is lets the call through ungated.
    const words = i.command.split(/[\s;|&<>()]+/).map((w) => w.replace(/^[^\w~./\\:-]+|["']+$/g, '').replace(/^["']+/, '')).filter(Boolean);
    words.forEach((w, n) => {
      const afterCd = /^(?:cd|pushd)$/.test(words[n - 1] || '');
      if (/^(?:~|\/|[A-Za-z]:[\\/])/.test(w)) found.push(w);
      else if (afterCd || /[\\/]/.test(w)) found.push(resolve(hook.cwd || '.', w));
    });
  }
  return found;
}

// The attached repo this call touches, if any.
export function concerns(hook, repos) {
  const touched = pathsOf(hook).map(realish);
  return repos.find((r) => touched.some((p) => inside(p, r.real))) || null;
}

// Sessions already gated this way are remembered by the server; see marks.mjs.
export { rememberOutside, rememberedRepo } from '../server/marks.mjs';

// Where the session was started. Claude Code tells hooks outright; the payload's
// cwd is the fallback, and is the same place until the agent changes directory.
export const launchedIn = (hook) => realish(process.env.CLAUDE_PROJECT_DIR || hook.cwd);

// ---------------------------------------------------------------------------
// Writing and removing the user-level hook
// ---------------------------------------------------------------------------

function readSettings(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return undefined; }   // present but unreadable: never overwrite it
}

// Either form: the file this version writes, or the flag 0.1.18–0.1.20 wrote, so
// turning Nearly on again replaces the broken one rather than adding beside it.
const outsideEntry = (e) => /outside-hook\.mjs|--outside\b/.test(JSON.stringify(e)) && (isOurs(e) || /outside-hook\.mjs/.test(JSON.stringify(e)));

// cmdFor(event) is the full command for that event.
export function installOutside(cmdFor) {
  const file = userSettingsFile();
  const s = readSettings(file);
  if (s === undefined) return { error: `${file} could not be read, so it was left alone` };
  const settings = s || {};
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    const kept = (hooks[ev] || []).filter((e) => !outsideEntry(e));
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  for (const [their, ours] of Object.entries(OUTSIDE_EVENTS)) {
    hooks[their] = [...(hooks[their] || []),
      { hooks: [{ type: 'command', command: cmdFor(ours), timeout: ours === 'pre-tool' ? 600 : ours === 'session-end' ? 120 : 30 }] }];
  }
  settings.hooks = hooks;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { file };
}

export function removeOutside() {
  const file = userSettingsFile();
  const settings = readSettings(file);
  if (!settings || !settings.hooks) return { removed: false };
  let removed = false;
  for (const ev of Object.keys(settings.hooks)) {
    const before = settings.hooks[ev] || [];
    const kept = before.filter((e) => !outsideEntry(e));
    if (kept.length !== before.length) removed = true;
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (!removed) return { removed: false };
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { removed: true, file };
}

// Whether the user-level hook would actually run this version's code. The form
// 0.1.18–0.1.20 wrote, or a path to a file that is not there, is worse than no hook.
export function outsideProblem() {
  const s = readSettings(userSettingsFile());
  const cmds = s && s.hooks ? Object.values(s.hooks).flatMap((list) => (list || []).filter(outsideEntry))
    .flatMap((e) => e.hooks || []).map((h) => String(h.command || '')) : [];
  if (!cmds.length) return null;
  if (cmds.some((c) => /--outside\b/.test(c))) return 'written by 0.1.18–0.1.20 in a form an older install misreads';
  for (const c of cmds) {
    const m = c.match(/"([^"]*outside-hook\.mjs)"/);
    if (m && !existsSync(m[1])) return `points at ${m[1]}, which is not there`;
  }
  return null;
}

export function outsideInstalled() {
  const s = readSettings(userSettingsFile());
  return !!(s && s.hooks && Object.values(s.hooks).some((list) => (list || []).some(outsideEntry)));
}
