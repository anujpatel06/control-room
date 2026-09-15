#!/usr/bin/env node
// One Claude Code hook event, forwarded to the Control Room.
//
//   node scripts/hook.mjs <event> <repo-name>
//
// Claude Code writes the event as JSON on stdin and reads our answer from
// stdout. We sit in between so the server does not have to be running before
// you start work: if nothing is listening, this starts it, waits for it, and
// forwards. Nobody has to remember a terminal.
//
// Two rules this file exists to honour:
//
//   1. Never break someone's session. If the server cannot be reached or
//      started, print nothing and exit 0. Claude Code then falls back to its own
//      permission prompts, which is worse than being recorded but better than
//      being stuck.
//   2. Never take longer than it has to. The health check is a few milliseconds
//      on the common path, where the server is already up.

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 47653;
const BASE = `http://${HOST}:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const [, , event, name = 'repo'] = process.argv;
if (!event) process.exit(0);

const body = await new Promise((r) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => r(s));
  process.stdin.on('error', () => r(''));
});

async function up(ms = 400) {
  try {
    const c = AbortSignal.timeout(ms);
    const r = await fetch(`${BASE}/health`, { signal: c });
    return r.ok;
  } catch { return false; }
}

async function start() {
  const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, detached: true, stdio: 'ignore',
  });
  child.unref();
  // Two seconds is generous for a dependency-free server binding one port.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await up(200)) return true;
  }
  return false;
}

if (!(await up()) && !(await start())) process.exit(0);   // fail open, silently

// PreToolUse can hold for as long as the server is willing to wait for a human.
// Everything else should be quick; keep it short so a wedged endpoint cannot
// stall the agent.
const budget = event === 'pre-tool' ? 600_000 : 15_000;

try {
  const res = await fetch(`${BASE}/hooks/${event}?attach=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body || '{}',
    signal: AbortSignal.timeout(budget),
  });
  const text = await res.text();
  if (text && text !== '{}') process.stdout.write(text);
} catch { /* fail open */ }

process.exit(0);
