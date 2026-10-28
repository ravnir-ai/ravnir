# Skills

A skill is a folder with a `SKILL.md` that an agent opens on the turn it needs it. The agent sees
one line per skill it can open (the name and a description of at most 60 characters); the body is
paid for only when the agent calls `skill_view`.

This is the Agent Skills layout, so the folders are readable by other tools too.

```
skills/<category>/<name>/SKILL.md      the skill
skills/<category>/<name>/references/   notes the model opens only when it needs them
skills/<category>/<name>/scripts/      a helper the skill tells the agent to run
skills/<category>/<name>/templates/    a file to fill in
```

## SKILL.md

```markdown
---
name: blocked-page-recovery
title: Blocked page recovery
description: Recover a blocked or paywalled page from an archived copy.
version: 1.0.0
author: Ravnir, adapted from Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/<40-character commit>/skills/web/blocked-page-recovery
requires: [Gmail plugin]
---

# Blocked Page Recovery

Two or three sentences on what this does and does not cover.

## When to Use

Bullets that a model can match against the task in front of it.

## Prerequisites

What must exist first: a connector, a login, an installed tool.

## Procedure

Numbered steps. Name this server's tools, in backticks.

## Pitfalls

The mistakes this exact task invites.

## Verification

How to know it went well, before replying.
```

The rules, enforced by `test/skills.test.js`:

- `description` is one sentence, at most 60 characters, ending with a period. It is the whole
  retrieval surface: long descriptions dilute attention and make the index expensive.
- The folder name is the skill name. Lowercase, dashes.
- `## When to Use` and `## Procedure` are required; the other sections are the house style.
- Tool names go in backticks. `server/skills.js` rewrites them for the provider the agent runs on:
  OpenCode gets `read`/`write`/`edit`/`grep` for the file tools and `ravnir_<tool>` for the rest.
  Write the canonical name once and it works everywhere.
- No home directory paths in the body. A skill ships with the server and runs on the owner's hub.
- `license` is required. `source`, when the skill came from elsewhere, is a GitHub link pinned to a
  full commit, so the Skills page can show exactly what was copied. `title` is the name people see;
  without it the name is used. `requires` lists, in plain words, what must be connected first.

## Default skills

`default: true` in the frontmatter opens a skill to every agent, after the ones it was given. The
document skills in `documents/` are default, because making a PDF, a Word file, an Excel workbook or
a slide deck is something every agent should do well. They go with the `make_document` tool.

## Giving a skill to an agent

The Skills page in the app (rail, or More on the phone) lists every skill this server ships, by
shelf, with its license, source, author, what it needs and what opening it costs. A switch per agent
adds or removes it; an agent's Setup, Skills tab lists what that agent holds. An agent holds at most
`INDEX_LIMIT` skills in its index, the built-in ones included, so the page refuses a full agent rather
than letting a new skill push the document skills out.

The same from the API:

```bash
curl -X PUT -u "$RAVNIR_USER:$RAVNIR_PASS" \
  -H 'content-type: application/json' \
  -d '{"agents":["<bot id>","<bot id>"]}' \
  "$RAVNIR_URL/api/skills/humanizer/agents"
```

`GET /api/skills/<name>` returns one skill with its body. Or set an agent's whole list:

```bash
curl -X PATCH -u "$RAVNIR_USER:$RAVNIR_PASS" \
  -H 'content-type: application/json' \
  -d '{"skills":["systematic-debugging","blocked-page-recovery"]}' \
  "$RAVNIR_URL/api/bots/<bot id>"
```

`GET /api/skills` lists everything this server ships. An agent with no skills gets no
`skill_view` tool and no index in its prompt, so nothing is paid for by default.

## Attribution

Most skills outside `documents/` are adapted from
[Nous Research's hermes-agent](https://github.com/NousResearch/hermes-agent) at commit
`ee7e0f517232fb619c72e49d7e648436bddc598e`. Each one names its upstream author, license and exact
source in its frontmatter, and says how it was changed in its `author` line ("adapted from"): tool
names rewritten for this server, scripts replaced with steps using Ravnir's own tools, and the text
condensed. Upstream authors include Siqi Chen (`humanizer`), Ben Barclay (inbox, meeting and
document action items, price and competitor monitors, weekly review), and others named in each file;
`systematic-debugging` and `test-driven-development` trace back to
[obra/superpowers](https://github.com/obra/superpowers).

- MIT skills: the hermes-agent license is in `LICENSES/hermes-agent-MIT.txt`.
- Apache-2.0 skills (`finance/`, which hermes-agent adapted from Anthropic's financial modeling
  skills): the license is in `LICENSES/Apache-2.0.txt`. These files were modified for Ravnir.

hermes' `1password` skill was deliberately not ported: it reads secrets into the model's context.
This server's login bridge never does; see `security/saved-logins`. Skills that bypass bot checks,
look people up across sites, or move money were left out on purpose too.
