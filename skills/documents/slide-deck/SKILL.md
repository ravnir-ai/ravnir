---
name: slide-deck
title: Slide deck
description: Build a PowerPoint deck with a clear storyline.
version: 1.0.0
author: Ravnir
license: MIT
default: true
---

# Slide Deck

Make a `.pptx` with `make_document` that opens in PowerPoint, Keynote and Google Slides. The
renderer handles layout and design; your job is the story. A great deck says one thing per slide,
and someone who reads only the titles still gets the whole argument.

## When to Use

- The user asks for a presentation, slides, a deck, a pitch or a board or client update.
- Results need to be shown to other people in a meeting.

For a document that is read, not presented, use the pdf-report or word-document skill.

## Procedure

1. Gather the facts first. Every number on a slide must come from a source you have; never invent
   a figure, a quote or a logo.
2. Write the storyline before any slide: the one-sentence message, then 3 to 5 points that
   support it, then what you ask of the audience. Lead with the answer, not the background.
3. Turn each point into slides. Use action titles: a full sentence that states the takeaway
   ("Revenue grew 12% on repeat customers"), not a label ("Revenue").
4. Pick the slide type that shows the point best: one big number is a `stat` slide, a trend or
   comparison is a `chart`, a few precise figures are a `table`, a contrast is `two-column`.
   Bullets are the last resort, not the default.
5. Put the detail and the sources in `notes`, so the slide stays clean and the speaker has it.
6. Call `make_document` with `format: "pptx"`, a `title`, a `path` like `outputs/q3-results.pptx`,
   and the spec as a JSON string in `content`.
7. Reply in a sentence or two with the storyline, not a slide-by-slide list.

A typical shape: title, executive summary (the answer in 3 bullets), one section per point,
next steps or the ask. 8 to 14 slides for a meeting; fewer is better.

### The spec

```json
{
  "theme": { "accent": "#2F5DA8", "font": "Arial" },
  "slides": [
    { "type": "title", "title": "Q3 results", "subtitle": "Sales team, 27 October 2026" },
    { "type": "bullets", "title": "Q3 beat plan on repeat customers",
      "bullets": ["Revenue €36.3k, 12% above plan", "Repeat customers drove 70% of growth", ["July was a record month"], "Margin held at 30%"],
      "notes": "Source: sales.xlsx, sheet Sales." },
    { "type": "stat", "title": "Three numbers that matter", "stats": [
      { "value": "+12%", "label": "revenue vs plan" }, { "value": "70%", "label": "growth from repeat" }, { "value": "30%", "label": "gross margin" } ] },
    { "type": "chart", "title": "September was the strongest month",
      "chart": { "type": "bar", "labels": ["Jul", "Aug", "Sep"], "unit": "€",
        "series": [{ "name": "2026", "data": [12400, 9800, 14100] }, { "name": "2025", "data": [11000, 9000, 12000] }] } },
    { "type": "table", "title": "Every region grew", "columns": ["Region", "Q2", "Q3", "Change"],
      "rows": [["North", "€10.2k", "€11.9k", "+17%"], ["South", "€9.1k", "€9.6k", "+5%"]] },
    { "type": "two-column", "title": "What worked and what did not",
      "left": { "heading": "Worked", "bullets": ["Bundles", "Email follow-ups"] },
      "right": { "heading": "Did not", "bullets": ["Paid social", "Discount codes"] } },
    { "type": "image", "title": "The new checkout", "image": "screenshots/checkout.png", "caption": "Live since 2 September" },
    { "type": "quote", "quote": "We reorder because it is easy.", "by": "Customer interview, October" },
    { "type": "section", "title": "Next steps", "subtitle": "What we need from you" }
  ]
}
```

- Slide types: `title`, `section`, `bullets`, `two-column`, `table`, `chart`, `stat` (up to 4),
  `image`, `quote`. Any slide takes `notes`.
- `bullets`: a nested list is a sub-point, as above.
- `chart`: the same spec as charts in chat. `type` is `bar`, `hbar`, `stacked`, `line`, `area`,
  `pie` or `donut`; `labels` and one `data` list per series of the same length; optional `unit`
  (`€`, `$`, `%` or a word), `decimals`, `title`, `note`. Pie and donut use the first series only,
  at most 8 slices. The chart is placed as a picture so every app shows it; add `"native": true`
  only when the user must edit the chart in PowerPoint (Keynote cannot show native charts).
- `image`: a PNG, JPEG or GIF inside your workspace. Take a screenshot or download it first.
- `theme`: `accent`, `background`, `text`, `muted`, `font`. Use the user's brand color when known.
- `"slideNumbers": false` at the top level hides slide numbers.

## Pitfalls

- Walls of text. At most 5 bullets of about 12 words; if you need more, split the slide or move it to notes.
- Label titles ("Overview", "Data") that make the reader work out the point.
- A table of more than 8 rows on one slide; show the top rows and put the rest in an Excel file.
- Charts with too many series. Two or three is readable; eight is not.
- A currency or unit the source does not state. If the data says 14400, do not label it € or $; write the unit only when you know it.
- Numbers that disagree between slides. Use one source and round the same way everywhere.
- Images from the web without a local copy: the renderer does not download anything.

## Verification

- `make_document` reports the slide count and any slide it could not build. Fix those and remake it.
- Read your titles in order. They should tell the whole story on their own.
- Check every number on a slide against its source once.
