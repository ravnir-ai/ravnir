# Roadmap

Ravnir is pre-alpha. This page distinguishes implemented features from release validation. It makes no release-date commitment.

## Implemented

- Persistent agents, browsers, files, terminals, approval policies, plugins and MCP connections.
- Owner preferences, a model-based computer-use fallback, container installation and first-run setup.
- Questions with repeat blocking, tool retry tracking and an isolated model evaluation suite.
- Shared git notes with a Memory view, source links, proposals, diffs, revert and export and restore.
- Reply cost details, daily and monthly caps, routine spend and cap warnings.
- Routine failure cards, stuck-turn alerts, quiet results and clock-change tests.

## Before the first public release

- Complete the 24-hour routine test with five agents, retain its report, and resolve any failures. The first run (October 25 to 26, 2026) had no failed runs but missed slots while the test machine slept; it needs a rerun on a machine that stays awake.
- Complete any remaining review of the memory, history and backup follow-up fixes. The current fixes passed the local suite and were deployed on October 25 with the companion logo.
- Validate the installer on a small amd64 Ubuntu VPS, including real remote access and resource use. Existing arm64 installation measurements are limited evidence.
- Have three people unfamiliar with Ravnir try first run and reach a useful reply; fix onboarding failures.
- Check the installable app, questions, voice, push and memory controls on a real iPhone.
- Finish the audit that optional integrations are optional for core behavior.
- Prepare a fresh public export with no private history. Remove personal deployment files and project instructions, replace them with contributor-safe guidance, and add a deny-list scan enforced in CI.
- Create the public repository, enable private vulnerability reporting and Discussions, and run its tests and install workflow from the clean checkout.
- Add a short product GIF and screenshots using synthetic data, a CI badge after the public workflow exists, and release notes for the first tag. Update the launch film to show the finished features.
- Run a private beta and resolve first-hour installation and usage problems before broad promotion.

The documentation and test workflow were deployed to the private hub with the companion logo on October 25. They are not proof that the public export or remote CI has run. The current source changes have not yet been committed or pushed.

## After launch

Potential next work, subject to beta feedback:

- Telegram conversations, including photos and voice notes.
- A backup model when an agent's provider fails or reaches a limit.
- Additional execution engines per agent, after checking their supported integration and usage terms.
- Broader per-agent container adoption and isolation verification.
- Enrolling other computers owned by the user.
- Signed webhooks and email triggers for routines.
- Spanish and Portuguese UI, and multiple accounts per plugin.

Native apps, multiple owners, single sign-on and hosted cloud service are outside the current release scope.
