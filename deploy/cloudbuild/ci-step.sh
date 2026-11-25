#!/usr/bin/env bash
# The CI job, run as root inside the bun image by deploy/cloudbuild/ci.yaml.
# Same steps and order as .github/workflows/ci.yml.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== exocortex CI for ${EXOCORTEX_CI_SOURCE_SHA:-unknown} on $(nproc) vCPU, bun $(bun --version)"

# The upload is a git archive, so commit identity arrives as
# .ci/commit-identities written by scripts/cloud-ci.sh.
echo "== commit identity check"
if [ ! -s .ci/commit-identities ]; then
  echo "commit identity check: missing or empty .ci/commit-identities" >&2
  exit 1
fi
bash scripts/check_commit_identity.sh --file .ci/commit-identities

# xvfb gives the real-browser (B*) layer a disposable display; xauth is what
# xvfb-run needs, and unzip is what Puppeteer unpacks Chrome with. nodejs is
# for the artifact contract's `node --check`: the image's own `node` is a
# shim onto bun, which rejects that flag, so the classic-script parse fails
# for a reason that has nothing to do with the bundle. git is for the commit
# identity check's fixture, which builds throwaway repositories; the check
# itself reads the exported .ci/commit-identities file.
apt-get update -qq
apt-get install -y -qq --no-install-recommends xvfb xauth unzip nodejs git ca-certificates >/dev/null
echo "== node $(node --version) at $(command -v node)"

bun install --frozen-lockfile

# Puppeteer's Chrome arrives through a lifecycle script (trustedDependencies in
# package.json). Asking again is a no-op when it is there, and --install-deps
# adds the shared libraries Chrome needs that the image does not ship.
bunx puppeteer browsers install chrome --install-deps

bun run build

# After the build: the manifest/artifact contract asserts against dist/. With
# the B* layer on, a skipped browser test cannot pass for a working extension.
EXOCORTEX_BROWSER_TESTS=1 EXOCORTEX_EMBEDDER_TESTS=1 xvfb-run -a bun run test
