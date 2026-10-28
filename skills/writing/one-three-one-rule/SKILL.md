---
name: one-three-one-rule
title: 1-3-1 decision brief
description: Write a decision brief: a problem, three options, a pick.
version: 1.0.0
author: Ravnir, adapted from Willard Moore via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/communication/one-three-one-rule
---

# 1-3-1 Decision Brief

A fixed shape for a decision with several workable answers: one sentence stating the problem, exactly
three genuinely different options with trade-offs, and one recommendation with a plan. It gives the
owner something they can approve in a minute or forward to someone else.

## When to Use

- The owner asks for a "1-3-1", or says "give me options" or "what are my choices".
- A task has several workable approaches with real trade-offs (tooling, architecture, a migration, a
  vendor, a plan for a launch).
- The owner needs a proposal to forward to a team or a stakeholder.

Do not use it for a question with one obvious answer, for debugging, or when the owner has already
chosen. Do not use it to avoid a decision you were asked to make.

## Procedure

1. **Gather what you need first.** Read the relevant files with `read_file` or `search`, or look up
   facts with `web_search` and `web_fetch`, before writing. Options built on guesses waste the owner's
   time. If a missing fact would change the pick, ask one question with `ask_user`.
2. **Problem, one sentence.** State the decision or the outcome wanted. Say what, not how: no tool
   names or implementation detail. If you need "and", you are describing two problems; split them.
3. **Options, exactly three, labeled A, B and C.** Each gets a short description, pros and cons.
   They must be different strategies, not three variations of one. If only two are real, say so and
   explain what a third would be rather than padding.
4. **Recommendation, one option.** Say which and why, in terms of the owner's stated priorities,
   constraints and budget. Be direct; no hedge.
5. **Definition of done.** Concrete, checkable outcomes for the recommended option.
6. **Implementation plan.** Ordered steps with the actual commands, files or actions where known.
7. **Hand off the choice.** The owner decides. If they pick another option, rewrite the
   recommendation, definition of done and plan to match it. Do not start irreversible work (sending,
   buying, deleting, deploying) until they confirm.

### Shape

```
Problem: <one sentence>

Option A: <name>. <description>
  Pros: ...
  Cons: ...
Option B: ...
Option C: ...

Recommendation: Option <X>. <why, tied to the owner's priorities>

Definition of done:
- <checkable outcome>

Implementation plan:
1. <step>
```

For a longer brief to forward, `make_document` can render it as a PDF or Word file.

## Pitfalls

- Two problems in the problem line.
- Three options where one is a straw man that nobody would choose.
- Options that differ only in a library name instead of in approach.
- Pros and cons that are generic. Tie each to the owner's situation.
- A recommendation that hedges ("it depends"). Pick, and name the condition that would change it.
- A definition of done made of aspirations ("works well") instead of checks.
- Inventing costs, timelines or benchmark numbers. Use figures you found, cite where, or say unknown.

## Verification

- Exactly one problem sentence, exactly three options, exactly one recommendation.
- Each option has pros and cons that refer to this owner's context.
- The definition of done and the plan match the recommended option.
- Every figure or factual claim has a source you checked, or is marked as an assumption.
- If the owner chose another option, all three trailing sections were updated.
