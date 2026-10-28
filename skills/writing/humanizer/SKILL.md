---
name: humanizer
title: Humanizer
description: Rewrite text to remove AI writing tells and sound human.
version: 1.0.0
author: Ravnir, adapted from Siqi Chen (blader) via Nous Research hermes-agent (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/skills/creative/humanizer
---

# Humanizer

Text written by a language model drifts toward the most likely phrasing, and that is where the tells
come from: inflated importance, stock vocabulary, tidy triplets, decorative formatting. This skill is
a checklist of those patterns (from the Wikipedia guide "Signs of AI writing" and its adapters) and a
method for rewriting them without flattening the voice. Removing the tells is half the job; the
other half is writing something a person would actually say.

## When to Use

- The owner asks to humanize, de-slop or "make this not sound like AI".
- A draft (post, email, memo, README, release note, cover letter) will go out under the owner's name.
- The owner gives a sample of their own writing and wants a draft to match it.
- You are about to deliver your own long-form prose, such as a summary or a report. Do one pass on it.

Do not use it to disguise authorship where the owner has to disclose it, or to polish facts you have
not checked.

## Procedure

1. **Get the text and the target voice.** The text arrives inline, as an attached file (open it with
   `read_file`, or `read_document` for a PDF, Word or PowerPoint file), or as a path in the
   workspace. If the owner gave a sample of their own writing, read it first and note sentence
   length, vocabulary level, how paragraphs open, punctuation habits and recurring phrases. If no
   sample exists, look in the owner's notes for past writing if you have access to them; otherwise
   use a plain, varied, direct voice.
2. **Scan for the patterns below.** Mark every hit before you rewrite anything.
3. **Rewrite each hit.** Use the simplest accurate construction: "is" and "has" over "serves as" and
   "boasts"; a named source over "experts say"; a concrete fact over a claim of significance.
4. **Keep the meaning and the facts.** Do not add examples, names, studies, numbers or personal
   anecdotes that are not in the original or given by the owner. Where a sentence only works with an
   invented specific, cut the sentence or ask.
5. **Add voice where it fits.** Vary sentence length. Allow an opinion if the owner holds one. Use "I"
   only when the text is the owner's own first-person writing and the claim is theirs.
6. **Audit your own rewrite.** Ask: what still makes this read as machine-written? List the
   remaining tells in a line or two, then fix them. One round is usually enough.
7. **Deliver.** Show the final text, and a short list of what changed. For a file, apply targeted
   edits with `edit_file` (or `write_file` for a full rewrite) and show the changed sections rather
   than overwriting silently. For a deliverable file, `make_document` can render the result.

## The patterns

### Content

| Pattern | Look for | Fix |
|---|---|---|
| Inflated significance | "stands as a testament", "pivotal moment", "evolving landscape", "marks a shift" | State what happened and when. |
| Notability padding | a list of outlets, "active social media presence" | Name one source and what it said. |
| Dangling "-ing" analysis | "highlighting", "underscoring", "showcasing", "fostering" tacked on the end | Cut it, or make it a sentence with a subject and a fact. |
| Promotional tone | "nestled", "vibrant", "breathtaking", "rich heritage", "renowned" | Neutral description with specifics. |
| Vague attribution | "experts argue", "industry reports", "observers note" | Name the source or drop the claim. |
| Formulaic "challenges" section | "Despite challenges, X continues to thrive" | Say what the problem was and what was done. |

### Language

| Pattern | Look for | Fix |
|---|---|---|
| AI vocabulary | delve, tapestry, testament, pivotal, crucial, intricate, landscape (abstract), underscore, foster, garner, showcase, align with | Plain word. |
| Business filler | "at the end of the day", "moving forward", "deep dive", "game-changer", "unpack", "lean into", "circle back" | Say the thing directly. |
| Copula avoidance | "serves as", "functions as", "boasts", "features" | "is", "has". |
| Negative parallelism | "It is not just X, it is Y"; clipped tails like "no guessing" | State Y. Turn tails into a real clause. |
| Rule of three | triplets everywhere, "innovation, inspiration, and insights" | Use the number of items there really are. |
| Synonym cycling | "the protagonist", "the main character", "the hero" in turn | Repeat the plain noun or use a pronoun. |
| False ranges | "from the Big Bang to dark matter" with no real scale | List the actual topics. |
| Hidden actor | "No setup is needed. Results are saved." | Name who does it when that is clearer. |

### Style

| Pattern | Look for | Fix |
|---|---|---|
| Dash overuse | dashes used for drama where a comma, period or parentheses works | Rewrite with commas, periods or parentheses. |
| Mechanical bold | bold on every key term | Keep bold for the rare warning. |
| Bold-header bullets | "- **Speed:** Speed is improved." | Fold into one sentence, or plain bullets. |
| Title Case headings | "Strategic Negotiations And Partnerships" | Sentence case. |
| Emoji decoration | emoji on headings and bullets | Remove. |
| Curly quotes | typographic quotes in plain-text contexts | Straight quotes. |
| Hyphen uniformity | every common pair hyphenated the same way | Hyphenate only where it prevents confusion. |

### Communication

| Pattern | Look for | Fix |
|---|---|---|
| Chatbot leftovers | "Great question!", "I hope this helps", "Let me know if", "Certainly!" | Delete. |
| Cutoff disclaimers | "based on available information", "details are limited" | Say what is known and how you know it. |
| Servile tone | praise of the question, "you're absolutely right" | Answer. |
| Filler and hedging | "in order to", "due to the fact that", "could potentially possibly" | "to", "because", "may". |
| Generic upbeat ending | "the future looks bright", "exciting times ahead" | End on the last concrete fact or next step. |
| Authority tropes | "the real question is", "at its core", "what really matters" | Make the point without the ceremony. |
| Signposting | "let's dive in", "here's what you need to know" | Start with the content. |
| Fragmented headers | a heading followed by a line that restates it | Delete the line. |
| Forced metaphor | a garden, ecosystem or journey that then gets explained | Say the literal thing. |
| Punchy kickers | "Not promises. Just results. Every time." | Fold into a real sentence with a subject. |
| Self-answered questions | "What makes it good? Predictability." | State it. |
| Opener tics | "So,", "Look,", "Interestingly,", "Importantly," | Drop the opener. |
| Reassurance kickers | "And that's okay.", "you're not alone" | Make the point and stop. |

### Example

Before: "Great question! The new dashboard serves as a pivotal tool for teams, showcasing real-time
insights and fostering collaboration. It is not just a report, it is a game-changer."

After: "The new dashboard shows each team's open tasks and updates when someone changes one."

(The after version only claims what the before version could be checked against. If the dashboard
facts are not in the source, ask rather than invent them.)

## Pitfalls

- Over-correcting into a different kind of tell: every sentence short, every paragraph ending on a
  quip. Read it aloud; if it sounds performed, relax it.
- Replacing a vague claim with an invented specific. Humanizing is not embellishing.
- Putting opinions or experiences in the owner's mouth that they did not state.
- Stripping terms of art or required legal and technical wording along with the filler.
- Applying every pattern to short, plain text that has none of them. If it is already clean, say so.
- Matching a voice sample too literally, so that quirks of one sentence become rules.

## Verification

- Reread the final text against the pattern tables once more; no leftover stock phrases.
- Every fact, name and number in the result appears in the original or in what the owner gave you.
- The rewrite has varied sentence lengths and at least some plain "is" and "has" constructions.
- If a voice sample was given, the result reads like it. If a file was changed, you showed the diff.
- You did not claim the text is undetectable. You only claim it is cleaner and more direct.
