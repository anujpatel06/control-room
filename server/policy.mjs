// The consent gradient: which tier a tool call lands in, and what "always" and
// "never" attach to.
//
// Kept apart from the server because this is the one piece where a mistake is
// silent and expensive. A rule key that is too broad turns one "always" into
// blanket permission for a whole class of commands; a never pattern that does
// not match means a destructive command reaches a human who approves it out of
// habit. Both are testable, so they are tested.

import path from 'node:path';

// Denied outright. These never reach a person, because a prompt is a chance to
// say yes and there is no version of these worth saying yes to in an agent's
// worktree.
export const NEVER_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bgit\s+push\b/,
  /\bsudo\b/,
  /\.env\b/,
  /curl[^|]*\|\s*(ba)?sh/,
  /\bchmod\s+777\b/,
];

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
  const cmd = String(hook.tool_input?.command || '');
  if (t === 'Bash' && NEVER_PATTERNS.some((r) => r.test(cmd))) {
    return { tier: 'never', reason: 'matches a never rule' };
  }
  const key = ruleKey(hook);
  if (rules.has(key)) return { tier: rules.get(key), reason: `rule ${key}` };
  return { tier: DEFAULT_TIER[t] ?? 'ask', reason: `default for ${t}` };
}
