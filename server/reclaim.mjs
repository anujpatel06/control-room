// Take the port back from a Nearly server that is not this one.
//
// The server outlives the run that starts it. So a single `npx nearly-cli`, or
// any upgrade, leaves the previous build holding 47653 — still answering, from a
// directory npm has since replaced. Its record pages 404, and worse, every fix
// shipped after it never runs. Nothing anywhere says why.
//
// Builds from 0.1.8 stand down when asked. Everything already installed does
// not, and that is most people. Telling them to run taskkill is not a fix; it
// is a fix for whoever reads the message. So when an older build is idle, we
// end it ourselves.
//
// The rule that makes that defensible: never kill anything until it has proved,
// twice, that it is one of ours, and never kill one that anybody is using.

import { execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';

async function get(base, path, ms = 700) {
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Two independent shapes only this server produces. /health alone is a couple of
// generic fields that anything could return by chance; /state carries the
// consent gradient itself — the tier table, the learned rules, the deadline. A
// process answering both is ours, whatever version wrote it.
export async function identify(base) {
  const health = await get(base, '/health');
  if (!health || health.ok !== true || typeof health.sessions !== 'number') return null;
  const state = await get(base, '/state');
  if (!state || !state.defaults || !Array.isArray(state.sessions)) return null;
  if (typeof state.defaults.Bash !== 'string' || typeof state.askTimeoutMs !== 'number') return null;
  return {
    version: health.version || null,           // absent before 0.1.8
    root: health.root || null,                 // absent before 0.1.8
    sessions: health.sessions,
    // Anything actually being decided right now. Killing over one of these
    // would drop a held request back to the agent's own prompt.
    waiting: state.sessions.reduce((n, s) => n + (s.pending?.length || 0), 0),
  };
}

function pidsOnPort(port) {
  try {
    if (isWin) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000 });
      return [...new Set(out.split(/\r?\n/)
        .filter((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
        .map((l) => Number(l.trim().split(/\s+/).pop()))
        .filter((n) => Number.isInteger(n) && n > 0))];
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  } catch { return []; }         // lsof or netstat missing, or nothing listening
}

const freed = async (base) => (await identify(base)) === null;

// Returns what happened, for a caller that wants to say so out loud.
//
//   'ours'      the server on this port is this build
//   'free'      nothing is listening
//   'busy'      someone else's, but a person is mid-decision — left alone
//   'stood-down'  it exited when asked (0.1.8 and later)
//   'ended'     older build, idle, so we closed it
//   'stuck'     ours by every test, but we could not end it
const parts = (v) => String(v || '').split('-')[0].split('.').map(Number);
function newer(a, b) {
  const x = parts(a), y = parts(b);
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Whether the server on the port is good enough to keep: this build, the same
// version run from somewhere else, or a newer one.
//
// This used to compare install folders. A second `npx nearly-cli` never shares a
// folder with the runtime install, so it closed a server with live sessions and
// announced that it had closed "an older" one. And an old hook pinned to a past
// release would have replaced a newer server with itself.
export function keep(serverVersion, ourVersion) {
  if (!serverVersion || !ourVersion) return false;
  return serverVersion === ourVersion || newer(serverVersion, ourVersion);
}

export async function reclaim({ port, base, root, version, kill = process.kill.bind(process) }) {
  const who = await identify(base);
  if (!who) return { outcome: 'free' };
  if ((who.root && who.root === root) || keep(who.version, version)) return { outcome: 'ours', who };
  if (who.waiting > 0) return { outcome: 'busy', who };

  // The polite path. A build that understands this will refuse if it is busy.
  try {
    const r = await fetch(`${base}/exit`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    if (r.status === 409) return { outcome: 'busy', who };
    if (r.ok) {
      for (let i = 0; i < 20; i++) {
        await new Promise((s) => setTimeout(s, 100));
        if (await freed(base)) return { outcome: 'stood-down', who };
      }
    }
  } catch { /* older build: no such endpoint */ }

  // Older build. It has already answered as ours on two endpoints and has no
  // sessions, so ending it costs nobody anything and is the only way its
  // replacement ever gets to run.
  if (who.sessions > 0) return { outcome: 'busy', who };
  for (const pid of pidsOnPort(port)) {
    if (pid === process.pid) continue;
    try { kill(pid, 'SIGTERM'); } catch { /* gone, or not ours to signal */ }
  }
  for (let i = 0; i < 25; i++) {
    await new Promise((s) => setTimeout(s, 100));
    if (await freed(base)) return { outcome: 'ended', who };
  }
  return { outcome: 'stuck', who };
}
