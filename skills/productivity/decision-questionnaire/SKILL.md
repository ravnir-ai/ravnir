---
name: decision-questionnaire
title: Decision questionnaire
description: Turn a decision you cannot make alone into a questionnaire.
version: 1.0.0
author: Ravnir, adapted from Matt Pocock (mattpocock/skills, to-questionnaire) and Hermes Agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/productivity/decision-questionnaire
---

# Decision Questionnaire

Turns something the owner cannot answer alone into a questionnaire: a document they hand to one
person to fill in later, or work through together in a meeting. The recipient holds knowledge the
owner lacks, and the questionnaire pulls it out of them.

## When to Use

- A decision depends on facts or judgment held by someone else: a domain expert, a stakeholder, a
  vendor contact, an operations lead.
- The owner says "I need to ask X about this", or keeps putting a decision off until someone else
  weighs in.
- Preparing a meeting where specific answers have to come back.

Do not use it when the answer can be found in your own reach (files, the vault, the web, a plugin).
Look there first and ask the person only for what is left.

## Principle: interview the send, not the subject

The owner cannot answer the subject-matter questions, that is why the document exists. They can always
answer questions about the send. Ask only about that, in at most two short exchanges (one `ask_user`
call each, or one call with both questions if you can):

1. **Who is it going to?** Their role, expertise and relationship to the owner. This sets the tone and
   how much context the questionnaire must carry. Done when you know who the recipient is and what they
   know that the owner does not.
2. **What do you need back?** The decisions or facts the owner cannot resolve alone. Done when you have
   a concrete list of what the owner must be able to do or decide afterwards.

If the owner already told you both, skip the questions.

## Procedure

1. Get the two answers above.
2. Draft questions aimed at the gap between what the recipient knows and what the owner needs, using
   the structure below. Order them most important first, since a late answer may only come in one pass.
   Group them under headings by theme once there are more than a handful.
3. Save the questionnaire with `make_document` as a docx the owner can send, or as Markdown with
   `write_file` as `questionnaires/<topic-slug>.md`. Pick docx if the owner will email it.
4. Tell the owner where the file is, in one or two sentences, and what it covers. Do not send it to
   anyone. Sending is the owner's call, and email goes through a draft they approve.

### Document structure

```markdown
# <Questionnaire title>

**Purpose:** why this exists and the decision riding on it.

**From:** <the owner> | **To:** <the recipient> |
**How your answers will be used:** <where they go>

## Context

One paragraph for a recipient who was not in the owner's head. Enough to answer well, not a page.

## How to answer

Deadline and rough effort. Partial answers and "I don't know" are useful: flag anything you are
unsure of rather than skipping it.

## <Theme heading>

### <One question, a single idea, never compound>

_Why this matters: <one line, only where the question could be misread or invite a throwaway answer>._

>

## Anything else?

A closing catch-all: anything we did not ask that we should know?
```

Every question gets an answer stub (`>`) directly beneath it.

## Pitfalls

- **Quizzing the owner about the subject.** They cannot answer it. Only interview the send.
- **Compound questions.** One idea per question. Split anything with "and" or "or" in it.
- **Burying the critical question.** Most important first.
- **A context dump.** One orienting paragraph, not the whole history.
- **Skipping "why this matters" on ambiguous questions.** It turns a throwaway answer into a useful one.
  Do not add it to questions that are already clear.
- **Putting private details in a document the recipient will see.** Include only what they need.

## Verification

- The recipient and the needed outcomes were captured before drafting.
- Every needed outcome is covered by at least one question.
- Questions are single-idea, in priority order, each with an answer stub.
- The file exists and you gave the owner its location.
