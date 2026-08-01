/**
 * <directory-listing> — the sortable table of entries.
 *
 * Owns no state. It receives entries already sorted and filtered by app.js,
 * renders them, and emits events upward. That split was a deliberate decision:
 * when this component held its own sort and filter while app.js held the route,
 * two places owned one view, and the predictable bug is that sorting by size
 * then entering a folder silently resets the sort, or the URL disagrees with
 * the table. One owner means the URL sync in app.js is a single serialize step.
 *
 * Table semantics come from ARIA roles rather than a real <table>, because a
 * custom element cannot be a <tr> — see the note at the top of file-row.js.
 *
 * Rows are built into a DocumentFragment and attached in one operation, so a
 * 500-row render triggers one layout pass instead of five hundred.
 */

import { formatCount, formatSize } from '../format.js';
import { isLatestAlias, SORT_COLUMNS } from '../manifest.js';

// Rendering one DOM node per file is fine for the folder sizes this serves,
// and catastrophic for a folder with fifty thousand entries: the page freezes.
// Capping with a visible, explicit escape hatch means it never freezes and
// nothing is hidden from the user. True windowed virtualization is the
// architecturally complete answer and is recorded in TODOS.md; it brings
// scroll-anchoring and variable-height bugs that are easy to ship broken.
const DEFAULT_CAP = 500;

const template = document.createElement('template');
template.innerHTML = `
  <link rel="stylesheet" href="/css/components.css">
  <div class="listing" part="listing">
    <div class="thead" role="rowgroup">
      <div class="row row--head" role="row"></div>
    </div>
    <div class="tbody" role="rowgroup"></div>
    <div class="notice" hidden></div>
    <p class="state" hidden></p>
  </div>`;

export class DirectoryListing extends HTMLElement {
  #entries = [];
  #sort = { column: 'name', direction: 'asc' };
  #state = 'loading';
  #searchMode = false;
  #showAll = false;
  #root = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.appendChild(template.content.cloneNode(true));
    this.#renderHead();
  }

  connectedCallback() {
    this.#root.querySelector('.listing').setAttribute('role', 'table');
    this.#root.querySelector('.listing').setAttribute('aria-label', 'Directory listing');
    this.#root.querySelector('.row--head').addEventListener('click', this.#onHeadClick);
    this.#root.querySelector('.notice').addEventListener('click', this.#onNoticeClick);
  }

  disconnectedCallback() {
    this.#root.querySelector('.row--head')?.removeEventListener('click', this.#onHeadClick);
    this.#root.querySelector('.notice')?.removeEventListener('click', this.#onNoticeClick);
  }

  set entries(value) {
    this.#entries = Array.isArray(value) ? value : [];
    this.#showAll = false;          // a new listing starts capped again
    this.render();
  }

  get entries() { return this.#entries; }

  /** @param {{column: string, direction: 'asc'|'desc'}} value */
  set sort(value) {
    this.#sort = value || { column: 'name', direction: 'asc' };
    this.#renderHead();
    this.render();
  }

  get sort() { return this.#sort; }

  /** @param {'loading'|'ready'} value */
  set state(value) {
    this.#state = value;
    this.render();
  }

  get state() { return this.#state; }

  /** True when showing search results from across the tree, not one folder. */
  set searchMode(value) {
    this.#searchMode = Boolean(value);
    this.render();
  }

  get searchMode() { return this.#searchMode; }

  #onHeadClick = (event) => {
    const button = event.target.closest('button[data-column]');
    if (!button) return;
    this.dispatchEvent(new CustomEvent('sort-change', {
      bubbles: true,
      composed: true,
      detail: { column: button.dataset.column },
    }));
  };

  #onNoticeClick = (event) => {
    if (!event.target.closest('button[data-action="show-all"]')) return;
    this.#showAll = true;
    this.render();
  };

  /**
   * Column headers, with aria-sort on the active one.
   *
   * aria-sort is what makes a sortable table usable with a screen reader: it
   * announces which column orders the data and in which direction. Without it
   * the sort controls are buttons that appear to do nothing.
   */
  #renderHead() {
    const head = this.#root.querySelector('.row--head');
    head.replaceChildren();

    for (const col of SORT_COLUMNS) {
      const cell = document.createElement('span');
      cell.className = `cell cell--${col.key === 'date' ? 'date' : col.key}`;
      cell.setAttribute('role', 'columnheader');

      const active = this.#sort.column === col.key;
      cell.setAttribute(
        'aria-sort',
        active ? (this.#sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
      );

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.dataset.column = col.key;
      button.textContent = col.label;
      if (active) button.classList.add(`is-${this.#sort.direction}`);

      // The arrow is decorative; aria-sort above carries the real meaning, so
      // announcing the glyph too would be redundant noise.
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = active ? (this.#sort.direction === 'asc' ? '▲' : '▼') : '';
      button.appendChild(arrow);

      cell.appendChild(button);
      head.appendChild(cell);
    }
  }

  render() {
    const root = this.#root;
    const body = root.querySelector('.tbody');
    const notice = root.querySelector('.notice');
    const state = root.querySelector('.state');
    const head = root.querySelector('.thead');

    const setState = (message, hint) => {
      state.replaceChildren();
      const strong = document.createElement('span');
      strong.className = 'state-message';
      strong.textContent = message;
      state.appendChild(strong);
      if (hint) {
        const small = document.createElement('span');
        small.className = 'state-hint';
        small.textContent = hint;
        state.appendChild(small);
      }
      state.hidden = false;
    };

    if (this.#state === 'loading') {
      body.replaceChildren();
      notice.hidden = true;
      head.hidden = true;
      setState('Loading index…');
      // aria-busy tells assistive tech the region is mid-update rather than
      // empty, so it does not announce an empty table then a full one.
      root.querySelector('.listing').setAttribute('aria-busy', 'true');
      return;
    }

    root.querySelector('.listing').removeAttribute('aria-busy');

    if (this.#entries.length === 0) {
      body.replaceChildren();
      notice.hidden = true;
      head.hidden = true;
      if (this.#searchMode) {
        setState('No matches.', 'Nothing in the tree matches that search.');
      } else {
        setState('This folder is empty.', 'No files or subfolders here.');
      }
      return;
    }

    state.hidden = true;
    head.hidden = false;

    const total = this.#entries.length;
    const limit = this.#showAll ? total : Math.min(DEFAULT_CAP, total);
    const visible = this.#entries.slice(0, limit);

    // One fragment, one insertion, one layout pass.
    const fragment = document.createDocumentFragment();
    for (const entry of visible) {
      const row = document.createElement('file-row');
      if (this.#searchMode) row.setAttribute('show-path', '');
      // Whether an entry is a "latest" alias depends on its siblings, which a
      // row cannot see on its own. Decided here, where the full set is known.
      if (isLatestAlias(entry, this.#entries)) row.setAttribute('latest', '');
      row.entry = entry;
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);

    if (limit < total) {
      notice.replaceChildren();
      const text = document.createElement('span');
      text.textContent = `Showing ${limit} of ${total} entries (${formatSize(
        this.#entries.reduce((sum, e) => sum + (Number(e.size) || Number(e.totalSize) || 0), 0),
      )} total).`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-button';
      button.dataset.action = 'show-all';
      button.textContent = `Show all ${total}`;
      notice.append(text, button);
      notice.hidden = false;
    } else {
      notice.hidden = true;
      if (!this.#searchMode && total > 0) {
        notice.replaceChildren();
        const summary = document.createElement('span');
        summary.className = 'summary';
        const dirs = this.#entries.filter((e) => e.type === 'dir').length;
        const files = total - dirs;
        const parts = [];
        // Each part is included only when it is non-zero. Naively joining both
        // produces "8 folders, empty" for a folder that holds only
        // subdirectories, which reads as a contradiction.
        if (dirs) parts.push(`${dirs} ${dirs === 1 ? 'folder' : 'folders'}`);
        if (files) parts.push(formatCount(files));
        summary.textContent = parts.join(', ');
        notice.appendChild(summary);
        notice.hidden = false;
      }
    }
  }
}

customElements.define('directory-listing', DirectoryListing);
