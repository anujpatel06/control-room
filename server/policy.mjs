// The consent gradient: which tier a tool call lands in, and what "always" and
// "never" attach to.
//
// Kept apart from the server because this is the one piece where a mistake is
// silent and expensive. A rule key that is too broad turns one "always" into
// blanket permission for a whole class of commands; a never pattern that does
// not match means a destructive command reaches a human who approves it out of
// habit. Both are testable, so they are tested.

import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Never: refused outright, with nobody asked.
// ---------------------------------------------------------------------------
//
// These used to be keywords. `rm -rf`, `git push` and `.env` anywhere in a
// command were enough — which refused `rm -rf node_modules`, every push to a
// feature branch, `cat .env.example`, and `node -e "…process.env…"` because
// "process.env" contains ".env". That was tolerable while a person saw
// everything else first. Once unattended became the default, a blunt rule had
// nobody to overrule it, and eight of twenty-eight ordinary commands an agent
// runs in a working day were refused.
//
// So each rule now states what it protects, and the principle is the same for
// all of them: refuse what cannot be undone. A file deleted inside the repo
// comes back from git. A home directory does not. A pushed feature branch is how
// work reaches review. A force-push rewrites what other people already have.

// Split a command into the pieces a shell would run separately, so a rule cannot
// be walked around by chaining — `git add -A && git push --force` is two
// commands and the second one is the dangerous one.
function segments(cmd) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Just enough of a shell's word splitting to find arguments: quotes group,
// whitespace separates. Not a shell; it does not need to be.
function words(seg) {
  const out = [];
  let cur = '', q = null, any = false;
  for (const c of seg) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

// Drop leading `sudo`, `env X=y`, `command`, `nice` and the like, so the rule
// sees the program that actually runs.
function program(ws) {
  let i = 0;
  while (i < ws.length && (/^[A-Z_][A-Z0-9_]*=/.test(ws[i]) || ['sudo', 'env', 'command', 'nice', 'time', 'nohup', 'exec'].includes(ws[i]))) i++;
  return ws.slice(i);
}

const inside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function rmReason(ws, cwd) {
  const [prog, ...rest] = program(ws);
  if (prog !== 'rm') return null;
  let recursive = false, endOfFlags = false;
  const targets = [];
  for (const w of rest) {
    if (!endOfFlags && w === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && w.startsWith('--')) { if (w === '--recursive') recursive = true; continue; }
    if (!endOfFlags && w.startsWith('-') && w.length > 1) { if (/[rR]/.test(w)) recursive = true; continue; }
    targets.push(w);
  }
  // Removing a single file is ordinary work, and a tracked one comes back from git.
  if (!recursive) return null;
  for (const raw of targets) {
    // Something the shell expands at run time cannot be checked from here. It
    // might be `dist`; it might be `/`.
    if (/[$`]/.test(raw)) return `deletes a path decided at run time (${raw})`;
    if (raw === '*' || raw === '.' || raw === './' || raw === './*' || raw === '.*') return 'deletes everything in the directory';
    const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (!cwd) {
      if (path.isAbsolute(expanded) || raw.startsWith('~') || raw.split('/').includes('..')) return `deletes ${raw} outside the repo`;
      continue;
    }
    const abs = path.resolve(cwd, expanded);
    if (!inside(cwd, abs)) return `deletes ${raw}, outside this repo, where git cannot give it back`;
    if (abs === path.resolve(cwd)) return 'deletes the repo itself';
    if (abs.split(path.sep).includes('.git')) return 'deletes git history, which nothing can restore';
  }
  return null;
}

const PROTECTED = new Set(['main', 'master']);

function currentBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch { return null; }
}

function pushReason(ws, cwd) {
  const p = program(ws);
  if (p[0] !== 'git') return null;
  let dir = cwd;
  let i = 1;
  while (i < p.length && p[i].startsWith('-')) {           // git -C <dir> push …
    if (p[i] === '-C' && p[i + 1]) { dir = dir ? path.resolve(dir, p[i + 1]) : p[i + 1]; i += 2; }
    else i++;
  }
  if (p[i] !== 'push') return null;

  const args = p.slice(i + 1);
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));

  const force = flags.some((f) => /^--force/.test(f) || (/^-[a-zA-Z]+$/.test(f) && f.includes('f')));
  if (force || positional.some((r) => r.startsWith('+'))) return 'force-pushes, rewriting history other people already have';
  if (flags.includes('--delete') || flags.includes('-d') || positional.some((r) => r.startsWith(':'))) {
    return 'deletes a branch on the remote';
  }

  // Everything after the remote is a refspec; what it lands on is after a colon.
  const refspecs = positional.slice(1);
  for (const r of refspecs) {
    const dest = r.includes(':') ? r.split(':').pop() : r;
    if (PROTECTED.has(dest.replace(/^refs\/heads\//, ''))) return `pushes straight to ${dest}, skipping review`;
  }
  // `git push`, `git push origin`, `git push origin HEAD` go wherever you are.
  if (refspecs.length === 0 || refspecs.includes('HEAD')) {
    const branch = dir ? currentBranch(dir) : null;
    if (!branch) return 'pushes a branch that could not be identified';
    if (PROTECTED.has(branch)) return `pushes straight to ${branch}, skipping review`;
  }
  return null;
}

// Real secrets, not their templates. `.env.example` exists to be read and
// copied; `process.env` is not a file.
const TEMPLATE = new Set(['example', 'sample', 'template', 'dist', 'defaults', 'schema']);
function isSecretEnv(word) {
  const base = path.basename(word.replace(/^[@<>=]+/, ''));
  const m = base.match(/^\.env(?:\.([\w.-]+))?$/);
  return !!m && !(m[1] && TEMPLATE.has(m[1].split('.')[0]));
}

function envReason(ws) {
  const p = program(ws);
  if (!p.some(isSecretEnv)) return null;
  const prog = p[0];
  // Putting a file in place is setup; `cp .env.example .env` is how most
  // projects tell you to start. Only moving a real one somewhere is a leak.
  if (prog === 'cp' || prog === 'mv' || prog === 'install' || prog === 'ln') {
    const paths = p.slice(1).filter((w) => !w.startsWith('-'));
    return paths.slice(0, -1).some(isSecretEnv) ? 'copies secrets out of a .env file' : null;
  }
  if (prog === 'touch' || prog === 'rm') return null;
  // A secret file that is only ever the target of `>` is being written, not read.
  const read = p.some((w, idx) => isSecretEnv(w) && !['>', '>>'].includes(p[idx - 1]));
  return read ? 'reads secrets from a .env file' : null;
}

function patternReason(seg) {
  if (/\bsudo\b/.test(seg)) return 'runs as root';
  if (/\b(curl|wget)\b[^|]*\|\s*(ba|z|da|k)?sh\b/.test(seg)) return 'pipes a download straight into a shell';
  if (/\bchmod\s+(-[a-zA-Z]+\s+)*0?777\b/.test(seg)) return 'makes files writable by everyone';
  return null;
}

// The reason a command must never run, or null. Exported for the tests, which
// hold both halves of the promise: the dangerous refused, the ordinary not.
export function neverReason(command, cwd) {
  const cmd = String(command || '');
  if (patternReason(cmd)) return patternReason(cmd);   // these hold across a whole chain
  for (const seg of segments(cmd)) {
    const ws = words(seg);
    const why = rmReason(ws, cwd) || pushReason(ws, cwd) || envReason(ws);
    if (why) return why;
  }
  return null;
}

// Everything not listed falls through to "ask", so a tool nobody has thought
// about yet is held rather than allowed.
export const DEFAULT_TIER = {
  Read: 'log', Glob: 'log', Grep: 'log', LS: 'log', WebSearch: 'log', TodoWrite: 'log',
  WebFetch: 'ask', Bash: 'ask', Edit: 'ask', Write: 'ask', MultiEdit: 'ask',
  NotebookEdit: 'ask', Task: 'ask',
};

// What a decision generalises to when you pick "always" or "never".
//
// For a shell command that is the first word, so allowing `git status` does not
// also allow `git push`. For a file write it is the extension, so allowing an
// edit to one .js file does not also allow edits to .env. Anything else is the
// tool itself.
export function ruleKey(hook) {
  const t = hook.tool_name;
  if (t === 'Bash') {
    const first = String(hook.tool_input?.command || '').trim().split(/\s+/)[0] || '?';
    return `Bash:${first}`;
  }
  if (t === 'Edit' || t === 'Write' || t === 'MultiEdit') {
    const p = hook.tool_input?.file_path || '';
    return `${t}:${path.extname(p) || '(no ext)'}`;
  }
  return t;
}

// never > learned rule > default for the tool > ask.
export function classify(hook, rules = new Map()) {
  const t = hook.tool_name;
  if (t === 'Bash') {
    const why = neverReason(hook.tool_input?.command, hook.cwd);
    if (why) return { tier: 'never', reason: why };
  }
  const key = ruleKey(hook);
  if (rules.has(key)) return { tier: rules.get(key), reason: `rule ${key}` };
  return { tier: DEFAULT_TIER[t] ?? 'ask', reason: `default for ${t}` };
}
