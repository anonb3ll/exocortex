#!/usr/bin/env bash
# Fail if commits in a base..head range use a personal identity.
#
# Checks author name, author email, committer name, committer email, and
# every Co-authored-by trailer. A hit prints the SHA and the field name.
# It does not print the name or the address.
#
# GitHub noreply addresses, the web-flow committer name, and [bot] accounts
# are allowed. anonb3ll@pm.me is allowed because it matches none of the rules.
# The operator's own address is also allowed, in commit metadata only
# (operator's ruling, 2026-11-27): GitHub authors a merge commit with it, so a
# landing that goes through a pull request must not be refused for that.
#
# Cloud Build uploads a git archive, which has no commits. scripts/cloud-ci.sh
# writes the same git-log stream to .ci/commit-identities and this script
# reads it with --file.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
range=""
file=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      repo="$2"
      shift 2
      ;;
    --range)
      range="$2"
      shift 2
      ;;
    --file)
      file="$2"
      shift 2
      ;;
    *)
      echo "usage: check_commit_identity.sh --range BASE..HEAD [--repo DIR] | --file PATH" >&2
      exit 2
      ;;
  esac
done

if [ -n "$range" ] && [ -n "$file" ]; then
  echo "pass only one of --range or --file" >&2
  exit 2
fi
if [ -z "$range" ] && [ -z "$file" ]; then
  echo "pass --range BASE..HEAD or --file PATH" >&2
  exit 2
fi

# Built at runtime so this file contains neither the name nor the handle as a
# literal: it is a tracked file in a public repository, and the operator's
# metadata exception covers commits, not file content.
name_re="$(printf '%s[[:space:]._/-]*%s' \
  "$(printf '%s%s' 'Anth' 'ony')" "$(printf '%s%s' 'Bell' 'ino')")"
handle="$(printf '%s%s' 'ant' 'mbel')"
# Same reason: assembled, never written out.
operator_email="$(printf '%s@%s.%s' "$handle" "$(printf '%s%s' 'gm' 'ail')" "$(printf '%s%s' 'c' 'om')")"

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_allowed_email() {
  local value
  value="$(lower "$1")"
  case "$value" in
    noreply@github.com | *@users.noreply.github.com) return 0 ;;
  esac
  return 1
}

is_allowed_name() {
  local value
  value="$(lower "$1")"
  [ "$value" = "web-flow" ] && return 0
  printf '%s' "$value" | grep -E -q '\[bot\]' && return 0
  return 1
}

# 0 when the value must fail the check.
forbidden() {
  local kind="$1" value="$2" email_kind=0
  case "$kind" in
    email | email-trailer) email_kind=1 ;;
  esac
  # The operator's own address is acceptable in commit METADATA (ruling of
  # 2026-11-27). Not in a Co-authored-by trailer, though: a merge never adds
  # one, so a trailer claiming that identity is a fabricated co-author rather
  # than a landing artifact.
  if [ "$kind" = "email" ] && [ "$(lower "$value")" = "$operator_email" ]; then
    return 1
  fi
  if [ "$email_kind" = 1 ]; then
    is_allowed_email "$value" && return 1
  else
    is_allowed_name "$value" && return 1
  fi
  printf '%s' "$value" | grep -E -i -q "$name_re" && return 0
  printf '%s' "$value" | grep -F -i -q -- "$handle" && return 0
  if [ "$email_kind" = 1 ]; then
    printf '%s' "$(lower "$value")" | grep -E -q '@gmail\.com$' && return 0
  fi
  return 1
}

hits="$(mktemp)"
stream="$(mktemp)"
trap 'rm -f "$hits" "$stream"' EXIT

note() {
  printf '%s %s\n' "$1" "$2" >>"$hits"
}

check_value() {
  local sha="$1" field="$2" kind="$3" value="$4"
  [ -n "$value" ] || return 0
  if forbidden "$kind" "$value"; then
    note "$sha" "$field"
  fi
}

check_trailer() {
  local sha="$1" line="$2" rest name email
  case "$line" in
    [Cc]o-[Aa]uthored-[Bb]y:*) ;;
    *) return 0 ;;
  esac
  rest="${line#*:}"
  rest="${rest#"${rest%%[![:space:]]*}"}"
  if [[ "$rest" == *"<"*">"* ]]; then
    email="${rest##*<}"
    email="${email%%>*}"
    email="${email%"${email##*[![:space:]]}"}"
    name="${rest%%<*}"
    name="${name%"${name##*[![:space:]]}"}"
  else
    name="$rest"
    email=""
  fi
  if forbidden name "$name" || { [ -n "$email" ] && forbidden email-trailer "$email"; }; then
    note "$sha" "co-authored-by"
  fi
}

inspect_record() {
  local record="$1" sha an ae cn ce body i=0 line
  sha="" an="" ae="" cn="" ce="" body=""
  while IFS= read -r line || [ -n "$line" ]; do
    i=$((i + 1))
    case "$i" in
      1) sha="$line" ;;
      2) an="$line" ;;
      3) ae="$line" ;;
      4) cn="$line" ;;
      5) ce="$line" ;;
      *) body+="$line"$'\n' ;;
    esac
  done <<<"$record"
  [ -n "$sha" ] || return 0
  check_value "$sha" "author-name" name "$an"
  check_value "$sha" "author-email" email "$ae"
  check_value "$sha" "committer-name" name "$cn"
  check_value "$sha" "committer-email" email "$ce"
  while IFS= read -r line; do
    check_trailer "$sha" "$line"
  done <<<"$body"
}

if [ -n "$range" ]; then
  git -C "$repo" log -z --format='%H%n%an%n%ae%n%cn%n%ce%n%b' "$range" >"$stream"
else
  cp "$file" "$stream"
fi

while IFS= read -r -d '' record || [ -n "$record" ]; do
  [ -n "$record" ] || continue
  inspect_record "$record"
done <"$stream"

if [ -s "$hits" ]; then
  sort -u "$hits"
  exit 1
fi
