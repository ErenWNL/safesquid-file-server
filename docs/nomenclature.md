# Artifact naming

Every published artifact follows one pattern, and every family carries an
unsuffixed alias pointing at its newest member.

```
{component}-{os-version}-{variant}-{unix-timestamp}.{ext}
```

```
aggregator-18.04-mini-1655391291.iso
│          │     │    │          └── extension
│          │     │    └───────────── build time, seconds since epoch
│          │     └────────────────── variant
│          └──────────────────────── target OS version
└─────────────────────────────────── component
```

## Fields

| Field | Rule | Examples |
|---|---|---|
| `component` | lowercase, matches the folder it lives in | `aggregator`, `appliance`, `swg`, `vpn` |
| `os-version` | the target OS release, dotted | `18.04`, `20.04`, `22.04`, `24.04` |
| `variant` | what distinguishes this build from its siblings | `mini`, `full`, `standard`, `hardened`, `client-linux` |
| `unix-timestamp` | seconds since epoch at build time, 9+ digits | `1655391291` |
| `ext` | real extension, compound extensions kept whole | `.iso`, `.ova`, `.deb`, `.tar.gz` |

The timestamp is the field that makes the scheme work. It sorts correctly as a
string, it never collides, it needs no registry to allocate, and it answers
"which of these two is newer" without consulting anything outside the filename.

Every file's modification time matches the timestamp in its own name. That is
worth preserving: it means the listing's date column and the filename never
disagree.

## The latest alias

Alongside each timestamped family sits an unsuffixed file:

```
aggregator-18.04-mini-1655391291.iso
aggregator-20.04-mini-1687012800.iso
aggregator-22.04-mini-1718548800.iso
aggregator.iso                        ← alias, same bytes as the newest
```

This is what a download link in documentation should point at, so the link
survives the next release. The timestamped names are what a deployment should
pin to, so a rebuild does not silently change under it.

The listing marks aliases with a **latest** badge. Detection is not "has no
timestamp in the name" — by that test `CHANGELOG.md` and `README.txt` would be
release aliases too. A file is an alias only when a sibling exists that shares
its base and extension **and** carries a timestamp. See `isLatestAlias` in
`public/js/manifest.js`, and the assertions for it at `/tests/`.

Compound extensions are treated as one unit, so `vpn.tar.gz` splits to base
`vpn` and extension `.tar.gz` rather than base `vpn.tar`. Splitting on the last
dot instead makes the alias undetectable, because no sibling is named
`vpn.tar-*`.

Aliases are real files, not symlinks. Apache runs with `Options -FollowSymLinks`
and the manifest generator skips symlinks outright, so a symlinked alias would
be listed but never downloadable. Copy or hardlink instead.

## Files that are not artifacts

`CHANGELOG.md`, `README.txt`, `DEPRECATED.txt` and similar are exempt. They
describe a folder rather than being a build of something, they carry no
timestamp, and they get no badge.

## Why not semantic versions

Semantic versions describe an interface contract. These are appliance images
and package snapshots, where the useful question is almost always "is this
newer than what I have", not "is this API-compatible with what I have". A build
timestamp answers that directly. Where a real version exists it appears in the
`os-version` field, which is the version anyone selecting an image actually
cares about.
