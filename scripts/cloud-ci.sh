#!/usr/bin/env bash
# Run CI for one exact commit on Google Cloud Build and post the result to
# GitHub as the commit status "CI / build". See docs/ci.md.
#
#   scripts/cloud-ci.sh <pr-number | branch | sha>
#   scripts/cloud-ci.sh --reconcile <build-id> <pr-number | branch | sha>
#
# Why this exists: GitHub-hosted Actions jobs are refused (account billing) and
# the Depot minute cap is reached, so neither workflow file runs. This runs
# the same steps (deploy/cloudbuild/ci.yaml) on Cloud Build's default pool,
# whose default machine is covered by a monthly free build-minute allowance.
#
# The source that is built is `git archive <sha>`: the commit and nothing
# else, whatever this checkout has modified. The build config comes from THIS
# checkout, so run it from a checkout of main or of the head under test.
# The status is posted from this machine with your `gh` login; no GitHub
# credential enters the build.
#
# --reconcile re-attaches to a build whose watcher died: it submits nothing,
# checks the build was made for that commit, waits, and posts the result.
#
# Env: EXOCORTEX_CI_GCP_PROJECT (required; falls back to UA_CI_GCP_PROJECT),
# EXOCORTEX_CI_GCP_REGION (us-central1), EXOCORTEX_CI_REPO (this repository),
# EXOCORTEX_CI_NO_STATUS=1 (run without posting; the build is still billed),
# EXOCORTEX_CI_FORCE=1 (submit although a run for this commit is still pending).
set -euo pipefail
export LC_ALL=C
# A prompt on a TTY would block the watcher with the status left pending.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

usage="usage: scripts/cloud-ci.sh [--reconcile <build-id>] <pr-number|branch|sha>"
attach=""
if [ "${1:-}" = "--reconcile" ]; then
    attach="${2:-}"
    if ! [[ "$attach" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then
        echo "$usage" >&2
        exit 2
    fi
    shift 2
fi
ref="${1:?$usage}"
project="${EXOCORTEX_CI_GCP_PROJECT:-${UA_CI_GCP_PROJECT:-}}"
if [ -z "$project" ]; then
    echo "set EXOCORTEX_CI_GCP_PROJECT to the Google Cloud project that runs CI" >&2
    exit 2
fi
region="${EXOCORTEX_CI_GCP_REGION:-us-central1}"
repo="${EXOCORTEX_CI_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
context="CI / build"
# The build's own timeout is 20 minutes; allow for queueing on top of it.
deadline_seconds=1800
root="$(git rev-parse --show-toplevel)"
config="$root/deploy/cloudbuild/ci.yaml"
step="$root/deploy/cloudbuild/ci-step.sh"
[ -f "$config" ] && [ -f "$step" ] || { echo "run this from a checkout that has deploy/cloudbuild/" >&2; exit 2; }

git -C "$root" fetch -q origin
if [[ "$ref" =~ ^[0-9]+$ ]]; then
    sha="$(gh pr view "$ref" -R "$repo" --json headRefOid -q .headRefOid)"
    git -C "$root" fetch -q origin "pull/$ref/head"
elif git -C "$root" rev-parse -q --verify "origin/$ref^{commit}" >/dev/null; then
    sha="$(git -C "$root" rev-parse "origin/$ref^{commit}")"
else
    sha="$(git -C "$root" rev-parse "$ref^{commit}")"
fi
git -C "$root" cat-file -e "$sha^{commit}"
short="${sha:0:8}"

post() { # state description
    [ -n "${EXOCORTEX_CI_NO_STATUS:-}" ] && return 0
    gh api "repos/$repo/statuses/$sha" -f state="$1" -f context="$context" \
        -f description="${2:0:140}" -f target_url="$url" >/dev/null \
        || echo "warning: could not post the '$1' status for $short" >&2
}
field() { # build-id field
    gcloud builds describe "$1" --project="$project" --region="$region" --format="value($2)"
}

if [ -n "$attach" ]; then
    build="$attach"
    built_for="$(field "$build" 'substitutions._SOURCE_SHA')"
    if [ "$built_for" != "$sha" ]; then
        echo "build $build was made for ${built_for:-an unknown commit}, not $sha; nothing posted" >&2
        exit 1
    fi
else
    # One billed run per commit: a second watcher on the same head would also
    # race the first one's status.
    if [ -z "${EXOCORTEX_CI_FORCE:-}" ] && [ -z "${EXOCORTEX_CI_NO_STATUS:-}" ]; then
        running="$(gh api "repos/$repo/commits/$sha/statuses" \
            -q "[.[] | select(.context == \"$context\")][0] | select(.state == \"pending\") | .description" 2>/dev/null || true)"
        if [ -n "$running" ]; then
            echo "a run for $short is already pending ($running)." >&2
            echo "Re-attach with: scripts/cloud-ci.sh --reconcile <build-id> $ref   (or set EXOCORTEX_CI_FORCE=1)" >&2
            exit 1
        fi
    fi
    scan_base=""
    if [[ "$ref" =~ ^[0-9]+$ ]]; then
        identity_base="$(gh pr view "$ref" -R "$repo" --json baseRefOid -q .baseRefOid)"
        git -C "$root" cat-file -e "${identity_base}^{commit}" 2>/dev/null \
            || git -C "$root" fetch -q origin "$identity_base"
        identity_range="${identity_base}..${sha}"
        scan_base="$identity_base"
    elif git -C "$root" show-ref --verify --quiet refs/remotes/origin/main; then
        identity_base="$(git -C "$root" merge-base origin/main "$sha")"
        if [ "$identity_base" = "$sha" ]; then
            # This commit is already on main. Check the requested commit.
            identity_range="${sha}^!"
            scan_base="$(git -C "$root" rev-parse --verify "$sha^1" 2>/dev/null || true)"
        else
            identity_range="${identity_base}..${sha}"
            scan_base="$identity_base"
        fi
    else
        # Before the first push, scan all commits reachable from the target.
        identity_range="$sha"
    fi
    # The archive cannot show secrets added and removed in the same PR.
    # Check history before uploading any source to the Cloud Build bucket.
    url="https://github.com/$repo/commit/$sha"
    if ! (cd "$root" && bash scripts/secret-scan.sh git "$sha" "$scan_base"); then
        post failure "Credential history scan failed before source upload"
        exit 1
    fi
    src="$(mktemp -d)"
    trap 'rm -rf -- "$src"' EXIT
    git -C "$root" archive "$sha" | tar -x -C "$src"
    mkdir "$src/.ci"
    cp "$config" "$step" "$src/.ci/"
    # The build container has no Git history. Send the commit identities for
    # the selected range without printing names or addresses.
    git -C "$root" log -z --format='%H%n%an%n%ae%n%cn%n%ce%n%b' "$identity_range" \
        > "$src/.ci/commit-identities"
    if [ ! -s "$src/.ci/commit-identities" ]; then
        echo "commit identity check: selected range produced no commits" >&2
        exit 1
    fi
    build="$(gcloud builds submit "$src" --config="$src/.ci/ci.yaml" --project="$project" \
        --region="$region" --substitutions="_SOURCE_SHA=$sha" --async --format='value(id)')"
    [ -n "$build" ] || { echo "Cloud Build returned no build id; nothing was posted" >&2; exit 1; }
fi
url="https://console.cloud.google.com/cloud-build/builds;region=$region/$build?project=$project"
echo "commit $sha"
echo "build  $build"
echo "log    $url"
post pending "Cloud Build ${build:0:8} running"

started=$SECONDS
status=""
while :; do
    status="$(field "$build" status 2>/dev/null || true)"
    case "$status" in
        SUCCESS|FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED) break ;;
    esac
    if [ $((SECONDS - started)) -ge "$deadline_seconds" ]; then
        echo "still ${status:-unknown} after $((deadline_seconds / 60)) minutes; the status stays pending." >&2
        echo "Re-attach with: scripts/cloud-ci.sh --reconcile $build $ref" >&2
        exit 1
    fi
    sleep 10
done

# What the run cost in build-minutes, and the month so far for this repo's runs.
read -r seconds month_runs month_minutes < <(
    gcloud builds list --project="$project" --region="$region" --filter='tags=exocortex-ci' \
        --limit=1000 --format='value(id,startTime,finishTime)' | python3 -I -c '
import sys
from datetime import datetime, timezone
want, now = sys.argv[1], datetime.now(timezone.utc)
def at(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))
this, runs, total = 0.0, 0, 0.0
for line in sys.stdin:
    parts = line.split()
    if len(parts) != 3:
        continue
    start, finish = at(parts[1]), at(parts[2])
    took = (finish - start).total_seconds()
    if parts[0] == want:
        this = took
    if (start.year, start.month) == (now.year, now.month):
        runs, total = runs + 1, total + took
print(round(this), runs, round(total / 60, 1))
' "$build"
) || { seconds=0; month_runs="?"; month_minutes="?"; }
took="$((seconds / 60))m$(printf '%02d' $((seconds % 60)))s"

if [ "$status" = "SUCCESS" ]; then
    post success "Cloud Build ${build:0:8} passed in $took"
    echo "PASS  $short in $took"
    result=0
else
    post failure "Cloud Build ${build:0:8} $status after $took"
    echo "FAIL  $short: $status after $took. Last lines of the log:" >&2
    gcloud builds log "$build" --project="$project" --region="$region" 2>/dev/null | tail -60 >&2 || true
    result=1
fi
echo "exocortex CI this month in $project: $month_runs run(s), $month_minutes build-minutes"
exit "$result"
