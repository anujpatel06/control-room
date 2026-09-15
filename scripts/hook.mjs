#!/usr/bin/env node
// One agent hook event, forwarded to the Nearly.
//
//   node scripts/hook.mjs <event> <repo-name> [--adapter=<id>]
//
// <event> is always one of Nearly's own names (pre-tool, stop, ...) because
// attach picks it when it writes the hook. --adapter names whose dialect is
// arriving on stdin; without one, Claude Code's is assumed and the payload is
// forwarded untouched, which keeps the oldest path the simplest one.
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
import { realpathSync } from 'node:fs';
import { byId } from '../server/adapters.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.NEARLY_PORT || 47653);
const BASE = `http://${HOST}:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = args.find((a) => a.startsWith('--adapter='));
const positional = args.filter((a) => !a.startsWith('--'));
const [event, name = 'repo'] = positional;
if (!event) process.exit(0);

// An unknown id is a typo in a config file, not a reason to wedge the agent.
const adapter = flag ? byId(flag.slice('--adapter='.length)) : null;

const body = await new Promise((r) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => r(s));
  process.stdin.on('error', () => r(''));
});

const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();

// Is the thing on this port *us*?
//
// A hook starts the server and the server outlives the run. So after an upgrade
// — or after a one-off `npx nearly-cli` — the old build keeps the port and keeps
// answering, from a directory that may not exist any more. Its record pages 404
// and every fix since is invisible, with nothing anywhere saying why. Reported
// from a Windows machine where an npx-cache server had been squatting for days.
async function up(ms = 400) {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return false;
    const h = await r.json().catch(() => ({}));
    // No root at all means a build from before this check: stale by definition.
    if (h.root !== realRoot) return 'stale';
    return true;
  } catch { return false; }
}

// Ask the old one to stand down. It refuses while somebody is mid-decision,
// which is right: those requests are being held for a human and dropping them
// would hand each one back to the agent's own prompt.
async function replace() {
  try {
    const r = await fetch(`${BASE}/exit`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    if (r.status === 409) return false;          // in use; leave it alone
  } catch { return false; }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await up(200) === false) return true;    // port is free
  }
  return false;
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

let health = await up();
if (health === 'stale' && await replace()) health = false;   // ours can have the port
if (health === 'stale') health = true;                       // in use by a human; talk to it anyway
if (!health && !(await start())) process.exit(0);            // fail open, silently

// PreToolUse can hold for as long as the server is willing to wait for a human.
// Everything else should be quick; keep it short so a wedged endpoint cannot
// stall the agent.
const budget = event === 'pre-tool' ? 600_000 : 15_000;

// Translate on the way in. A payload we cannot parse is forwarded as it came,
// so a harness that changes its shape degrades to Claude Code's rather than to
// nothing.
let payload = body || '{}';
if (adapter && adapter.normalize) {
  try { payload = JSON.stringify(adapter.normalize(event, JSON.parse(body || '{}'))); }
  catch { /* keep the original */ }
}

try {
  const hold = adapter?.holdMs ? `&hold=${adapter.holdMs}` : '';
  const res = await fetch(`${BASE}/hooks/${event}?attach=${encodeURIComponent(name)}${hold}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(budget),
  });
  const text = await res.text();

  // ...and on the way out. Rendering is what makes a deny actually land: half of
  // these harnesses would read Claude Code's answer as no answer at all, and an
  // unread deny is a gate that reports success while allowing everything.
  if (adapter && adapter.render) {
    let answer = {};
    try { answer = JSON.parse(text || '{}'); } catch { /* treat as no answer */ }
    const out = adapter.render(event, answer);
    if (out.stderr) process.stderr.write(out.stderr);
    if (out.stdout) process.stdout.write(out.stdout);
    process.exit(out.exit || 0);
  }

  if (text && text !== '{}') process.stdout.write(text);
} catch { /* fail open */ }

process.exit(0);
