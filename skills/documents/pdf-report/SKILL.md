---
name: pdf-report
title: PDF report
description: Write a polished PDF report, brief or one-pager.
version: 1.0.0
author: Ravnir
license: MIT
default: true
---

# PDF Report

Make a `.pdf` with `make_document` from Markdown (clean report layout, tables, charts, page numbers)
or from a full HTML page when the user wants a designed piece such as an invoice, a one-pager or a
certificate. A PDF is for reading and sending: it should look finished and need no explanation.

## When to Use

- The user asks for a PDF, a report, a brief, a memo, a summary to send, an invoice or a one-pager.
- Research or analysis results that someone will read later or forward.

Use word-document instead when the user will edit the text; spreadsheet when they will work with the numbers.

## Procedure

1. Gather and check the facts first. Every figure, name and date must come from a source you
   have. Use absolute dates ("27 October 2026"), never "yesterday".
2. Structure it for a busy reader: a one-line title, then a short summary of the answer and what
   to do about it, then the evidence in sections with descriptive headings, then sources.
3. Write it in Markdown: `#` for the title, `##` for sections, short paragraphs, tables for
   anything compared across more than two items, a `chart` block for trends and comparisons.
4. Call `make_document` with `format: "pdf"`, a `title`, a `path` like
   `outputs/competitor-brief-2026-10.pdf`, the Markdown in `content`, and options if needed.
5. Reply with one or two sentences: the headline finding and what the PDF contains.

### Markdown it understands

- Headings, bold, italic, links, bullet and numbered lists (nested), task lists, quotes, code,
  horizontal rules, tables (number columns are right-aligned automatically).
- Images: `![Caption](charts/margin.png)`, a PNG, JPEG or GIF inside your workspace.
- A page break: a line with only `\pagebreak`.
- Charts, with the same spec as charts in chat:

````markdown
```chart
{ "type": "line", "title": "Monthly revenue", "unit": "€",
  "labels": ["Jul", "Aug", "Sep"],
  "series": [{ "name": "2026", "data": [12400, 9800, 14100] }] }
```
````

  `type` is `bar`, `hbar`, `stacked`, `line`, `area`, `pie` or `donut`; every series has a `name`
  and a `data` list as long as `labels`; optional `subtitle`, `note`, `unit`, `decimals`, `yMin`, `yMax`.

### Options

`{"subtitle": "Prepared for the board", "accent": "#2F5DA8", "landscape": true, "pageSize": "Letter",
"pageNumbers": false, "cover": false}`. A4 portrait with page numbers is the default. When the
Markdown has no `#` title, the `title` is printed at the top unless `cover` is false.

### Full HTML

When `content` starts with `<!doctype html>` or `<html>`, it is printed as it is. Put all CSS in a
`<style>` tag and set the page with `@page { size: A4; margin: 0; }`. JavaScript does not run and
nothing is fetched from the web; images load only from your workspace by relative path, like
`<img src="logo.png">`. Use this for layouts Markdown cannot express, and check the result.

## Pitfalls

- Burying the answer under background. The first paragraph should say what you found.
- Long unbroken text. Headings every few paragraphs, lists for parallel items, a table for comparisons.
- Copying web pages wholesale. Summarize in your own words and link the sources.
- A currency or unit the source does not state. If the data says 14400, do not label it € or $; write the unit only when you know it.
- Unsourced numbers. Every figure needs a source in the text or in the sources section.
- Images that live on the web: download them into the workspace first, or they will not appear.

## Verification

- `make_document` reports the page count and any image or chart it could not draw. Fix and remake.
- A brief should be 1 to 3 pages. If it ran long, cut, do not shrink the text.
- Spot-check that every table and chart number matches its source.
