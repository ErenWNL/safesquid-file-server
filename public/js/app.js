/**
 * app.js — bootstrap, state, and History API routing.
 *
 * THE SINGLE OWNER
 *
 * This module owns every piece of view state: which folder is open, which
 * column sorts, in which direction, and what is in the search box. The
 * components render what they are given and emit events back; none of them
 * keeps state of its own.
 *
 * That was a deliberate call. With <directory-listing> holding sort and filter
 * while this module held the route, two places owned one view — and the
 * predictable bug is that sorting by size then opening a folder silently
 * resets the sort, or the URL says one thing while the table shows another.
 * With one owner, syncing state to the URL is a single serialize step and the
 * back button restores everything at once.
 *
 * URL SHAPE
 *
 *   /                          root
 *   /browse/repo/dists/stable  a folder
 *   ?sort=size&dir=desc&q=iso  view state, on any of the above
 *
 * Apache rewrites unknown paths to index.html so deep links work on a cold
 * load — with /files/ explicitly excluded, so a missing artifact 404s instead
 * of quietly returning this page. See httpd.conf.
 */

import './components/file-row.js';
import './components/breadcrumb-nav.js';
import './components/directory-listing.js';

import { formatAge, formatDateISO } from './format.js';
import {
  validateManifest,
  resolvePath,
  breadcrumbTrail,
  flatten,
  filterEntries,
  comparator,
  SORT_KEYS,
} from './manifest.js';

const MANIFEST_URL = '/manifest.json';
const SEARCH_DEBOUNCE_MS = 150;

const el = {
  breadcrumb: document.getElementById('breadcrumb'),
  listing: document.getElementById('directory'),
  search: document.getElementById('search-input'),
  pageState: document.getElementById('page-state'),
  pageStateTitle: document.querySelector('.page-state-title'),
  pageStateBody: document.querySelector('.page-state-body'),
  pageStateAction: document.getElementById('page-state-action'),
  generatedAt: document.getElementById('generated-at'),
};

/** The one place view state lives. */
const state = {
  manifest: null,
  path: '',
  sort: { column: 'name', direction: 'asc' },
  query: '',
  status: 'loading',   // loading | ready | not-found | error
  error: '',
};

// A navigation that lands mid-fetch must not have the older response overwrite
// the newer view. One controller, aborted before each new request.
let inFlight = null;
let searchTimer = null;

/* ------------------------------------------------------------------ routing */

/**
 * Read the current URL into state. The URL is the source of truth on load and
 * on popstate; state is the source of truth in between.
 */
function readLocation() {
  const { pathname, searchParams } = new URL(window.location.href);

  state.path = pathname.startsWith('/browse/')
    ? pathname.slice('/browse/'.length).replace(/\/+$/, '')
    : '';

  const column = searchParams.get('sort');
  const direction = searchParams.get('dir');
  state.sort = {
    // Anything not in the allow-list falls back to the default rather than
    // being trusted. A hand-edited ?sort=__proto__ selects nothing.
    column: SORT_KEYS.has(column) ? column : 'name',
    direction: direction === 'desc' ? 'desc' : 'asc',
  };

  state.query = searchParams.get('q') || '';
  if (el.search.value !== state.query) el.search.value = state.query;
}

/**
 * Serialize state back into a URL.
 * @returns {string}
 */
function currentUrl() {
  const segments = state.path.split('/').filter(Boolean).map(encodeURIComponent);
  const path = segments.length ? `/browse/${segments.join('/')}` : '/';

  const params = new URLSearchParams();
  // Only non-default values go in the URL, so the common case stays clean and
  // a shared link carries only what the sender actually changed.
  if (state.sort.column !== 'name') params.set('sort', state.sort.column);
  if (state.sort.direction !== 'asc') params.set('dir', state.sort.direction);
  if (state.query) params.set('q', state.query);

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * @param {'push'|'replace'} mode
 *
 * Navigation and sorting push, so the back button undoes them. Typing in the
 * search box replaces, because pushing per keystroke would bury the previous
 * page under thirty history entries — the URL still reflects the query and
 * stays shareable, it just is not a separate stop in history.
 */
function syncUrl(mode) {
  const url = currentUrl();
  if (url === window.location.pathname + window.location.search) return;
  if (mode === 'replace') window.history.replaceState({}, '', url);
  else window.history.pushState({}, '', url);
}

/* ------------------------------------------------------------------- render */

function showPageState(title, body, actionLabel, onAction) {
  el.listing.hidden = true;
  el.pageStateTitle.textContent = title;
  el.pageStateBody.textContent = body;

  if (actionLabel) {
    el.pageStateAction.textContent = actionLabel;
    el.pageStateAction.hidden = false;
    el.pageStateAction.onclick = onAction;
  } else {
    el.pageStateAction.hidden = true;
    el.pageStateAction.onclick = null;
  }
  el.pageState.hidden = false;
}

function hidePageState() {
  el.pageState.hidden = true;
  el.listing.hidden = false;
}

function render() {
  if (state.status === 'loading') {
    hidePageState();
    el.listing.state = 'loading';
    return;
  }

  if (state.status === 'error') {
    // Distinct from "empty". A blank listing when the index is unreachable
    // would tell the user the server has no files, which is a lie.
    showPageState(
      'The index could not be loaded',
      state.error || 'The file index is unavailable. It may not have been generated yet.',
      'Try again',
      () => loadManifest(),
    );
    el.breadcrumb.trail = [{ name: 'downloads', path: '' }];
    return;
  }

  const root = state.manifest.root;
  const searching = state.query.trim().length > 0;

  // Search spans the whole tree, not the open folder. The entire manifest is
  // already in memory, so recursive search costs no extra network — and it is
  // the thing mod_autoindex fundamentally cannot do.
  let entries;
  if (searching) {
    entries = filterEntries(flatten(root).filter((e) => e.type === 'file'), state.query);
    el.breadcrumb.trail = [{ name: 'downloads', path: '' }];
  } else {
    const node = resolvePath(root, state.path);
    if (!node || node.type !== 'dir') {
      state.status = 'not-found';
      showPageState(
        'No such folder',
        `Nothing in the index matches "${state.path}".`,
        'Back to the index',
        () => { state.path = ''; state.status = 'ready'; syncUrl('push'); render(); },
      );
      el.breadcrumb.trail = [{ name: 'downloads', path: '' }];
      return;
    }
    entries = node.entries.slice();
    el.breadcrumb.trail = breadcrumbTrail(root, state.path) || [{ name: 'downloads', path: '' }];
  }

  hidePageState();
  entries.sort(comparator(state.sort.column, state.sort.direction));

  el.listing.searchMode = searching;
  el.listing.sort = state.sort;
  el.listing.entries = entries;
  el.listing.state = 'ready';

  document.title = state.path
    ? `${state.path} — SafeSquid downloads`
    : 'SafeSquid downloads';
}

function renderFreshness() {
  const epoch = state.manifest?.generatedAtEpoch;
  if (!epoch) {
    el.generatedAt.textContent = 'unknown';
    return;
  }
  el.generatedAt.textContent = formatAge(epoch);
  el.generatedAt.dateTime = formatDateISO(epoch);
  el.generatedAt.title = formatDateISO(epoch);
}

/* --------------------------------------------------------------- data load */

async function loadManifest() {
  if (inFlight) inFlight.abort();
  // Held in a local as well, so the finally block can tell whether the
  // controller it is about to clear is still the current one.
  const controller = new AbortController();
  inFlight = controller;

  state.status = 'loading';
  render();

  try {
    const response = await fetch(MANIFEST_URL, {
      signal: controller.signal,
      // The manifest is already Cache-Control: no-cache from Apache; asking
      // again here means a hard reload genuinely re-reads it.
      cache: 'no-cache',
    });

    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'The index has not been generated yet. Run `make manifest`.'
          : `The server returned HTTP ${response.status}.`,
      );
    }

    // A truncated or malformed body throws SyntaxError here. Without this
    // catch it surfaces as an unhandled rejection and a permanently blank
    // page — the exact silent failure the error state exists for.
    const data = await response.json();
    state.manifest = validateManifest(data);
    state.status = 'ready';
    renderFreshness();
    render();
  } catch (error) {
    // An abort is a newer navigation superseding this one, not a failure.
    if (error.name === 'AbortError') return;

    state.status = 'error';
    state.error = error instanceof SyntaxError
      ? 'The index is present but could not be parsed. It may have been written while it was being read.'
      : error.message;
    render();
  } finally {
    // Only clear if this call is still the current one. Without the guard, a
    // superseded request's finally runs after the newer request has already
    // stored its controller, wipes it, and the next navigation then has
    // nothing to abort.
    if (inFlight === controller) inFlight = null;
  }
}

/* ------------------------------------------------------------------ events */

el.breadcrumb.addEventListener('navigate', (event) => {
  state.path = event.detail.path;
  state.query = '';
  el.search.value = '';
  state.status = 'ready';
  syncUrl('push');
  render();
  window.scrollTo({ top: 0 });
});

document.addEventListener('entry-activate', (event) => {
  const { entry } = event.detail;
  if (entry.type !== 'dir') return;    // files are plain links; the browser has them
  state.path = entry.path;
  state.query = '';
  el.search.value = '';
  state.status = 'ready';
  syncUrl('push');
  render();
  window.scrollTo({ top: 0 });
});

el.listing.addEventListener('sort-change', (event) => {
  const { column } = event.detail;
  if (!SORT_KEYS.has(column)) return;

  state.sort = state.sort.column === column
    // Same column toggles direction.
    ? { column, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' }
    // A new column starts ascending for names, descending for size and date —
    // newest and biggest first is what people actually want from those two.
    : { column, direction: column === 'name' ? 'asc' : 'desc' };

  syncUrl('push');
  render();
});

el.search.addEventListener('input', () => {
  // Debounced: without this, every keystroke walks and re-sorts the whole tree
  // and rewrites the URL.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value;
    state.status = 'ready';
    syncUrl('replace');
    render();
  }, SEARCH_DEBOUNCE_MS);
});

// Escape clears the search from anywhere, which is the one keyboard
// affordance worth having when the search spans the whole tree.
el.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  el.search.value = '';
  state.query = '';
  syncUrl('replace');
  render();
});

document.querySelector('.masthead-title a')?.addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  state.path = '';
  state.query = '';
  el.search.value = '';
  state.status = 'ready';
  syncUrl('push');
  render();
});

window.addEventListener('popstate', () => {
  readLocation();
  if (state.status !== 'error') state.status = 'ready';
  render();
});

/* -------------------------------------------------------------- initialise */

readLocation();
loadManifest();

// Refresh the "generated N minutes ago" label without re-fetching, so a tab
// left open does not keep claiming the index is fresh.
setInterval(() => { if (state.manifest) renderFreshness(); }, 60_000);
