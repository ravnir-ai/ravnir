---
name: systematic-debugging
title: Systematic debugging
description: Find the root cause of a bug before changing anything.
version: 1.0.0
author: Ravnir, adapted from obra/superpowers via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/skills/software-development/systematic-debugging
---

# Systematic Debugging

Random fixes waste time and add bugs. A patch that makes the symptom disappear without a cause you
can name is a second bug with better manners.

**The iron law: no fix before you have reproduced the failure and named the cause.**
If you have not finished Phase 1, you may investigate and you may explain — you may not change
code.

## When to Use

Use for any technical failure:

- A test that fails, or a command that exits non-zero when it should not
- Something that worked yesterday and does not work today
- A page, a build, a deploy or an API that misbehaves
- A bug the owner reports with "it just breaks"

Use it especially when:

- You are under time pressure (that is when guessing feels reasonable)
- The fix looks obvious ("it is probably the cache")
- You have already tried one fix and it did not work
- You do not actually understand the code path yet

Skip it for a pure typo or a missing import you can see. Even then, confirm the error goes away
with the same command that showed it.

## Prerequisites

- A way to run the failing thing: `run_command` in the workspace.
- The code: `read_file` and `search` (both need no approval).
- Nothing else. A debugger is optional and usually slower than a good print.

## The feedback loop is the work

Before you read code to build a theory, build the **tight loop**: one command that fails on the
owner's exact symptom and passes when the bug is fixed.

A tight loop is:

- **Fast** — seconds, not minutes
- **Deterministic** — same result every run; if it is flaky, that is the first bug
- **Narrow** — it exercises the broken path, not the whole app
- **Specific** — it fails for this bug, not for "something is wrong"

If a clean reproduction is hard, spend disproportionate effort on it. A loop you trust is what
turns guessing into testing; without one, every "fix" is a coin flip you cannot score.

## Procedure

### Phase 1 — Reproduce and understand

1. Write down the symptom in one sentence: what happens, what should happen, since when.
2. Build the loop. Run it. Watch it fail. Report the exit code and the first real error line, not
   the last one in the stack.
3. Read the failing path end to end: the entry point, the branch that runs, the value that is
   wrong. `search` for the error string and for the function name; `read_file` the function.
4. Answer, in writing: which line produces the wrong value, and what value did it get?

If you cannot answer step 4, you are not ready for Phase 2. Say what you know and what you still
need — an unproven theory is honest; a fix built on one is not.

### Phase 2 — Narrow

5. Move the loop's boundary inward. Change one input at a time; log the suspect value at two
   points and bisect between them.
6. Reduce to the smallest failing case. Delete anything from the reproduction that does not
   change the failure. What is left is the bug's neighbourhood.
7. Name the cause concretely: "`parseDate` returns `NaN` for `2026-13-01` because `Date.parse`
   rejects month 13 and the caller never checks". A cause you cannot state in one line is not a
   cause yet.

### Phase 3 — Fix at the cause

8. Fix the cause, not the symptom. If the caller passes garbage, fix the caller; do not add a
   guard that silently swallows it. If you must guard, also fix what produced the garbage.
9. Make the smallest change that removes the cause. No refactor, no renamed variables, no
   "while I am here" — those belong in a separate step the owner can see.
10. Run the loop. It must pass. If it passes without your change, your loop was not tight.
11. Add the regression test *before* you declare victory: it fails on the old code, passes on the
    new. Reproduce that both ways; a test that cannot fail proves nothing.

### Phase 4 — Verify and prevent

12. Run the wider suite, not only the loop. A cause fix often moves the failure elsewhere.
13. Check the neighbouring cases the bug implies: the same parser on the same kind of input, the
    same missing check in a sibling function. Report them; fix only what you were asked to fix.
14. Write down the cause and the fix where the next person looks: a commit line, a note, or the
    reply to the owner. "It was the timezone" is not a cause; "the server formats dates in UTC
    and the test compared against local time" is.

## Quick reference

| Symptom | First move |
|---|---|
| Works locally, fails on the server | Compare env: `run_command` `env`, versions, timezone, paths |
| Fails sometimes | Log the inputs of both runs; the difference is the bug |
| Fails after a deploy | Diff the change; run the loop on the previous commit |
| Empty list or `undefined` | Follow the value backwards; find the last point it was correct |
| Timeout | Time the steps; find which one costs the seconds |
| "It used to work" | Ask what changed outside the code: data, credential, dependency |

## Pitfalls

- **Fixing the first plausible thing.** Plausible is not proven. Finish Phase 2.
- **A loop that cannot fail** (mocks everything, asserts nothing). It will always pass.
- **Changing several things at once.** You learn nothing about which one mattered.
- **Trusting the error message.** The stack shows where it broke, not where it went wrong.
- **Deleting the reproduction** once it passes. It is now the regression test.
- **Declaring victory on a green run of the wrong command.** Run the one that failed.

## Verification

- The original failing command now passes, run exactly as the owner runs it.
- The regression test fails on the old code and passes on the new (you saw both).
- You can state the cause in one sentence, with the line and the value.
- The wider suite is green, or the remaining failures are named and unrelated.
