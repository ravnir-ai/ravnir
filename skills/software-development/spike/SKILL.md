---
name: spike
title: Spike
description: Run throwaway experiments to test an idea before building.
version: 1.0.0
author: Ravnir, adapted from Hermes Agent, itself adapted from gsd-build/get-shit-done (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/skills/software-development/spike
---

# Spike

A spike is a small, disposable experiment that answers one feasibility question before the owner
commits to a real build. It is built to be thrown away once it has paid its debt, and a spike that
proves an idea impossible is a successful spike.

## When to Use

- The owner says "let me try this", "is this even possible?", "before I commit to X", "quick
  prototype of Z" or "compare A and B".
- There is a risk that reading cannot settle: speed, compatibility, whether two parts fit together.

Do not spike when the answer is in the docs or the code (read and report instead), when the work is
the real production path (plan and build it), or when the idea is already validated.

## Procedure

The loop is: decompose, research, build, verdict, then iterate on what you found.

1. **Decompose.** Split the idea into 2 to 5 independent feasibility questions. Each one is a spike.
   Show them to the owner as a table:

   | # | Spike | Validates (Given, When, Then) | Risk |
   |---|---|---|---|
   | 001 | streaming-chunks | Given a socket, when the model streams tokens, then the client receives each chunk | High |
   | 002a | parse-with-lib-a | Given a multi-page PDF, when parsed with library A, then structured text comes out | Medium |
   | 002b | parse-with-lib-b | Same question with library B | Medium |

   A spike is either standard (one approach, one question) or a comparison (same question, several
   approaches, a shared number and a letter suffix). A good question names an observable output. A
   bad one is too broad or is just "read about X". Order by risk: the spike most likely to kill the
   idea goes first. If the owner already knows the single thing to test, skip this step.
2. **Align.** For more than one spike, show the table with `ask_user` and let the owner drop,
   reorder or reword before any code is written.
3. **Research, briefly.** For each spike write two or three sentences: what it is, why it matters,
   the key risk. If there is a real choice of library or approach, find candidates with
   `web_search`, read the actual docs with `web_fetch`, and check what is installed with
   `run_command`. List them (approach, pros, cons, maintained or abandoned), pick one and say why.
   Skip this step for pure logic with no outside dependency.
4. **Build.** One folder per spike under `spikes/`, named `NNN-short-name/`, standalone, with a
   `README.md` and the code:

   ```
   spikes/
     001-streaming-chunks/
       README.md
       main.py
     002a-parse-with-lib-a/
     002b-parse-with-lib-b/
   ```

   Make it something the owner can feel working, in this order of preference: a runnable command
   line tool with visible output, a minimal HTML page, a small server with one endpoint, a test with
   clear assertions. Hardcode everything. Avoid bundlers, Docker, env files and config systems unless
   the spike is about them. Create files with `write_file` and run them with `run_command`. Do not stop at one
   happy-path run: try edge cases and follow surprises.
5. **Verdict.** End each spike's `README.md` with:

   ```markdown
   ## Verdict: VALIDATED | PARTIAL | INVALIDATED

   ### What worked
   ### What didn't
   ### Surprises
   ### Recommendation for the real build
   ```

   VALIDATED means the question was answered yes, with evidence. PARTIAL means it works under
   stated constraints, and you list them. INVALIDATED means it does not work, and you say why.
6. **Compare.** For comparison spikes, build them back to back and finish with a head-to-head table
   (extraction quality, setup effort, speed on a realistic input, limits) and a named winner for the
   owner's use case. Measure the numbers; do not estimate them.

If there are already spikes and the owner asks what to try next, read the existing folders and look
for integration risks (two validated spikes that touch one resource), unproven handoffs (one
spike's output assumed to fit another's input), assumed capabilities nobody tested, and a different
angle on any PARTIAL or INVALIDATED spike. Offer two to four candidates as Given, When, Then and let
the owner pick.

## Pitfalls

- A spike whose only output is a log line saying "it works". Give the owner something to run.
- Testing only the easy parts first. Risk order matters.
- Letting the spike grow into the product. If cleaning it up would take days, it was the wrong
  spike. Keep the code throwaway.
- Installing things into the owner's real project or system. Keep the spike in its folder and a
  local environment.
- Calling a result "validated" without quoting the output that shows it.

## Verification

- Every spike has a README with a question, the approach, the observed results and a verdict.
- Each verdict cites real output you ran, not an expectation.
- The final report gives the owner one line per spike (verdict and the reason) and a recommendation
  for the real build.
