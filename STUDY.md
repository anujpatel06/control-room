# Seeded-error study

**The claim to test:** a reviewer who sees the session record catches something a reviewer who sees only the diff misses.

Nobody in this space has published evidence that their surface changes what a person catches. Prempti, Agent Approve and Endor Labs all ship a product; none of them ships a number. This is the cheapest thing on the schedule that cannot be copied in a sprint.

Three participants, twenty minutes each, no incentives, run in person or over a call with screen share.

---

## Design

Within-subject, two tasks per participant, order counterbalanced.

| | Condition A, control | Condition B, treatment |
|---|---|---|
| What they get | The pull request: title, description, diff | The same pull request, plus a link to the session record |
| What they do | Decide: approve, request changes, or block | Same |

Each participant does one task in each condition. Participant 1 gets A then B, participant 2 gets B then A, participant 3 gets A then B. With three people this does not remove order effects, it only stops them all pointing the same way. Say so in the write-up.

**Do not tell participants what the study is about.** Say: "you are reviewing a branch a coding agent wrote; decide whether to approve it." Nothing about refusals, nothing about the Control Room.

---

## The two tasks

Both run against the demo workspace. Both produce a diff that looks correct and passes a glance. The planted problem is not in the diff.

### Task 1 — the unrun test

The agent is asked to change behaviour **and run the test suite to confirm**. The supervisor refuses the test command. The agent edits the code correctly and reports honestly that tests did not run.

- **Diff shows:** a clean, plausible code change.
- **Diff hides:** that the change was never verified, because the verification step was refused.
- **Catch condition:** the participant says, unprompted, that the change is unverified or that tests did not run.

### Task 2 — the rolled-back turn

The agent makes two rounds of changes. The supervisor undoes the second. The branch ends in a state that looks deliberate.

- **Diff shows:** the surviving change only.
- **Diff hides:** that the agent tried a second approach which a human threw away, and why that matters for the reviewer's suggestion to "just also do X".
- **Catch condition:** the participant mentions that something was attempted and reverted, or asks what else was tried.

Record both sessions once and reuse the recordings for all three participants, so every participant sees identical material. Build with `--audience reviewer`, which is the default.

---

## Script

Read this aloud, the same way each time.

> You are reviewing a branch that a coding agent wrote. Another engineer supervised the agent while it worked. Take as long as you need, think out loud, and at the end tell me whether you would approve it, request changes, or block it.

Then, in the treatment condition only, add:

> There is also a link to a record of the session in the pull request comment. Use it or ignore it, whichever you would normally do.

Say nothing else. Do not point at the refusals. If they ask what the record is, say "have a look and tell me."

---

## What to write down

For each task, per participant:

| Field | How to record it |
|---|---|
| Condition | A or B |
| Caught the planted problem | yes / no, and the exact words they used |
| Time to decision | stopwatch, from start to their verdict |
| Opened the record (B only) | yes / no, unprompted or after the prompt |
| Verdict | approve / request changes / block |
| Quote | one sentence in their words worth publishing |

The headline number is the first row: how many of three caught it with the record, how many without.

---

## Reporting honestly

With three people this is a **usability test, not an experiment**. Write it up that way:

- Report the raw count, never a percentage. "Two of three caught it with the record, none of three without" is honest. "67% improvement" is not.
- Report participants who caught it for the wrong reason as misses of the design, not hits.
- If the record does not help, say so and publish it anyway. A negative result honestly reported is still evidence you ran the test, and it is more interesting than another feature.
- Note every confound: three people, order effects, the author present, participants who know what the project is.

The essay sentence to aim for is a fact, not a claim: *given the same branch, N of three reviewers noticed the refused test run with the record, and N without.*

---

## Before the session

- [ ] Both recordings captured with a real agent, not simulated
- [ ] Both recaps built and reachable at a public link
- [ ] Both pull requests open, with the recap comment posted on the treatment one
- [ ] Recap opens in under two seconds on a cold load
- [ ] Practice run with someone who is not a participant, to fix the script
- [ ] Stopwatch, and a written sheet per participant, not memory
