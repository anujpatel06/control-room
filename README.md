# Control Room

**A pull request tells you what changed. This tells you what nearly happened.**

When a coding agent writes a branch, the person who reviews it has no idea what the agent tried, what a human refused, or what got rolled back. The diff is the only thing that survives, and the diff is the one artifact that cannot show you any of it.

Control Room gates a coding agent's actions so a human decides the risky ones, records every one of those decisions, and then turns the session into a short narrated page written for **the reviewer**, not for the person who was in the room. That page is a link. It goes on the pull request.

```
agent acts  →  gate holds it  →  human decides  →  recording  →  session record  →  PR comment
                                        ↑                              ↑
                              the data nobody keeps          the artifact nobody ships
```

## Why the gate is not the point

Gating agent tool calls is a solved problem and several teams do it better:

- **[Prempti](https://prempti.falco.org/)** (Falco, CNCF, Apache 2.0) runs a real rule engine over every tool call, with policies in ordinary Falco YAML and a monitor mode for tuning them. Its homepage promises "a story of the session, not just the diff" — then ships that story as a local log file with no viewer.
- **[Agent Approve](https://www.agentapprove.com/)** puts each approval on your Apple Watch across twelve different agents, and parses chained shell commands so a dangerous one cannot hide behind a safe one. When the session ends it leaves no artifact at all.
- **[Endor Labs](https://www.endorlabs.com/)** streams every action into a searchable audit trail for enterprise security teams, and can rewrite a command before it runs. What it posts on your pull request is security findings about the code, never the story of the session.
- Claude Code, Cursor, Antigravity, Warp, Devin and Goose all ship their own allow/deny/ask lists, and Anthropic's **auto mode** now lets a classifier decide, on the evidence that users approve 93% of the prompts they see.

All of them capture the moment a human refuses something. None of them passes it on. Prempti writes it to a log for a security engineer, Agent Approve shows it to one person on a watch, Endor files it for an auditor.

**The gate here exists to produce the recording.** It is the instrument, not the product. If you already run Prempti, its audit trail is richer than ours and reading it as an input is the obvious next step; see *Roadmap*.

## The consent gradient

Every tool call passes through an HTTP `PreToolUse` hook to this server, which sorts it into a tier:

| Tier | What happens | Default for |
|---|---|---|
| never | denied, no prompt, logged | `rm -rf`, `git push`, `sudo`, `.env`, `curl … | sh` |
| ask | held until a human decides in the UI; denied if nobody answers in 2 minutes (fails closed) | Bash, Edit, Write, WebFetch, Task |
| log | allowed, receipt recorded | Read, Glob, Grep |

"Allow always" and "Never" turn a decision into a rule for the rest of the run, keyed by tool and first word of the command, or file extension for edits. In lab mode every turn is committed in the agent's worktree by the `Stop` hook, so **Undo turn** is a `git reset --hard HEAD~1`.

Agents in lab mode are real Claude Code sessions (`claude -p`) on your Claude subscription, each in its own git worktree under `workspace/.worktrees/`. No API key, no paid infrastructure, anywhere in this project.

## Run

```bash
node server/index.mjs
```

Open http://127.0.0.1:47653, name an agent, give it a task in the workspace (the Tempo demo), and watch the "Needs you" column.

## Why the hook must answer fast

Claude Code treats a hook that times out, errors, or returns anything other than `200` with JSON as a non-blocking error and lets the tool call proceed. So this server always answers with JSON, holds "ask" calls for at most `ASK_TIMEOUT_MS`, and denies when nobody decides. The hook's own timeout is set longer than that.

## Attach to the repo you already work in

The launcher above is "lab mode": the Control Room starts agents itself. Most days you start Claude Code yourself, in a terminal or in VS Code. Attach mode gates and records those sessions too.

```bash
node server/index.mjs                          # keep running, in any terminal
node scripts/attach.mjs ~/code/my-app          # once per repo; --detach to remove
```

That writes HTTP hooks into `my-app/.claude/settings.local.json` (Claude Code keeps that file out of git). From then on every Claude Code session in that repo:

- sends each tool call through the same consent gradient; "ask" calls wait for you at http://127.0.0.1:47653 and Claude Code skips its own prompt when the Control Room answers
- records the prompt, every decision, and each turn's working-tree diff into `recordings/`
- builds a recap automatically when the session ends

Differences from lab mode, on purpose: nothing is auto-committed on your branch, so there is no Undo button; the diff scene shows uncommitted changes instead. If the server is not running, Claude Code treats the hook as a non-blocking error and falls back to its own permission prompts, so attach fails open.

To put the recap on the pull request for that branch, click **Post to PR** on the session card, or:

```bash
node scripts/post-recap.mjs latest --dry-run                       # see the comment
node scripts/post-recap.mjs latest --url-base https://…/recaps     # gh pr comment, from your gh login
```

The comment carries the computed stats, every narration line, and the refused actions as text, plus a link to the page when `--url-base` (or `RECAP_URL_BASE`) says where `ui/recaps/` is hosted (GitHub Pages works). Posting is always a deliberate click or command; the server never posts on its own.

## Recap: the session as a short narrated story

> **Who it is for.** The recap is written for the *reviewer* — the person who opens a pull request an agent wrote and has to decide whether to trust it. They were not in the room, so the narration names the supervisor rather than saying "you", and it leads with the actions that never happened. Pass `--audience supervisor` for the second-person version.


Mainframe-style "watch your agent work", built from the recording instead of a screen capture.

```bash
node scripts/build-recap.mjs latest            # or a session id prefix
node scripts/build-recap.mjs latest --llm      # let Claude rewrite the sentences (needs `claude login`)
node scripts/build-recap.mjs latest --no-audio --voice Daniel --avatar AP
```

Writes one self-contained file to `ui/recaps/<agent>-<id>.html` (served at `/recaps/…` by the server, and there is a **Recap** button on each session card). The page plays 8 to 12 scenes with captions and narration: the task verbatim, every ask card with the answer you gave and how long you took, each turn's diff, anything you undid (recovered from the worktree reflog, so the story stays honest), and intent versus outcome.

Rules the builder follows:

- Every number, diff and decision is computed from `recordings/<session>.jsonl` and the worktree's git history. With `--llm`, Claude only rewrites the narration sentences; it cannot add or change a fact, and the page says which mode produced it.
- Narration is macOS `say` converted to AAC and embedded, so the file needs no server and no API key. About 6 KB per second of speech.
- The storyboard is also written to `recaps/<agent>-<id>.json` for inspection.

## The branch is the unit, not the session

A reviewer opens a pull request, not a session. One branch collects several agent
sessions over days, so the record they get merges all of them:

```bash
node scripts/build-recap.mjs --branch feat/third-task --repo ~/code/my-app
```

That writes `ui/recaps/<repo>--<branch>.html`: every instruction given, numbered in
order, each session's decisions and diffs, and one closing view of what the branch
asked for against what actually happened.

## Hand it over at push time

Pushing is the moment the work stops being yours and becomes someone else's to
review, so that is when the record should change hands.

```bash
node scripts/install-push-hook.mjs ~/code/my-app
```

That installs a `pre-push` hook. On your next push it builds the branch record,
prints what it found including anything refused, and — only if there is an open
pull request — asks whether to post it. Answer `y` and it comments; anything else
and the push just continues.

Three rules it follows:

- **It never blocks a push.** No sessions on the branch, no server, a crash, a
  timeout: it prints one dim line at most and exits 0.
- **It never posts without you.** A record of what you refused is more revealing
  than a diff. Publishing that to a shared pull request is your call, every time.
- **It stays fast.** Narration is skipped by default, because a minute of `say`
  at every push is not acceptable. Set `RECAP_AUDIO=1` when you want the good one.

Set `RECAP_URL_BASE` to the hosted path so the comment can link to the page:

```bash
export RECAP_URL_BASE=https://<user>.github.io/<repo>/recaps
```

Today the poster speaks GitHub, through the `gh` CLI. Bitbucket and GitLab each
need their own small poster; the record itself is provider-agnostic, since it is
just a hosted page and a link.

## Publish the records

Recap pages are self-contained HTML, so GitHub Pages hosts them for free and the links in pull request comments resolve for anyone who can see the repo.

```bash
node scripts/publish-pages.mjs --base https://<user>.github.io/<repo>
```

That copies every built recap into `docs/recaps/` and writes `docs/index.html`, an index of the sessions on record. Commit `docs/`, then set **Settings → Pages → branch `main`, folder `/docs`**. Preview it locally first at http://127.0.0.1:47653/docs/ while the server is running.

## Study

The claim this project makes is testable: a reviewer who sees the session record catches something a reviewer who sees only the diff misses. [`STUDY.md`](STUDY.md) is the protocol — two seeded-error tasks, three participants, and rules for reporting the result honestly including when it is negative.

## Roadmap

- **Read Prempti's audit trail as an input.** Their recording is structured, local, Apache-licensed and covers more than ours. The recap builder reads its own JSONL today; a second reader would let anyone already running Prempti get a session record without changing their gate.
- **A Cursor adapter.** The server speaks JSON in and JSON out, so a tool that runs a script instead of calling a URL needs about twenty lines of translation. Cursor's `beforeShellExecution` is the first target.
- **Port the recap player to React.** It is one self-contained page today.

## Files

- `server/index.mjs`, spawn sessions, hooks, policy, recorder, undo
- `ui/index.html`, sessions, triage of pending approvals, rules, log
- `scripts/attach.mjs`, install or remove the hooks in a repo of your own; `scripts/post-recap.mjs`, comment the recap on its PR
- `scripts/build-recap.mjs` + `ui/recap.template.html`, narrated recap page per session
- `scripts/build-replay.mjs` + `ui/replay.template.html`, full event-level replay
- `scripts/publish-pages.mjs`, build the `docs/` folder GitHub Pages serves
- `scripts/install-push-hook.mjs` + `scripts/push-record.mjs`, hand the branch record over at `git push`
- `workspace/`, the repo agents work on (seeded with the Tempo demo)
- `recordings/<session>.jsonl`, every event and decision; `recordings/demo/` is committed so the recaps can be rebuilt from source
- `STUDY.md`, the protocol for testing whether any of this helps a reviewer
