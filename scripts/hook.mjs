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
import { realpathSync, readFileSync } from 'node:fs';
import { byId } from '../server/adapters.mjs';
import { keep } from '../server/reclaim.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.NEARLY_PORT || 47653);
const BASE = `http://${HOST}:${PORT}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = args.find((a) => a.startsWith('--adapter='));
const positional = args.filter((a) => !a.startsWith('--'));
const [event] = positional;
let name = positional[1] || null;
if (!event) process.exit(0);

// Anything this build does not understand, it stays out of. A flag from a newer
// version, or a hook with no repo name, used to be read as "gate this session,
// supervised" — which, run from Claude Code's user settings, held every tool call
// of every session on the machine. Unknown means answer nothing.
const KNOWN = /^--(?:adapter=[a-z0-9-]+|auto|supervise|outside)$/;
if (args.some((a) => a.startsWith('--') && !KNOWN.test(a))) process.exit(0);
if (!name && !args.includes('--outside')) process.exit(0);

// The off switch for every session at once: `nearly pause`. A file rather than an
// environment variable, because sessions already running cannot be given a new
// environment, and those are exactly the ones that need stopping.
try {
  const { existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  if (existsSync(join(process.env.NEARLY_HOME || join(homedir(), '.nearly'), 'paused'))) process.exit(0);
} catch { /* no home to check: carry on */ }

// An unknown id is a typo in a config file, not a reason to wedge the agent.
const adapter = flag ? byId(flag.slice('--adapter='.length)) : null;
// Nobody is at the keyboard. Set by attach --auto, carried per repo rather than
// as machine-wide state, because supervising one project and not another is the
// normal case.
let unattended = args.includes('--auto');
// Holding a call for a person happens only when a hook says so outright. The
// absence of --auto used to mean it, so any hook that lost or never had the flag
// froze its session; a missing setting now runs unattended, never-rules intact.
// Repo hooks written before --supervise existed say supervised by leaving --auto
// out, and still mean it, so a named repo hook without --auto is read that way.
let supervised = args.includes('--supervise') || (!!name && !args.includes('--auto') && !args.includes('--outside'));
// Written into Claude Code's user settings rather than a repo's: see outside.mjs.
const outside = args.includes('--outside');

const body = await new Promise((r) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => r(s));
  process.stdin.on('error', () => r(''));
});

const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
const VERSION = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return null; } })();

// Is the thing on this port *us*?
//
// A hook starts the server and the server outlives the run. So after an upgrade
// — or after a one-off `npx nearly-cli` — the old build keeps the port and keeps
// answering, from a directory that may not exist any more. Its record pages 404
// and every fix since is invisible, with nothing anywhere saying why.
async function up(ms = 400) {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return false;
    const h = await r.json().catch(() => ({}));
    if (h.root === realRoot || keep(h.version, VERSION)) return true;
    return 'stale';   // older, or from before servers said what they were
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

// A session opened somewhere else. Decide whether this call is any of our
// business before doing anything that costs more than reading a few small files.
// Nothing goes to a server unless the answer is yes.
let extra = '';
if (outside) {
  let hook = {};
  try { hook = JSON.parse(body || '{}'); } catch { /* nothing to go on */ }
  const { attachedRepos, concerns, launchedIn, rememberedRepo } = await import('./outside.mjs');
  const repos = attachedRepos();
  if (!repos.length) process.exit(0);
  // Started in one of them: its own hooks are running, and answering twice would
  // record every call twice. A subfolder is not certain to load them, so there
  // both fire and the server keeps whichever arrives first.
  if (repos.some((r) => r.real === launchedIn(hook))) process.exit(0);
  const hit = ((event === 'pre-tool' || event === 'post-tool') ? concerns(hook, repos) : null)
    || rememberedRepo(hook.session_id, repos);
  if (!hit) process.exit(0);
  name = hit.name;
  unattended = hit.auto;
  supervised = !hit.auto;
  extra = `&outside=1&repo=${encodeURIComponent(hit.repo)}`;
}

let health = await up();
if (health === 'stale') {
  // Take the port back rather than run whatever is already there. Nobody reads
  // a hook's output, so this has to happen without being asked — otherwise the
  // only people who ever get the fix are the ones who happen to re-run `nearly`
  // and read the message.
  const { reclaim } = await import('../server/reclaim.mjs');
  const { outcome } = await reclaim({ port: PORT, base: BASE, root: realRoot, version: VERSION });
  // 'busy' and 'stuck' both mean it is still there. Talking to an old server
  // still gates the call, which is better than not gating it.
  health = (outcome === 'stood-down' || outcome === 'ended' || outcome === 'free') ? false : true;
}
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
  const auto = (unattended ? '&auto=1' : '') + (supervised && !unattended ? '&supervise=1' : '');
  const res = await fetch(`${BASE}/hooks/${event}?attach=${encodeURIComponent(name)}${hold}${auto}${extra}`, {
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
