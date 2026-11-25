# Public export

The public repository is a **fresh-repository export**, not a mirror of this
one's history: this repository's commits carry personal identities and internal
agent labels, so no commit from it is published. The public tree is a single
root commit authored as the project identity.

Two scripts under `scripts/public_release/` build and gate that tree. Both are
private: the export excludes `scripts/public_release/` itself, because the
anonymity denylist it pairs with stores the owner's real identifiers as
patterns. For the same reason the checker assembles the owner's own
identifiers at runtime instead of writing them as literals — the private
anonymity gate scans every tracked file, this one included.

## Build

```bash
python3 scripts/public_release/export_public_tree.py \
  --repo <path to this checkout> --ref main --out /tmp/exocortex-public
```

`--ref` is any commit-ish. The tree comes from `git archive`, so uncommitted
edits are never exported. The script:

- drops the files that exist only in the private development home
  (`CLAUDE.md`, `GEMINI.md`, `conductor/`, the anonymity gate and its test),
- removes the anonymity gate's step from all three CI venues and the
  references to it in `docs/ci.md`,
- rewrites references to files that are not in the export,
- replaces internal agent labels with the project identity,
- commits once, as the project identity, with the source commit's timestamp so
  the same input yields the same tree.

## Verify

```bash
python3 scripts/public_release/verify_public_tree.py --dir /tmp/exocortex-public
```

The identifier gate runs two pattern sets: the checker's own built-ins (places,
hosts, links and vocabulary specific to this export) and the private repo's
`scripts/anonymity-denylist.txt`, applied on top so there is one list the owner
maintains. The denylist is read from the source checkout by default and is
never copied into the export; pass `--denylist <path>` to point elsewhere. A
missing denylist fails the run instead of silently checking less.

It fails on any of: more than one commit or a root commit with parents, a
non-project author or committer, any personal identifier, private path, hostname, tailnet
address, private-repo link or internal agent label, a missing license/readme/
security file, a project-scoped `.mcp.json`, a symlink, a CI step that runs a
script absent from the export, or a dangling relative markdown link. Text and
binary files are both scanned: a file that is not valid UTF-8 is read as
latin-1 so its bytes are still matched.


Run it on a deliberately dirty copy once per change to the denylist: a checker
that has never failed is not evidence. Then build and test a clean clone of the
export, and run the CI venue against the exported root commit:

```bash
git clone /tmp/exocortex-public /tmp/exocortex-clean
cd /tmp/exocortex-clean && bun install --frozen-lockfile && bun run build && bun run test
EXOCORTEX_CI_GCP_PROJECT=<project> EXOCORTEX_CI_NO_STATUS=1 \
  bash scripts/cloud-ci.sh "$(git rev-parse HEAD)"
```

The Cloud Build run is the only venue that executes the real-browser (B*)
layer, because it supplies xvfb and Chrome.
