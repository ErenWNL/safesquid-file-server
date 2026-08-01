# TODOS

Deferred work, captured during `/office-hours`, `/plan-ceo-review` and
`/plan-eng-review`. Nothing here blocks the current scope. Each item records
why it was deferred so the decision doesn't have to be re-argued.

## Deferred by explicit decision

- **SHA256 checksums + copy-curl controls** (D4b) — a download server's real
  consumers are scripts, so per-file checksums and a ready-made `curl` command
  are the natural next feature. Deferred because checksums of placeholder
  files are ceremonial; this becomes worth building the moment `storage/`
  holds real artifacts.
- **Keyboard-first navigation** (D4c) — `/` to focus search, `j`/`k` to move,
  Enter to open, Backspace to go up. Deferred because the real cost is focus
  management and ARIA live regions, not the key handlers, and doing it badly
  is worse than not doing it.
- **True windowed virtualization** (F2) — the current design caps rendering at
  500 rows with an explicit "show all" escape. Deferred because hand-rolled
  virtual scrolling brings scroll-anchoring and variable-height bugs, and the
  cap already prevents the freeze. Revisit if a real folder exceeds ~5,000
  entries.
- **Formal WCAG AA contrast audit** (F4) — the semantic accessibility baseline
  is in scope; a measured contrast audit across both themes is not. Deferred
  because it constrains the dark palette before the palette exists.

## Deferred as out of scope for an interview deliverable

- **CI/CD pipeline** — a GitHub Actions workflow that regenerates
  `manifest.json` and runs `verify-security.sh` on every push is the obvious
  next step and would make the freshness problem disappear entirely.
- **Manifest as a published API** — the 10x version identified during the CEO
  review: a stable, versioned, machine-readable index that appliance update
  checkers poll. `schemaVersion` is in scope now precisely so this stays open.

## Known limitations to document, not fix

- `manifest.json` is a cache. It is stale from the moment a file changes in
  `storage/` until the generator runs again. Mitigated by the `generatedAt`
  stamp shown in the footer and by `make serve` coupling regeneration to
  startup, but not eliminated. `mod_autoindex` does not have this problem;
  this is the cost of replacing it.
- `<file-row>` creates one shadow root per row. At the 500-row cap that is 500
  shadow roots. This follows the task spec's explicit requirement for a
  file-row component, and sits in tension with the same spec's rule against
  using a component where a `<template>` would do. The cap is what bounds the
  cost.
