/**
 * manifest.js — reading and querying the generated index.
 *
 * This module is the client-time layer of the path-traversal defense. The
 * important property is negative: nothing here ever builds a filesystem path,
 * and nothing here concatenates a user-supplied string into a URL that reaches
 * the server. `resolvePath` walks the manifest tree node by node, matching each
 * segment against the names actually present. A segment that is not there
 * yields null and the app renders "not found" — it never produces a request
 * that probes the filesystem.
 *
 * Everything is a pure function of its arguments so public/tests/ can verify it
 * without a DOM or a network.
 */

/**
 * Parse and structurally validate a manifest payload.
 *
 * Rejects anything that is not the shape we expect, loudly. A manifest that is
 * present but malformed is more dangerous than one that is missing: the app
 * would render a confidently empty listing rather than an error.
 *
 * @param {unknown} data  parsed JSON
 * @returns {{schemaVersion: number, generatedAt: string, generatedAtEpoch: number, root: object}}
 * @throws {Error} if the payload is not a manifest this build understands
 */
export function validateManifest(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('manifest is not an object');
  }
  if (data.schemaVersion !== 1) {
    // Refusing an unknown version beats silently misreading it. This is the
    // reason generate-manifest.sh stamps a version at all.
    throw new Error(`unsupported manifest schemaVersion: ${data.schemaVersion}`);
  }
  if (!data.root || data.root.type !== 'dir' || !Array.isArray(data.root.entries)) {
    throw new Error('manifest root is missing or not a directory node');
  }
  return data;
}

/**
 * Split a URL path into clean segments.
 *
 * Empty segments (from "//" or a trailing slash) are dropped. "." and ".." are
 * dropped rather than resolved: this function has no notion of a parent, so
 * there is nothing for ".." to escape from. A path of "../../etc/passwd"
 * becomes ["etc", "passwd"], which then simply fails to match any node.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function pathSegments(path) {
  if (!path || typeof path !== 'string') return [];
  return path
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        // A malformed escape sequence ("%zz") throws. Treat it as literal text
        // rather than letting it take down the router.
        return s;
      }
    })
    .filter((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Walk the tree to the node a path names.
 *
 * @param {object} root      the manifest root node
 * @param {string} path      e.g. "repo/dists/stable"
 * @returns {object|null}    the directory or file node, or null if absent
 */
export function resolvePath(root, path) {
  if (!root) return null;
  let node = root;

  for (const segment of pathSegments(path)) {
    if (node.type !== 'dir' || !Array.isArray(node.entries)) return null;
    // Exact name match against what is actually in the tree. No string
    // building, no normalisation that could be tricked — a name either exists
    // among the children or it does not.
    const next = node.entries.find((e) => e.name === segment);
    if (!next) return null;
    node = next;
  }
  return node;
}

/**
 * The chain of nodes from root to the given path, for the breadcrumb.
 *
 * @param {object} root
 * @param {string} path
 * @returns {Array<{name: string, path: string}>|null}
 */
export function breadcrumbTrail(root, path) {
  const trail = [{ name: 'downloads', path: '' }];
  let node = root;
  let acc = [];

  for (const segment of pathSegments(path)) {
    if (!node || node.type !== 'dir') return null;
    const next = node.entries.find((e) => e.name === segment);
    if (!next) return null;
    acc.push(next.name);
    trail.push({ name: next.name, path: acc.join('/') });
    node = next;
  }
  return trail;
}

/**
 * Every file in the tree, flattened, for recursive search.
 *
 * The whole manifest is already in memory, so searching the entire tree costs
 * no more network than searching one folder. This is the capability
 * mod_autoindex fundamentally cannot offer.
 *
 * @param {object} node
 * @param {Array} [acc]
 * @returns {Array<object>}
 */
export function flatten(node, acc = []) {
  if (!node || !Array.isArray(node.entries)) return acc;
  for (const entry of node.entries) {
    acc.push(entry);
    if (entry.type === 'dir') flatten(entry, acc);
  }
  return acc;
}

/**
 * Case-insensitive substring filter.
 *
 * Deliberately NOT a regular expression. `new RegExp(query)` throws the moment
 * someone types "(" or "[", which on a search-as-you-type box means the
 * listing dies mid-keystroke. Substring matching cannot throw on any input,
 * so every character a user can type is safe by construction.
 *
 * @param {Array<object>} entries
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterEntries(entries, query) {
  if (!query) return entries;
  const needle = String(query).toLowerCase().trim();
  if (!needle) return entries;
  return entries.filter((e) => {
    const name = String(e.name || '').toLowerCase();
    const path = String(e.path || '').toLowerCase();
    return name.includes(needle) || path.includes(needle);
  });
}

/**
 * The sortable columns, in display order.
 *
 * Single source of truth. app.js validates ?sort= against this and
 * <directory-listing> renders one header per entry; when the two kept separate
 * lists, adding a column meant editing both and forgetting one made the header
 * clickable but the URL parameter silently ignored.
 *
 * @type {ReadonlyArray<{key: string, label: string}>}
 */
export const SORT_COLUMNS = Object.freeze([
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
  { key: 'date', label: 'Last modified' },
]);

/** @type {ReadonlySet<string>} */
export const SORT_KEYS = new Set(SORT_COLUMNS.map((c) => c.key));

/**
 * Sort comparator factory.
 *
 * Folders always sort above files regardless of column or direction. That is
 * how every file browser behaves, and inverting it on a descending sort would
 * scatter directories through the listing.
 *
 * @param {'name'|'size'|'date'} column
 * @param {'asc'|'desc'} direction
 * @returns {(a: object, b: object) => number}
 */
export function comparator(column, direction) {
  const dir = direction === 'desc' ? -1 : 1;

  return (a, b) => {
    // Group first, then sort within the group.
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;

    let result;
    switch (column) {
      case 'size':
        // A folder's sortable size is its recursive total; a file's is its own.
        result = sizeOf(a) - sizeOf(b);
        break;
      case 'date':
        result = (a.mtime || 0) - (b.mtime || 0);
        break;
      case 'name':
      default:
        // localeCompare with numeric collation so "swg-9" sorts before
        // "swg-10", which plain string comparison gets backwards.
        result = String(a.name).localeCompare(String(b.name), undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        break;
    }

    // Stable tie-break by name, so an equal-size or equal-date pair does not
    // reorder between renders.
    if (result === 0 && column !== 'name') {
      result = String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
    }
    return result * dir;
  };
}

/**
 * Sortable size for an entry: recursive total for a folder, own size for a file.
 * @param {object} entry
 * @returns {number}
 */
export function sizeOf(entry) {
  if (!entry) return 0;
  if (entry.type === 'dir') return Number(entry.totalSize) || 0;
  return Number(entry.size) || 0;
}

// Compound extensions have to be recognised as a unit, otherwise the last dot
// splits "vpn.tar.gz" into base "vpn.tar" and the family match fails.
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.xz', '.tar.bz2', '.tar.zst'];

/**
 * Split a filename into base and extension, compound extensions included.
 * @param {string} name
 * @returns {{base: string, ext: string}}
 */
export function splitName(name) {
  const lower = String(name).toLowerCase();
  for (const ext of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return { base: String(name).slice(0, -ext.length), ext: String(name).slice(-ext.length) };
    }
  }
  const dot = String(name).lastIndexOf('.');
  if (dot <= 0) return { base: String(name), ext: '' };
  return { base: String(name).slice(0, dot), ext: String(name).slice(dot) };
}

/**
 * Is this the unsuffixed "latest" alias of a timestamped artifact family?
 *
 * The nomenclature is {component}-{os-version}-{variant}-{unix-timestamp}.{ext}
 * with an unsuffixed alias alongside — aggregator.iso beside
 * aggregator-22.04-mini-1718548800.iso.
 *
 * "Has no timestamp in its name" is NOT sufficient on its own: by that test
 * CHANGELOG.md and README.txt are aliases too. An alias is only meaningful
 * relative to a family, so this requires an actual timestamped sibling sharing
 * the same base and extension.
 *
 * @param {object} entry
 * @param {Array<object>} siblings  entries in the same directory
 * @returns {boolean}
 */
export function isLatestAlias(entry, siblings) {
  if (!entry || entry.type !== 'file' || !Array.isArray(siblings)) return false;
  return latestAliasSet(siblings).has(entry.name);
}

/**
 * Every name in `entries` that is a latest alias, computed in one pass.
 *
 * The per-entry form above rescans the whole sibling list for each entry it is
 * asked about, which is O(n*m): rendering 500 rows of a 12,000-entry folder ran
 * six million string splits. This builds the family index once instead.
 *
 * The result is cached against the array identity, so a component calling
 * isLatestAlias in a render loop pays for the scan once per listing rather than
 * once per row.
 *
 * @param {Array<object>} entries
 * @returns {Set<string>}
 */
const aliasCache = new WeakMap();

export function latestAliasSet(entries) {
  if (!Array.isArray(entries)) return new Set();
  const cached = aliasCache.get(entries);
  if (cached) return cached;

  // One pass to collect the families that actually have a timestamped member.
  //
  // A timestamped file registers every hyphen-prefix of its base, not only the
  // whole base. aggregator-18.04-mini-1655391291.iso registers "aggregator",
  // "aggregator-18.04" and "aggregator-18.04-mini", because the alias it
  // belongs to is named aggregator.iso and matches only the first of those.
  // Keying on the full base alone finds no family and misses every alias - the
  // bug this rewrite introduced on its first attempt, caught by /tests/. Bases
  // have a handful of segments, so this stays effectively linear.
  const families = new Set();
  for (const e of entries) {
    if (e.type !== 'file') continue;
    const { base, ext } = splitName(e.name);
    if (!ext) continue;
    const match = /^(.*)-\d{9,}$/.exec(base);
    if (!match || !match[1]) continue;

    const segments = match[1].split('-');
    for (let i = 1; i <= segments.length; i++) {
      families.add(`${segments.slice(0, i).join('-')} ${ext}`);
    }
  }

  // Second pass: an unsuffixed file whose family exists is the alias.
  const aliases = new Set();
  for (const e of entries) {
    if (e.type !== 'file') continue;
    const { base, ext } = splitName(e.name);
    if (!ext || /-\d{9,}$/.test(base)) continue;
    if (families.has(`${base} ${ext}`)) aliases.add(e.name);
  }

  aliasCache.set(entries, aliases);
  return aliases;
}

/**
 * Build the download URL for a file node.
 *
 * Each path segment is encoded individually, so a filename containing "#",
 * "?", "&" or a space produces a URL that means what it says. Encoding the
 * whole path in one call would mangle the separators.
 *
 * @param {object} entry
 * @returns {string}
 */
export function downloadUrl(entry) {
  const segments = String(entry.path || '').split('/').filter(Boolean);
  return '/files/' + segments.map(encodeURIComponent).join('/');
}

/**
 * Build the in-app browse URL for a directory node.
 * @param {string} path
 * @returns {string}
 */
export function browseUrl(path) {
  const segments = String(path || '').split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  return '/browse/' + segments.map(encodeURIComponent).join('/');
}
