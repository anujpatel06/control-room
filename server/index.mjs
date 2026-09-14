// Agent Control Room — spike server.
// Zero dependencies. Spawns `claude -p` sessions (your Claude subscription, no API key),
// gates every tool call through an HTTP PreToolUse hook, and streams everything to the UI.
//
//   node server/index.mjs        then open http://127.0.0.1:47653
//
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47653;
const HOST = '127.0.0.1';
const WORKSPACE = path.join(ROOT, 'workspace');
const WORKTREES = path.join(WORKSPACE, '.worktrees');
const RECORDINGS = path.join(ROOT, 'recordings');
const UI = path.join(ROOT, 'ui', 'index.html');
const MAX_SESSIONS = 3;                 // 8 GB machine
const ASK_TIMEOUT_MS = 120_000;         // UI must answer before this; then we fail CLOSED (deny)
const HOOK_TIMEOUT_S = 180;             // Claude Code's own hook timeout; must be > ASK_TIMEOUT
const MODEL = 'sonnet';
const MAX_TURNS = '12';

fs.mkdirSync(RECORDINGS, { recursive: true });
fs.mkdirSync(WORKTREES, { recursive: true });

// ---------------------------------------------------------------------------
// Consent gradient (policy). Tiers: never | ask | log | suggest
// never  -> deny, no prompt, logged
// ask    -> hold the call until a human decides (or time out to deny)
// log    -> allow, record a receipt
// suggest-> not enforced at the hook level in this spike (it is a prompt-side behaviour)
// ---------------------------------------------------------------------------
const NEVER_PATTERNS = [/\brm\s+-rf?\b/, /\bgit\s+push\b/, /\bsudo\b/, /\.env\b/, /curl[^|]*\|\s*(ba)?sh/, /\bchmod\s+777\b/];
const DEFAULT_TIER = {
  Read: 'log', Glob: 'log', Grep: 'log', LS: 'log', WebSearch: 'log', TodoWrite: 'log',
  WebFetch: 'ask', Bash: 'ask', Edit: 'ask', Write: 'ask', MultiEdit: 'ask', NotebookEdit: 'ask', Task: 'ask',
};
const rules = new Map(); // learned this run via "allow always" / "deny always": ruleKey -> tier

function ruleKey(hook) {
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

function classify(hook) {
  const t = hook.tool_name;
  const cmd = String(hook.tool_input?.command || '');
  if (t === 'Bash' && NEVER_PATTERNS.some((r) => r.test(cmd))) return { tier: 'never', reason: 'matches a never rule' };
  const key = ruleKey(hook);
  if (rules.has(key)) return { tier: rules.get(key), reason: `rule ${key}` };
  return { tier: DEFAULT_TIER[t] ?? 'ask', reason: `default for ${t}` };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessions = new Map(); // id -> session
const clients = new Set();  // SSE responses

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(line);
}

function record(sid, ev) {
  const s = sessions.get(sid);
  const full = { ...ev, session: sid, at: ev.at || Date.now() };
  if (s) {
    s.events.push(full);
    fs.appendFileSync(path.join(RECORDINGS, `${s.id}.jsonl`), JSON.stringify(full) + '\n');
  }
  broadcast(full);
}

function summary(s) {
  return {
    id: s.id, name: s.name, state: s.state, worktree: s.worktree, branch: s.branch,
    turns: s.turns, lastText: s.lastText, currentTool: s.currentTool, usage: s.usage,
    rateLimit: s.rateLimit, pending: [...s.pending.values()].map(pendingView), startedAt: s.startedAt,
  };
}
function pendingView(p) {
  return { id: p.id, session: p.sid, tool: p.tool, input: p.input, tier: p.tier, reason: p.reason, key: p.key, at: p.at };
}

function hooksSettings(sid) {
  const url = (ev) => `http://${HOST}:${PORT}/hooks/${ev}?s=${sid}`;
  const h = (ev, timeout) => [{ hooks: [{ type: 'http', url: url(ev), timeout }] }];
  return {
    hooks: {
      PreToolUse: h('pre-tool', HOOK_TIMEOUT_S),
      PostToolUse: h('post-tool', 10),
      Stop: h('stop', 20),
      Notification: h('notification', 10),
      SubagentStart: h('subagent-start', 10),
      SubagentStop: h('subagent-stop', 10),
      PreCompact: h('pre-compact', 10),
    },
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createSession({ name, prompt }) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`max ${MAX_SESSIONS} sessions on this machine`);
  const id = randomUUID();
  const safe = String(name || 'agent').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 24) || 'agent';
  const branch = `cr/${safe}-${id.slice(0, 4)}`;
  const worktree = path.join(WORKTREES, `${safe}-${id.slice(0, 4)}`);
  git(WORKSPACE, ['worktree', 'add', '-B', branch, worktree, 'main']);

  const settingsPath = path.join(worktree, '.control-room-hooks.json');
  fs.writeFileSync(settingsPath, JSON.stringify(hooksSettings(id)));

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--settings', settingsPath,
    '--permission-mode', 'default',
    '--permission-prompts', 'none',
    '--model', MODEL,
    '--max-turns', MAX_TURNS,
    '--name', safe,
  ];
  const proc = spawn('claude', args, { cwd: worktree, stdio: ['pipe', 'pipe', 'pipe'] });

  const s = {
    id, name: safe, branch, worktree, proc, state: 'starting', turns: 0, lastText: '', currentTool: null,
    usage: null, rateLimit: null, pending: new Map(), events: [], startedAt: Date.now(), buf: '',
  };
  sessions.set(id, s);
  record(id, { type: 'session', subtype: 'created', name: safe, branch, worktree, prompt });

  proc.stderr.on('data', (d) => record(id, { type: 'stderr', text: String(d).slice(0, 2000) }));
  proc.stdout.on('data', (d) => {
    s.buf += d;
    const lines = s.buf.split('\n');
    s.buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      onStream(s, j);
    }
  });
  proc.on('exit', (code) => {
    s.state = 'exited';
    record(id, { type: 'session', subtype: 'exited', code });
    broadcast({ type: 'session-state', session: id, state: s.state });
  });

  send(s, prompt);
  return s;
}

function send(s, text) {
  const m = { type: 'user', message: { role: 'user', content: text } };
  s.proc.stdin.write(JSON.stringify(m) + '\n');
  s.state = 'working';
  record(s.id, { type: 'prompt', text });
  broadcast({ type: 'session-state', session: s.id, state: s.state });
}

function onStream(s, j) {
  // Keep the recording compact: store what the UI needs, not raw payloads.
  switch (j.type) {
    case 'system':
      if (j.subtype === 'init') {
        s.state = 'working';
        record(s.id, { type: 'init', model: j.model, claudeSession: j.session_id, apiKeySource: j.apiKeySource });
      } else if (j.subtype === 'hook_started' || j.subtype === 'hook_response') {
        // hook traffic is already recorded by our endpoints; skip to reduce noise
      } else if (j.subtype === 'api_error') {
        record(s.id, { type: 'api_error', attempt: j.retryAttempt, max: j.maxRetries, in: j.retryInMs });
      } else {
        record(s.id, { type: 'system', subtype: j.subtype, detail: trim(j) });
      }
      break;
    case 'assistant': {
      const content = j.message?.content || [];
      for (const b of content) {
        if (b.type === 'text' && b.text) { s.lastText = b.text.slice(0, 400); record(s.id, { type: 'text', text: b.text }); }
        if (b.type === 'tool_use') { s.currentTool = b.name; record(s.id, { type: 'tool_use', id: b.id, tool: b.name, input: b.input }); }
      }
      if (j.message?.usage) s.usage = pickUsage(j.message.usage);
      break;
    }
    case 'user': {
      const content = j.message?.content || [];
      for (const b of content) {
        if (b.type === 'tool_result') {
          s.currentTool = null;
          record(s.id, { type: 'tool_result', id: b.tool_use_id, is_error: !!b.is_error, content: String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 1500) });
        }
      }
      break;
    }
    case 'rate_limit_event':
      s.rateLimit = j.rate_limit_info?.unifiedWindows || null;
      record(s.id, { type: 'rate_limit', windows: s.rateLimit });
      break;
    case 'result':
      s.turns += 1;
      s.state = 'idle';
      s.currentTool = null;
      record(s.id, {
        type: 'result', subtype: j.subtype, num_turns: j.num_turns, duration_ms: j.duration_ms,
        cost_usd: j.total_cost_usd, denials: (j.permission_denials || []).map((p) => ({ tool: p.tool_name, input: p.tool_input })),
        text: String(j.result || '').slice(0, 2000),
      });
      break;
    default:
      break;
  }
  broadcast({ type: 'session-state', session: s.id, state: s.state, currentTool: s.currentTool, turns: s.turns, usage: s.usage, rateLimit: s.rateLimit, lastText: s.lastText });
}

function pickUsage(u) {
  return { in: u.input_tokens, out: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens };
}
function trim(o) { const s = JSON.stringify(o); return s.length > 600 ? s.slice(0, 600) + '…' : s; }

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
function decide(sid, id, decision, why, scope = 'once') {
  const s = sessions.get(sid);
  if (!s) return false;
  const p = s.pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  s.pending.delete(id);
  if (scope === 'always') rules.set(p.key, decision === 'allow' ? 'log' : 'never');
  p.respond(decision, why);
  record(sid, { type: 'decision', id, decision, why, scope, tool: p.tool, key: p.key, waitedMs: Date.now() - p.at });
  if (s.pending.size === 0 && s.state === 'waiting') s.state = 'working';
  broadcast({ type: 'session-state', session: sid, state: s.state });
  broadcast({ type: 'rules', rules: Object.fromEntries(rules) });
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
function hookOk(res, extra = {}) { json(res, 200, extra); }
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const sid = url.searchParams.get('s');

  // ---- hooks from Claude Code (always answer 200 + JSON; anything else fails open) ----
  if (url.pathname.startsWith('/hooks/')) {
    let hook = {};
    try { hook = JSON.parse(await readBody(req) || '{}'); } catch { /* keep {} */ }
    const s = sessions.get(sid);
    const ev = url.pathname.slice('/hooks/'.length);

    if (ev === 'pre-tool') {
      const { tier, reason } = classify(hook);
      const id = hook.tool_use_id || randomUUID();
      const respond = (decision, why) => hookOk(res, {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `control room: ${why}` },
      });
      if (!s) return respond('deny', 'unknown session');
      if (tier === 'never') { record(sid, { type: 'decision', id, decision: 'deny', why: reason, scope: 'policy', tool: hook.tool_name, input: hook.tool_input, tier }); return respond('deny', `never (${reason})`); }
      if (tier === 'log') { record(sid, { type: 'decision', id, decision: 'allow', why: reason, scope: 'policy', tool: hook.tool_name, input: hook.tool_input, tier }); return respond('allow', `do and log (${reason})`); }
      // ask: hold the response until the UI decides, or fail closed
      const item = { id, sid, tool: hook.tool_name, input: hook.tool_input, tier, reason, key: ruleKey(hook), at: Date.now(), respond };
      item.timer = setTimeout(() => decide(sid, id, 'deny', 'no human answer; control room fails closed'), ASK_TIMEOUT_MS);
      s.pending.set(id, item);
      s.state = 'waiting';
      record(sid, { type: 'ask', ...pendingView(item) });
      broadcast({ type: 'session-state', session: sid, state: s.state });
      return; // response is sent by decide()
    }

    if (ev === 'post-tool') {
      if (s) record(sid, { type: 'post_tool', id: hook.tool_use_id, tool: hook.tool_name, duration_ms: hook.duration_ms, response: trim(hook.tool_response ?? '') });
      return hookOk(res);
    }
    if (ev === 'stop') {
      if (s) {
        // commit per turn so "undo" is a git revert
        try {
          git(s.worktree, ['add', '-A']);
          const msg = `turn ${s.turns + 1}: ${(hook.last_assistant_message || '').replace(/\s+/g, ' ').slice(0, 60)}`;
          git(s.worktree, ['-c', 'user.name=Control Room', '-c', 'user.email=control-room@local', 'commit', '-qm', msg, '--allow-empty']);
          const sha = git(s.worktree, ['rev-parse', '--short', 'HEAD']);
          record(sid, { type: 'checkpoint', sha, msg });
        } catch (e) { record(sid, { type: 'checkpoint_error', error: String(e.message).slice(0, 300) }); }
      }
      return hookOk(res);
    }
    if (s) record(sid, { type: 'hook', event: ev, detail: trim(hook) });
    return hookOk(res);
  }

  // ---- UI API ----
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(UI));
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: [...sessions.values()].map(summary), rules: Object.fromEntries(rules), defaults: DEFAULT_TIER })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    return json(res, 200, { sessions: [...sessions.values()].map(summary), rules: Object.fromEntries(rules), defaults: DEFAULT_TIER });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/recordings/')) {
    const id = url.pathname.split('/')[2];
    const s = sessions.get(id);
    return json(res, 200, s ? s.events : []);
  }
  if (req.method === 'POST' && url.pathname === '/sessions') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      if (!b.prompt) return json(res, 400, { error: 'prompt required' });
      const s = createSession({ name: b.name, prompt: b.prompt });
      return json(res, 200, summary(s));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/decide') {
    const b = JSON.parse(await readBody(req) || '{}');
    const ok = decide(b.session, b.id, b.decision === 'allow' ? 'allow' : 'deny', b.why || `human ${b.decision} (${b.scope || 'once'})`, b.scope || 'once');
    return json(res, ok ? 200 : 404, { ok });
  }
  if (req.method === 'POST' && url.pathname === '/message') {
    const b = JSON.parse(await readBody(req) || '{}');
    const s = sessions.get(b.session);
    if (!s || s.state === 'exited') return json(res, 404, { error: 'no such live session' });
    send(s, b.text);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    const b = JSON.parse(await readBody(req) || '{}');
    const s = sessions.get(b.session);
    if (!s) return json(res, 404, { error: 'no such session' });
    for (const id of [...s.pending.keys()]) decide(s.id, id, 'deny', 'session stopped');
    if (b.hard) s.proc.kill('SIGTERM'); else s.proc.stdin.end();
    record(s.id, { type: 'session', subtype: b.hard ? 'killed' : 'stopping' });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/undo') {
    const b = JSON.parse(await readBody(req) || '{}');
    const s = sessions.get(b.session);
    if (!s) return json(res, 404, { error: 'no such session' });
    try {
      const before = git(s.worktree, ['rev-parse', '--short', 'HEAD']);
      git(s.worktree, ['reset', '--hard', 'HEAD~1']);
      const after = git(s.worktree, ['rev-parse', '--short', 'HEAD']);
      record(s.id, { type: 'undo', from: before, to: after });
      return json(res, 200, { ok: true, from: before, to: after });
    } catch (e) { return json(res, 400, { error: String(e.message).slice(0, 300) }); }
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`control room  http://${HOST}:${PORT}`);
  console.log(`workspace     ${WORKSPACE}`);
  console.log(`recordings    ${RECORDINGS}`);
});

process.on('SIGINT', () => {
  for (const s of sessions.values()) { try { s.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  process.exit(0);
});
