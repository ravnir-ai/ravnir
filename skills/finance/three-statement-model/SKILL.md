---
name: three-statement-model
title: Three-statement model
description: Build a linked income, balance sheet and cash flow model.
version: 1.0.0
author: Ravnir, adapted from Anthropic via Nous Research hermes-agent (Apache-2.0)
license: Apache-2.0
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/finance/3-statement-model
---

# Three-Statement Model

An integrated model has an income statement, a balance sheet and a cash flow statement that feed each
other, so a change in one driver flows through all three and the balance sheet still balances. You
build it as an Excel workbook with `make_document` (format `xlsx`), with live formulas, so the owner
can change an assumption and watch the statements move.

Open the `spreadsheet` skill with `skill_view` for the exact workbook spec. This skill is about what
goes in it.

## When to Use

- The owner asks for an integrated financial model, a three-statement forecast, or "IS, BS and CF"
  for a company, a business plan or a startup.
- The owner attached a model template and wants it filled in. `make_document` cannot edit a file in
  place: read the template with `read_document`, copy its line items, order and sign convention, and
  say plainly that you rebuilt the workbook rather than edited theirs.

Do not use it for a valuation only (use `dcf-model`), a one-sheet budget or tracker (use
`spreadsheet`), or a P&L table the owner only wants to read once.

## Prerequisites

- The historical statements the model starts from. Sources, in order: files the owner attached
  (`read_document`), numbers the owner typed, then public filings (the 10-K financial statements on
  SEC EDGAR through `web_fetch`, or the company's investor page).
- Anything you cannot source stays empty and is labelled `UNSOURCED` in the notes column. Never
  invent a historical figure to complete a table.

## Procedure

1. **Pin the scope.** Entity, reporting currency, units ("USD millions" is written once on a Control
   sheet, never baked into a number format), fiscal year end, how many historical and projected years
   (five projected is a sensible default), annual only unless asked. Use the currency the source
   filing uses.
2. **Check the historicals tie before projecting.** For each historical period, assets equal
   liabilities plus equity, and cash flow ending cash equals balance sheet cash. If they do not,
   report the gap and ask; do not plug it.
3. **First checkpoint, in your reply.** Show the historical block as a table and the driver
   assumptions you intend to use (revenue growth, cost percentages of revenue, working capital days,
   capex percent, tax rate, interest rate, dividends, debt repayment). If the owner has not given
   drivers, propose them with the reasoning (history, guidance) and ask once with `ask_user` whether
   to proceed. If they already gave the numbers and said to build it, build it and list the
   assumptions afterwards.
4. **Fix the row map before writing any formula.** The workbook spec makes the header row 1 and the
   first item row 2, so item `i` (from 0) is on row `i + 2`. Write down, in your notes, the row of
   every line item on every sheet. Off-by-one references are the most common failure.
5. **Lay out the sheets** around what the spec can do (one number format per column, no per-cell
   styling):
   - `Control`: scenario selector (integer 1, 2, 3), units, currency, fiscal year end.
   - `Assumptions`: every driver as a percent, one row per driver, one column per projected year.
     Days-based drivers (receivable, inventory and payable days) go on a small `Days` sheet because
     they are not percents.
   - `IS`, `BS`, `CF`: line items down the first column, one column per period labelled `FY2024A`,
     `FY2025E`. The same period sits in the same column letter on every sheet, so a link reads
     `=IS!E12`. Amounts only, with format `number` or `integer`. Percent lines (growth, margins)
     live on `Assumptions` or a `Ratios` sheet, never inside a statement.
   - Schedules: `WC` (working capital), `PPE`, `Debt`, and `Equity` (retained earnings), plus an
     `NOL` schedule only when the business has losses to carry.
   - `Checks`: see step 9.
   Section titles inside a statement are rows with only the first cell filled. Set `filter: false`
   on statements.
6. **Make every projected cell a formula.** Only historical actuals and assumption drivers may be
   typed numbers. Never compute a projection yourself and write the result in a cell, or the model
   stops responding to its drivers.
   - Revenue: prior year times `1 + growth`. Cost of revenue and each operating expense line: net
     revenue times its percent driver. Gross profit is net revenue minus cost of revenue (not gross
     revenue).
   - EBIT is gross profit minus operating expenses and D&A; EBITDA is EBIT plus D&A.
   - Interest: opening debt balance times the rate. This avoids a circular reference, because the
     workbook cannot turn on iterative calculation. Say that you did it this way.
   - Tax: `=MAX(0, pre-tax income * rate)`. With an NOL schedule, taxable income is pre-tax income
     minus losses used, and use is capped at the utilization limit set in an assumption cell (for US
     federal losses arising after 2017 that limit is 80 percent of taxable income; ask which rules
     apply).
   - Working capital: receivables are revenue times receivable days over 365; inventory and payables
     use cost of revenue and their days.
   - PP&E: prior net plus capex minus depreciation. Debt: opening plus borrowing minus repayment.
   - Retained earnings: prior plus net income minus dividends. If you add back stock-based
     compensation on the cash flow statement, credit it to equity once, so the sheet still balances.
7. **Cash flow statement and the link back.** Operations start from net income on `IS`, add D&A and
   non-cash items, then subtract the increase in receivables and inventory and add the increase in
   payables. Investing is capex. Financing is debt issued, debt repaid, equity issued and dividends.
   Ending cash is beginning cash plus the net change, and `BS` cash links to that ending cash.
8. **Scenarios, only if asked.** Give each scenario-driven assumption three rows (base, upside,
   downside) and a live row `=CHOOSE(Control!$B$2, base, upside, downside)`. Statements read only the
   live row. Extras, only if asked: margins on `Ratios`, and credit metrics (total debt over EBITDA,
   net debt over EBITDA, EBITDA over interest, debt over total capital, current ratio).
9. **Build the `Checks` sheet.** One row per check and one column per period, each `=ROUND(x, 2)`
   that must equal 0:

   | Check | Formula |
   |---|---|
   | Balance | assets - liabilities - equity |
   | Cash tie | `CF` ending cash - `BS` cash |
   | Net income link | `IS` net income - first line of `CF` |
   | Retained earnings | prior + net income - dividends - `BS` retained earnings |
   | Debt tie | schedule ending debt - balance sheet debt |
   | Equity issued | change in common stock and APIC - equity issued on `CF` |

   Add a master cell: `=IF(SUMPRODUCT(ABS(range))=0, "All checks pass", "Errors: review")`.
10. **Call `make_document`** with `format: "xlsx"`, a clear title and a path like
    `outputs/acme-three-statement-2026-10.xlsx`. The `spreadsheet` skill has the spec shape.
11. **Verify, then reply** (see Verification). Say what is in it, the key outputs, every assumption
    you chose, and what is `UNSOURCED` or estimated.

### Sign conventions

| Where | Item | Sign |
|---|---|---|
| Operations | D&A, stock compensation | positive add-back |
| Operations | Increase in receivables or inventory | negative (cash used) |
| Operations | Increase in payables | positive (cash source) |
| Investing | Capex | negative |
| Financing | Debt issued | positive |
| Financing | Debt repaid, dividends | negative |

## Pitfalls

- **Formulas with no stored result.** `make_document` writes formulas that Excel, Numbers and
  LibreOffice calculate when the file opens. A quick-look preview may show blank cells. Tell the owner
  to open it in a spreadsheet app, and do not claim numbers you have not checked.
- **Hardcoded projections**, or an ending balance typed in to force a check to zero.
- **Percents in an amount column.** The format belongs to the column. Keep ratios on their own sheet.
- **A currency symbol or unit the source does not state.** Write the unit only when you know it.
- **Cash that does not tie.** If `BS` cash is typed rather than linked to `CF` ending cash, the
  balance check will pass for the wrong reason.
- **Mixed sign conventions** between sheets, or a working capital change with the wrong sign.
- **Gross revenue instead of net revenue** as the base for margins.
- **Editing the owner's template** silently. Say it was rebuilt.
- **Presenting a forecast as a fact.** Projections come from stated drivers, not from the future.

## Verification

- The `make_document` reply lists the sheets and row counts you planned.
- Open the file with `read_document`: the projected cells show `(=formula)`, the historical cells are
  numbers, and no sheet has an empty row where a line item should be.
- Formulas cannot be recalculated on the server, so recompute the headline lines yourself with a few
  lines of Python through `run_command`, from the same inputs: revenue, net income, ending cash and
  the balance check for the first and last projected year. They must match what the formulas will
  give. Use the script to check, never to fill cells.
- Every check row evaluates to 0 in your recomputation, in each scenario you built.
- Every number the owner will rely on has a source or is marked as an assumption.
