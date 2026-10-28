---
name: spreadsheet
title: Spreadsheet
description: Build an Excel workbook people can audit and reuse.
version: 1.0.0
author: Ravnir
license: MIT
default: true
---

# Spreadsheet

Make a real `.xlsx` with `make_document`: typed numbers, number formats, live formulas, frozen
headers and filters. A good workbook is one the reader can sort, filter, check and extend without
asking you how it was built.

## When to Use

- The user asks for an Excel, a spreadsheet, a table they can work with, a tracker or a budget.
- The answer is a list of more than about 15 rows, or numbers someone will sum, sort or chart.
- A financial model, a comparison, a lead list, an inventory, a timeline with dates.

A table that is only read once belongs in the reply or in a PDF instead.

## Procedure

1. Get the data first and keep it exact: from files (open a PDF, Word, Excel or PowerPoint the user
   attached with `read_document`), the web, tools or the user. Never invent a
   figure to fill a cell. Leave a cell empty (`null`) and say so rather than guess.
2. Plan the sheets. One table per sheet, starting at A1. With several sheets, put a short summary
   sheet first. For a model, keep inputs on an `Assumptions` sheet and reference them.
3. Write the spec (below) with numbers as numbers: `12400`, not `"12.400 €"`; `0.31` with
   `percent`, not `"31%"`; dates as `"2026-10-27"` with `date`. The format does the display.
4. Use formulas for anything derived, so the reader can audit it: `"=C2*D2"`, `"=Assumptions!B3"`.
   Data starts on row 2 (row 1 is the header), so the row of item `i` (from 0) is `i + 2`.
5. Call `make_document` with `format: "xlsx"`, a clear `title`, a `path` like
   `outputs/leads-madrid-2026-10.xlsx`, and the spec as a JSON string in `content`.
6. Reply in one or two sentences: what is in it, how many rows, anything missing or estimated.

### The spec

```json
{
  "sheets": [
    {
      "name": "Sales",
      "columns": [
        { "header": "Month", "key": "month" },
        { "header": "Date", "key": "date", "format": "date" },
        { "header": "Units", "key": "units", "format": "integer" },
        { "header": "Price (€)", "key": "price", "format": "currency:EUR" },
        { "header": "Revenue (€)", "key": "revenue", "format": "currency:EUR" },
        { "header": "Margin", "key": "margin", "format": "percent" },
        { "header": "Notes", "key": "notes", "width": 40, "wrap": true }
      ],
      "rows": [
        { "month": "July", "date": "2026-07-31", "units": 310, "price": 40, "revenue": "=C2*D2", "margin": 0.31 },
        { "month": "August", "date": "2026-08-31", "units": 245, "price": 40, "revenue": "=C3*D3", "margin": 0.28 }
      ],
      "totals": { "month": "Total", "units": "sum", "revenue": "sum", "margin": "average" }
    }
  ]
}
```

- `columns`: `header` is what the reader sees; put the unit in it, like `Price (€)`. `key` matches
  the row objects. Rows may also be arrays in column order.
- `format`: `text` (default), `integer`, `number` (2 decimals), `percent` (value 0.31 shows 31.0%),
  `currency:EUR`, `currency:USD`, `currency:GBP`, `date`, `datetime`, or a raw Excel format like `0.000`.
- `width` in characters (otherwise fitted to the content), `wrap: true` for long text.
- `totals`: `sum`, `average`, `count`, `min`, `max` per column, or a label like `"Total"`. It adds a
  bold formula row under the data.
- `freeze: false` and `filter: false` turn off the frozen header row and the filter buttons.
- Top level: `"accent": "#2F5DA8"` colors the header row; `"author"`.

## Pitfalls

- A currency or unit the source does not state. If the data says 14400, do not label it € or $; write the unit only when you know it.
- Numbers stored as text: they cannot be summed or sorted. This is the most common way to ruin a sheet.
- Hard-coded results where a formula belongs. If revenue is units times price, write the formula.
- Off-by-one formula rows: row 1 is the header, the first data row is 2.
- Merged cells, blank spacer rows and titles above the header break sorting and filters. Do not add them.
- Sheet names: at most 31 characters, none of `\ / ? * [ ] :`.
- Charts are not drawn inside the workbook. If the user needs one, also make a slide deck or PDF
  with the chart, or tell them to insert it from the data in one click.
- Very large data (tens of thousands of rows): write it as CSV with `write_file` and share that instead.

## Verification

- The reply from `make_document` states sheets and row counts. Check they match your source.
- Recompute one total by hand from the data you passed and compare.
- If the user will reuse it, say which cells are inputs and which are formulas.
