---
name: grill-me
title: Grill me
description: Stress-test a plan with rounds of hard questions first.
version: 1.0.0
author: Ravnir, adapted from Rafael Zendron, Matt Pocock and Hermes Agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/software-development/grill-me
---

# Grill me

Stress-test a plan by questioning it before any work starts. Treat the plan as a design tree, where
every decision branches into the decisions that hang off it, and interview the owner in rounds until
every branch is settled and nothing is silently assumed. The point is to find the problems while they
are still cheap.

## When to Use

- The owner says "grill me", "interview my plan", "stress test this idea" or "poke holes in this".
- Before complex work where mistakes are expensive: login flows, schema changes, migrations,
  payments, anything that is hard to undo.
- A plan is vague or has decisions nobody has made yet.

Do not use it to review code that already exists (open the requesting-code-review skill) or for a
simple one-off task.

## Procedure

1. **Map the plan as a tree.** Write down, privately, the decisions the plan contains and which ones
   depend on others. Fix the ground facts first.
2. **Find the frontier.** The frontier is every decision whose prerequisites are already settled, so
   you can ask about it now without guessing at answers you have not heard. A question that depends
   on another question still open in this round belongs to a later round.
3. **Look up facts yourself.** If a question needs a fact from the environment (the code, the
   files, a config, the docs), find it with `search`, `read_file`, `list_dir` or `run_command`,
   or `web_fetch` for documentation. Facts are your job and decisions are the owner's. Never ask
   something you could look up. Do not wait for a slow lookup: only the questions downstream of it wait.
4. **Ask one round.** Number the frontier questions, and give each one your recommended answer with
   a one-line reason:

   ```
   Q1. <short title>: <the question, with the options when there are any>
       Recommendation: <your answer, and why in one line>

   Q2. ...
   ```

   Send the round through `ask_user`: put a short line in the `question` field that names the round
   and points at the numbered list (for example "Round 2: please answer Q1 to Q4"), use `about:
   decision`, and write the full numbered list in your reply, which is what the owner reads. Then end
   your turn and wait. `ask_user` refuses a question you already asked, so each round needs a
   distinct line. If one question matters far more than the rest, ask only that one.
5. **Update the tree.** Each answer settles a branch and may unlock new ones. Recompute the frontier
   and ask the next round. Challenge answers that contradict an earlier one. If the owner says "I
   don't know", suggest options, explain the trade-offs and make a recommendation instead of
   dropping the question.
6. **Cover these areas** while building the tree:
   - Understanding: the real objective, what is in scope and what is out, the constraints (time,
     technology, team, budget), and who the users are.
   - Technical decisions: why this approach and not another, what happens when a part fails, the
     worst case, and how to roll back. Check the existing project for a pattern and point it out.
   - Edge cases: what happens when the user does something unexpected, when a dependency is down,
     at 100 times the expected volume, and what the security consequences are.
7. **Synthesize when the frontier is empty.** Summarize every decision as bullets, list what stays
   open and what is explicitly out of scope, and ask with `ask_user` whether to start building or
   adjust something. Do not act on the plan until the owner confirms.

## Pitfalls

- Asking questions out of dependency order. A question that depends on an unanswered one is a
  guess with a question mark.
- Skipping the project and asking the owner for facts that are in the files.
- Accepting "I don't know" as final.
- Starting to build during the interview. This is alignment only; work begins after a clear go.
- Being too agreeable. Your job is to find problems. If everything looks fine, look harder.
- Interviewing in the wrong language. Use the language the owner writes in.
- Asking too many questions per round. If the frontier is long, ask the ones that unlock the most
  first, and say that more are coming.

## Verification

- Every question in a round had its prerequisites settled.
- Each question came with a recommendation.
- Facts that could be looked up were looked up, not asked.
- The frontier was empty before you summarized: no branch was silently assumed.
- The summary lists all decisions and all open items, and the owner confirmed it before any work began.
