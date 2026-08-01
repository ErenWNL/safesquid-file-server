/**
 * format.js — presentation helpers, shared by the components.
 *
 * These live in one module because two consumers need them: <file-row> formats
 * a file's own size and date, and <directory-listing> formats the aggregate
 * size a folder row shows. Duplicating them would guarantee the two drift.
 *
 * Everything here is a pure function of its arguments. That is deliberate:
 * there is no test runner in this project (no npm, by requirement), so
 * public/tests/ verifies these by calling them directly. Anything that reached
 * for the DOM or the clock would not be testable that way.
 */

const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'];

/**
 * Human-readable byte size: 1536 -> "1.50K", 76546048 -> "73.00M".
 *
 * Matches the shape used by the page this replaces (a number, two decimals, a
 * single-letter unit) rather than inventing a new one, so the output is
 * recognisably the same product.
 *
 * Raw byte counts under 1K are shown as integers — "512B" reads better than
 * "512.00B", and fractional bytes do not exist.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  // Guard the shadow paths explicitly. A manifest entry with a missing or
  // malformed size should render as "-", the same as a folder with no total,
  // rather than as "NaNB" or crashing the row.
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '-';

  let value = Number(bytes);
  if (value < 0) return '-';
  if (value < 1024) return `${Math.round(value)}B`;

  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(2)}${UNITS[unit]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * English ordinal suffix: 1 -> "st", 2 -> "nd", 3 -> "rd", 4 -> "th".
 *
 * The 11/12/13 exception is the part people get wrong: they are "th", not
 * "st"/"nd"/"rd", even though they end in 1/2/3.
 *
 * @param {number} day
 * @returns {string}
 */
export function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Human-readable timestamp: 1655391291 -> "16th Jun 2022 14:54".
 *
 * Rendered in UTC, always. Two reasons:
 *
 *   1. Determinism. Local-time formatting would make the assertion page pass
 *      or fail depending on the machine's timezone, which is exactly the
 *      flaky-test pattern worth avoiding.
 *   2. Honesty. A public download server has a worldwide audience; "14:54"
 *      meaning something different per visitor helps nobody. The full ISO
 *      timestamp goes in a title attribute for anyone who needs precision.
 *
 * @param {number} epochSeconds
 * @returns {string}
 */
export function formatDate(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return '-';
  const n = Number(epochSeconds);
  if (Number.isNaN(n) || n <= 0) return '-';

  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '-';

  const day = d.getUTCDate();
  const pad = (v) => String(v).padStart(2, '0');
  return `${day}${ordinalSuffix(day)} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Full ISO-8601 form for the title attribute, so hovering a date gives the
 * unambiguous value.
 *
 * @param {number} epochSeconds
 * @returns {string}
 */
export function formatDateISO(epochSeconds) {
  const n = Number(epochSeconds);
  if (!n || Number.isNaN(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('.000', '');
}

/**
 * "12 files", "1 file", "empty" — the count shown against a folder row.
 *
 * @param {number} count
 * @returns {string}
 */
export function formatCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n === 0) return 'empty';
  return n === 1 ? '1 file' : `${n} files`;
}

/**
 * How long ago the index was built, for the freshness stamp in the footer.
 *
 * The manifest is a cache of the filesystem and is stale from the moment
 * storage/ changes until the generator runs again. Showing its age is what
 * keeps that staleness visible instead of silent — see the README.
 *
 * @param {number} epochSeconds  when the manifest was generated
 * @param {number} [nowSeconds]  injectable clock, so tests are deterministic
 * @returns {string}
 */
export function formatAge(epochSeconds, nowSeconds) {
  const then = Number(epochSeconds);
  if (!then || Number.isNaN(then)) return 'unknown';

  const now = nowSeconds === undefined ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  const delta = now - then;

  if (delta < 0) return 'just now';           // clock skew; do not say "-3 minutes ago"
  if (delta < 60) return 'just now';
  if (delta < 3600) {
    const m = Math.floor(delta / 60);
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  if (delta < 86400) {
    const h = Math.floor(delta / 3600);
    return h === 1 ? '1 hour ago' : `${h} hours ago`;
  }
  const d = Math.floor(delta / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}
