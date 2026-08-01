/**
 * <file-row> — one entry in a directory listing.
 *
 * WHY THIS IS NOT A <tr>
 *
 * A custom element cannot be a table row. The HTML parser only permits <tr>
 * inside <tbody>, and anything else placed there is hoisted out of the table
 * entirely. The standard escape hatch, a customized built-in
 * (<tr is="file-row">), is not implemented in Safari and never will be. So the
 * listing is built from elements carrying explicit ARIA table roles instead —
 * role="row" on this host, role="cell" on the parts inside. Shadow trees are
 * flattened for accessibility, so a screen reader sees a coherent table.
 *
 * WHY THE STYLES ARE LINKED, NOT INLINE
 *
 * The Content-Security-Policy sets style-src 'self' with no 'unsafe-inline'. A
 * <style> block inside a shadow root is still an inline style as far as CSP is
 * concerned — shadow DOM gets no exemption — so the pattern every Web
 * Components tutorial shows breaks the moment the policy is enabled. Linking a
 * same-origin stylesheet into the shadow root is an ordinary fetch and is
 * allowed. The browser fetches components.css once and serves it from cache to
 * every subsequent row.
 *
 * WHY EVERY VALUE GOES IN VIA textContent
 *
 * Filenames on a file server are untrusted input. A file named
 * `<img src=x onerror=alert(1)>.iso` is stored XSS the instant a name reaches
 * innerHTML. The static skeleton below is a developer-authored constant and is
 * safe to parse as markup; every value derived from the manifest is assigned
 * with textContent, which cannot create an element. The CSP is a second layer,
 * not the fix.
 *
 * This component owns no state. It renders the entry it is given and emits an
 * event when activated; app.js decides what that means.
 */

import { formatSize, formatDate, formatDateISO, formatCount } from '../format.js';
import { downloadUrl, browseUrl, sizeOf } from '../manifest.js';

const FOLDER_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M1.5 3.5a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .7.3l1 1h5.7a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>
  </svg>`;

const FILE_ICON = `
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M3.5 1.5h6l3 3v10a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z"/>
    <path class="icon-fold" d="M9.5 1.5v3h3z"/>
  </svg>`;

// Built once and cloned per instance. The markup here is a constant authored
// in this file — no manifest data reaches it — so parsing it as HTML is safe.
const template = document.createElement('template');
template.innerHTML = `
  <link rel="stylesheet" href="/css/components.css">
  <a class="row" part="row">
    <span class="cell cell--name" role="cell">
      <span class="icon-slot"></span>
      <span class="name"></span>
      <span class="badge" hidden>latest</span>
      <span class="path" hidden></span>
    </span>
    <span class="cell cell--size" role="cell"></span>
    <span class="cell cell--date" role="cell"></span>
  </a>`;

export class FileRow extends HTMLElement {
  static get observedAttributes() { return ['show-path']; }

  #entry = null;
  #root = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.appendChild(template.content.cloneNode(true));
  }

  connectedCallback() {
    // Role goes on the host, so the flattened accessibility tree sees
    // row → cell rather than a bare custom element wrapping cells.
    this.setAttribute('role', 'row');
    this.#root.querySelector('.row').addEventListener('click', this.#onActivate);
  }

  disconnectedCallback() {
    this.#root.querySelector('.row')?.removeEventListener('click', this.#onActivate);
  }

  attributeChangedCallback() {
    if (this.#entry) this.render();
  }

  /**
   * The manifest node this row displays. Setting it re-renders.
   * @param {object} value
   */
  set entry(value) {
    this.#entry = value;
    this.render();
  }

  get entry() { return this.#entry; }

  #onActivate = (event) => {
    const entry = this.#entry;
    if (!entry) return;

    // Files are real links to /files/... — let the browser handle the download
    // so middle-click, ctrl-click and "Save link as" all behave normally.
    // Apache sets Content-Disposition: attachment on the response.
    if (entry.type === 'file') return;

    // Folders navigate within the app, so intercept and let the router decide.
    // Modified clicks still fall through to the browser, which is what a user
    // opening a folder in a new tab expects.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    this.dispatchEvent(new CustomEvent('entry-activate', {
      bubbles: true,
      composed: true,          // cross the shadow boundary so app.js hears it
      detail: { entry },
    }));
  };

  render() {
    const entry = this.#entry;
    if (!entry) return;

    const root = this.#root;
    const link = root.querySelector('.row');
    const isDir = entry.type === 'dir';

    link.href = isDir ? browseUrl(entry.path) : downloadUrl(entry);
    link.classList.toggle('row--dir', isDir);
    link.classList.toggle('row--file', !isDir);

    // Icon markup is a constant from this module, never manifest data.
    root.querySelector('.icon-slot').innerHTML = isDir ? FOLDER_ICON : FILE_ICON;

    // textContent, not innerHTML. This is the line that makes a filename
    // containing markup render as text instead of executing.
    root.querySelector('.name').textContent = entry.name;

    // In search results a row appears out of its folder, so show where it
    // lives. `show-path` is set by <directory-listing> in search mode.
    const pathEl = root.querySelector('.path');
    const showPath = this.hasAttribute('show-path');
    pathEl.hidden = !showPath;
    if (showPath) {
      const parent = String(entry.path || '').split('/').slice(0, -1).join('/');
      pathEl.textContent = parent ? `in ${parent}` : 'in downloads';
    }

    // An unsuffixed name alongside timestamped siblings is the "latest" alias
    // described in the nomenclature doc. Flagging it makes the convention
    // legible instead of something a reader has to reverse-engineer.
    const badge = root.querySelector('.badge');
    badge.hidden = !(entry.type === 'file' && !/-\d{9,}\./.test(entry.name));

    const sizeCell = root.querySelector('.cell--size');
    sizeCell.textContent = isDir
      ? `${formatSize(sizeOf(entry))} · ${formatCount(entry.fileCount)}`
      : formatSize(entry.size);

    const dateCell = root.querySelector('.cell--date');
    dateCell.textContent = formatDate(entry.mtime);
    const iso = formatDateISO(entry.mtime);
    if (iso) dateCell.title = iso;

    // A useful label for assistive tech, and it is set as an attribute value,
    // which is inert.
    link.setAttribute(
      'aria-label',
      `${isDir ? 'Folder' : 'File'} ${entry.name}, ${sizeCell.textContent}, modified ${dateCell.textContent}`,
    );
  }
}

customElements.define('file-row', FileRow);
