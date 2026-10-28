# From an issue to a verified pull request

Use this when the owner says "fix issue 123 and open a PR". The job is not done when the PR
exists. It is done when CI is reported from live evidence and the issue thread shows the result.
Every step that pushes, opens or comments needs the owner's yes through `ask_user`.

## Steps

1. **Read the live issue, body and thread.** `gh issue view N --comments`. The newest comments hold
   the current state: partial fixes already merged, maintainer decisions, questions to you. Also read
   the repository's `AGENTS.md`, `CONTRIBUTING.md` or README for rules. Done when you know the
   requested behavior, the non-goals, and any unanswered question.
2. **Sweep for existing work.** `gh pr list --search "#N" --state all`, plus two searches with
   keywords for the symptom, and `git log --oneline -20 -- <relevant files>`. Popular issues attract
   several fixes, and a duplicate wastes the work. Done when you know every open PR and recent
   commit that touches it, or know there are none.
3. **Check the premise against the current code.** Reproduce the bug on the default branch with a
   failing test. Then check whether the "bug" is deliberate: run `git log -p -S "<symbol>"` on the
   code the issue wants changed and read the original commit's intent. A missing link or a
   restriction is sometimes the feature. If the issue is stale or wrong, say so instead of
   implementing it blindly.
4. **Write down the acceptance criteria.** The behavior, the interfaces, anything that migrates
   state, compatibility and security concerns. Map each criterion to a test or a check you will run.
5. **Implement the smallest complete change.** Work on a branch. Write the failing test first (open
   the test-driven-development skill) and find causes before fixing (open the systematic-debugging
   skill). When the fix works, `search` for the same bug at sibling call sites and fix the whole
   class in this PR. Every changed line must trace to the issue. No drive-by cleanup.
6. **Prove the test bites.** Temporarily put the old behavior back in the function under test, run
   the new test, and confirm it fails. Restore the fix and confirm it passes. A test that passes
   both ways proves nothing.
7. **Run the repository's gates.** Formatter, linter, type check, and the canonical test command.
   Review your own diff (open the requesting-code-review skill). Then, with the owner's yes, push
   and open the PR, linking the issue and describing the problem, the approach, the tests, the
   risk, and what you left out.
8. **Shepherd CI honestly.** `gh pr checks N`, `gh run view ID --log-failed`. Separate failures from
   your diff from failures already on the default branch (reproduce there if unsure). When the PR
   lands, offer the owner a short comment on the issue with the PR link.

## Pitfalls

- Coding before reading the comments or the duplicates.
- "Fixing" something the original commit shows is intentional.
- Fixing one call site while its siblings keep the bug.
- A regression test that also passes without the fix.
- Unrelated formatting changes in the diff.
- Calling the issue delivered because a PR exists.

## Done when

- The full thread was read and the plan reflects the newest comment.
- A duplicate sweep ran.
- The bug was reproduced on current code and the design intent checked.
- The test was shown to fail without the fix.
- Sibling sites are fixed or ruled out, with the reason.
- CI state is quoted from a `gh` command you just ran.
