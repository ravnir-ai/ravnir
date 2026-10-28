---
name: architecture-diagram
title: Architecture diagram
description: Draw a dark system architecture diagram as an HTML page.
version: 1.0.0
author: Ravnir, adapted from Cocoon AI via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/skills/creative/architecture-diagram
---

# Architecture Diagram

A system architecture diagram as one self-contained HTML page with inline SVG, in a dark,
grid-backed style. You save it with `create_artifact` (kind `html`), so the owner sees it as a card
in the chat, can open it full size and can download it.

For a quick or plain flow where the look does not matter, the cheaper route is a fenced
`mermaid` block in your reply, or `create_artifact` with kind `mermaid`. The app draws both. Use
this skill when the owner wants a diagram they will present, share or keep.

Based on Cocoon AI's architecture-diagram-generator (MIT).

## When to Use

- Software architecture: frontend, backend, database layers; an API and its data stores.
- Cloud and infrastructure: networks, regions, subnets, managed services, deployment layouts.
- Microservice or event-driven topology; a data pipeline between systems.
- "Draw how X is built" when X is a codebase, a product or a plan.

Use `concept-diagrams` instead for science, physical objects, floor plans and teaching visuals, and
`sketch` for UI mockups. A numeric chart is a fenced `chart` block in the reply, not this.

## Procedure

1. **Inventory first, and never invent.** List components, their groups, and each connection with its
   direction and protocol. If the diagram is of the owner's code, read it (`list_dir`, `read_file`,
   `search`) and diagram what is there, not what is typical. Mark anything you could not confirm as
   "unconfirmed" in the summary cards.
2. **Group by meaning**, and give each group one color from the table below.
3. **Plan the layout on paper before writing SVG.** Put layers in columns or rows, keep at least
   40 px between components vertically, and compute every `x`, `y`, width and height first. A message
   bus sits in the gap between the services it connects, never on top of them.
4. **Write the page** with the structure in the skeleton below: header with a title and subtitle, the
   SVG inside a rounded card, three summary cards under it (what it is, key flows, what is
   unconfirmed or risky), and a minimal footer.
5. **Draw in this order**: background grid, boundaries, connections, then component boxes on top,
   then labels, then the legend last. Arrows go early so boxes cover their ends.
6. **Save** with `create_artifact`: kind `html`, a title like "Ravnir architecture". To fix something,
   use `update_artifact` with the full new content.
7. **Reply in two or three sentences**: what the diagram shows, what you could not confirm.

### Color by meaning

| Component | Fill | Stroke |
|---|---|---|
| Frontend | `rgba(8,51,68,0.4)` | `#22d3ee` |
| Backend | `rgba(6,78,59,0.4)` | `#34d399` |
| Database | `rgba(76,29,149,0.4)` | `#a78bfa` |
| Cloud service | `rgba(120,53,15,0.3)` | `#fbbf24` |
| Security | `rgba(136,19,55,0.4)` | `#fb7185` |
| Message bus | `rgba(251,146,60,0.3)` | `#fb923c` |
| External | `rgba(30,41,59,0.5)` | `#94a3b8` |

Security flows and groups are dashed rose lines (`stroke-dasharray="4,4"`). Regions are large dashed
amber rectangles (`8,4`, `rx="12"`).

### Skeleton

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>System architecture</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:#020617;color:#fff;padding:2rem}
  .wrap{max-width:1200px;margin:0 auto}
  h1{font-size:1.5rem;letter-spacing:-.02em}
  .sub{color:#94a3b8;font-size:.875rem;margin:.4rem 0 1.5rem}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#22d3ee;margin-right:.6rem;animation:p 2s infinite}
  @keyframes p{50%{opacity:.5}}
  .board{background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:1rem;overflow-x:auto}
  .board svg{min-width:720px;width:100%;height:auto;display:block}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;margin-top:1.5rem}
  .card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:1rem}
  .card h3{font-size:.9rem;margin-bottom:.5rem}
  .card li{list-style:none;color:#94a3b8;font-size:.8rem;line-height:1.7}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style></head><body><div class="wrap">
<h1><span class="dot"></span>Title</h1><p class="sub">One line on scope</p>
<div class="board">
<svg viewBox="0 0 1000 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Architecture of ...">
  <defs>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="#1e293b" stroke-width=".5"/></pattern>
    <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M2 1L8 5L2 9" fill="none" stroke="#94a3b8" stroke-width="1.5"/></marker>
  </defs>
  <rect width="1000" height="560" fill="#020617"/><rect width="1000" height="560" fill="url(#grid)"/>
  <!-- boundaries, then connections -->
  <path d="M200 110H380" stroke="#94a3b8" stroke-width="1.5" fill="none" marker-end="url(#ah)"/>
  <!-- components: opaque base first, translucent fill on top -->
  <rect x="60" y="80" width="140" height="60" rx="6" fill="#0f172a"/>
  <rect x="60" y="80" width="140" height="60" rx="6" fill="rgba(8,51,68,0.4)" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="130" y="106" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">Web app</text>
  <text x="130" y="124" text-anchor="middle" fill="#94a3b8" font-size="10">React, Vercel</text>
  <!-- legend last, below the lowest boundary -->
</svg></div>
<div class="cards"><div class="card"><h3>Summary</h3><ul><li>One fact per line</li></ul></div></div>
</div></body></html>
```

An optional monospace web font may be linked from Google Fonts; the system stack above is the
fallback, so the page works offline.

## Pitfalls

- **Components or links that are not in the source.** A tidy picture of an invented system is worse
  than none.
- **Text that overflows its box.** At 12 px monospace a character is about 0.6 of the font size
  wide, so a box needs roughly `characters * 7.5 + 24` px. Widen the box or shorten the label.
- **Fonts below 10 px.** The page is often scaled down on a phone. Use 12 for names and 10 for
  sublabels.
- **Arrows drawn after boxes**, so lines cut through them. Draw connections first.
- **The legend inside a boundary or overlapping one.** Place it at least 20 px below the lowest
  boundary.
- **Semi-transparent boxes showing arrows through them.** Paint the opaque base rectangle first.
- **Secrets on the page.** Never put keys, tokens, passwords or private addresses in a label.
- **Scripts or remote images.** None are needed; the page is pure HTML, CSS and SVG.

## Verification

- Every `x + width` and `y + height` fits inside the `viewBox`, and the `viewBox` height is the lowest
  element plus about 40.
- Each connection starts and ends on a real component edge and has a direction.
- Each label fits its box by the width rule above.
- Every component and link traces back to something you read or the owner said; the rest is marked
  unconfirmed.
- The artifact opened as a card; the reply says what it shows and what is unconfirmed.
