/**
 * <breadcrumb-nav> — the path trail above the listing.
 *
 * Owns no state. It is handed a trail (from manifest.breadcrumbTrail) and
 * emits a navigate event when a crumb is clicked; app.js decides what happens.
 *
 * Styles are linked rather than inlined for the same CSP reason as <file-row>:
 * a <style> block inside a shadow root is an inline style, and the policy has
 * no 'unsafe-inline'.
 */

import { browseUrl } from '../manifest.js';

const template = document.createElement('template');
template.innerHTML = `
  <link rel="stylesheet" href="/css/components.css">
  <nav class="crumbs" part="crumbs">
    <ol class="crumb-list"></ol>
  </nav>`;

export class BreadcrumbNav extends HTMLElement {
  #trail = [];
  #root = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.appendChild(template.content.cloneNode(true));
  }

  connectedCallback() {
    this.#root.querySelector('.crumb-list').addEventListener('click', this.#onClick);
    // The nav landmark needs a name, otherwise a screen reader announces an
    // unlabelled navigation region.
    this.#root.querySelector('.crumbs').setAttribute('aria-label', 'Breadcrumb');
  }

  disconnectedCallback() {
    this.#root.querySelector('.crumb-list')?.removeEventListener('click', this.#onClick);
  }

  /**
   * @param {Array<{name: string, path: string}>} value
   */
  set trail(value) {
    this.#trail = Array.isArray(value) ? value : [];
    this.render();
  }

  get trail() { return this.#trail; }

  #onClick = (event) => {
    const link = event.target.closest('a[data-path]');
    if (!link) return;
    // Modified clicks fall through so "open in new tab" works.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    this.dispatchEvent(new CustomEvent('navigate', {
      bubbles: true,
      composed: true,
      detail: { path: link.dataset.path },
    }));
  };

  render() {
    const list = this.#root.querySelector('.crumb-list');
    // Clear by removing children rather than assigning innerHTML = '' so the
    // element never briefly parses a string as markup.
    list.replaceChildren();

    this.#trail.forEach((crumb, index) => {
      const isLast = index === this.#trail.length - 1;
      const li = document.createElement('li');
      li.className = 'crumb';

      if (isLast) {
        // The current location is not a link — linking to where you already
        // are is a dead control, and aria-current announces it properly.
        const span = document.createElement('span');
        span.className = 'crumb-current';
        span.setAttribute('aria-current', 'page');
        span.textContent = crumb.name;   // untrusted: folder names come from disk
        li.appendChild(span);
      } else {
        const a = document.createElement('a');
        a.className = 'crumb-link';
        a.href = browseUrl(crumb.path);
        a.dataset.path = crumb.path;
        a.textContent = crumb.name;      // untrusted: folder names come from disk
        li.appendChild(a);

        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '/';
        li.appendChild(sep);
      }
      list.appendChild(li);
    });
  }
}

customElements.define('breadcrumb-nav', BreadcrumbNav);
