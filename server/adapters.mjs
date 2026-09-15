// One gate, six harnesses.
//
// Nearly's server speaks one dialect: Claude Code's. Everything downstream of a
// hook — the consent gradient, the recording, the record page, the PR comment —
// reads that shape and nothing else. So supporting another agent is not a
// second gate. It is a translation at the edge: turn their payload into Claude
// Code's on the way in, turn our answer into theirs on the way out. The server
// never learns that any of this happened.
//
// Three things make the translation small enough to be worth trusting.
//
// 1. Nearly never asks the harness to ask. Every one of these has some notion of
//    "prompt the user", and we want none of them, because their dialog is not
//    the record. We hold the hook open instead and answer allow or deny once a
//    human has. So the only thing an adapter needs is a pre-tool hook that
//    blocks, which is the one thing all of them have.
//
// 2. Tools are matched by shape, not only by name. `run_command`, `shell`,
//    `run_terminal_cmd` and `bash` are all Bash, and anything carrying a command
//    string is treated as Bash even when nobody here has heard of it — because
//    if it is not, the never-rules do not apply to it, and `rm -rf` walks
//    through a gate that reports itself as working. Unknown falls to "ask".
//
// 3. The raw name still travels, as tool_label, so the record says what the
//    agent actually called rather than what we translated it to.
//
// Honesty about what this is: every format below is taken from the vendor's own
// hook documentation, and every one is exercised in test/adapters.test.mjs
// against payloads copied from those docs. Only Claude Code has been run end to
// end against a live agent. An adapter built to spec is a claim, not a
// demonstration, and `nearly agents` says so out loud.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Tool identity
// ---------------------------------------------------------------------------

// Canonical names are Claude Code's, because that is what server/policy.mjs
// keys on, and because a rule you set in one harness should mean the same thing
// in the next one.
const CANON = new Set(['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep',
  'LS', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite']);

const TOOL_ALIASES = {
  // shell — the safety-critical row: a miss here disables the never-rules
  run_command: 'Bash', run_terminal_cmd: 'Bash', run_shell_command: 'Bash',
  shell: 'Bash', bash: 'Bash', local_shell: 'Bash', terminal: 'Bash',
  execute_command: 'Bash', runcommand: 'Bash', run_in_terminal: 'Bash',
  // read
  view_file: 'Read', read_file: 'Read', view: 'Read', open_file: 'Read',
  read_many_files: 'Read', readfile: 'Read',
  // write
  write_to_file: 'Write', write_file: 'Write', create_file: 'Write', create: 'Write',
  // edit
  replace_file_content: 'Edit', multi_replace_file_content: 'Edit', replace: 'Edit',
  edit_file: 'Edit', str_replace: 'Edit', str_replace_editor: 'Edit',
  apply_patch: 'Edit', replace_string_in_file: 'Edit', edit_notebook: 'NotebookEdit',
  // search and listing
  grep: 'Grep', grep_search: 'Grep', search_file_content: 'Grep',
  codebase_search: 'Grep', semantic_search: 'Grep', ripgrep: 'Grep',
  glob: 'Glob', file_search: 'Glob', find_files: 'Glob',
  list_directory: 'LS', list_dir: 'LS', ls: 'LS',
  // network
  web_fetch: 'WebFetch', fetch: 'WebFetch', read_url: 'WebFetch', read_url_content: 'WebFetch',
  web_search: 'WebSearch', google_web_search: 'WebSearch', search_web: 'WebSearch',
  // delegation
  task: 'Task', spawn_agent: 'Task', subagent: 'Task',
};

// Different harnesses spell the same argument differently. Copy the ones policy
// and the record read into the names they expect, and leave everything else
// alone so nothing is lost from the record.
export function normalizeInput(input) {
  const i = (input && typeof input === 'object') ? { ...input } : {};
  const cmd = i.command ?? i.CommandLine ?? i.command_line ?? i.commandLine ?? i.cmd ?? i.script;
  if (typeof cmd === 'string') i.command = cmd;
  const fp = i.file_path ?? i.filePath ?? i.TargetFile ?? i.target_file ?? i.path
    ?? i.absolute_path ?? i.AbsolutePath;
  if (typeof fp === 'string') i.file_path = fp;
  return i;
}

// Name first, then shape. Shape is the safety net: an unrecognised tool that
// carries a command string is a shell call whatever its author called it.
export function canonicalTool(name, input) {
  const raw = String(name ?? '');
  if (CANON.has(raw)) return raw;
  const alias = TOOL_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (typeof input?.command === 'string') return 'Bash';
  if (typeof input?.file_path === 'string') {
    return (input.content !== undefined || input.contents !== undefined) ? 'Write' : 'Edit';
  }
  return raw || 'unknown';
}

// Everything an adapter produces for the server, in Claude Code's own words.
function toolEvent(p, { name, input, id, session, cwd, model }) {
  const tool_input = normalizeInput(input);
  const tool_name = canonicalTool(name, tool_input);
  const out = { session_id: session, cwd, tool_name, tool_input, tool_use_id: id };
  if (name && name !== tool_name) out.tool_label = String(name);
  if (model) out.model = model;
  return out;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

// ---------------------------------------------------------------------------
// Config file helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    // Some editors write these files with a byte-order mark. Windsurf's own
    // parser had to be taught to tolerate one; ours should not be worse.
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return undefined; }   // present but unreadable: distinct from absent
}

function writeJson(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// Ours is anything that runs nearly. Matching on that rather than on a version
// or a path is what makes attach safe to re-run, and what stopped a rename from
// orphaning hooks the last time.
const isOurs = (h) => /nearly/i.test(JSON.stringify(h ?? ''));

// Strip our entries out of an event map shaped { event: [entry, ...] }, and drop
// events we emptied so the file does not fill with husks.
function stripEvents(map) {
  for (const ev of Object.keys(map || {})) {
    const kept = (map[ev] || []).filter((e) => !isOurs(e));
    if (kept.length) map[ev] = kept; else delete map[ev];
  }
  return map;
}

// How long each pre-tool hook may hold while a person decides. Everything else
// should be quick. The unit differs per harness; the intent does not.
const SECONDS = {
  'pre-tool': 600,      // long enough to hold while a human decides
  'session-end': 120,   // the record is built off the back of this one
  stop: 30,
};
const holdFor = (ev) => SECONDS[ev] ?? 20;

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------

// Claude Code's own answer shape, which is what the server returns.
const decisionOf = (answer) => answer?.hookSpecificOutput?.permissionDecision
  ?? answer?.permissionDecision ?? null;
const reasonOf = (answer) => answer?.hookSpecificOutput?.permissionDecisionReason
  ?? answer?.permissionDecisionReason ?? 'nearly';

// Passing the answer through untouched, for harnesses that already speak it.
const passThrough = (ev, answer) => ({ stdout: JSON.stringify(answer ?? {}), exit: 0 });

export const ADAPTERS = [

  // -------------------------------------------------------------------------
  {
    id: 'claude-code',
    name: 'Claude Code',
    verified: 'run end to end against a live agent',
    config: '.claude/settings.local.json',
    // Also read by Claude Code inside VS Code and JetBrains, which is why those
    // editors need no adapter of their own.
    events: {
      SessionStart: 'session-start', UserPromptSubmit: 'prompt', PreToolUse: 'pre-tool',
      PostToolUse: 'post-tool', Stop: 'stop', SessionEnd: 'session-end',
    },
    install({ repo, cmdFor }) {
      const file = join(repo, '.claude', 'settings.local.json');
      const s = readJson(file);
      if (s === undefined) return { error: `could not read ${file}` };
      const settings = s || {};
      settings.hooks = stripEvents(settings.hooks || {});
      for (const [their, ours] of Object.entries(this.events)) {
        settings.hooks[their] = [...(settings.hooks[their] || []),
          { hooks: [{ type: 'command', command: cmdFor(ours), timeout: holdFor(ours) }] }];
      }
      writeJson(file, settings);
      return { file };
    },
    uninstall({ repo }) {
      const file = join(repo, '.claude', 'settings.local.json');
      const settings = readJson(file);
      if (!settings || settings.hooks === undefined) return { removed: false };
      settings.hooks = stripEvents(settings.hooks);
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      writeJson(file, settings);
      return { removed: true, file };
    },
    normalize: (ev, p) => p,      // already canonical
    render: passThrough,
  },

  // -------------------------------------------------------------------------
  {
    id: 'cursor',
    name: 'Cursor',
    verified: null,
    config: '.cursor/hooks.json',
    // preToolUse is the gate rather than beforeShellExecution, because it covers
    // every tool with one entry and cannot double-fire against the shell hook.
    // Its documented output has no "ask", which costs us nothing: we hold the
    // hook and answer allow or deny ourselves.
    events: {
      sessionStart: 'session-start', beforeSubmitPrompt: 'prompt', preToolUse: 'pre-tool',
      postToolUse: 'post-tool', stop: 'stop', sessionEnd: 'session-end',
    },
    install({ repo, cmdFor }) {
      const file = join(repo, '.cursor', 'hooks.json');
      const c = readJson(file);
      if (c === undefined) return { error: `could not read ${file}` };
      const cfg = c || { version: 1, hooks: {} };
      cfg.version = cfg.version || 1;
      cfg.hooks = stripEvents(cfg.hooks || {});
      for (const [their, ours] of Object.entries(this.events)) {
        cfg.hooks[their] = [...(cfg.hooks[their] || []),
          { command: cmdFor(ours), timeout: holdFor(ours), failClosed: ours === 'pre-tool' }];
      }
      writeJson(file, cfg);
      return { file };
    },
    uninstall({ repo }) {
      const file = join(repo, '.cursor', 'hooks.json');
      const cfg = readJson(file);
      if (!cfg || cfg.hooks === undefined) return { removed: false };
      cfg.hooks = stripEvents(cfg.hooks);
      if (!Object.keys(cfg.hooks).length) rmSync(file, { force: true });
      else writeJson(file, cfg);
      return { removed: true, file };
    },
    normalize(ev, p) {
      // conversation_id is on every Cursor event; session_id only on sessionStart.
      const session = p.conversation_id || p.session_id;
      const cwd = p.cwd || first(p.workspace_roots);
      if (ev === 'pre-tool' || ev === 'post-tool') {
        // beforeShellExecution sends a bare command with no tool name; treat it
        // as the shell tool it is, in case someone wires that event up instead.
        const name = p.tool_name ?? (p.command !== undefined ? 'run_terminal_cmd' : undefined);
        const input = p.tool_input ?? (p.command !== undefined ? { command: p.command } : {});
        const base = toolEvent(p, { name, input, id: p.tool_use_id, session, cwd, model: p.model });
        if (ev === 'post-tool') {
          base.tool_response = p.tool_output ?? p.output;
          base.duration_ms = p.duration;
        }
        return base;
      }
      if (ev === 'prompt') return { session_id: session, cwd, prompt: p.prompt };
      if (ev === 'stop') return { session_id: session, cwd, last_assistant_message: p.text };
      if (ev === 'session-end') return { session_id: session, cwd, reason: p.reason || p.final_status };
      return { session_id: session, cwd };
    },
    render(ev, answer) {
      if (ev !== 'pre-tool') return { stdout: '', exit: 0 };
      const d = decisionOf(answer);
      if (!d) return { stdout: '', exit: 0 };
      return {
        stdout: JSON.stringify({
          permission: d === 'deny' ? 'deny' : 'allow',
          user_message: reasonOf(answer),
          agent_message: reasonOf(answer),
        }),
        exit: 0,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'antigravity',
    name: 'Antigravity',
    verified: null,
    config: '.agents/hooks.json',
    // Antigravity nests the call under toolCall and spells the shell argument
    // CommandLine. Both are handled by normalizeInput and canonicalTool, so the
    // policy sees `Bash` with a `command` like everywhere else.
    events: {
      PreToolUse: 'pre-tool', PostToolUse: 'post-tool',
      PreInvocation: 'prompt', PostInvocation: 'stop', Stop: 'session-end',
    },
    install({ repo, cmdFor }) {
      const file = join(repo, '.agents', 'hooks.json');
      const c = readJson(file);
      if (c === undefined) return { error: `could not read ${file}` };
      const cfg = c || {};
      // Antigravity's top level is a map of named containers, so ours is one key
      // and anybody else's are untouched.
      cfg.nearly = { enabled: true };
      for (const [their, ours] of Object.entries(this.events)) {
        cfg.nearly[their] = [{ matcher: '.*', handler: { command: cmdFor(ours), timeout: holdFor(ours) } }];
      }
      writeJson(file, cfg);
      return { file };
    },
    uninstall({ repo }) {
      const file = join(repo, '.agents', 'hooks.json');
      const cfg = readJson(file);
      if (!cfg || cfg.nearly === undefined) return { removed: false };
      delete cfg.nearly;
      if (!Object.keys(cfg).length) rmSync(file, { force: true });
      else writeJson(file, cfg);
      return { removed: true, file };
    },
    normalize(ev, p) {
      const session = p.conversationId || p.conversation_id;
      const cwd = first(p.workspacePaths) || first(p.workspace_paths);
      const model = p.modelName || p.model_name;
      if (ev === 'pre-tool' || ev === 'post-tool') {
        const call = p.toolCall || p.tool_call || {};
        const base = toolEvent(p, {
          name: call.name ?? p.tool_name, input: call.args ?? p.tool_input,
          id: p.stepIdx != null ? `step-${p.stepIdx}` : p.tool_use_id,
          session, cwd, model,
        });
        if (ev === 'post-tool') base.tool_response = p.toolResult ?? p.result ?? p.tool_response;
        return base;
      }
      if (ev === 'prompt') return { session_id: session, cwd, model, prompt: p.prompt ?? p.userMessage };
      if (ev === 'stop') return { session_id: session, cwd, model, last_assistant_message: p.response ?? p.text };
      if (ev === 'session-end') return { session_id: session, cwd, model, reason: p.reason };
      return { session_id: session, cwd, model };
    },
    render(ev, answer) {
      if (ev !== 'pre-tool') return { stdout: '', exit: 0 };
      const d = decisionOf(answer);
      if (!d) return { stdout: '', exit: 0 };
      return { stdout: JSON.stringify({ decision: d === 'deny' ? 'deny' : 'allow', reason: reasonOf(answer) }), exit: 0 };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    verified: null,
    config: '.github/hooks/nearly.json',
    // Copilot accepts PascalCase event names as a Claude Code compatibility
    // mode, and in that mode it sends snake_case fields and Claude's own tool
    // names. So this adapter is mostly a different file path.
    events: {
      SessionStart: 'session-start', UserPromptSubmit: 'prompt', PreToolUse: 'pre-tool',
      PostToolUse: 'post-tool', Stop: 'stop', SessionEnd: 'session-end',
    },
    install({ repo, cmdFor }) {
      const file = join(repo, '.github', 'hooks', 'nearly.json');
      const cfg = { version: 1, hooks: {} };
      for (const [their, ours] of Object.entries(this.events)) {
        cfg.hooks[their] = [{ type: 'command', command: cmdFor(ours), timeoutSec: holdFor(ours) }];
      }
      writeJson(file, cfg);        // our own file; nobody else's entries to keep
      return { file };
    },
    uninstall({ repo }) {
      const file = join(repo, '.github', 'hooks', 'nearly.json');
      if (!existsSync(file)) return { removed: false };
      rmSync(file, { force: true });
      return { removed: true, file };
    },
    normalize(ev, p) {
      // Tolerate both spellings: the payload arrives PascalCase-shaped when the
      // event is registered that way, camelCase when it is not.
      const session = p.session_id || p.sessionId;
      const cwd = p.cwd;
      if (ev === 'pre-tool' || ev === 'post-tool') {
        const base = toolEvent(p, {
          name: p.tool_name ?? p.toolName, input: p.tool_input ?? p.toolArgs,
          id: p.tool_use_id ?? p.toolUseId, session, cwd,
        });
        if (ev === 'post-tool') {
          base.tool_response = p.tool_response ?? p.toolOutput ?? p.result;
          base.duration_ms = p.duration_ms ?? p.duration;
        }
        return base;
      }
      if (ev === 'prompt') return { session_id: session, cwd, prompt: p.prompt };
      if (ev === 'stop') {
        return { session_id: session, cwd, transcript_path: p.transcriptPath ?? p.transcript_path,
          last_assistant_message: p.lastAssistantMessage ?? p.last_assistant_message };
      }
      if (ev === 'session-end') return { session_id: session, cwd, reason: p.reason };
      return { session_id: session, cwd };
    },
    render(ev, answer) {
      if (ev !== 'pre-tool') return { stdout: '', exit: 0 };
      const d = decisionOf(answer);
      if (!d) return { stdout: '', exit: 0 };
      // Flat is what the reference documents; the nested form is what the
      // Claude-compatible path reads. Sending both costs a few bytes and means
      // a doc that is behind the build cannot turn a deny into an allow.
      return {
        stdout: JSON.stringify({
          permissionDecision: d, permissionDecisionReason: reasonOf(answer),
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, permissionDecisionReason: reasonOf(answer) },
        }),
        exit: 0,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'codex',
    name: 'Codex CLI',
    verified: null,
    config: '.codex/hooks.json',
    // Codex parses "allow" and "ask" and does nothing with them: deny is the
    // only decision that moves. That suits us exactly, because holding the hook
    // open is how we ask, and an allow is simply the hook returning.
    events: { PreToolUse: 'pre-tool', PostToolUse: 'post-tool', SessionEnd: 'session-end' },
    install({ repo, cmdFor }) {
      const file = join(repo, '.codex', 'hooks.json');
      const c = readJson(file);
      if (c === undefined) return { error: `could not read ${file}` };
      const cfg = c || {};
      cfg.hooks = stripEvents(cfg.hooks || {});
      for (const [their, ours] of Object.entries(this.events)) {
        cfg.hooks[their] = [...(cfg.hooks[their] || []), {
          matcher: '.*',
          hooks: [{ type: 'command', command: cmdFor(ours), timeout: holdFor(ours) }],
        }];
      }
      writeJson(file, cfg);
      return { file, note: 'Codex has no session-start, prompt or turn hook, so the record has no prompts and one turn.' };
    },
    uninstall({ repo }) {
      const file = join(repo, '.codex', 'hooks.json');
      const cfg = readJson(file);
      if (!cfg || cfg.hooks === undefined) return { removed: false };
      cfg.hooks = stripEvents(cfg.hooks);
      if (!Object.keys(cfg.hooks).length) rmSync(file, { force: true });
      else writeJson(file, cfg);
      return { removed: true, file };
    },
    normalize(ev, p) {
      const session = p.session_id || p.sessionId;
      if (ev === 'pre-tool' || ev === 'post-tool') {
        const base = toolEvent(p, {
          name: p.tool_name, input: p.tool_input, id: p.tool_use_id, session, cwd: p.cwd,
        });
        if (ev === 'post-tool') base.tool_response = p.tool_response ?? p.tool_output;
        return base;
      }
      if (ev === 'session-end') return { session_id: session, cwd: p.cwd, reason: p.reason };
      return { session_id: session, cwd: p.cwd };
    },
    render(ev, answer) {
      if (ev !== 'pre-tool') return { stdout: '', exit: 0 };
      const d = decisionOf(answer);
      if (d !== 'deny') return { stdout: '', exit: 0 };   // anything else is a pass
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reasonOf(answer) },
        }),
        exit: 0,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'gemini',
    name: 'Gemini CLI',
    verified: null,
    config: '.gemini/settings.json',
    events: {
      SessionStart: 'session-start', BeforeAgent: 'prompt', BeforeTool: 'pre-tool',
      AfterTool: 'post-tool', AfterAgent: 'stop', SessionEnd: 'session-end',
    },
    install({ repo, cmdFor }) {
      const file = join(repo, '.gemini', 'settings.json');
      const s = readJson(file);
      if (s === undefined) return { error: `could not read ${file}` };
      // This file is the user's whole Gemini configuration, not ours. Merge into
      // it and never rewrite it wholesale.
      const settings = s || {};
      settings.hooks = stripEvents(settings.hooks || {});
      for (const [their, ours] of Object.entries(this.events)) {
        settings.hooks[their] = [...(settings.hooks[their] || []), {
          matcher: '.*',
          hooks: [{ type: 'command', name: `nearly ${ours}`, command: cmdFor(ours), timeout: holdFor(ours) * 1000 }],
        }];
      }
      writeJson(file, settings);
      return { file };
    },
    uninstall({ repo }) {
      const file = join(repo, '.gemini', 'settings.json');
      const settings = readJson(file);
      if (!settings || settings.hooks === undefined) return { removed: false };
      settings.hooks = stripEvents(settings.hooks);
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      if (!Object.keys(settings).length) rmSync(file, { force: true });
      else writeJson(file, settings);
      return { removed: true, file };
    },
    normalize(ev, p) {
      const base = { session_id: p.session_id, cwd: p.cwd, transcript_path: p.transcript_path };
      if (ev === 'pre-tool' || ev === 'post-tool') {
        const t = toolEvent(p, { name: p.tool_name, input: p.tool_input, id: p.tool_use_id, session: p.session_id, cwd: p.cwd });
        t.transcript_path = p.transcript_path;
        if (ev === 'post-tool') {
          // Gemini wraps the result; the record wants the part a person reads.
          t.tool_response = p.tool_response?.returnDisplay ?? p.tool_response?.llmContent ?? p.tool_response;
        }
        return t;
      }
      if (ev === 'prompt') return { ...base, prompt: p.prompt };
      if (ev === 'stop') return { ...base, last_assistant_message: p.prompt_response };
      if (ev === 'session-end') return { ...base, reason: p.reason };
      return { ...base, source: p.source };
    },
    render(ev, answer) {
      if (ev !== 'pre-tool') return { stdout: '', exit: 0 };
      const d = decisionOf(answer);
      if (!d) return { stdout: '', exit: 0 };
      return { stdout: JSON.stringify({ decision: d === 'deny' ? 'deny' : 'allow', reason: reasonOf(answer) }), exit: 0 };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'windsurf',
    name: 'Windsurf',
    verified: null,
    config: '.windsurf/hooks.json',
    // The odd one out twice over. Windsurf has no JSON answer at all — a pre
    // hook blocks by exiting 2 with the reason on stderr — and it has no single
    // pre-tool event, so the gate is spread across three.
    events: {
      pre_run_command: 'pre-tool', pre_write_code: 'pre-tool', pre_read_code: 'pre-tool',
      post_run_command: 'post-tool', pre_user_prompt: 'prompt', post_cascade_response: 'stop',
    },
    install({ repo, cmdFor }) {
      const file = join(repo, '.windsurf', 'hooks.json');
      const c = readJson(file);
      if (c === undefined) return { error: `could not read ${file}` };
      const cfg = c || {};
      cfg.hooks = stripEvents(cfg.hooks || {});
      for (const [their, ours] of Object.entries(this.events)) {
        cfg.hooks[their] = [...(cfg.hooks[their] || []), { command: cmdFor(ours), show_output: false }];
      }
      writeJson(file, cfg);
      return { file, note: 'Windsurf hooks have no configurable timeout, so a request held longer than Cascade waits is denied.' };
    },
    uninstall({ repo }) {
      const file = join(repo, '.windsurf', 'hooks.json');
      const cfg = readJson(file);
      if (!cfg || cfg.hooks === undefined) return { removed: false };
      cfg.hooks = stripEvents(cfg.hooks);
      if (!Object.keys(cfg.hooks).length) rmSync(file, { force: true });
      else writeJson(file, cfg);
      return { removed: true, file };
    },
    normalize(ev, p) {
      const session = p.trajectory_id || p.conversation_id;
      const info = p.tool_info || {};
      const cwd = info.cwd || p.cwd;
      if (ev === 'pre-tool' || ev === 'post-tool') {
        // The event name is the only tool name Windsurf gives, and pre_write_code
        // and pre_read_code carry file fields rather than a command. Shape
        // inference in canonicalTool is what sorts them out.
        const byEvent = { pre_run_command: 'run_command', post_run_command: 'run_command',
          pre_write_code: 'write_to_file', pre_read_code: 'view_file' };
        const base = toolEvent(p, {
          name: byEvent[p.agent_action_name] ?? p.agent_action_name,
          input: info, id: p.execution_id, session, cwd, model: p.model_name,
        });
        if (ev === 'post-tool') base.tool_response = info.output ?? p.output;
        return base;
      }
      if (ev === 'prompt') return { session_id: session, cwd, model: p.model_name, prompt: p.prompt ?? info.prompt };
      if (ev === 'stop') return { session_id: session, cwd, model: p.model_name, last_assistant_message: p.response ?? info.response };
      return { session_id: session, cwd, model: p.model_name };
    },
    render(ev, answer) {
      if (ev !== 'pre-tool') return { stdout: '', exit: 0 };
      if (decisionOf(answer) !== 'deny') return { stdout: '', exit: 0 };
      return { stdout: '', stderr: reasonOf(answer), exit: 2 };
    },
  },
];

export const byId = (id) => ADAPTERS.find((a) => a.id === id) || null;
export const ids = () => ADAPTERS.map((a) => a.id);
