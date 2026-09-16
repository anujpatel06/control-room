// Which coding agents is this repo actually driven by?
//
// The IDE is not the question. Claude Code inside VS Code or a JetBrains IDE is
// still Claude Code, reading the same settings file, so those need nothing. What
// matters is the harness making the tool calls, because that is what exposes the
// hook Nearly attaches to.
//
// This exists so nobody has to know that. You run one command; it finds what you
// use here and turns the gate on for each of them.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ADAPTERS, byId } from '../server/adapters.mjs';

// Signals beyond each adapter's own config file: the files a harness leaves in a
// repo whether or not anybody has configured hooks in it.
const MARKS = {
  'claude-code': ['.claude', 'CLAUDE.md', '.claude/settings.json'],
  cursor: ['.cursor', '.cursorrules', '.cursor/rules'],
  antigravity: ['.agents', '.antigravity'],
  copilot: ['.github/copilot-instructions.md', '.github/hooks'],
  codex: ['.codex', 'AGENTS.md'],
  gemini: ['.gemini'],
  windsurf: ['.windsurf', '.windsurfrules'],
};

const CLIS = {
  'claude-code': ['claude'], cursor: ['cursor-agent'], antigravity: ['agy'],
  copilot: ['copilot'], codex: ['codex'], gemini: ['gemini'], windsurf: ['windsurf'],
};

function onPath(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

// A config file in the repo is evidence about this repo. A CLI on PATH is only
// evidence about the machine, so it is reported separately and never acted on:
// having Gemini installed is not a reason to write files into someone's project.
export function detect(repo) {
  const found = [];
  for (const a of ADAPTERS) {
    const marks = [a.config, ...(MARKS[a.id] || [])];
    const inRepo = marks.some((m) => existsSync(join(repo, m)));
    if (inRepo) found.push({ id: a.id, name: a.name, why: 'configured in this repo' });
  }
  return found;
}

export function installed() {
  return ADAPTERS
    .filter((a) => (CLIS[a.id] || []).some(onPath))
    .map((a) => ({ id: a.id, name: a.name, why: 'installed on this machine' }));
}

// What attach should turn on: everything this repo shows signs of, and Claude
// Code either way, since it is the one that has been run end to end.
//
//   --agent=cursor,gemini   exactly these
//   --agent=all             every adapter there is
export function choose(repo, argv = []) {
  const at = argv.indexOf('--agent');
  const flag = argv.find((a) => a.startsWith('--agent=')) ?? (at !== -1 && argv[at + 1] ? `--agent=${argv[at + 1]}` : undefined);
  if (flag) {
    const want = flag.slice('--agent='.length).split(',').map((s) => s.trim()).filter(Boolean);
    if (want.includes('all')) return { chosen: ADAPTERS, unknown: [] };
    const chosen = want.map(byId).filter(Boolean);
    return { chosen, unknown: want.filter((w) => !byId(w)) };
  }
  const ids = new Set(['claude-code', ...detect(repo).map((d) => d.id)]);
  return { chosen: ADAPTERS.filter((a) => ids.has(a.id)), unknown: [] };
}
