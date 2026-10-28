---
name: test-driven-development
title: Test-driven development
description: Write the failing test first, then the code, then clean up.
version: 1.0.0
author: Ravnir, adapted from Hermes Agent, itself adapted from obra/superpowers (MIT)
license: MIT
source: https://github.com/NousResearch/hermes-agent/tree/ee7e0f517232fb619c72e49d7e648436bddc598e/skills/software-development/test-driven-development
---

# Test-driven development

Write the test first, watch it fail, then write the least code that makes it pass. If you never saw
the test fail, you do not know that it tests the right thing.

**The iron law: no production code without a failing test first.**

## When to Use

- A new feature, a bug fix, a refactor or a change in behavior.
- A bug the owner reports: write a test that reproduces it before you touch the code (open the
  systematic-debugging skill to find the cause first).

Ask the owner before skipping the tests for a throwaway prototype, generated code or a pure
configuration file. Do not decide to skip by yourself.

## Prerequisites

- A test command that runs in the workspace through `run_command`. Find it in the project's
  README, `package.json`, `Makefile` or `pyproject.toml`, and run the whole suite once to learn the
  starting state. If the project has no test runner at all, say so and ask the owner before adding one.

## Procedure

Work in vertical slices: one behavior, one full cycle, then the next. Do not write a pile of tests
first and then all the code. Tests written in bulk describe imagined behavior, and they turn brittle
because the code has not yet taught you what the interface needs to be.

```text
Wrong:  tests 1, 2, 3, 4, then code 1, 2, 3, 4
Right:  test 1 -> code 1, test 2 -> code 2, test 3 -> code 3
```

1. **Red: write one small test.** One behavior per test, a name that says the behavior ("retries a
   failed call three times", not "retry works"), real code instead of mocks unless a mock is
   unavoidable. If the name needs "and", split it. Save it with `write_file` or `edit_file`.
2. **Verify red.** Run only that test with `run_command`. Confirm that it fails, that it fails for
   the reason you expected (the feature is missing, not a typo or an import error), and that the
   message reads sensibly. If it passes at once, it tests existing behavior: fix the test. If it
   errors, fix the error and run again until it fails correctly.
3. **Green: write the least code that passes.** Nothing extra: no logging, no options, no cleanup
   of nearby code. Hardcoding a return value is allowed at this step, because the next test will
   force the real logic.
4. **Verify green.** Run the test, then the whole suite. The test passes, nothing else broke, and
   the output has no new errors or warnings. If the test fails, change the code, not the test.
5. **Refactor, only while green.** Remove duplication, improve names, extract helpers. Add no
   behavior. If a test turns red, undo the last change and take a smaller step.
6. **Repeat** with the next failing test.

If you wrote code before the test: delete it, write the test, and implement again from the test.
Do not keep it "as reference" and do not adapt it.

## Pitfalls

Excuses that mean you are skipping the discipline:

| Excuse | Reality |
|---|---|
| "Too simple to test" | Simple code breaks too, and the test takes a minute. |
| "I will add tests after" | A test written after the code passes at once, which proves nothing. |
| "I already tried it by hand" | No record, cannot be re-run, and the edge cases get forgotten. |
| "Deleting my work is wasteful" | The time is spent either way. Unverified code is the cost. |
| "I need to explore first" | Fine. Throw the exploration away, then start with a test. |
| "The test is hard to write" | The design is hard to use. Simplify the interface. |
| "This case is different" | It is the same rule. |

Test anti-patterns:

- Testing the mock instead of the real behavior.
- Testing internals (which private method ran) instead of results, so any refactor breaks the test.
- Only the happy path. Add errors, empty input and boundaries.
- Several behaviors in one test, so a failure does not say what broke.

When stuck:

| Problem | What to do |
|---|---|
| You do not know how to test it | Write the call you wish existed, then the assertion. Ask the owner. |
| The test setup is huge | Extract helpers. If it is still huge, the design is too coupled. |
| You must mock everything | Inject the dependencies instead. |

## Verification

Before you report the work as done, check each item and show the real output of the last full run:

- Every new function or behavior has a test.
- You watched each test fail first, for the expected reason.
- You wrote only the code needed to pass each one.
- The full suite passes, with no new warnings.
- Edge cases and error paths are covered.

If a box cannot be ticked, say which one and why instead of claiming the work is done.
