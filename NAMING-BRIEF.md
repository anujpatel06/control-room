# Naming brief

Everything needed to name this project. Written to be pasted whole into another
model or handed to a person. Nothing here assumes you have seen the code.

---

## 1. What it is, in one paragraph

A tool that sits between an AI coding agent and your computer. When the agent
wants to do something consequential, such as change a file, run a shell command
or reach the network, the tool holds that action and asks a human. It records
every one of those moments, including the refusals. When the work is later pushed
and turned into a pull request, it hands the reviewer a short narrated web page
describing what happened while the branch was written, including the things the
agent tried and was not allowed to do.

## 2. The problem it exists for

An AI agent writes a branch. A teammate reviews the pull request. All that
teammate can see is the diff: the final state of the files.

The diff cannot show:

- a command a human refused, and why the change is therefore unverified
- an action blocked by policy before any human saw it
- an approach the agent tried and a human rolled back
- how long a person actually spent deciding, or whether they were paying attention

Those moments are the most information-dense events in the whole session, and
every existing tool throws them away before anyone downstream sees them.

**The sentence the project is built around:**

> A pull request tells you what changed. This tells you what nearly happened.

## 3. How it works, mechanically

1. You turn it on for a repo with one command. It installs hooks.
2. You work normally: VS Code, a terminal, whatever you already use.
3. Read-only actions run silently and leave a receipt.
4. Anything that changes or reaches out is **held**. A card appears in a local
   browser tab with the exact command, a plain-English description of what it
   could affect, and a countdown. You answer with a single key.
5. Nobody answering means denied. It fails closed on purpose.
6. Some things are never allowed and never reach a human at all.
7. Everything is recorded: the instruction, every decision, how long it took,
   every change, anything undone.
8. When you `git push`, it merges every session on that branch into one record,
   shows you what was refused, and asks whether to hand it over.
9. If you say yes, it comments on the pull request. That comment leads with the
   actions that never happened, then links to a narrated page.

## 4. Who it is for

There are three people in the story and the name should serve the third.

- **The supervisor** answers the prompts while the agent works. They already
  know what happened; they lived it.
- **The reviewer** opens the pull request days later with no context. They are
  the one being served. Industry research shows 96% of developers do not fully
  trust AI-written code, only 48% consistently review it, and review times have
  risen sharply as agents write more code.
- **The security or compliance owner** wants an audit trail. Well served by
  other products already. Deliberately not the target.

## 5. What makes it different

Three funded or backed products already gate an agent's actions and all three
throw the refusal away at a different door:

- One writes it to a local log file for a security engineer to grep.
- One shows it as a phone notification and keeps no artifact at all.
- One files it in an enterprise audit system for an auditor months later.

One of them literally promises "a story of the session, not just the diff" on its
homepage, then ships that story as a text log with no viewer.

**Nobody turns the refusal into something the next person to open the branch
actually reads.** That junction is the entire product.

## 6. Tone and character

The project's voice is plain, precise and unshowy. It avoids hype, states
uncertainty openly, and refuses to overclaim. Sample lines from the product:

- "3 things the agent wanted to do did not happen. The diff cannot show you this."
- "Denied automatically in 78s if nobody answers."
- "Every number here was computed from the recording, not written by a model."
- "An agent wrote the branch you are about to review."

It is a developer tool, dark and keyboard-first, closer in feel to Linear or
Raycast than to a consumer app. Serious but not corporate. Not cute, no mascot
energy, no exclamation marks.

## 7. Vocabulary the project already lives in

Words that are load-bearing in the product and the writing:

**Actions:** held, refused, denied, blocked, rolled back, allowed, undone,
attached, handed over

**Artifacts:** the record, the receipt, the trail, the story of the session

**Concepts:** consent, supervision, custody, provenance, accountability,
verification, blast radius, fails closed, what nearly happened

The current internal name uses a control-room metaphor: a place you watch from.
That metaphor may be wrong, because the product is less about watching in the
moment and more about **what you hand to the next person**.

## 8. What the name has to do

Rank these by importance when judging candidates:

1. **Survive being typed constantly.** It is a command people run: `npx <name>`.
   Short, easy to spell from hearing it, no ambiguous characters.
2. **Read well in a pull request.** The comment header will say something like
   "<Name>: 3 actions never happened". It appears next to real code review.
3. **Point at the receipt, not the surveillance.** Names about watching,
   monitoring or policing make it sound like management spyware, which is the
   fastest way to make developers refuse to install it.
4. **Not sound enterprise-compliance.** That market is taken and it is the wrong
   buyer.
5. **Work as a noun for the artifact itself.** People will need to say "send me
   the ___" or "did you look at the ___".

## 9. Hard constraints

- The npm package name must be free. Check at `npmjs.com/package/<name>`.
- A matching GitHub repository name, ideally.
- One or two words. Lowercase, hyphen at most.
- Must not collide with a well-known developer tool.
- English, but it will be read by non-native speakers constantly.

For reference, all of these were free on npm at the time of writing:
`control-room`, `controlroom`, `agent-control-room`, `session-record`,
`nearly-happened`.

## 10. Territories worth exploring

Not name suggestions, just directions the metaphor could come from:

- **The handover.** What one person passes to the next: relay, baton, handoff,
  briefing, debrief.
- **The receipt.** Proof of what occurred: receipt, stub, ledger, docket,
  manifest, chit.
- **The witness.** Something that was present and can testify to what happened.
- **The negative space.** The road not taken, the thing that did not happen,
  the counterfactual. This is the most distinctive idea in the project and the
  least explored territory.
- **The pause.** The moment of holding before a decision: hold, stay, beat,
  checkpoint, threshold.

The fourth is the one to push hardest. Every competitor names itself after
control, policy or approval. None of them names itself after the absence.

## 11. What to avoid

- Anything with "AI", "agent", "GPT" or "copilot" in it. Dated immediately.
- Anything implying the tool watches the developer rather than the agent.
- Anything that sounds like a compliance product: audit, govern, policy, comply.
- Overloaded tech words: flow, hub, stack, core, forge, sentinel, guardian.
- Names that need explaining before they make sense.

---

## Appendix: facts you may want to use

- Zero dependencies. Runs on an existing Claude subscription, no API key.
- Works with Claude Code today; the architecture generalises to Cursor, Codex,
  Gemini CLI, Copilot and about fifteen others that expose a comparable hook.
- Records are self-contained web pages, about 800KB, that work with no server.
- Narration is generated locally and free; it can also be the author's own voice.
- Anthropic's own measurement: agents ask roughly a hundred permissions an hour
  and users approve 93% of them. In a separate study of 1,053 people, only 13.6%
  caught a deliberately dangerous command.
- The industry's answer has been to ask fewer questions. This project's answer is
  that the record of what you refused is worth keeping.
