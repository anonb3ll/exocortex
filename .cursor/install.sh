#!/usr/bin/env bash
# Cloud Agent install phase for Exocortex.
#
# Idempotent repository bootstrap: installs Bun (if the base image lacks it),
# refreshes dependencies from bun.lock, ensures Puppeteer's Chrome is on disk for
# the real-browser (B*) test layer, and produces dist/ so the L1 manifest/artifact
# contract has something to gate. Chrome and xvfb come from the base image.
set -euo pipefail

# --- Bun ---------------------------------------------------------------------
# Bun is the project runtime and package manager (bun.lock is authoritative).
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi
bun --version

cd "$(dirname "$0")/.."

# --- Dependencies ------------------------------------------------------------
# --frozen-lockfile keeps setup deterministic and never rewrites bun.lock.
# Puppeteer is a trustedDependency, so its Chrome download runs as a lifecycle
# script during install.
echo "==> Installing dependencies"
bun install --frozen-lockfile

# Belt-and-suspenders: ensure the Puppeteer Chrome the B-layer launches is
# present even if the lifecycle download was skipped. This is a no-op when the
# browser is already cached.
echo "==> Ensuring Puppeteer Chrome is installed"
bunx puppeteer browsers install chrome

# --- Build -------------------------------------------------------------------
# tsc type-gate + extension bundle + classic content-script bundle. Required:
# tests/manifest-artifact-contract.test.ts gates on a fresh dist/.
echo "==> Building extension"
bun run build

echo "==> Install complete"
