# Control Room

A supervision surface for several long-running coding agents. Spike 1: one Node server, one HTML page, no dependencies, no API key.

Agents are real Claude Code sessions (`claude -p`) running on your Claude subscription, each in its own git worktree under `workspace/.worktrees/`. Every tool call passes through an HTTP `PreToolUse` hook to this server, which applies a consent gradient:

| Tier | What happens | Default for |
|---|---|---|
| never | denied, no prompt, logged | `rm -rf`, `git push`, `sudo`, `.env`, `curl … | sh` |
| ask | held until you decide in the UI; denied if nobody answers in 2 minutes (fails closed) | Bash, Edit, Write, WebFetch, Task |
| log | allowed, receipt recorded | Read, Glob, Grep |

"Allow always" and "Never" buttons turn a decision into a rule for the rest of the run, keyed by tool and first word of the command (or file extension for edits). Every turn is committed in the worktree by the `Stop` hook, so **Undo turn** is a `git reset --hard HEAD~1`.

## Run

```bash
node server/index.mjs
```

Open http://127.0.0.1:47653, name an agent, give it a task in the workspace (the Tempo demo), and watch the "Needs you" column.

## Why the hook must answer fast

Claude Code treats a hook that times out, errors, or returns anything other than `200` with JSON as a non-blocking error and lets the tool call proceed. So this server always answers with JSON, holds "ask" calls for at most `ASK_TIMEOUT_MS`, and denies when nobody decides. The hook's own timeout is set longer than that.

## Files

- `server/index.mjs`, spawn sessions, hooks, policy, recorder, undo
- `ui/index.html`, sessions, triage of pending approvals, rules, log
- `workspace/`, the repo agents work on (seeded with the Tempo demo)
- `recordings/<session>.jsonl`, every event and decision, for the replay demo later

## Not yet

Progressive delegation with track records, intent-versus-outcome view at handoff, multiplayer, replay page. Those are weeks 3 to 6.
