# Nearly

**A pull request tells you what changed. This tells you what nearly happened.**

When a coding agent writes a branch, the person reviewing it has no idea what the agent tried, what a human refused, or what got rolled back. The diff is the only thing that survives, and the diff is the one artifact that cannot show you any of it.

Nearly holds an agent's risky actions until a human decides, records every one of those decisions, and turns the branch into a short narrated page written for **the reviewer**. That page is a link, and it goes on the pull request.

```
you work normally  →  agent acts  →  risky action held  →  you decide
                                                              ↓
   reviewer opens the PR  ←  comment posted  ←  you push  ←  recorded
```

## Look before you install anything

Nothing to run. This is a real record from two real agent sessions on one branch:

**[A branch where three things never happened →](https://anujpatel06.github.io/nearly/records/priya-app--feat-third-task.html)**

Watch the first thirty seconds. The cover says what the diff cannot: an action the supervisor refused, a push policy blocked, and a file deletion refused. [Here is how it looks on the pull request.](https://github.com/anujpatel06/tempo-demo/pull/2)

## What it needs

Node 18 or newer, Claude Code signed in, and git. No dependencies and no API key: agents run on your existing Claude subscription.

Gating, recording and the record itself work on macOS, Linux and Windows. **Spoken narration is macOS only**, because it uses the built-in `say`. Elsewhere the record is built the same way and reads from its captions, or you can supply your own recordings with `--voice-dir`.

## Use it on your own repo

One command, in the repo you want recorded.

```bash
cd ~/code/my-app
nearly
```

```
✓ Nearly is on for my-app

  · every Claude Code session here is gated and recorded
  · the record is offered when you push
  · records publish to https://you.github.io/nearly/records

  Now just work. Requests that need you appear at http://127.0.0.1:47653
  Nothing to leave running. Turn it off again with --off.
```

It installs the Claude Code hooks and the git pre-push hook, and works out where records publish by reading the Nearly's own remote. Nothing to configure. `nearly off` removes all of it.

**To get that command,** until this is on npm:

```bash
git clone https://github.com/anujpatel06/nearly ~/nearly
npm link --prefix ~/nearly
```

No dependencies, so the link is instant. Once published it becomes `npx nearly-cli` with nothing to clone at all.

### Upgrading

```bash
npm install -g nearly-cli@latest
```

That is the whole upgrade. Hooks invoke `nearly` by name and resolve it fresh
each time they fire, so every repo you turned it on for picks up the new version
at once and nothing has to be turned on again.

Nothing updates on its own: npm never pushes anything to anyone's machine. What
you get instead is a notice. Once a day, when you run a command and are already
waiting on it, `nearly` checks whether a newer version exists and tells you in
two lines. It never runs in the hook path, so a registry lookup can never sit in
front of an action an agent is waiting to take, and it goes quiet on a failed
network rather than making it your problem. `NEARLY_NO_UPDATE_CHECK=1` turns it
off for good.

Two exceptions to the one-command upgrade, and `nearly` says which applies when
you turn it on:

- Run through `npx` with nothing installed globally, and the hooks are pinned to
  the version that wrote them, on purpose: resolving `@latest` before every tool
  call would put a registry lookup in front of every action an agent takes. Run
  `nearly` again in the repo after upgrading to move it forward.
- Run from a clone, and `git pull` is the upgrade.

**There is no server to start.** The hooks start it the first time they need it, in about a second, and it stays up. If it cannot start, Claude Code falls back to its own permission prompts and your session continues. Nothing to remember and nothing to break.

## Then work normally

Nothing about how you work changes. Open the repo in VS Code or a terminal, start Claude Code, give it a task.

1. **Reads run silently.** Anything that only looks at your code is allowed and logged.
2. **Anything that changes or reaches out is held.** It appears at http://127.0.0.1:47653 with the command, what it can affect, and a countdown. Answer with `A` or `D`, or shift for always and never. Nobody answering means denied after two minutes.
3. **The record builds itself** when the session ends.
4. **At `git push`** the hook merges every session on that branch, prints what was refused, and asks whether to post it. Say no and the push just continues.
5. **Your reviewer opens the pull request** and the record is there, as one comment that updates on every push rather than a new one each time.

### For a team

`.claude/settings.local.json` is per-person and stays out of git, which is right while you are trying it. To turn it on for everyone, move the same hooks into `.claude/settings.json` and commit that file. Once this is on npm the hooks invoke `npx nearly-cli`, so a teammate who clones the repo needs nothing installed beyond Node.

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

## What the record actually contains

**Who it is for.** The reviewer, who was not in the room. So the narration names the supervisor rather than saying "you", and it leads with the actions that never happened. Pass `--audience supervisor` for the second-person version.

Scene by scene: the task verbatim, every held request with the answer given and how long it took, each round of changes as a diff, anything rolled back, and one closing view of what was asked against what the agent claims it did. Every figure is computed from the recording.

The push hook builds this for you. To build one by hand:

```bash
node scripts/build-recap.mjs --branch feat/x --repo ~/code/my-app   # a branch
node scripts/build-recap.mjs latest                                 # one session
node scripts/build-recap.mjs latest --llm                           # Claude rewrites the sentences, never the facts
```

Output is one self-contained HTML file in `ui/records/`, served at `/records/…` while the server runs.

### The voice

macOS ships three tiers of every voice. The **compact** one is installed by default and is the robot everyone recognises. **Enhanced** and **Premium** are free downloads and sound dramatically better:

```
System Settings → Accessibility → Spoken Content → System Voice → Manage Voices
```

The builder picks the best tier it finds and tells you when all it has is compact. See what you have:

```bash
node scripts/build-recap.mjs --voices
node scripts/build-recap.mjs latest --voice "Ava (Premium)"
```

**Better still, read it yourself.** Synthesis is a stand-in for a person reading their own words, and for the one record you put in front of people it is worth ten minutes:

```bash
node scripts/build-recap.mjs latest --script          # writes records/<slug>-script.md
# record each numbered line into a folder as 01.m4a, 02.m4a, …
node scripts/build-recap.mjs latest --voice-dir ~/Desktop/narration
```

Lines you have not recorded fall back to the system voice, so you can do them a few at a time.

Rules the builder follows:

- Every number, diff and decision is computed from `recordings/<session>.jsonl` and the worktree's git history. With `--llm`, Claude only rewrites the narration sentences; it cannot add or change a fact, and the page says which mode produced it.
- Narration is macOS `say` converted to AAC and embedded, so the file needs no server and no API key. About 6 KB per second of speech.
- The storyboard is also written to `records/<agent>-<id>.json` for inspection.

## The branch is the unit, not the session

A reviewer opens a pull request, not a session. One branch collects several agent sessions over days, so the record merges all of them, numbering each instruction in order. A branch record supersedes the per-session records inside it, so the published index never shows the same story twice.

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
  at every push is not acceptable. Set `NEARLY_AUDIO=1` when you want the good one.

Set `NEARLY_URL_BASE` to the hosted path so the comment can link to the page:

```bash
export NEARLY_URL_BASE=https://<user>.github.io/<repo>/records
```

Today the poster speaks GitHub, through the `gh` CLI. Bitbucket and GitLab each
need their own small poster; the record itself is provider-agnostic, since it is
just a hosted page and a link.

## Publish the records

Recap pages are self-contained HTML, so GitHub Pages hosts them for free and the links in pull request comments resolve for anyone who can see the repo.

```bash
node scripts/publish-pages.mjs --base https://<user>.github.io/<repo>
```

That copies every built recap into `docs/records/` and writes `docs/index.html`, an index of the sessions on record. Commit `docs/`, then set **Settings → Pages → branch `main`, folder `/docs`**. Preview it locally first at http://127.0.0.1:47653/docs/ while the server is running.

## Why the hook fails open

Claude Code treats a hook that times out, errors, or returns anything other than `200` with JSON as a non-blocking error and lets the tool call proceed. So this server always answers with JSON, holds "ask" calls for at most `ASK_TIMEOUT_MS`, and denies when nobody decides. The hook's own timeout is set longer than that.

## Tests

```bash
npm test
```

41 tests, no dependencies, about 30 seconds. They run on a fresh clone with no
agent, no network and no Claude subscription, because the fixtures are the two
recorded sessions committed in `recordings/demo`.

What they hold the project to:

- **The consent gradient.** That destructive commands are denied without asking,
  that a never pattern still fires when the command is buried in a chain, that an
  unclassified tool is held rather than allowed, and that "always" for `git status`
  can never become permission for `git push`.
- **The hook contract.** The exact JSON Claude Code reads, for every tier. That an
  ask really is held until somebody answers, and that **nobody answering means
  denied**, which is the assumption the whole design rests on.
- **The record's central claim.** That every figure on the page matches the
  recording: the refusal count, who refused each one, every instruction verbatim
  and in order. The test reads the recordings itself rather than trusting the
  builder's own summary.
- **The failure paths**, which are the ones that lose you a user silently. That a
  hook whose server cannot start stays quiet and exits 0 rather than wedging a
  session. That two hooks racing for the port do not crash. That turning it on
  twice installs nothing twice, turning it off removes everything, and neither
  touches settings somebody else put there.

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
- `scripts/publish-pages.mjs`, build the `docs/` folder GitHub Pages serves
- `scripts/install-push-hook.mjs` + `scripts/push-record.mjs`, hand the branch record over at `git push`
- `workspace/`, the repo agents work on (seeded with the Tempo demo)
- `recordings/<session>.jsonl`, every event and decision; `recordings/demo/` is committed so the records can be rebuilt from source
- `STUDY.md`, the protocol for testing whether any of this helps a reviewer
