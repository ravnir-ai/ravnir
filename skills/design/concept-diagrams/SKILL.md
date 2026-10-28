---
name: concept-diagrams
title: Concept diagrams
description: Draw clean flat SVG diagrams for explaining a concept.
version: 1.0.0
author: Ravnir, adapted from v1k22 via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/creative/concept-diagrams
---

# Concept Diagrams

Flat, minimal SVG diagrams in one consistent design system, for explaining things: how a process
flows, how a mechanism works, how an object is built. One SVG file, with its styles inside it, that
follows the viewer's light or dark mode. You save it with `create_artifact` (kind `svg`) and the
owner sees it as a card.

For a plain flowchart or sequence where the look does not matter, a fenced `mermaid` block in the
reply is quicker, and the app draws it. Use this skill when the diagram is the deliverable.

## When to Use

- Physics setups, chemistry mechanisms, math curves, biology, anatomy and cross-sections.
- Physical objects: a vehicle, a turbine, a phone, a mechanical part; exploded layer views.
- Floor plans and layout conversions.
- Processes and journeys (the life cycle of X, how Y gets made), pipelines, approval flows.
- Hub-and-spoke systems (a city, an IoT network, a grid) and teaching visuals in any field.

Use `architecture-diagram` instead for software and cloud systems with the dark tech look, `sketch`
for UI mockups, and a fenced `chart` block in the reply for numeric charts.

## Procedure

1. **Choose the type** from the list under Diagram types, and write down the nodes, groups and links
   you will draw. Draw only what the owner told you or what you verified; do not invent steps.
2. **Fix the canvas.** `viewBox="0 0 680 H"` where `H` is the lowest element plus 40. Keep everything
   inside x = 40 to x = 640 and y = 40 to H - 40. Compute positions before writing.
3. **Start from the boilerplate** below (style, background, arrowhead), then add the content.
4. **Color by meaning**, not sequence. Use 2 or 3 ramps per diagram: `c-gray` for neutral nodes
   (start, end, users), `c-purple`, `c-teal`, `c-coral` and `c-pink` for categories, and keep
   `c-blue`, `c-green`, `c-amber` and `c-red` for info, success, warning and error.
5. **Run the checklist** under Verification, fix, then save with `create_artifact` (kind `svg`, a
   specific title). Fix with `update_artifact` and the full new content.
6. **Reply** in a sentence or two: what it shows and anything you assumed.

### Boilerplate

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 680 H" role="img" aria-label="...">
<style>
  svg{--bg:#fff;--t1:#1a1a18;--t2:#5f5e5a;--bx:#f6f5f0}
  @media (prefers-color-scheme:dark){svg{--bg:#1a1a18;--t1:#e8e6de;--t2:#b4b2a9;--bx:#2c2c2a}}
  .bg{fill:var(--bg)}
  .t,.ts,.th{font-family:system-ui,-apple-system,sans-serif}
  .t{font-size:14px;fill:var(--t1)} .th{font-size:14px;font-weight:500;fill:var(--t1)} .ts{font-size:12px;fill:var(--t2)}
  .box{fill:var(--bx);stroke:var(--t2);stroke-width:.5}
  .arr{stroke:var(--t2);stroke-width:1.5;fill:none} .ah{fill:none;stroke:var(--t2);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .leader{stroke:var(--t2);stroke-width:.5;stroke-dasharray:4 3;fill:none}
  g[class*="c-"]>rect,g[class*="c-"]>circle,g[class*="c-"]>ellipse{fill:var(--f);stroke:var(--s)}
  g[class*="c-"]>.th,g[class*="c-"]>.t{fill:var(--h)} g[class*="c-"]>.ts{fill:var(--s)}
  .c-purple{--f:#EEEDFE;--s:#534AB7;--h:#3C3489} .c-teal{--f:#E1F5EE;--s:#0F6E56;--h:#085041}
  .c-coral{--f:#FAECE7;--s:#993C1D;--h:#712B13} .c-pink{--f:#FBEAF0;--s:#993556;--h:#72243E}
  .c-gray{--f:#F1EFE8;--s:#5F5E5A;--h:#444441} .c-blue{--f:#E6F1FB;--s:#185FA5;--h:#0C447C}
  .c-green{--f:#EAF3DE;--s:#3B6D11;--h:#27500A} .c-amber{--f:#FAEEDA;--s:#854F0B;--h:#633806}
  .c-red{--f:#FCEBEB;--s:#A32D2D;--h:#791F1F}
  @media (prefers-color-scheme:dark){
    .c-purple{--f:#3C3489;--s:#AFA9EC;--h:#CECBF6} .c-teal{--f:#085041;--s:#5DCAA5;--h:#9FE1CB}
    .c-coral{--f:#712B13;--s:#F0997B;--h:#F5C4B3} .c-pink{--f:#72243E;--s:#ED93B1;--h:#F4C0D1}
    .c-gray{--f:#444441;--s:#B4B2A9;--h:#D3D1C7} .c-blue{--f:#0C447C;--s:#85B7EB;--h:#B5D4F4}
    .c-green{--f:#27500A;--s:#97C459;--h:#C0DD97} .c-amber{--f:#633806;--s:#EF9F27;--h:#FAC775}
    .c-red{--f:#791F1F;--s:#F09595;--h:#F7C1C1}}
</style>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path class="ah" d="M2 1L8 5L2 9"/></marker></defs>
<rect class="bg" width="680" height="H"/>
<!-- content -->
</svg>
```

The colors are three stops per ramp: a light fill, a mid stroke (also the subtitle color) and a dark
title color, swapped for dark mode. Put the `c-*` class on a `<g>` that holds the shape and its text.

### Node patterns

Single line, 44 px high:

```xml
<g class="c-blue"><rect x="100" y="20" width="180" height="44" rx="8" stroke-width="0.5"/>
  <text class="th" x="190" y="42" text-anchor="middle" dominant-baseline="central">Service name</text></g>
```

Two lines, 56 px high, titles and subtitles 18 px apart (`th` at y + 18, `ts` at y + 36).

Connector: `<line x1="200" y1="76" x2="200" y2="120" class="arr" marker-end="url(#arrow)"/>`. Use `fill="none"`
on every connector path. Container: a `rx="16"` rectangle in a `c-*` group, with its label at the top
left and 20 px of padding inside.

## Design rules

- **Flat.** No gradients, shadows, blur or glow. Stroke width 0.5 on node borders. Corner radius 8
  for nodes, 12 for inner containers, 16 to 20 for outer ones.
- **Two text sizes.** `th` 14 px medium for titles, `ts` 12 px for subtitles and arrow labels, `t` 14
  px for plain text. Sentence case, never Title Case or ALL CAPS. Every `<text>` carries one of the
  three classes, and text inside a box has `dominant-baseline="central"`.
- **Width.** Box width at least `characters * 8 + 48` for 14 px text, `characters * 6.5 + 48` for 12 px.
- **Space.** At least 60 px between boxes and 10 px between an arrowhead and the box. Nest at most
  two or three levels.
- **Meaning, not decoration.** No icons inside boxes, no rainbow cycling of colors.

## Diagram types

1. **Flowchart**: one direction, top to bottom or left to right, four or five nodes per row.
2. **Containment**: outer containers with inner regions; dashed rectangles for logical groups.
3. **Tree or map**: a root branching into groups (endpoints, a taxonomy, a hierarchy).
4. **Data flow**: sources on the left, processing in the middle, sinks on the right.
5. **Physical or structural**: shapes that match the object, drawn outside first, then the inside
   sections, then details, then leader lines with labels.
6. **Hub and spoke**: a central platform with subsystems around it, one line style per kind of link
   (data dashed, power solid, water thick), with the legend stated in the reply.
7. **Narrative journey**: a winding path with the state of the thing changing along it.
8. **Exploded view**: a vertical stack of layers with labels alternating left and right.
9. **Dashboard mockup**: a dark screen inside a light frame, with small bars, gauges and green,
   amber and red status dots. The screen stays dark in both modes.

| Physical form | SVG element |
|---|---|
| Curved bodies (a tank, a fuselage) | `<path>` with curve commands |
| Tapered or angular shapes (a wing, a fin) | `<polygon>` |
| Round parts (an engine, a wheel) | `<ellipse>`, `<circle>` |
| Beams and struts | `<line>` |
| Compartments | `<rect>` nested in its parent |
| Hidden or optional parts | dashed stroke |

For physical shapes define semantic classes in the same `<style>` (for example `.wing`, `.engine`)
with the same fill and stroke pairs, instead of reusing `c-*` classes.

## Pitfalls

- **Invented content.** A neat mechanism you made up teaches the wrong thing. Stick to what is known
  and say what is simplified.
- **Unclassed text**, which falls back to black and disappears in dark mode.
- **Connectors without `fill="none"`**, which become black blobs.
- **Arrows crossing unrelated boxes.** Reroute with an elbow.
- **Six colors.** More than three ramps stops meaning anything.
- **External fonts, images or scripts.** The SVG is sandboxed; keep everything inline.
- **Color classes on `<path>` connectors.** Put them on groups and shapes only.

## Verification

- Every `<text>` has `t`, `ts` or `th`; every text inside a box is centered with `dominant-baseline`.
- Every box is wide enough by the width rule, and the longest label still fits.
- All content sits within x = 40 to 640, and the `viewBox` height is the lowest element plus 40.
- The arrow `<marker>` is defined and every arrow line uses it.
- No gradients, shadows or filters; two or three color ramps used by meaning.
- The reply says what the diagram shows and what you simplified or assumed.
