# Contributing

This repo is a local Chrome extension plus a Bun MCP process. There is no hosted app to deploy.

## Setup

```bash
bun install
bun run build
```

`bun.lock` is the lockfile `bun install` uses. CI installs with `bun install --frozen-lockfile`.

## Tests

```bash
bun run test
```

`pretest` runs `bun run build` first. `bun test` does not, so a fresh checkout fails the manifest contract until you have built.

Real Chrome tests are off unless you opt in. They are headless and need a display, which CI provides with `xvfb`:

```bash
EXOCORTEX_BROWSER_TESTS=1 xvfb-run -a bun run test
```

A skipped browser test is not evidence the extension loads.

## CI

GitHub Actions and Depot do not run for this repository. CI is a Cloud Build job started by hand:

```bash
export EXOCORTEX_CI_GCP_PROJECT=<your-gcp-project>
scripts/cloud-ci.sh <pr-number>
```

Run that from a checkout of the commit you are testing. The script posts a commit status named `CI / build`. Details are in `docs/ci.md`.

## Changes

Keep a pull request focused. Do not commit `.env` files, browser profiles, or captured page text. Browser dwell capture stays off until the side panel toggle is on.
