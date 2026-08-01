#!/usr/bin/env bash
#
# verify-security.sh — assert every hardening claim against a running server.
#
# The README makes a list of security claims. This script is what makes them
# checkable rather than something you take on trust: it runs curl against a
# live instance and asserts each one. Every claim in the README maps to an
# assertion here.
#
# Run:  scripts/verify-security.sh [BASE_URL]
#       make verify
#
# Default BASE_URL is http://localhost:8081.
# Exits non-zero if any assertion fails, so it works as a gate in a pipeline.

set -uo pipefail

BASE="${1:-http://localhost:8081}"
BASE="${BASE%/}"

PASS=0
FAIL=0
FAILED_NAMES=()

if [ -t 1 ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[1m'; N='\033[0m'
else
  G=''; R=''; Y=''; B=''; N=''
fi

ok()  { PASS=$((PASS + 1)); printf "  ${G}PASS${N}  %s\n" "$1"; }
bad() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); printf "  ${R}FAIL${N}  %s\n" "$1"; [ -n "${2:-}" ] && printf "        expected %s, got %s\n" "$2" "${3:-nothing}"; }

section() { printf "\n${B}%s${N}\n" "$1"; }

# status <url> -> HTTP code. --path-as-is keeps traversal sequences intact so
# curl does not helpfully normalise away the thing being tested.
status() { curl -s -o /dev/null -w '%{http_code}' --path-as-is "$1" 2>/dev/null; }
header() { curl -sI --path-as-is "$1" 2>/dev/null | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }
body()   { curl -s --path-as-is "$1" 2>/dev/null; }

# assert_status <description> <url> <expected...>  (any of the expected codes)
assert_status() {
  local desc="$1" url="$2"; shift 2
  local got; got="$(status "$url")"
  for want in "$@"; do
    [ "$got" = "$want" ] && { ok "$desc"; return; }
  done
  bad "$desc" "$*" "$got"
}

# assert_denied — 401/403/404/400 all count as denied. Which one Apache picks
# varies with the mechanism (rewrite, RedirectMatch, or its own request-line
# validation); what matters is that the resource is not served.
assert_denied() {
  local desc="$1" url="$2"
  local got; got="$(status "$url")"
  case "$got" in
    400|401|403|404) ok "$desc (HTTP $got)" ;;
    *) bad "$desc" "a 4xx denial" "$got" ;;
  esac
}

assert_header_contains() {
  local desc="$1" url="$2" name="$3" needle="$4"
  local got; got="$(header "$url" "$name")"
  case "$got" in
    *"$needle"*) ok "$desc" ;;
    *) bad "$desc" "$name to contain '$needle'" "'${got:-<absent>}'" ;;
  esac
}

assert_header_absent_value() {
  local desc="$1" url="$2" name="$3" needle="$4"
  local got; got="$(header "$url" "$name")"
  case "$got" in
    *"$needle"*) bad "$desc" "$name without '$needle'" "'$got'" ;;
    *) ok "$desc" ;;
  esac
}

assert_body_lacks() {
  local desc="$1" url="$2" needle="$3"
  if body "$url" | grep -qi -- "$needle"; then
    bad "$desc" "body without '$needle'" "a body containing it"
  else
    ok "$desc"
  fi
}

printf "${B}verify-security.sh${N}  target: %s\n" "$BASE"

# ---------------------------------------------------------------- reachable
if ! curl -s -o /dev/null --max-time 5 "$BASE/" 2>/dev/null; then
  printf "\n${R}Server is not responding at %s${N}\n" "$BASE"
  printf "Start it with:  make serve\n"
  printf "Then re-run:    scripts/verify-security.sh %s\n" "$BASE"
  exit 2
fi

# ============================================================================
section "1. Apache's own directory listing is gone"
# ============================================================================
# The central claim of this project. mod_autoindex is not merely disabled, it
# is not loaded — so there is no code path that can produce a listing.
assert_denied "storage root is not listable"            "$BASE/files/"
assert_denied "a folder is not listable (trailing /)"   "$BASE/files/SWG/"
assert_denied "a folder is not listable (no slash)"     "$BASE/files/SWG"
assert_denied "a nested folder is not listable"         "$BASE/files/repo/dists/"
assert_body_lacks "no 'Index of' output anywhere"       "$BASE/files/SWG/" "index of"
assert_body_lacks "no autoindex sort links leak"        "$BASE/files/" "?C=N;O=D"

# ============================================================================
section "2. Artifacts download, and only download"
# ============================================================================
assert_status "an artifact is served"                   "$BASE/files/SWG/swg.iso" 200
assert_header_contains "forced to download, never inline" \
  "$BASE/files/SWG/swg.iso" "Content-Disposition" "attachment"
assert_header_contains "artifacts are not indexed by crawlers" \
  "$BASE/files/SWG/swg.iso" "X-Robots-Tag" "noindex"
assert_header_contains "MIME sniffing is off on artifacts" \
  "$BASE/files/SWG/swg.iso" "X-Content-Type-Options" "nosniff"

# A missing artifact must 404. If the History API fallback is written without
# excluding /files/, this returns 200 with index.html and `curl -O` silently
# writes a web page to disk under the requested .iso name.
assert_status "a missing artifact 404s"                 "$BASE/files/SWG/nope.iso" 404
# The needle must be unique to the application shell. "SafeSquid downloads"
# is not: it is also the error page's <title>, which made this assertion fail
# against correct behaviour. <directory-listing> appears only in index.html.
assert_body_lacks "a missing artifact is not the app shell" \
  "$BASE/files/SWG/nope.iso" "<directory-listing"

# Regression guard. The config-denial rules match extensions like .sh, .log and
# .conf so that /httpd.conf fails closed. They sat in global scope originally,
# which also denied published artifacts with those extensions — 403 on the
# download while the manifest still listed it, so the UI offered a link that
# always failed. These must stay scoped to the docroot.
for EXT_PATH in "contrib/install-helper-1720000000.sh" "contrib/build-1720000000.log"; do
  EXT_CODE="$(status "$BASE/files/$EXT_PATH")"
  case "$EXT_CODE" in
    200) ok "an artifact named *.${EXT_PATH##*.} downloads (not caught by the config denial)" ;;
    404) ok "no *.${EXT_PATH##*.} fixture present — skipped" ;;
    *)   bad "an artifact named *.${EXT_PATH##*.} downloads" "200 or 404" "$EXT_CODE" ;;
  esac
done


# The History API fallback must rewrite ONLY /browse/... Written the usual SPA
# way (rewrite anything that is not an existing file) it also swallowed a
# MISSING /manifest.json, answering HTML with a 200 so the client reported the
# index as unparseable instead of ungenerated. Unknown paths must 404.
assert_status "an app route serves the shell"           "$BASE/browse/SWG" 200
assert_status "a deep app route serves the shell"       "$BASE/browse/repo/dists/stable" 200
assert_status "an unknown path 404s, not the shell"     "$BASE/nonsense-xyz" 404
assert_status "a missing asset 404s, not the shell"     "$BASE/css/missing-xyz.css" 404
assert_body_lacks "an unknown path is not the app shell" \
  "$BASE/nonsense-xyz" "<directory-listing"

# ============================================================================
section "3. Path traversal"
# ============================================================================
# Both raw and percent-encoded forms, because Apache decodes REQUEST_URI before
# rewrite rules see it and only the raw request line still shows %2e%2e.
assert_denied "raw ../ from the alias"          "$BASE/files/../httpd.conf"
assert_denied "raw ../ twice"                   "$BASE/files/SWG/../../httpd.conf"
assert_denied "percent-encoded .."              "$BASE/files/%2e%2e/httpd.conf"
assert_denied "double-encoded .."               "$BASE/files/%252e%252e/httpd.conf"
assert_denied "encoded slash"                   "$BASE/files/..%2fhttpd.conf"
assert_denied "encoded backslash"               "$BASE/files/..%5chttpd.conf"
assert_denied "traversal to /etc/passwd"        "$BASE/files/../../../../../../etc/passwd"
assert_denied "null byte in path"               "$BASE/files/SWG/swg.iso%00.txt"
assert_denied "traversal outside the docroot"   "$BASE/../httpd.conf"

# ============================================================================
section "4. Configuration, tooling and dotfiles are unreachable"
# ============================================================================
assert_denied "httpd.conf"                      "$BASE/httpd.conf"
assert_denied "the manifest generator"          "$BASE/scripts/generate-manifest.sh"
assert_denied "the generator's tests"           "$BASE/scripts/test-generate-manifest.sh"
assert_denied "this script"                     "$BASE/scripts/verify-security.sh"
assert_denied "the scripts directory"           "$BASE/scripts/"
assert_denied "the error log"                   "$BASE/logs/error.log"
assert_denied "the access log"                  "$BASE/logs/access.log"
assert_denied "the Makefile"                    "$BASE/Makefile"
assert_denied "a dotfile at the root"           "$BASE/.gitignore"
assert_denied "a dotfile under storage"         "$BASE/files/staging/pending/.gitkeep"
assert_denied "a dot-directory"                 "$BASE/.git/config"
assert_denied "a dot-directory under storage"   "$BASE/files/.hidden/x"

# Config contents must never appear in any response body, whatever the status.
assert_body_lacks "no config contents leak"     "$BASE/httpd.conf" "LoadModule"
assert_body_lacks "no script contents leak"     "$BASE/scripts/generate-manifest.sh" "STORAGE_DIR"

# ============================================================================
section "5. Security headers"
# ============================================================================
assert_header_contains "X-Content-Type-Options" "$BASE/" "X-Content-Type-Options" "nosniff"
assert_header_contains "X-Frame-Options"        "$BASE/" "X-Frame-Options" "DENY"
assert_header_contains "Referrer-Policy"        "$BASE/" "Referrer-Policy" "no-referrer"
assert_header_contains "CSP default-src none"   "$BASE/" "Content-Security-Policy" "default-src 'none'"
assert_header_contains "CSP frame-ancestors"    "$BASE/" "Content-Security-Policy" "frame-ancestors 'none'"
assert_header_contains "CSP base-uri"           "$BASE/" "Content-Security-Policy" "base-uri 'none'"
assert_header_contains "CSP form-action"        "$BASE/" "Content-Security-Policy" "form-action 'none'"
assert_header_contains "CSP object-src"         "$BASE/" "Content-Security-Policy" "object-src 'none'"

# The single most common finding in a CSP audit. Present in neither directive.
assert_header_absent_value "CSP has no 'unsafe-inline'" \
  "$BASE/" "Content-Security-Policy" "unsafe-inline"
assert_header_absent_value "CSP has no 'unsafe-eval'" \
  "$BASE/" "Content-Security-Policy" "unsafe-eval"

# ============================================================================
section "6. Information disclosure"
# ============================================================================
# ServerTokens Prod: "Apache", never "Apache/2.4.66 (Unix)".
SERVER_HDR="$(header "$BASE/" "Server")"
if printf '%s' "$SERVER_HDR" | grep -qE '[0-9]+\.[0-9]+'; then
  bad "Server header hides the version" "no version number" "'$SERVER_HDR'"
else
  ok "Server header hides the version ('${SERVER_HDR:-absent}')"
fi

assert_body_lacks "error pages carry no server signature" "$BASE/nope-does-not-exist-xyz" "Apache/"

TRACE_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X TRACE "$BASE/" 2>/dev/null)"
case "$TRACE_CODE" in
  405|403|501) ok "TRACE is refused (HTTP $TRACE_CODE)" ;;
  *) bad "TRACE is refused" "405/403/501" "$TRACE_CODE" ;;
esac

# A denied path and a missing path must render an identical body, so probing
# for which paths exist tells an attacker nothing from the response itself.
#
# Both sides must be paths Apache actually resolves. An unknown path like
# /definitely-not-here is NOT one: the History API fallback serves the app
# shell for it with a 200, deliberately, so the client router can render "no
# such folder". Comparing against that measured the SPA design, not the error
# pages. The right comparison is a denied file against a missing artifact.
DENIED_BODY="$(body "$BASE/httpd.conf")"
MISSING_BODY="$(body "$BASE/files/SWG/definitely-not-here.iso")"
if [ "$DENIED_BODY" = "$MISSING_BODY" ]; then
  ok "denied (403) and missing (404) render the same page"
else
  bad "denied (403) and missing (404) render the same page" "identical bodies" "different bodies"
fi

# ============================================================================
section "7. The index itself"
# ============================================================================
assert_status "manifest is served"              "$BASE/manifest.json" 200
assert_header_contains "manifest is JSON"       "$BASE/manifest.json" "Content-Type" "application/json"

# The manifest is a cache of the filesystem and is already stale the moment
# storage/ changes. Letting the browser cache it too would stack one staleness
# on another and make the age shown in the footer a lie.
assert_header_contains "manifest is not browser-cached" \
  "$BASE/manifest.json" "Cache-Control" "no-cache"

if body "$BASE/manifest.json" | python3 -m json.tool >/dev/null 2>&1; then
  ok "manifest parses as valid JSON"
else
  bad "manifest parses as valid JSON" "parseable JSON" "a parse error"
fi

# Encoding correctness is what stops a filename containing a quote or a newline
# from taking the whole site down. scripts/test-generate-manifest.sh proves it
# against adversarial fixtures; this confirms the served copy is intact.
if body "$BASE/manifest.json" | python3 -c \
  'import json,sys; m=json.load(sys.stdin); sys.exit(0 if m.get("schemaVersion")==1 and m["root"]["type"]=="dir" else 1)' 2>/dev/null; then
  ok "manifest has the expected schema"
else
  bad "manifest has the expected schema" "schemaVersion 1 with a dir root" "something else"
fi

# ============================================================================
section "8. Compression"
# ============================================================================
gz_ratio() {
  local url="$1"
  local raw gz
  raw="$(curl -s -o /dev/null -w '%{size_download}' "$url" 2>/dev/null)"
  gz="$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$url" 2>/dev/null)"
  printf '%s %s' "$raw" "$gz"
}

for path in /manifest.json /css/style.css /js/app.js; do
  read -r RAW GZ <<<"$(gz_ratio "$BASE$path")"
  if [ "${GZ:-0}" -gt 0 ] && [ "${RAW:-0}" -gt 0 ] && [ "$GZ" -lt "$RAW" ]; then
    ok "$path is gzipped (${RAW}b -> ${GZ}b)"
  else
    bad "$path is gzipped" "a smaller gzipped response" "${RAW}b -> ${GZ}b"
  fi
done

# Already-compressed artifacts must not be re-compressed; that is CPU spent to
# make the payload marginally larger.
read -r RAW GZ <<<"$(gz_ratio "$BASE/files/contrib/contrib-tools-1720000000.tar.gz")"
if [ "${GZ:-0}" -ge "${RAW:-1}" ]; then
  ok "already-compressed artifacts are not re-gzipped"
else
  bad "already-compressed artifacts are not re-gzipped" "no size change" "${RAW}b -> ${GZ}b"
fi

# ============================================================================
section "9. No inline script or style (the CSP must be satisfiable)"
# ============================================================================
# A strict CSP is only meaningful if the page actually complies with it. An
# inline <script> or <style> here would be blocked at runtime and the site
# would break — so this asserts the policy and the page agree.
# HTML comments are stripped first. This page's own comments explain why there
# is no inline script or style, and quoting those tag names made the scan
# report the documentation as a violation. A comment cannot execute, so it is
# not what is being tested.
SHELL_HTML="$(body "$BASE/" | python3 -c \
  'import re,sys; sys.stdout.write(re.sub(r"<!--.*?-->", "", sys.stdin.read(), flags=re.S))')"

if printf '%s' "$SHELL_HTML" | grep -qE '<script[^>]*>[[:space:]]*[^[:space:]<]'; then
  bad "no inline <script> in the shell" "only external scripts" "an inline script block"
else
  ok "no inline <script> in the shell"
fi

if printf '%s' "$SHELL_HTML" | grep -qE '<style[[:space:]>]'; then
  bad "no <style> block in the shell" "only linked stylesheets" "a style block"
else
  ok "no <style> block in the shell"
fi

if printf '%s' "$SHELL_HTML" | grep -qE '[[:space:]]style="'; then
  bad "no inline style attributes" "no style= attributes" "a style attribute"
else
  ok "no inline style attributes"
fi

if printf '%s' "$SHELL_HTML" | grep -qiE '[[:space:]]on(click|load|error|mouseover)='; then
  bad "no inline event handlers" "no on* attributes" "an inline handler"
else
  ok "no inline event handlers"
fi

# ============================================================================
printf "\n"
if [ "$FAIL" -eq 0 ]; then
  printf "${G}${B}%d assertions passed, 0 failed.${N}\n" "$PASS"
  exit 0
else
  printf "${R}${B}%d passed, %d FAILED.${N}\n" "$PASS" "$FAIL"
  printf "${R}Failed:${N}\n"
  for name in "${FAILED_NAMES[@]}"; do printf "  - %s\n" "$name"; done
  exit 1
fi
