---
name: creative-ideation
title: Creative ideation
description: Generate specific ideas using named creative methods.
version: 1.0.0
author: Ravnir, adapted from SHL0MS via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/creative/creative-ideation
---

# Creative Ideation

A small library of ideation methods and a way to choose between them. The default way a model
brainstorms (a numbered list of five plausible ideas) is the thing to avoid. Read the owner's
situation, pick one method that fits, apply it, and return fewer ideas that are specific, odd in one
respect, and honest about how they could fail.

## When to Use

- "I want to make, build or write something", "inspire me", "give me ideas for X".
- "I'm stuck", "make this weirder", "this feels too safe", "help me pick".
- "I need a name, angle, hook or concept" where the first answers would be generic.
- The owner has a pile of notes or feedback and needs structure.

Do not use it for factual questions, for a decision that needs data rather than ideas (use
`one-three-one-rule`), or once the owner has picked an idea: then build it.

## Prerequisites

Two files ship with this skill. Open them with `skill_view` when you need them:

- `references/methods.md` has the steps of each method named below.
- `references/anti-slop.md` has the rules that every idea set must pass.

## Procedure

1. **Read three signals** in the request.
   - Phase: generating, expanding a base idea, selecting between ideas, unblocking, making something
     less safe, refining, or synthesizing a pile of material.
   - Domain: text, visual or sound work, software or hardware, an organization or community, a
     personal decision, research, or a product or business.
   - Specificity: nothing given, a field given, a project given, or a specific friction given.
2. **Apply overrides first.**
   - The owner names a method: use it.
   - The owner says weird, strange or less obvious: use lateral provocations.
   - The owner asks which method to use: offer two or three with one line each, and let them pick
     with `ask_user`.
   - The topic is saturated ("AI ideas", "startup ideas", habit, fitness, food or travel apps): use
     lateral provocations, and refuse the first five ideas you think of, not three.
3. **Route by phase, then by domain.**

   | Situation | Method |
   |---|---|
   | Nothing given, blank page | A constraint plus a direction (see methods.md, "Constraints") |
   | Has a base idea, wants variations | SCAMPER |
   | Needs many ideas fast | Volume generation |
   | Choosing between candidates or testing a plan | Premortem and inversion |
   | Stuck with material in hand | Oblique strategies |
   | Idea too safe | Lateral provocations |
   | Pile of notes, interviews or feedback | Affinity diagram |
   | Product, service or business | Jobs to be done |
   | Suspects the usual way is outdated | First principles |
   | Fiction or poetry | Formal constraints; a narrative skeleton other than the hero's journey |

   Methods that exist in the full library but are not summarized here (TRIZ, leverage points,
   biomimicry, pattern languages and others) can be used by name if the owner asks.
4. **Resolve ambiguity.** If two methods fit, pick the one closest to the owner's own words. If the
   request is truly ambiguous, ask one question. If signals conflict, stack two methods and say so.
   If the owner asks the same question again, switch methods.
5. **Do the unrouted draft in your head, then discard it.** The first three ideas (five on saturated
   topics) are the average. Generate past them. Run the self-check in `references/anti-slop.md`.
6. **Write the answer.** Name the method and who devised it. For each idea give: the idea in one line,
   the concrete mechanism or material, who or what situation it is for, and the honest way it could
   fail. Mark at least one idea as the grounded one, doable now with a real first step. Fewer ideas
   with more depth beat a long list. Prefer three or seven to five.
7. **When the owner picks one, stop generating and build it.** Draft the thing, or plan its first
   step. A saved result can go in `create_artifact` (a page or markdown) or `make_document`.

## Pitfalls

- Stacking three or more methods. It becomes performance, not ideation.
- Choosing the most exotic method to look clever. Constraints plus direction usually work.
- Weird with no mechanism or reason to exist. Every set needs a grounded idea.
- Naming a tech stack and calling it specific. A mechanism, a named real thing, or an unusual
  material is specific.
- Marketing voice ("exciting", "powerful", "seamless"). Describe ideas the way a working maker
  describes their own work to a peer.
- Inventing facts about real people, works or places to make an idea sound grounded. Use ones you
  know to be real, or check with `web_search`.
- Fake research: if a method needs customer interviews or data you do not have, say so and propose
  how to get it.

## Verification

- A named method, and a sentence on why it fits the request.
- Each idea has a mechanism, a situation and a failure mode.
- At least one idea is flagged as buildable now with a first step.
- No idea survives the test "could this be for a different prompt if I changed one noun".
- No buzzwords from the anti-slop list, and no five-item list of equal length.
