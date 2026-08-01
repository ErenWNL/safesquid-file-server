# SafeSquid file server

A rebuild of the public download server at `downloads.safesquid.com`, replacing
Apache's `mod_autoindex` output with a hardened static host and a browsing layer
built from native Web Components.

No framework. No bundler. No npm. No build step. `public/` is the DocumentRoot
and deploys exactly as it sits in the repo.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BUILD TIME                                                               │
│                                                                          │
│  storage/**  ──walk──▶  scripts/generate-manifest.sh  ──▶ public/        │
│   the real                    │                            manifest.json │
│   artifacts        ┌──────────┴───────────┐                              │
│                    │ realpath containment │                              │
│                    │ symlinks skipped     │                              │
│                    │ dotfiles skipped     │                              │
│                    │ json.dumps encoding  │                              │
│                    └──────────────────────┘                              │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
═══════════════════════════════════│══════════════════════════════════════
                                   │
┌──────────────────────────────────▼───────────────────────────────────────┐
│ REQUEST TIME                                                             │
│                                                                          │
│   GET /            ──▶ index.html ─▶ js/app.js                           │
│   GET /browse/SWG  ──▶ (only /browse/* rewrites to index.html)           │
│                              │                                           │
│                              │ owns ALL view state                       │
│                              │ route · sort · filter · cap               │
│                    ┌─────────┼─────────────┐                             │
│                    ▼         ▼             ▼                             │
│           <breadcrumb-nav>  <directory-listing>  js/format.js            │
│                                    │                                     │
│                                    ▼                                     │
│                              <file-row> × N                              │
│                                    │                                     │
│   GET /files/SWG/swg.iso ──────────┴──▶ Apache Alias ──▶ storage/        │
│                                          -Indexes                        │
│                                          Content-Disposition: attachment │
│                                          X-Robots-Tag: noindex           │
└──────────────────────────────────────────────────────────────────────────┘
```

Apache serves file **bytes** out of `storage/`. It is never permitted to **list**
a directory. `manifest.json` is the only index.

## Running it

Requires Apache 2.4 and python3. Both ship with macOS; on Debian/Ubuntu,
`apt install apache2 python3`.

```bash
make serve          # regenerates the manifest, then starts Apache on :8081
```

Then open <http://localhost:8081>.

Port 8081 rather than 8080, which is commonly occupied. Override with
`make serve PORT=9000`.

`make serve` regenerates the manifest **before** starting, always. That coupling
is deliberate — see [Known limitations](#known-limitations).

| Command | What it does |
|---|---|
| `make serve` | Regenerate the manifest, then run Apache |
| `make manifest` | Rebuild `public/manifest.json` from `storage/` |
| `make verify` | 69 security assertions against a running server |
| `make test` | 28 adversarial tests for the manifest generator |
| `make check` | Manifest + generator tests + security assertions, no browser |
| `make stop` | Stop a server started by `make serve` |

Client-side assertions live at <http://localhost:8081/tests/> — 119 of them,
run by opening the page.

### Which Apache gets used

`make` picks the binary and its module paths automatically:

| Found | Uses | Modules from |
|---|---|---|
| `/opt/homebrew/opt/httpd` | Homebrew Apache | `$(brew --prefix httpd)/lib/httpd/modules` |
| Apple's built-in | `/usr/sbin/httpd` | `/usr/libexec/apache2` |
| Neither | `/usr/sbin/apache2` | `/usr/lib/apache2/modules` |

`httpd.conf` takes these from the environment rather than hardcoding them, so
the same config runs on all three. Override with `APACHE_SERVER_ROOT`,
`APACHE_MODULE_DIR`, `APACHE_MIME_TYPES`, or point at a specific binary with
`make serve HTTPD=/path/to/httpd`.

Without `make`:

```bash
SAFESQUID_ROOT="$PWD" \
APACHE_SERVER_ROOT=/opt/homebrew/opt/httpd \
APACHE_MODULE_DIR=/opt/homebrew/opt/httpd/lib/httpd/modules \
APACHE_MIME_TYPES=/opt/homebrew/etc/httpd/mime.types \
/opt/homebrew/opt/httpd/bin/httpd -f "$PWD/httpd.conf" -DFOREGROUND
```

### macOS: Apple's Apache cannot read ~/Documents

macOS TCC blocks `/usr/sbin/httpd` from `~/Documents`, `~/Desktop` and
`~/Downloads`. With the repo in one of those and Apple's binary in use, startup
fails with:

```
httpd: Could not open configuration file .../httpd.conf: Operation not permitted
```

That is a permission boundary, not a syntax error — the config is fine.

**`brew install httpd` fixes it**, and `make` then picks the Homebrew binary
automatically, so the project runs wherever it is checked out. Note that
`httpd` on `PATH` still resolves to Apple's copy even after installing, which
is why the Makefile uses an absolute path rather than trusting `PATH`.

Alternatives if you would rather not install it: move the repo outside those
folders, or grant Full Disk Access to `/usr/sbin/httpd` in System Settings →
Privacy & Security.

Linux is unaffected.

## Security

Every item below is asserted by `scripts/verify-security.sh` against a running
server. `make verify` prints the results; the suite exits non-zero on any
failure, and has been confirmed to go red when the protections are deliberately
weakened.

### Apache's own listing is gone, not merely disabled

`mod_autoindex` is **not loaded**. The module that generates "Index of /" pages
is absent from the process, so there is no code path that can produce one.
Beyond that, four independent mechanisms stop a directory being served:

- `Options -Indexes`
- `DirectoryIndex disabled` on the storage alias — otherwise an `index.html`
  dropped into `storage/` is silently promoted to a directory listing
- `RedirectMatch 404` on directory paths under `/files/`
- `Options -FollowSymLinks`

### Path traversal

There is no application server in the request path — Apache maps URLs to files
itself — so there is no single `normalize()` function to point at. **A reviewer
looking for one will not find it.** Protection is layered across the three
places a path is genuinely resolved:

| Layer | Where | What it catches |
|---|---|---|
| Request time | `httpd.conf` | Raw `../`, percent-encoded `%2e%2e`, double-encoded `%252e`, encoded slashes, null bytes, dotfiles and dot-directories — all before URL-to-file mapping |
| Generation time | `scripts/generate-manifest.sh` | `realpath` containment against the resolved storage root. The **only** layer that can see a symlink escape, because by request time the symlink is already resolved |
| Client time | `public/js/manifest.js` | The router walks the manifest tree node by node instead of concatenating path strings. An unknown segment renders "not found" rather than producing a request that probes anything |

Traversal rules inspect both `THE_REQUEST` and `REQUEST_URI`, because Apache
decodes `REQUEST_URI` before rewrite rules see it and only the raw request line
still shows `%2e%2e`.

### Untrusted filenames

Filenames on a file server are attacker-influenced input, and they flow into two
places that both matter:

- **Into the manifest.** Encoding goes through python3's `json.dumps`, never
  string interpolation. A name containing `"`, `\` or a newline breaks a
  hand-rolled encoder, and a broken `manifest.json` does not corrupt one row —
  it takes the whole site down, because the browser cannot parse the index at
  all. `scripts/test-generate-manifest.sh` proves this against a fixture tree of
  adversarial names.
- **Into the DOM.** Every value derived from the manifest is assigned with
  `textContent`. A file named `<img src=x onerror=alert(1)>.iso` renders as
  literal text. `/tests/` asserts this with five XSS payloads, checking both
  that the text is literal and that the shadow tree contains no injected
  elements. The CSP is the second layer, not the fix.

### Headers

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
                         img-src 'self' data:; font-src 'self'; connect-src 'self';
                         object-src 'none'; base-uri 'none'; form-action 'none';
                         frame-ancestors 'none'
X-Content-Type-Options:  nosniff
X-Frame-Options:         DENY
Referrer-Policy:         no-referrer
X-Robots-Tag:            noindex, nofollow      (on /files/)
Content-Disposition:     attachment             (on /files/)
```

No `'unsafe-inline'` in either `script-src` or `style-src`. That constraint has
a real architectural consequence, covered below.

`Content-Disposition: attachment` on everything under `/files/` is not only
download UX. A file server hosts whatever it is given, and forcing attachment
disposition eliminates stored-XSS-via-hosted-HTML as an entire class.

### Denied

`httpd.conf`, `scripts/`, `logs/`, the `Makefile`, all dotfiles and all
dot-directories. These live outside DocumentRoot and are unreachable anyway;
the rules make it fail closed rather than relying on that.

### Information disclosure

`ServerTokens Prod` and `ServerSignature Off` (the `Server` header reads
`Apache`, with no version or OS), `TraceEnable Off`, `AllowOverride None`, and
`AllowEncodedSlashes Off`. A denied path and a missing path render an identical
body, so probing for which paths exist reveals nothing from the response.

### Compression

`mod_deflate` on `manifest.json`, JS and CSS. The manifest is the largest thing
on the wire and compresses roughly 8:1. Already-compressed artifacts
(`.iso`, `.gz`, `.deb`, …) are excluded, since re-compressing them costs CPU to
make the payload slightly larger.

## Two decisions worth explaining

### A strict CSP is incompatible with the standard Web Component pattern

The usual way to style a Web Component is a `<style>` block inside its shadow
root. CSP treats that as an **inline style** wherever it appears — shadow DOM
gets no exemption — so `style-src 'self'` blocks it, and every component renders
unstyled the moment the policy is switched on.

Each component therefore links `/css/components.css` into its shadow root, which
is an ordinary same-origin fetch and is allowed. Theming still works because
custom properties inherit through the shadow boundary even though ordinary
selectors do not.

### The listing is not a `<table>`

A custom element cannot be a `<tr>`: the parser only permits `<tr>` inside
`<tbody>` and hoists anything else out of the table entirely. The escape hatch,
a customized built-in (`<tr is="file-row">`), is unimplemented in Safari.

The listing is built from explicit ARIA table roles instead — `role="row"` on
each `<file-row>` host, `role="cell"` inside, `aria-sort` on the active column
header. Shadow trees are flattened for accessibility, so a screen reader sees a
coherent table.

## Known limitations

**`manifest.json` is a cache, and it goes stale.** It is out of date from the
moment anything in `storage/` changes until the generator runs again.
`mod_autoindex` — the thing this replaces — reads the filesystem per request and
therefore *can never be stale*. That is the one real advantage given up here,
and it is a deliberate trade for control over the output.

It is mitigated, not eliminated: the footer shows how old the index is, and
`make serve` regenerates before starting so the step cannot be forgotten. If you
add a file and do not see it, run `make manifest`. In production this belongs in
CI, triggered on artifact publish — see `TODOS.md`.

**One shadow root per row.** `<file-row>` is a Web Component per the brief,
which means 500 shadow roots at the render cap. This sits in tension with the
brief's own instruction not to use a component where a `<template>` would do.
The explicit requirement wins; the cap bounds the cost.

**Rendering caps at 500 rows** with a "Show all N" control, so a very large
folder never freezes the page. True windowed virtualization is in `TODOS.md`.

**Placeholder artifacts are zero-filled and size-reduced** so a clone stays
small. The size formatter is unit-tested from one byte to a petabyte rather than
relying on fixture sizes to exercise it.

## Layout

```
├── httpd.conf                     self-contained vhost, heavily commented
├── Makefile                       serve / manifest / verify / test / check
├── public/                        Apache DocumentRoot, deploys as-is
│   ├── index.html                 app shell, no inline script or style
│   ├── error.html                 one page for both 403 and 404
│   ├── robots.txt
│   ├── manifest.json              GENERATED — do not hand-edit
│   ├── css/style.css              page styling and the theme tokens
│   ├── css/components.css         shadow-root styling, linked not inlined
│   ├── js/app.js                  bootstrap, state, History API routing
│   ├── js/format.js               size and date formatting
│   ├── js/manifest.js             tree query, traversal-safe path resolution
│   ├── js/components/             directory-listing, file-row, breadcrumb-nav
│   └── tests/                     119 client-side assertions
├── storage/                       the served artifacts
├── scripts/
│   ├── generate-manifest.sh       walks storage/, writes manifest.json
│   ├── test-generate-manifest.sh  28 adversarial tests for the above
│   └── verify-security.sh         62 assertions against a running server
└── docs/nomenclature.md           artifact naming convention
```

## Process

This was built through a planned workflow rather than straight into the editor.

- **[TIMELOG.md](TIMELOG.md)** — every phase boundary, timestamped from real
  `date` output. Scoping and two plan reviews ran before any code was written.
- **[USAGE.md](USAGE.md)** — token and cost readings per phase, pasted verbatim.
  Phases where no reading was captured say so rather than carrying an estimate.
- **[TODOS.md](TODOS.md)** — deferred work, each item with the reason it was
  deferred.

The planning phases paid for themselves twice. `/plan-ceo-review` caught the
stored-XSS and manifest-corruption paths through filenames, neither of which was
in the original brief. `/plan-eng-review` caught that a naive History API
fallback would match missing artifacts and return `index.html` with HTTP 200 —
so `curl -O` would silently write a web page to disk under the requested `.iso`
name.

Several more were found only by running the server, and two of those were
reported as `Syntax OK` by `httpd -t`: `RewriteRule` inside a `<Directory>`
block is refused outright when `FollowSymLinks` is off, and in server context
`REQUEST_FILENAME` is not yet a filesystem path, which made the fallback rewrite
*every* request to `index.html`.

QA then found that even the corrected fallback was too broad. The standard SPA
recipe — rewrite anything that is not an existing file — also swallowed a
*missing* `manifest.json`, answering HTML with a 200 so the page reported the
index as unparseable rather than ungenerated. The fallback now names its route
prefix explicitly: only `/browse/...` rewrites, and every other unknown path
gets a real 404. All of it is documented at the point of the fix in
`httpd.conf` and guarded by assertions in `verify-security.sh`.
