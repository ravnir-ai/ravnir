---
name: blocked-page-recovery
title: Blocked page recovery
description: Recover a blocked or paywalled page from an archived copy.
version: 1.0.0
author: Ravnir, adapted from Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/skills/web/blocked-page-recovery
---

# Blocked Page Recovery

When a page will not come back — 403, 429, a Cloudflare "Just a moment", a paywall, a bot wall —
the page usually still exists somewhere. Third-party services keep copies. Work down this ladder
cheapest first, and stop at the first copy you can verify.

You do not need a script for this. Every step is a plain `web_fetch` on a public API.

## When to Use

Use when any of these happens:

- `web_fetch` returns 403, 429, 503, or a wall instead of the article
- The text you get is an interstitial ("Just a moment…", "Enable JavaScript", "Checking your browser")
- `browser_open` shows a page that stays blank, or the site refuses this server's network
- The owner pastes a link and you cannot read it

Do not use it when the page needs a login you do not have, or when the content is behind a form
only the owner can fill in. Those go to `ask_user`, not to an archive.

## Prerequisites

- Nothing installed. `web_fetch` needs no approval, and so does every endpoint below.
- `references/endpoints.md` in this skill has the exact URLs, parameters and response shapes.
  Open it with `skill_view` when a step needs the precise call.

## Procedure

Work down the list. After each attempt, check the body against the four validation rules below
before you believe it.

1. **The Wayback Machine.** Ask its availability API for the URL, then fetch the snapshot it
   returns. Prefer the newest snapshot from the last two years; an old copy of a price or a
   changelog is worse than no copy. Cite it as `archived from <url>, <date>`.
2. **archive.today.** If Wayback has nothing, try `archive.ph`, then `.md`, then `.li`, then
   `.is`. The same snapshot is served under all four; a domain can be blocked on its own. Cite it
   with its own date.
3. **A machine shape of the same content.** Before falling back to a browser, look for a JSON,
   GraphQL or RSS version on the same host: many sites render an article from
   `/api/...`, `/wp-json/...` or `/feed`. The notes page usually links its own feed. This is the
   least fakeable source: it is the publisher's own data.
4. **Your own browser.** `browser_open` on that exact URL. Ravnir already tried the owner's Mac
   when the note says the network was refused, so a second attempt from here is a real second
   try, not a repeat. If the page loads, read it with `browser_read` and cite it as live.
5. **The owner.** If the browser is also blocked, stop. Call `ask_user` with the URL, what you
   tried and what you need (usually: sign in, or paste the text). Never guess other addresses on
   the same site; they get the same block.

### Validation: is this really the page?

Fake successes are the norm here. A 200 with 600 bytes is not a win. Check all four:

- **Length.** A real article is usually over 2,000 characters of text. Under that, suspect a stub.
- **Title.** Reject "Just a moment", "Attention Required", "Redirecting", "Access denied",
  "Are you a robot", or a title that is just the domain.
- **Redirect back to the original.** Meta-refresh, `location.href`, or a canonical link pointing
  at the address that blocked you means you got the wall, not the copy.
- **The claim you came for.** Find the sentence you actually need. If the copy does not contain
  it, the copy does not answer the question — say so rather than citing the page generally.

### Provenance, which you keep

| Route | What it is | How to cite it |
|---|---|---|
| Wayback | A dated snapshot | `archived <date>` + the snapshot URL |
| archive.today | A dated snapshot | `archived <date>` + the archive URL |
| API / feed | The publisher's own data, live | The endpoint, and the page that links it |
| Browser | The live page | The page URL, as normal |

Never present an archived copy as the live page. If the copy is old, say how old: a blocked page
plus its real date is useful; a blocked page passed off as current is a wrong answer.

## Pitfalls

- **Looping on the original URL.** Two identical attempts is the whole failure. Change route.
- **Citing the wall.** If you only have the blocked page, you have no source. Say that.
- **Trusting a paywall "text" dump** that turns out to be the subscribe nag. Validate first.
- **Forgetting the date.** The owner reads prices, versions and policies; the snapshot date is
  part of the answer.
- **Using `run_command` and curl for this.** `web_fetch` already retries through the browser and
  needs no approval. Reach for the shell only for a POST that the notes really require.

## Verification

Before you write the answer:

- The body you are quoting passed all four validation rules.
- Every archived claim carries its date and, if the copy is older than a month, you said so.
- If nothing worked, the reply says which routes you tried and asks one clear question — it does
  not present the wall as the page.
