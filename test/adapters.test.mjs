// Six harnesses, one gate.
//
// These run the real launcher as a subprocess against the real server, feeding
// each agent's own payload on stdin exactly as its vendor documents it, and
// reading back what the agent would read. Nothing is stubbed, because the whole
// risk of an adapter is in the two translations at the edges: a deny that lands
// in the wrong shape is a deny nobody acts on, and a gate that reports success
// while allowing everything is the failure this project exists to catch.
//
// The two claims every adapter has to make good on:
//
//   · `rm -rf` is refused, whatever that harness calls its shell tool
//   · the refusal comes back in words that harness will act on
//
// What these tests cannot prove is that the vendor's documentation matches the
// vendor's build. Only Claude Code has been run against a live agent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47800 + Math.floor(Math.random() * 90);
const HOOK = join(root, 'scripts', 'hook.mjs');
let server, recordings;

before(async () => {
  recordings = mkdtempSync(join(tmpdir(), 'nearly-adapters-'));
  server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root, stdio: 'ignore',
    env: { ...process.env, NEARLY_PORT: String(PORT), NEARLY_ASK_TIMEOUT_MS: '2000', NEARLY_RECORDINGS: recordings },
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(recordings, { recursive: true, force: true });
});

// Run the launcher the way the harness's own config file runs it.
function fire(adapter, event, payload, repo = 'adapters-test') {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK, event, repo, `--adapter=${adapter}`], {
      env: { ...process.env, NEARLY_PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code }));
    p.stdin.end(JSON.stringify(payload));
  });
}

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Each harness's payloads, in its own dialect, with the field names its docs
// give. The session id field differs in every one of them, which is exactly the
// sort of detail that is silently wrong until something like this runs.
const CASES = {
  cursor: {
    id: 'conversation_id',
    danger: (s) => ({ conversation_id: s, cwd: root, tool_name: 'run_terminal_cmd', tool_input: { command: 'rm -rf build' }, tool_use_id: 't1', workspace_roots: [root] }),
    safe: (s) => ({ conversation_id: s, cwd: root, tool_name: 'read_file', tool_input: { file_path: '/tmp/x' }, tool_use_id: 't2', workspace_roots: [root] }),
    denied: (r) => json(r.out)?.permission === 'deny',
    allowed: (r) => json(r.out)?.permission === 'allow',
  },
  antigravity: {
    id: 'conversationId',
    // The nested call and the PascalCase argument are both real, and both are
    // why a name-only tool table would have missed this command entirely.
    danger: (s) => ({ conversationId: s, workspacePaths: [root], modelName: 'gemini-3-pro', stepIdx: 4, toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf build' } } }),
    safe: (s) => ({ conversationId: s, workspacePaths: [root], modelName: 'gemini-3-pro', stepIdx: 5, toolCall: { name: 'view_file', args: { AbsolutePath: '/tmp/x' } } }),
    denied: (r) => json(r.out)?.decision === 'deny',
    allowed: (r) => json(r.out)?.decision === 'allow',
  },
  copilot: {
    id: 'session_id',
    danger: (s) => ({ session_id: s, cwd: root, tool_name: 'bash', tool_input: { command: 'rm -rf build' } }),
    safe: (s) => ({ session_id: s, cwd: root, tool_name: 'view', tool_input: { file_path: '/tmp/x' } }),
    denied: (r) => json(r.out)?.permissionDecision === 'deny',
    allowed: (r) => json(r.out)?.permissionDecision === 'allow',
  },
  codex: {
    id: 'session_id',
    danger: (s) => ({ session_id: s, turn_id: 'turn-1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'rm -rf build' }, tool_use_id: 'c1' }),
    safe: (s) => ({ session_id: s, turn_id: 'turn-1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_input: { file_path: '/tmp/x' }, tool_use_id: 'c2' }),
    denied: (r) => json(r.out)?.hookSpecificOutput?.permissionDecision === 'deny',
    // Codex does nothing with "allow", so silence is how a call is let through.
    allowed: (r) => r.out === '' && r.code === 0,
  },
  gemini: {
    id: 'session_id',
    danger: (s) => ({ session_id: s, cwd: root, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf build' } }),
    safe: (s) => ({ session_id: s, cwd: root, hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { absolute_path: '/tmp/x' } }),
    denied: (r) => json(r.out)?.decision === 'deny',
    allowed: (r) => json(r.out)?.decision === 'allow',
  },
  windsurf: {
    id: 'trajectory_id',
    danger: (s) => ({ agent_action_name: 'pre_run_command', trajectory_id: s, execution_id: 'e1', model_name: 'swe-1', tool_info: { command_line: 'rm -rf build', cwd: root } }),
    safe: (s) => ({ agent_action_name: 'pre_read_code', trajectory_id: s, execution_id: 'e2', model_name: 'swe-1', tool_info: { file_path: '/tmp/x', cwd: root } }),
    // No JSON at all: Cascade reads the exit code and the reason on stderr.
    denied: (r) => r.code === 2 && /never/.test(r.err),
    allowed: (r) => r.code === 0 && r.out === '',
  },
};

let n = 0;
const sid = () => `adapter-${++n}-${Date.now()}`;

for (const [id, c] of Object.entries(CASES)) {
  test(`${id}: rm -rf is refused, in words ${id} acts on`, async () => {
    const s = sid();
    const r = await fire(id, 'pre-tool', c.danger(s));
    assert.ok(c.denied(r), `${id} did not receive a refusal it can read: ${JSON.stringify(r)}`);
  });

  test(`${id}: an ordinary read is let through`, async () => {
    const s = sid();
    const r = await fire(id, 'pre-tool', c.safe(s));
    assert.ok(c.allowed(r), `${id} did not receive a pass it can read: ${JSON.stringify(r)}`);
  });

  test(`${id}: a session appears from its own id field, ${c.id}`, async () => {
    const s = sid();
    await fire(id, 'pre-tool', c.safe(s));
    const state = await fetch(`http://127.0.0.1:${PORT}/state`).then((r) => r.json());
    assert.ok(state.sessions.some((x) => x.id === s),
      `${id} session never appeared; its id lives in ${c.id}`);
  });

  test(`${id}: a payload it never sends does not wedge the agent`, async () => {
    // Harnesses change. Garbage in has to mean the agent keeps working, not that
    // it hangs waiting for a hook that crashed.
    const r = await fire(id, 'pre-tool', { nonsense: true });
    assert.ok(r.code === 0 || r.code === 2, `${id} exited ${r.code} on an unrecognised payload`);
  });
}

test('an adapter id nobody recognises still lets the session run', async () => {
  const r = await fire('not-a-real-agent', 'pre-tool', { session_id: sid(), tool_name: 'Read', tool_input: {} });
  assert.equal(r.code, 0);
});
