#!/usr/bin/env bash
#
# test-generate-manifest.sh — adversarial tests for the manifest generator
#
# generate-manifest.sh is the highest-risk file in this project. It is the only
# code that turns untrusted input (filenames, which anyone who can write to
# storage/ controls) into a document the browser parses. Two things can go
# wrong there and both are severe:
#
#   1. A filename containing " \ or a newline breaks JSON encoding. That does
#      not corrupt one row, it takes the entire site down, because the browser
#      cannot parse the manifest at all.
#   2. A symlink pointing outside storage/ gets indexed, advertising a download
#      that either escapes the storage root or 403s forever.
#
# The JavaScript assertion page (public/tests/) cannot reach shell code, so
# without this file the riskiest code in the project would have no coverage.
#
# Run: scripts/test-generate-manifest.sh
# Exits non-zero if any assertion fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATOR="$REPO_ROOT/scripts/generate-manifest.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

# assert_json <description> <python expression over `m`>
# The expression is evaluated with the parsed manifest bound to `m`; it must
# evaluate truthy for the assertion to pass.
assert_json() {
  local desc="$1" expr="$2"
  if python3 - "$MANIFEST" "$expr" <<'PY' >/dev/null 2>&1
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))

def names(node, acc=None):
    """Every entry name anywhere in the tree."""
    acc = [] if acc is None else acc
    for e in node["entries"]:
        acc.append(e["name"])
        if e["type"] == "dir":
            names(e, acc)
    return acc

def paths(node, acc=None):
    acc = [] if acc is None else acc
    for e in node["entries"]:
        acc.append(e["path"])
        if e["type"] == "dir":
            paths(e, acc)
    return acc

sys.exit(0 if eval(sys.argv[2]) else 1)
PY
  then ok "$desc"; else bad "$desc"; fi
}

FIXTURE="$(mktemp -d "${TMPDIR:-/tmp}/manifest-fixture.XXXXXX")"
MANIFEST="$(mktemp "${TMPDIR:-/tmp}/manifest-out.XXXXXX")"
OUTSIDE="$(mktemp -d "${TMPDIR:-/tmp}/manifest-outside.XXXXXX")"
trap 'rm -rf "$FIXTURE" "$OUTSIDE"; rm -f "$MANIFEST"' EXIT

echo "building adversarial fixture in $FIXTURE"

# --- names that break naive JSON encoding ----------------------------------
printf 'x' > "$FIXTURE/quote\"inside.iso"
printf 'x' > "$FIXTURE/back\\slash.iso"
printf 'x' > "$FIXTURE/$(printf 'line1\nline2')".iso
printf 'x' > "$FIXTURE/tab	inside.iso"

# --- names that break naive shell handling ---------------------------------
printf 'x' > "$FIXTURE/-rf.iso"                  # looks like a flag
printf 'x' > "$FIXTURE/spaces everywhere.iso"
printf 'x' > "$FIXTURE/\$(whoami).iso"           # command substitution bait
printf 'x' > "$FIXTURE/semi;colon&amp.iso"

# --- names that break naive HTML rendering ---------------------------------
printf 'x' > "$FIXTURE/<img src=x onerror=alert(1)>.iso"

# --- unicode ---------------------------------------------------------------
printf 'x' > "$FIXTURE/café-日本語-Ω.iso"

# --- things that must NOT appear -------------------------------------------
printf 'secret' > "$OUTSIDE/escaped.txt"
ln -s "$OUTSIDE/escaped.txt" "$FIXTURE/escape-link.iso"   # symlink out of tree
printf 'x' > "$FIXTURE/real-target.iso"
ln -s "$FIXTURE/real-target.iso" "$FIXTURE/inside-link.iso"  # symlink in tree
printf 'x' > "$FIXTURE/.hidden-dotfile"
mkdir -p "$FIXTURE/.hidden-dir"
printf 'x' > "$FIXTURE/.hidden-dir/inner.iso"
mkfifo "$FIXTURE/a-fifo" 2>/dev/null || true              # not a regular file

# --- nesting ---------------------------------------------------------------
mkdir -p "$FIXTURE/nested/deeper"
printf 'xxxxx' > "$FIXTURE/nested/deeper/buried.iso"
mkdir -p "$FIXTURE/empty-dir"

echo
echo "running generator"
GEN_STDERR="$(mktemp "${TMPDIR:-/tmp}/manifest-err.XXXXXX")"
"$GENERATOR" -s "$FIXTURE" -o "$MANIFEST" -q 2>"$GEN_STDERR"
GEN_EXIT=$?

echo
echo "assertions:"

[ "$GEN_EXIT" -eq 0 ] && ok "generator exits 0 on an adversarial tree" \
                      || bad "generator exits 0 on an adversarial tree (got $GEN_EXIT)"

if python3 -m json.tool "$MANIFEST" >/dev/null 2>&1; then
  ok "output is valid JSON"
else
  bad "output is valid JSON"
  echo
  echo "generator stderr:"; sed 's/^/    /' "$GEN_STDERR"
  echo "manifest head:";    head -c 400 "$MANIFEST" | sed 's/^/    /'
  rm -f "$GEN_STDERR"
  echo; echo "$PASS passed, $FAIL failed"
  exit 1
fi

# Every adversarial name must survive verbatim. json.dumps escapes them for
# transport; json.load brings back the original bytes. If the round trip is
# lossy, the browser would render a different name than the one on disk, and
# the download link would 404.
assert_json 'filename with a double quote round-trips'   '"quote\"inside.iso" in names(m["root"])'
assert_json 'filename with a backslash round-trips'      '"back\\slash.iso" in names(m["root"])'
assert_json 'filename with a newline round-trips'        '"line1\nline2.iso" in names(m["root"])'
assert_json 'filename with a tab round-trips'            '"tab\tinside.iso" in names(m["root"])'
assert_json 'filename that looks like a flag round-trips' '"-rf.iso" in names(m["root"])'
assert_json 'filename with spaces round-trips'           '"spaces everywhere.iso" in names(m["root"])'
assert_json 'command-substitution bait is inert text'    '"$(whoami).iso" in names(m["root"])'
assert_json 'shell metacharacters round-trip'            '"semi;colon&amp.iso" in names(m["root"])'
assert_json 'HTML injection payload is stored literally' '"<img src=x onerror=alert(1)>.iso" in names(m["root"])'
assert_json 'unicode filename round-trips'               '"café-日本語-Ω.iso" in names(m["root"])'

# The guards.
assert_json 'symlink escaping the root is absent'   '"escape-link.iso" not in names(m["root"])'
assert_json 'symlink inside the root is absent too' '"inside-link.iso" not in names(m["root"])'
assert_json 'escaped file content is not indexed'   '"escaped.txt" not in names(m["root"])'
assert_json 'dotfile is absent'                     '".hidden-dotfile" not in names(m["root"])'
assert_json 'dot-directory is absent'               '".hidden-dir" not in names(m["root"])'
assert_json 'file inside a dot-directory is absent' '"inner.iso" not in names(m["root"])'
assert_json 'FIFO is absent'                        '"a-fifo" not in names(m["root"])'

# Structure.
assert_json 'nested directory is walked'      '"nested/deeper/buried.iso" in paths(m["root"])'
assert_json 'empty directory is present'      'any(e["name"] == "empty-dir" and e["entries"] == [] for e in m["root"]["entries"])'
assert_json 'totals bubble up from nesting'   'next(e for e in m["root"]["entries"] if e["name"] == "nested")["totalSize"] == 5'
assert_json 'nested fileCount is recursive'   'next(e for e in m["root"]["entries"] if e["name"] == "nested")["fileCount"] == 1'
assert_json 'schemaVersion is present'        'm["schemaVersion"] == 1'
assert_json 'generatedAt is present'          'bool(m["generatedAt"])'
assert_json 'directories sort before files'   '[e["type"] for e in m["root"]["entries"]][:2] == ["dir", "dir"]'
assert_json 'no entry path escapes the root'  'all(not p.startswith("/") and ".." not in p.split("/") for p in paths(m["root"]))'

# The generator must have said something about what it skipped, rather than
# dropping entries silently.
if grep -q 'symlink skipped' "$GEN_STDERR"; then
  ok "skipped symlinks are reported on stderr"
else
  bad "skipped symlinks are reported on stderr"
fi
rm -f "$GEN_STDERR"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%d passed, 0 failed\033[0m\n' "$PASS"
  exit 0
else
  printf '\033[31m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
