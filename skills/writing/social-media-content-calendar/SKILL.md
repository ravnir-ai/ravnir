---
name: social-media-content-calendar
title: Content calendar
description: Plan a multi-platform social calendar from brief to drafts.
version: 1.0.0
author: Ravnir, adapted from Ben Barclay (benbarclay) via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/optional-skills/creative/social-media-content-calendar
---

# Content Calendar

Plan a concrete calendar across the platforms the owner picks: campaign structure, a brief for every
post, copy adapted to each channel, a review pass, and an approved package. Ravnir has no social
posting tool of its own, so the verified end point is approved drafts for the owner's scheduler,
unless the owner has connected a plugin for a platform. Say which it is; never claim a post is
scheduled or published when it is only drafted.

## When to Use

- "Build next month's social calendar."
- "Turn this launch into posts for X, LinkedIn, Instagram and TikTok."
- "Repurpose these articles or videos into social content."
- "Draft a campaign and get it ready to schedule."

Do not use it for a single one-off post. Just write it.

## Prerequisites

- The owner's brief, or enough to ask for it (step 1).
- Source material the owner can give or point to: files, links, a product page, past posts.
- Optional: a connected plugin for any platform you are expected to publish to. Check which tools you
  actually have before you promise anything.

## Procedure

1. **Define the constraints.** Collect objective, audience, offer or message, platforms, date range,
   posting cadence, voice, claims you must or must not make, links and tracking conventions, language,
   and who approves. Ask the missing ones in one `ask_user` call. Done when each proposed post can
   be tied to a purpose.
2. **Inventory the source material.** Read what the owner supplied: `read_file` for files,
   `read_document` for PDFs, Word, Excel and PowerPoint attachments, `web_fetch` for pages, and
   `web_search` only for facts you need to confirm. Note dates, product facts, quotes, testimonials
   (only with permission), assets and who owns each claim. Done when unsupported claims and missing
   assets are listed.
3. **Build themes and slots.** Mix content types such as education, proof, product, community,
   events, behind the scenes and conversation. Fit each platform's natural cadence and the campaign's
   milestones. One idea may become a thread on one channel and a single image on another, but avoid
   the same post pasted everywhere. Done when dates, platforms and themes form a coherent plan.
4. **Write a brief for each post.** Include the hook, core message, format, copy length, call to
   action, link, asset description, alt text, tags or mentions, and how success will be judged. Done
   when a creator could produce it with no hidden context.
5. **Draft the copy.** Adapt voice to each platform instead of copying. If the `humanizer` skill is
   available to you, open it for a final pass. Assets are described in the brief; if an asset is
   simple, a clean SVG or HTML mock can be made with `create_artifact`, but say it is a draft. Done
   when every slot has copy and an asset status.
6. **Review before anything goes out.** Check facts, tone, repetition, rights and permissions,
   disclosures (paid partnerships and so on), link destinations, date relevance and whether the
   moment is sensitive. Mark each post `draft`, `needs review` or `approved`. Done when every post
   has a status and an owner.
7. **Deliver the calendar.** Build it as a spreadsheet with `make_document` (format `xlsx`; one
   row per post with date, platform, theme, copy, asset, status) or as a document for review. Present
   the approval batch in the reply.
8. **Publish only what is approved, and only if you can.** If the owner approves a post and a
   plugin for that platform is connected, use it, after `ask_user` confirms the exact text, account
   and time. Otherwise mark the slot `handed off`. To follow up later, `create_job` can remind the
   owner on the posting day. Read back the result of anything you did publish.

## Pitfalls

- Identical copy on every platform.
- Filling the cadence with low-value repeats.
- Invented metrics, testimonials, quotes or future claims. Use only what the owner supplied or
  what you verified.
- Treating a finished draft as a scheduled post.
- Posting from the owner's accounts, or through the browser, without an explicit yes on the exact
  content.
- Ignoring platform rules, character limits or disclosure requirements. Check them before you
  say a post is ready.
- Copying a competitor's wording.

## Verification

- Every post traces to an objective and to a claim you verified.
- No post was published from `draft` or `needs review`.
- Every slot says `draft`, `approved`, `handed off` or `published`, and `published` ones have a
  confirmation you read back.
- Rights, permissions and disclosures were checked.
- The reply says clearly what the owner still has to do themselves.
