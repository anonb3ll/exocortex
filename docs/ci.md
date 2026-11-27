# CI on Google Cloud Build

CI for this repository runs on Google Cloud Build. One command builds one
exact commit, runs the whole test suite including the real-browser (B\*) layer,
and posts the result to GitHub as the commit status `CI / build`.

```bash
export EXOCORTEX_CI_GCP_PROJECT=<your-gcp-project>
scripts/cloud-ci.sh 69            # a pull request number
scripts/cloud-ci.sh my-branch     # a branch on origin
scripts/cloud-ci.sh 4ff431f       # a commit
```

A run takes about three minutes. The script prints the build id, a link to the
log, `PASS` or `FAIL`, and the month's usage so far.

## Why not GitHub Actions or Depot

`.github/workflows/ci.yml` and `.depot/workflows/ci.yml` still describe the
job, and neither runs: GitHub refuses hosted jobs for this account (billing)
and the Depot plan's minute cap is reached. Pull requests therefore showed no
checks at all. `scripts/cloud-ci.sh` runs the same steps in the same order.

## What a run does

1. Resolves the argument to a commit and scans its introduced Git history
   for credentials before uploading anything. Then it exports the exact
   commit with `git archive`. Uncommitted changes are never built.
2. Submits it to Cloud Build with `deploy/cloudbuild/ci.yaml`, which runs
   `deploy/cloudbuild/ci-step.sh` in the `oven/bun:1-debian` image:
   `bash scripts/check_commit_identity.sh` using `.ci/commit-identities`
   (the archive has no commits, so
   `scripts/cloud-ci.sh` writes this file before submit). The file covers
   commits added by a PR or branch, the requested commit if it is already on
   main, or all commits reachable from the target before the first main push.
   Then CI installs system
   packages (xvfb, unzip, Node, git, curl) → secret scan of the exported source
   → `bun install --frozen-lockfile` →
   Puppeteer's Chrome and its libraries → `bun run build` →
   `EXOCORTEX_BROWSER_TESTS=1 EXOCORTEX_EMBEDDER_TESTS=1 xvfb-run -a bun run test`.
3. Posts `pending`, waits, then posts `success` or `failure` with a link to
   the build log. On failure it prints the last 60 lines of the log.

The build config and step script come from the checkout you run the script
from, not from the commit under test. Run it from `main` or from the head you
are testing.

The status is posted from your machine with your `gh` login. No GitHub
credential enters the build, and the build has no access to anything but the
source it was sent.

## Cost

The job uses Cloud Build's default pool with its default machine
(`e2-standard-2`). That machine costs $0.006 per build-minute, and the first
2,500 build-minutes each month are free per billing account. At about three
minutes a run, that is roughly 800 free runs a month, and about $0.02 a run
after that. Leave `machineType` unset in `ci.yaml`: any larger machine is
billed from the first minute and the suite does not need it.

The free allowance is a Google promotion and can change. The script prints the
month's total after every run (`exocortex CI this month in <project>: N
run(s), M build-minutes`), counted from builds tagged `exocortex-ci`. Other
Cloud Build use in the same billing account draws on the same allowance.

The alternative was a Spot VM, which is how `unified_agent` runs its CI. A
Spot `e2-highcpu-8` is about $0.10 an hour, so a run would cost about a cent,
but it is paid from the first second, needs a boot disk and a results bucket,
and needs a runner and cleanup script kept working. That trade is worth it for
a 30-minute suite that needs eight cores. This suite takes three minutes on
two, and costs nothing inside the allowance. If the allowance ends, the Spot
route is the fallback.

## Runs are started by hand

Nothing triggers a run when you push. Run the script for each new head and
check the status is on the commit you mean to merge:

```bash
gh api repos/<owner>/exocortex/commits/<sha>/statuses -q '.[0] | .context, .state'
```

Automatic runs on every push need a Cloud Build trigger, and a trigger needs
the Cloud Build GitHub App connected to the repository. That is an
authorization step for the repository owner.

## When something goes wrong

| What you see | What to do |
|---|---|
| `a run for <sha> is already pending` | Another run is in progress, or its watcher died. Re-attach with `scripts/cloud-ci.sh --reconcile <build-id> <ref>`. To start over, set `EXOCORTEX_CI_FORCE=1`. |
| `still WORKING after 30 minutes` | The watcher gave up; the status stays pending. Re-attach with `--reconcile`. |
| `build <id> was made for ... not <sha>` | The build id belongs to a different commit. Nothing was posted. |
| `set EXOCORTEX_CI_GCP_PROJECT` | Export the project id. The script also accepts `UA_CI_GCP_PROJECT`. |
| `Secret scan found potential credentials` | Inspect the affected commit range privately with Gitleaks. CI suppresses scanner output. |

To run without posting a status (for example while changing the CI files
themselves), set `EXOCORTEX_CI_NO_STATUS=1`. The build is still billed.

## Requirements

- `gcloud`, signed in to an account that may submit builds in the project
  (`roles/cloudbuild.builds.editor`), with the Cloud Build API enabled.
- `gh`, signed in with permission to write commit statuses on the repository.
- `git`, `tar`, `curl` and `python3` on the machine that runs the script.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `EXOCORTEX_CI_GCP_PROJECT` | none (falls back to `UA_CI_GCP_PROJECT`) | Project that runs and pays for the builds. |
| `EXOCORTEX_CI_GCP_REGION` | `us-central1` | Cloud Build region. |
| `EXOCORTEX_CI_REPO` | this repository | `owner/name` the status is posted to. |
| `EXOCORTEX_CI_NO_STATUS` | unset | `1` runs the build and posts nothing. |
| `EXOCORTEX_CI_FORCE` | unset | `1` submits although a run for the commit is pending. |
