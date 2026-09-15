// Which coding agents are in use here, and which of them Nearly can actually gate.
//
// The IDE is not the question. Claude Code inside VS Code is still Claude Code
// and Nearly works there unchanged. What matters is the harness making the tool
// calls, because that is what exposes the hook Nearly attaches to.
//
// This exists to stop the worst outcome: somebody running Nearly in a repo where
// they drive Cursor or Antigravity, seeing a tick, and believing they are gated
// when nothing of theirs is. Reporting success while doing nothing is the exact
// failure this project was built to catch.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Ordered by how likely a signal is to mean real use rather than a stray file.
const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', supported: true,
    marks: ['.claude/settings.json', '.claude/CLAUDE.md', 'CLAUDE.md'], cmds: ['claude'] },
  { id: 'cursor', name: 'Cursor', supported: false, hook: 'beforeShellExecution',
    marks: ['.cursor/hooks.json', '.cursor/rules', '.cursorrules'], cmds: ['cursor'] },
  { id: 'antigravity', name: 'Antigravity', supported: false, hook: 'PreToolUse',
    marks: ['.agents/hooks.json', '.antigravity'], cmds: ['agy'] },
  { id: 'copilot', name: 'GitHub Copilot', supported: false, hook: 'preToolUse',
    marks: ['.github/hooks', '.github/copilot-instructions.md'], cmds: ['copilot'] },
  { id: 'windsurf', name: 'Windsurf', supported: false, hook: 'pre_run_command',
    marks: ['.windsurf/hooks.json', '.windsurfrules'], cmds: ['windsurf'] },
  { id: 'codex', name: 'Codex', supported: false, hook: 'PreToolUse',
    marks: ['.codex/hooks.json', 'AGENTS.md'], cmds: ['codex'] },
  { id: 'gemini-cli', name: 'Gemini CLI', supported: false, hook: 'BeforeTool',
    marks: ['.gemini/settings.json'], cmds: ['gemini'] },
  { id: 'junie', name: 'JetBrains Junie', supported: false, hook: 'PreToolUse',
    marks: ['.junie'], cmds: [] },
];

function onPath(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

export function detect(repo) {
  const found = [];
  for (const a of AGENTS) {
    const inRepo = a.marks.some((m) => existsSync(join(repo, m)));
    // A command on PATH alone is weak evidence: plenty of people have a CLI
    // installed and do not use it here. Only count it for the repo's own marks.
    const installed = a.cmds.some(onPath);
    if (inRepo || (installed && a.id === 'claude-code')) {
      found.push({ ...a, why: inRepo ? 'configured in this repo' : 'installed' });
    }
  }
  return found;
}

// One honest paragraph about what is and is not covered here.
export function report(repo, { dim, bold }) {
  const found = detect(repo);
  const others = found.filter((a) => !a.supported);
  if (!others.length) return null;

  const lines = [''];
  lines.push(`  ${bold('Nearly gates Claude Code.')} This repo also looks set up for:`);
  for (const a of others) lines.push(`    ${a.name} ${dim(`(${a.why})`)}`);
  lines.push(dim('    Those are not gated yet. Sessions you run in them are neither held nor recorded.'));
  lines.push(dim(`    Each exposes a comparable hook, so an adapter is small: github.com/anujpatel06/nearly/issues`));
  return lines.join('\n');
}
