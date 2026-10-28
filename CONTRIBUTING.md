# Contributing

Ravnir is pre-alpha. Small, focused changes with a reproducible problem and clear validation are the easiest to review. The [roadmap](docs/roadmap.md) lists priorities. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 22 or newer, git, and Python 3 for terminal tests. From your checkout:

```bash
npm ci
npx playwright install chromium
RAVNIR_VAULT=local npm start
```

On Linux, `npx playwright install --with-deps chromium` also installs browser system dependencies. It may require elevated privileges. The container image supplies the Linux desktop tools; browser tests do not require the entire desktop stack.

Use a separate data directory for experiments, for example `RAVNIR_HOME=./data/dev RAVNIR_VAULT=local npm start`. Never point tests at a real installation's data or accounts. Most tests create temporary data and use mock services; live-model evaluations and real container tests are explicit opt-ins.

The app is plain JavaScript with ES modules and no frontend build step:

- `server/`: HTTP routes, turns, models, approvals, browser tools, scheduling and persistence.
- `server/vault/`: Markdown indexing, context, git writes, proposals and history.
- `public/`: client JavaScript, CSS and installable web app.
- `test/`: Node's built-in test runner, mock integrations and HTTP tests.
- `evals/`: isolated tasks against real models. Read `evals/README.md` before running them because they can incur charges.
- `box/`, `Dockerfile`, `compose.yaml`, `install.sh`: computer and installation environments.

## Tests

Run a focused suite while working, for example:

```bash
node --test test/cost.test.js
```

`npm test` runs the full suite. A terminal shutdown race that caused hangs now has a regression test. CI also isolates the terminal suite in its own job, with an explicit timeout that fails the job instead of concealing a hang. To reproduce that separation locally, use Bash:

```bash
files=(test/*.test.js)
suite=()
for file in "${files[@]}"; do
  if [[ "$file" != test/terminal.test.js ]]; then suite+=("$file"); fi
done
node --test --test-timeout=180000 "${suite[@]}"
node --test --test-timeout=120000 test/terminal.test.js
```

Install Chromium before testing: some browser tests otherwise skip, so a green run without the browser is incomplete evidence. Python 3 is required to exercise the real terminal bridge. Real per-agent container tests additionally require an explicit `RAVNIR_TEST_BOX=podman` or `RAVNIR_TEST_BOX=docker`; see `test/box.test.js` before running them.

## Changes and pull requests

- Explain the concrete problem and resulting behavior. Include steps or a small example that reproduces it.
- Add regression tests when behavior changes. For documentation-only changes, check commands, links and claims against the code.
- Run relevant tests and state exactly what passed, skipped or remains unverified. A local run does not establish that remote CI passed.
- Keep new dependencies justified. Do not add generated browser profiles, data directories, recordings or model evaluation results containing private material.
- Use Ravnir for product text and `RAVNIR_*` for settings. Existing `TRUEBOT_*` compatibility and internal persistence constants require deliberate migration; do not rename encryption salts.
- Keep user-facing language plain. Preserve keyboard access, mobile layouts and visible errors when changing the UI.

Do not decompile another product, extract its private prompts or credentials, or copy its assets into Ravnir. Use synthetic fixtures and accounts you control. Never include passwords, tokens, private hostnames, personal conversations or production screenshots in a contribution.

The development checkout currently includes private operational material. It is not a safe public export. Follow the public-export checks in the roadmap before publishing a new repository or copying project instructions into one.
