#!/usr/bin/env bash
# Proves check_commit_identity.sh around the operator identity.
#
# The operator's own address is acceptable in commit metadata (a GitHub-authored
# merge carries it). Everything else stays refused: another Gmail address, the
# retired name whatever the address, and a Co-authored-by trailer claiming the
# operator identity. Findings name the SHA and the field, never the address.
#
# Forbidden strings are assembled at runtime so this file stays clean.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
check=$root/scripts/check_commit_identity.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'check_commit_identity_test: %s\n' "$1" >&2
  exit 1
}

handle() { printf '%s%s' ant mbel; }
gmail() { printf '%s@%s.%s' "$1" "$(printf '%s%s' gm ail)" "$(printf '%s%s' c om)"; }
operator_mail() { gmail "$(handle)"; }
full_name() { printf '%s %s' "$(printf '%s%s' Anth ony)" "$(printf '%s%s' Bell ino)"; }

new_repo() {
  local dir=$1
  git init -q "$dir"
  git -C "$dir" config user.name anonb3ll
  git -C "$dir" config user.email anonb3ll@pm.me
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" commit -q --allow-empty -m base
}

base_of() { git -C "$1" rev-parse HEAD; }
head_of() { git -C "$1" rev-parse HEAD; }

accepts() {
  local repo=$1 base=$2 head=$3 label=$4 output code
  set +e
  output=$("$check" --range "$base..$head" --repo "$repo" 2>&1)
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    fail "$label was rejected: $output"
  fi
  if [ -n "$output" ]; then
    fail "$label printed a finding"
  fi
}

rejects() {
  local repo=$1 base=$2 head=$3 label=$4 field=$5 secret=$6 output code
  set +e
  output=$("$check" --range "$base..$head" --repo "$repo" 2>&1)
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    fail "$label was accepted"
  fi
  printf '%s\n' "$output" | grep -q "$head" || fail "$label did not print the SHA"
  printf '%s\n' "$output" | grep -q "$field" || fail "$label did not name $field"
  if [ -n "$secret" ] && printf '%s\n' "$output" | grep -qF -- "$secret"; then
    fail "$label printed a forbidden address"
  fi
}

# A GitHub-authored merge: the operator is the author, GitHub is the committer.
repo=$work/author
new_repo "$repo"
base=$(base_of "$repo")
GIT_AUTHOR_NAME='Ant' \
  GIT_AUTHOR_EMAIL="$(operator_mail)" \
  GIT_COMMITTER_NAME='GitHub' \
  GIT_COMMITTER_EMAIL='noreply@github.com' \
  git -C "$repo" commit -q --allow-empty -m 'Merge pull request #1 from anonb3ll/topic'
accepts "$repo" "$base" "$(head_of "$repo")" 'operator author'

# The same allowance as committer, with a different author.
repo=$work/committer
new_repo "$repo"
base=$(base_of "$repo")
GIT_AUTHOR_NAME='anonb3ll' \
  GIT_AUTHOR_EMAIL='anonb3ll@pm.me' \
  GIT_COMMITTER_NAME='Ant' \
  GIT_COMMITTER_EMAIL="$(operator_mail)" \
  git -C "$repo" commit -q --allow-empty -m 'committed through the account'
accepts "$repo" "$base" "$(head_of "$repo")" 'operator committer'

# Any other Gmail address is still a finding, and the address is not echoed.
repo=$work/other
new_repo "$repo"
base=$(base_of "$repo")
secret=$(gmail planted-other)
GIT_AUTHOR_NAME='anonb3ll' \
  GIT_AUTHOR_EMAIL="$secret" \
  git -C "$repo" commit -q --allow-empty -m 'planted'
rejects "$repo" "$base" "$(head_of "$repo")" 'another Gmail author' 'author-email' "$secret"

# The exemption is exact, so a look-alike that merely shares the handle, or a
# +tag variant of the mailbox, is still refused. Without these two cases a
# substring or prefix match would pass.
repo=$work/lookalike
new_repo "$repo"
base=$(base_of "$repo")
secret=$(gmail "not-$(handle)")
GIT_AUTHOR_NAME='Ant' \
  GIT_AUTHOR_EMAIL="$secret" \
  git -C "$repo" commit -q --allow-empty -m 'look-alike'
rejects "$repo" "$base" "$(head_of "$repo")" 'handle-prefix look-alike' 'author-email' "$secret"

repo=$work/plustag
new_repo "$repo"
base=$(base_of "$repo")
secret=$(gmail "$(handle)+work")
GIT_AUTHOR_NAME='Ant' \
  GIT_AUTHOR_EMAIL="$secret" \
  git -C "$repo" commit -q --allow-empty -m '+tag variant'
rejects "$repo" "$base" "$(head_of "$repo")" '+tag variant' 'author-email' "$secret"

# The retired name still fails even when the address is a noreply one.
repo=$work/name
new_repo "$repo"
base=$(base_of "$repo")
GIT_AUTHOR_NAME="$(full_name)" \
  GIT_AUTHOR_EMAIL='1+anonb3ll@users.noreply.github.com' \
  git -C "$repo" commit -q --allow-empty -m 'named'
rejects "$repo" "$base" "$(head_of "$repo")" 'retired name' 'author-name' ''

# A Co-authored-by trailer claiming the operator identity is a fabricated
# co-author, not a landing artifact, so it stays refused.
repo=$work/trailer
new_repo "$repo"
base=$(base_of "$repo")
secret=$(operator_mail)
git -C "$repo" commit -q --allow-empty -m 'merge' -m "Co-authored-by: Ant <$secret>"
rejects "$repo" "$base" "$(head_of "$repo")" 'operator co-author trailer' 'co-authored-by' "$secret"

# --file mode reads the same stream Cloud Build uploads.
repo=$work/stream
new_repo "$repo"
base=$(base_of "$repo")
GIT_AUTHOR_NAME='Ant' \
  GIT_AUTHOR_EMAIL="$(operator_mail)" \
  GIT_COMMITTER_NAME='GitHub' \
  GIT_COMMITTER_EMAIL='noreply@github.com' \
  git -C "$repo" commit -q --allow-empty -m 'merge from the archive path'
head=$(head_of "$repo")
git -C "$repo" log -z --format='%H%n%an%n%ae%n%cn%n%ce%n%b' "$base..$head" >"$work/identities"
set +e
output=$("$check" --file "$work/identities" 2>&1)
code=$?
set -e
if [ "$code" -ne 0 ]; then
  fail "--file mode rejected the operator identity: $output"
fi

printf 'check_commit_identity_test: ok\n'
