#!/usr/bin/env bash
#
# generate-manifest.sh — walk storage/ and write public/manifest.json
#
# This is the ONLY thing that reads the filesystem to build an index. Apache is
# configured never to list a directory (Options -Indexes, DirectoryIndex
# disabled), so the manifest this script emits is the site's entire index. If
# it is wrong, the site is wrong.
#
#   storage/**  ──walk──▶  [guards]  ──encode──▶  public/manifest.json
#                              │
#                    ┌─────────┴──────────┐
#                    │ realpath containment
#                    │ symlinks skipped
#                    │ dotfiles skipped
#                    │ non-regular files skipped
#                    │ unreadable entries skipped + warned
#                    └────────────────────┘
#
# WHY PYTHON IS EMBEDDED HERE
#
# Building JSON by interpolating shell strings into braces is the single most
# common way a generator like this becomes a vulnerability: a filename holding
# a double quote, a backslash or a newline breaks the document, and a broken
# manifest.json takes the whole site down (not one row). Filenames on a file
# server are untrusted input. So the walk and the encoding both happen in
# python3, where json.dumps handles escaping correctly by construction. The
# bash wrapper owns argument handling, validation and reporting.
#
# See scripts/test-generate-manifest.sh, which asserts exactly this with a
# fixture tree full of adversarial filenames.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_DIR="${STORAGE_DIR:-$REPO_ROOT/storage}"
OUTPUT_FILE="${OUTPUT_FILE:-$REPO_ROOT/public/manifest.json}"

usage() {
  cat <<'USAGE'
Usage: generate-manifest.sh [-s STORAGE_DIR] [-o OUTPUT_FILE] [-q]

  -s  directory to walk       (default: <repo>/storage)
  -o  manifest to write       (default: <repo>/public/manifest.json)
  -q  quiet; suppress the summary on stdout (warnings still go to stderr)
  -h  this message

Exits non-zero if the storage directory is missing or the walk fails.
USAGE
}

QUIET=0
while getopts ":s:o:qh" opt; do
  case "$opt" in
    s) STORAGE_DIR="$OPTARG" ;;
    o) OUTPUT_FILE="$OPTARG" ;;
    q) QUIET=1 ;;
    h) usage; exit 0 ;;
    :) echo "generate-manifest.sh: -$OPTARG requires an argument" >&2; exit 2 ;;
    \?) echo "generate-manifest.sh: unknown option -$OPTARG" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "generate-manifest.sh: python3 is required (used for correct JSON encoding)" >&2
  exit 1
fi

if [ ! -d "$STORAGE_DIR" ]; then
  echo "generate-manifest.sh: storage directory not found: $STORAGE_DIR" >&2
  echo "generate-manifest.sh: refusing to write an empty manifest" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Write to a temporary file and move it into place, so a failure part-way
# through never leaves a truncated manifest.json being served. A truncated
# manifest is a SyntaxError in the browser, which is the blank-page failure
# the client-side error state exists to catch — but not leaving one behind in
# the first place is better.
TMP_OUT="$(mktemp "${OUTPUT_FILE}.XXXXXX")"
trap 'rm -f "$TMP_OUT"' EXIT

# -q silences the summary on stdout. Warnings keep going to stderr regardless:
# a skipped entry is something you always want to hear about, even in a
# scripted run.
[ "$QUIET" -eq 1 ] && exec 3>&1 >/dev/null

STORAGE_DIR="$STORAGE_DIR" python3 - "$TMP_OUT" <<'PYTHON'
import json
import os
import sys
import time

out_path = sys.argv[1]
storage_dir = os.environ["STORAGE_DIR"]

# The containment root. Every entry's real path must live underneath this or it
# does not go in the manifest. Resolved once, up front, so a symlinked storage
# directory itself still produces a correct boundary.
root_real = os.path.realpath(storage_dir)

stats = {"files": 0, "dirs": 0, "bytes": 0, "skipped": 0}
warnings = []


def warn(reason, path):
    stats["skipped"] += 1
    warnings.append("%s: %s" % (reason, path))


def contained(path):
    """True if path resolves to somewhere inside the storage root.

    This is the generation-time layer of the traversal defense. It is the only
    layer that can see a symlink escape, because by the time Apache serves a
    request the symlink has already been resolved (and FollowSymLinks is off,
    so Apache would refuse anyway — listing such a file would be a lie).
    """
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real + os.sep)


def walk(dir_path, rel_path):
    """Return a directory node, recursing depth-first.

    Totals bubble upward: a folder's fileCount and totalSize include everything
    beneath it, not just its immediate children, so the listing can show
    "12 files, 4.7M" against a folder row.
    """
    entries = []
    file_count = 0
    total_size = 0

    try:
        names = sorted(os.listdir(dir_path))
    except OSError as exc:
        warn("unreadable directory (%s)" % exc.strerror, dir_path)
        names = []

    for name in names:
        # Dotfiles never enter the index. Apache denies them separately; this
        # keeps the two layers agreeing rather than advertising a 403.
        if name.startswith("."):
            continue

        full = os.path.join(dir_path, name)
        child_rel = name if not rel_path else rel_path + "/" + name

        # Symlinks are skipped wholesale. Apache runs with -FollowSymLinks, so
        # it would not serve one; listing it would advertise a download that
        # always 403s. Skipping also removes symlink loops as a concern.
        if os.path.islink(full):
            warn("symlink skipped", full)
            continue

        if not contained(full):
            warn("resolves outside storage root", full)
            continue

        try:
            st = os.stat(full)
        except OSError as exc:
            warn("unreadable (%s)" % exc.strerror, full)
            continue

        if os.path.isdir(full):
            node = walk(full, child_rel)
            stats["dirs"] += 1
            entries.append(node)
            file_count += node["fileCount"]
            total_size += node["totalSize"]
        elif os.path.isfile(full):
            # Regular files only. Sockets, FIFOs and device nodes are not
            # downloadable artifacts and have no business in a download index.
            entries.append({
                "name": name,
                "type": "file",
                "path": child_rel,
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            })
            stats["files"] += 1
            stats["bytes"] += st.st_size
            file_count += 1
            total_size += st.st_size
        else:
            warn("not a regular file or directory", full)

    # Directories first, then files; each group alphabetical. This is the
    # server-side default order. The client re-sorts on demand, but a manifest
    # consumed by a script (curl, an update checker) gets a stable order too.
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))

    try:
        dir_mtime = int(os.stat(dir_path).st_mtime)
    except OSError:
        dir_mtime = 0

    return {
        "name": os.path.basename(rel_path) if rel_path else "",
        "type": "dir",
        "path": rel_path,
        "mtime": dir_mtime,
        "fileCount": file_count,
        "totalSize": total_size,
        "entries": entries,
    }


tree = walk(storage_dir, "")

manifest = {
    # Bumped when the shape below changes incompatibly. A consumer that pins to
    # a version can refuse a manifest it does not understand instead of
    # silently misreading one.
    "schemaVersion": 1,
    # The freshness stamp. This manifest is a cache of the filesystem and is
    # stale from the moment storage/ changes until this script runs again; the
    # UI surfaces this value so the staleness is visible rather than silent.
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "generatedAtEpoch": int(time.time()),
    "root": tree,
}

with open(out_path, "w", encoding="utf-8") as fh:
    # ensure_ascii keeps the payload pure ASCII, so no encoding assumption is
    # needed anywhere downstream. sort_keys makes the output byte-stable, which
    # means regenerating an unchanged tree produces no git diff.
    json.dump(manifest, fh, ensure_ascii=True, sort_keys=True, indent=2)
    fh.write("\n")

for line in warnings:
    sys.stderr.write("generate-manifest.sh: %s\n" % line)

# One-line summary on stdout. Every skipped entry has already warned on stderr
# above; this is the count-level view, and it is what makes a walk that quietly
# indexed nothing visible instead of silent.
sys.stdout.write("manifest: %d files in %d directories, %d bytes, %d skipped\n" % (
    stats["files"], stats["dirs"], stats["bytes"], stats["skipped"]))
sys.stdout.write("manifest: schema v%d, generated %s\n" % (
    manifest["schemaVersion"], manifest["generatedAt"]))
PYTHON

mv "$TMP_OUT" "$OUTPUT_FILE"
trap - EXIT

if [ "$QUIET" -eq 1 ]; then
  exec 1>&3 3>&-
else
  echo "manifest: written to $OUTPUT_FILE"
fi
exit 0
