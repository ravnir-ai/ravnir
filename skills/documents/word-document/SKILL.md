---
name: word-document
title: Word document
description: Write an editable Word document, letter or proposal.
version: 1.0.0
author: Ravnir
license: MIT
default: true
---

# Word Document

Make a `.docx` with `make_document` from Markdown. Real Word headings, lists, tables, images and
charts, so the user can edit it, track changes, apply their own template or send it on.

## When to Use

- The user asks for a Word file, a .docx, or a text they will edit or sign: a proposal, a
  contract draft, a letter, a policy, a CV, meeting minutes, a template.
- Someone else (a lawyer, a client, a colleague) will edit the text after you.

For something only read, the pdf-report skill looks more finished.

## Procedure

1. Gather the facts and the user's own wording first. Use their names, dates and terms exactly;
   never invent clauses, prices, references or signatures.
2. Choose the shape for the kind of document:
   - Proposal: summary, the problem, the approach, timeline, price, next step.
   - Letter: date, recipient, subject line, body, sign-off; pass `cover: false` so no title is added.
   - Minutes: date and attendees, decisions, actions with owner and date.
   - Contract or policy draft: numbered sections, defined terms in bold on first use.
3. Write Markdown with real headings (`#`, `##`, `###`) because Word builds its navigation and
   table of contents from them. Use lists for steps and tables for anything compared.
4. Call `make_document` with `format: "docx"`, a `title`, a `path` like
   `outputs/proposal-acme-2026-10.docx`, the Markdown in `content`, and options if needed.
5. Reply in a sentence or two: what it is and what the user should still fill in or check.

### Markdown it understands

Headings, bold, italic, strikethrough, links, nested bullet and numbered lists, task lists (shown as
check boxes), quotes, code blocks, horizontal rules, tables, images from your workspace
(`![Logo](logo.png)`), a page break (a line with only `\pagebreak`), and charts in a `chart` block
with the same spec as charts in chat (see the pdf-report skill). Charts are inserted as pictures.

### Options

`{"subtitle": "Draft for review", "author": "Ana García", "font": "Arial", "accent": "#2F5DA8",
"landscape": true, "cover": false}`. When the Markdown has no `#` title, the `title` becomes the
document title at the top unless `cover` is false.

## Pitfalls

- Fake structure with bold lines instead of headings: Word cannot navigate or build a contents page from them.
- Placeholder text left in. Mark anything the user must complete as `[TO FILL: ...]` and list it in your reply.
- Legal or financial wording presented as final. Say it is a draft for the user to review.
- Very wide tables. More than 6 columns does not fit a portrait page; use `landscape` or split it.

## Verification

- `make_document` reports headings, tables and any image it could not insert. Fix and remake.
- Read the headings in order: they should outline the document on their own.
- Check every name, date and amount against what the user gave you.
