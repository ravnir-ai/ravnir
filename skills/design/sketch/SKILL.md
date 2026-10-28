---
name: sketch
title: Sketch
description: Make 2 or 3 throwaway HTML mockups to compare.
version: 1.0.0
author: Ravnir, adapted from Nous Research hermes-agent, itself adapted from gsd-build/get-shit-done (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/creative/sketch
---

# Sketch

Show a design direction before anyone commits to it. You build two or three disposable HTML mockups
of the same screen, each taking a different design stance, and put them side by side so the owner can
compare real pages instead of imagining them. The point is a decision, not shippable code.

Each variant is saved with `create_artifact` (kind `html`), so it shows up as a card the owner can
open full size.

## When to Use

- "Sketch this screen", "show me what X could look like", "compare layout A and B", "give me a few
  takes on this UI", "mock this up before I build it".
- A new page, dashboard, onboarding step, settings screen or component where the look is undecided.

Do not use it when the design is already locked (just build it), when the owner wants production
code, or when the subject is a diagram (use `architecture-diagram` or `concept-diagrams`).

## Procedure

1. **Intake, only what is missing.** Three things shape a design: the feel (adjectives or a vibe),
   references (apps or sites that capture it), and the one core action on the screen. If the request
   or the project already answers them, skip this. Otherwise ask the single most useful one with
   `ask_user`. If it is still unclear, state your assumptions in the reply and build; do not hold up
   the work.
2. **Pick the axis and pull the variants apart.** Make 2 or 3 variants (never 1, rarely 4), each a
   different stance on one axis. Two variants that differ only in accent color are wasted effort.

   | Axis | Examples of poles |
   |---|---|
   | Density | compact, airy |
   | Emphasis | content first, action first, tool first |
   | Aesthetic | editorial, utilitarian, playful |
   | Layout | single column, sidebar, split pane |
   | Grounding | cards, bare content, document style |

   Name each variant after its stance ("Calm editorial", "Dense utilitarian"), not a number.
3. **Build each variant as one real page.** One self-contained HTML file: inline `<style>` and
   `<script>`, system fonts or one web font, realistic content (real sentences and names, never lorem
   ipsum), and responsive at a phone width with `<meta name="viewport">` and a media query.
   Starting point: `box-sizing: border-box`, a system font stack, a neutral background, line height
   1.5. If the project has a visual identity, read its colors, fonts and radius from the repo
   (`read_file`) and use them as CSS variables in every variant. Three colors and one font is enough
   for a sketch.
4. **Make it interactive enough to judge.** The owner should be able to click the primary action and
   see something happen, see one meaningful state change (filter a list, switch a mode, open and
   close a panel), and hover the obvious affordances. More is over-building a throwaway; less is a
   screenshot. Keep state in JavaScript variables: the page runs in a sandbox, where browser storage
   may not be available.
5. **Save each with `create_artifact`**, title like "Sketch: settings screen, calm editorial". Make
   the variants in one go.
6. **Compare, with an opinion.** In your reply, a short table of how they differ on the dimensions
   that matter here, then your recommendation and who each variant serves best:

   | | Calm editorial | Dense utilitarian |
   |---|---|---|
   | Density | low | high |
   | Primary action visibility | medium | high |
   | Feel | calm | sharp |

   End with one question the owner can answer in a word: pick one, combine two, or another round. Do
   not list the variants without taking a position.

### Interactivity bar

A variant passes when: one click does something visible, one state change works, and the hover
states exist. If you cannot say which of the three each variant shows, it is not done.

### What next

When the owner picks a winner, offer to build it properly (a real component in the project, with
tests if there are any). A sketch that matters is promoted into the codebase, not curated as an
asset. If sketches already exist and the owner asks what to try next, suggest two to four named
candidates from: states not yet shown (empty, loading, error, very long lists), the same screen at
a phone width, screens referenced but never sketched, and interactions beyond layout.

## Pitfalls

- **Variants that only differ in color.** Change the structure or the emphasis.
- **Describing instead of building.** The owner asked to see it.
- **Lorem ipsum and placeholder boxes.** They hide the real problems (long names, empty states).
- **External dependencies that may not load.** Prefer inline CSS and no frameworks. If you load a
  library from a CDN, use a pinned `https` URL and expect the page to degrade without it.
- **Broken markup.** Re-read each file for unclosed tags, missing quotes and text that cannot fit its
  container before you save it. You usually cannot see the page rendered, so keep layout simple
  (flex and grid, no absolute-position tricks).
- **Treating the sketch as code to ship.** Say it is a throwaway.
- **Remote images of real people or brands** the owner did not give you. Use shapes and neutral
  placeholders.

## Verification

- Two or three artifact cards exist, each with a different stance in its name.
- Each page has a click, a state change and hover states, and works at a narrow width.
- The comparison names a recommendation and a next step, not just a list.
