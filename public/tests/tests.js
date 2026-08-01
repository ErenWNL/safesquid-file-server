/**
 * tests.js — assertions for the client-side pure functions and components.
 *
 * Dependency-free. Imports the same modules the site imports, so nothing here
 * can pass against code the site does not actually use.
 */

import {
  formatSize, formatDate, formatDateISO, formatCount, formatAge, ordinalSuffix,
} from '../js/format.js';

import {
  validateManifest, pathSegments, resolvePath, breadcrumbTrail, flatten,
  filterEntries, comparator, sizeOf, downloadUrl, browseUrl, splitName,
  isLatestAlias,
} from '../js/manifest.js';

import '../js/components/file-row.js';

let pass = 0;
let fail = 0;
let currentGroup = null;
const results = document.getElementById('results');

function group(name) {
  currentGroup = document.createElement('section');
  currentGroup.className = 'group';
  const h = document.createElement('h2');
  h.textContent = name;
  currentGroup.appendChild(h);
  results.appendChild(currentGroup);
}

function record(okay, label, detail) {
  const line = document.createElement('div');
  line.className = `case ${okay ? 'case--pass' : 'case--fail'}`;

  const badge = document.createElement('span');
  badge.className = 'case-badge';
  badge.textContent = okay ? 'PASS' : 'FAIL';

  const text = document.createElement('span');
  text.className = 'case-label';
  text.textContent = label;

  line.append(badge, text);

  if (!okay && detail) {
    const d = document.createElement('div');
    d.className = 'case-detail';
    d.textContent = detail;
    line.appendChild(d);
  }
  currentGroup.appendChild(line);
  okay ? pass++ : fail++;
}

const eq = (actual, expected, label) =>
  record(
    Object.is(actual, expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const deepEq = (actual, expected, label) =>
  record(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const isTrue = (value, label) => record(value === true, label, `expected true, got ${JSON.stringify(value)}`);
const isFalse = (value, label) => record(value === false, label, `expected false, got ${JSON.stringify(value)}`);

function throws(fn, label) {
  try { fn(); record(false, label, 'expected a throw, but it returned'); }
  catch { record(true, label); }
}

function doesNotThrow(fn, label) {
  try { fn(); record(true, label); }
  catch (e) { record(false, label, `threw ${e}`); }
}

/* =================================================================== sizes */

group('formatSize');
eq(formatSize(76546048), '73.00M', 'the size from the brief renders as 73.00M');
eq(formatSize(0), '0B', 'zero bytes');
eq(formatSize(1), '1B', 'one byte');
eq(formatSize(1023), '1023B', 'just under 1K stays in bytes');
eq(formatSize(1024), '1.00K', 'exactly 1K');
eq(formatSize(1536), '1.50K', 'one and a half K');
eq(formatSize(1048576), '1.00M', 'exactly 1M');
eq(formatSize(1073741824), '1.00G', 'exactly 1G');
eq(formatSize(1099511627776), '1.00T', 'exactly 1T');
// Fixture files are small, so the large magnitudes are only ever exercised
// here. That is the reason to test them rather than rely on the demo data.
eq(formatSize(1125899906842624), '1.00P', 'a petabyte, well beyond any fixture');
eq(formatSize(null), '-', 'null size');
eq(formatSize(undefined), '-', 'undefined size');
eq(formatSize(-5), '-', 'a negative size is not rendered as a size');
eq(formatSize('not a number'), '-', 'a non-numeric size');

/* =================================================================== dates */

group('formatDate and ordinals');
eq(formatDate(1655391291), '16th Jun 2022 14:54', 'the timestamp from the brief');
eq(formatDate(0), '-', 'epoch zero is treated as absent, not 1970');
eq(formatDate(null), '-', 'null date');
eq(formatDate('nonsense'), '-', 'a non-numeric date');
eq(formatDate(1700000000), '14th Nov 2023 22:13', 'a known UTC instant');
eq(formatDateISO(1655391291), '2022-06-16T14:54:51Z', 'ISO form for the title attribute');

eq(ordinalSuffix(1), 'st', '1st');
eq(ordinalSuffix(2), 'nd', '2nd');
eq(ordinalSuffix(3), 'rd', '3rd');
eq(ordinalSuffix(4), 'th', '4th');
// The exception people get wrong: these end in 1/2/3 but take "th".
eq(ordinalSuffix(11), 'th', '11th, not 11st');
eq(ordinalSuffix(12), 'th', '12th, not 12nd');
eq(ordinalSuffix(13), 'th', '13th, not 13rd');
eq(ordinalSuffix(21), 'st', '21st');
eq(ordinalSuffix(22), 'nd', '22nd');
eq(ordinalSuffix(23), 'rd', '23rd');
eq(ordinalSuffix(31), 'st', '31st');

group('formatCount and formatAge');
eq(formatCount(0), 'empty', 'zero files');
eq(formatCount(1), '1 file', 'one file is singular');
eq(formatCount(12), '12 files', 'many files');
eq(formatAge(1000, 1030), 'just now', 'under a minute');
eq(formatAge(1000, 1120), '2 minutes ago', 'minutes');
eq(formatAge(1000, 4700), '1 hour ago', 'one hour is singular');
eq(formatAge(1000, 90000), '1 day ago', 'a day');
// A clock skewed backwards must not produce "-3 minutes ago".
eq(formatAge(2000, 1000), 'just now', 'a future timestamp does not go negative');

/* ================================================================ traversal */

group('pathSegments — traversal cannot survive parsing');
deepEq(pathSegments('repo/dists/stable'), ['repo', 'dists', 'stable'], 'a normal path');
deepEq(pathSegments('/repo//dists/'), ['repo', 'dists'], 'empty segments are dropped');
deepEq(pathSegments('../../etc/passwd'), ['etc', 'passwd'], 'dot-dot is dropped, not resolved');
deepEq(pathSegments('a/../../../b'), ['a', 'b'], 'dot-dot cannot climb out');
deepEq(pathSegments('./a/./b'), ['a', 'b'], 'single dots are dropped');
deepEq(pathSegments(''), [], 'the empty path');
deepEq(pathSegments(null), [], 'a null path');
deepEq(pathSegments('%2e%2e/x'), ['x'], 'percent-encoded dot-dot is decoded then dropped');
doesNotThrow(() => pathSegments('%zz/bad'), 'a malformed escape does not throw');

/* ================================================================= manifest */

const tree = {
  name: '', type: 'dir', path: '', mtime: 100, fileCount: 4, totalSize: 610,
  entries: [
    {
      name: 'repo', type: 'dir', path: 'repo', mtime: 90, fileCount: 2, totalSize: 300,
      entries: [
        {
          name: 'pool', type: 'dir', path: 'repo/pool', mtime: 80, fileCount: 2, totalSize: 300,
          entries: [
            { name: 'a-1700000000.deb', type: 'file', path: 'repo/pool/a-1700000000.deb', size: 100, mtime: 70 },
            { name: 'b.deb', type: 'file', path: 'repo/pool/b.deb', size: 200, mtime: 60 },
          ],
        },
      ],
    },
    { name: 'empty', type: 'dir', path: 'empty', mtime: 50, fileCount: 0, totalSize: 0, entries: [] },
    { name: 'zeta.iso', type: 'file', path: 'zeta.iso', size: 10, mtime: 40 },
    { name: 'alpha.iso', type: 'file', path: 'alpha.iso', size: 300, mtime: 30 },
  ],
};

group('validateManifest');
doesNotThrow(() => validateManifest({ schemaVersion: 1, root: tree }), 'a valid manifest');
throws(() => validateManifest(null), 'null is rejected');
throws(() => validateManifest({}), 'a manifest with no version is rejected');
// Refusing an unknown version beats silently misreading it — the reason the
// generator stamps a version at all.
throws(() => validateManifest({ schemaVersion: 2, root: tree }), 'a future schema version is rejected');
throws(() => validateManifest({ schemaVersion: 1 }), 'a manifest with no root is rejected');
throws(() => validateManifest({ schemaVersion: 1, root: { type: 'file' } }), 'a non-directory root is rejected');

group('resolvePath');
eq(resolvePath(tree, '')?.path, '', 'the empty path resolves to the root');
eq(resolvePath(tree, 'repo')?.name, 'repo', 'a top-level folder');
eq(resolvePath(tree, 'repo/pool')?.name, 'pool', 'a nested folder');
eq(resolvePath(tree, 'repo/pool/b.deb')?.name, 'b.deb', 'a file');
eq(resolvePath(tree, 'nope'), null, 'an unknown segment returns null');
eq(resolvePath(tree, 'repo/nope/deeper'), null, 'an unknown mid-path segment returns null');
eq(resolvePath(tree, '../../etc/passwd'), null, 'a traversal attempt resolves to nothing');
eq(resolvePath(tree, 'zeta.iso/child'), null, 'you cannot descend into a file');

group('breadcrumbTrail');
deepEq(breadcrumbTrail(tree, 'repo/pool'),
  [{ name: 'downloads', path: '' }, { name: 'repo', path: 'repo' }, { name: 'pool', path: 'repo/pool' }],
  'a two-level trail');
deepEq(breadcrumbTrail(tree, ''), [{ name: 'downloads', path: '' }], 'the root trail');
eq(breadcrumbTrail(tree, 'nope'), null, 'an unknown path has no trail');

group('flatten and filterEntries');
// 3 directories (repo, repo/pool, empty) + 4 files.
eq(flatten(tree).length, 7, 'every node in the tree');
eq(flatten(tree).filter((e) => e.type === 'file').length, 4, 'every file in the tree');
eq(filterEntries(flatten(tree), 'deb').length, 2, 'a substring match across folders');
eq(filterEntries(flatten(tree), 'DEB').length, 2, 'matching is case-insensitive');
eq(filterEntries(flatten(tree), 'repo/pool').length, 3, 'the path is searchable too');
eq(filterEntries(flatten(tree), '').length, 7, 'an empty query filters nothing');

// The reason filterEntries uses substring matching and not a RegExp: these
// inputs all throw inside new RegExp(), which on a search-as-you-type box
// would kill the listing mid-keystroke.
doesNotThrow(() => filterEntries(flatten(tree), '('), 'an unbalanced paren does not throw');
doesNotThrow(() => filterEntries(flatten(tree), '[a-z'), 'an unclosed character class does not throw');
doesNotThrow(() => filterEntries(flatten(tree), '*'), 'a bare quantifier does not throw');
doesNotThrow(() => filterEntries(flatten(tree), '\\'), 'a trailing backslash does not throw');
doesNotThrow(() => filterEntries(flatten(tree), '+?{'), 'assorted metacharacters do not throw');

group('comparator');
const rootEntries = () => tree.entries.slice();

const namesBy = (col, dir) => rootEntries().sort(comparator(col, dir)).map((e) => e.name);
deepEq(namesBy('name', 'asc'), ['empty', 'repo', 'alpha.iso', 'zeta.iso'], 'name ascending, folders first');
deepEq(namesBy('name', 'desc'), ['repo', 'empty', 'zeta.iso', 'alpha.iso'], 'name descending keeps folders first');
deepEq(namesBy('size', 'asc'), ['empty', 'repo', 'zeta.iso', 'alpha.iso'], 'size ascending');
deepEq(namesBy('size', 'desc'), ['repo', 'empty', 'alpha.iso', 'zeta.iso'], 'size descending');
deepEq(namesBy('date', 'desc'), ['repo', 'empty', 'zeta.iso', 'alpha.iso'], 'date descending');

// Numeric collation: plain string comparison puts "x-10" before "x-9".
const numeric = [{ name: 'x-10.iso', type: 'file' }, { name: 'x-9.iso', type: 'file' }]
  .sort(comparator('name', 'asc')).map((e) => e.name);
deepEq(numeric, ['x-9.iso', 'x-10.iso'], 'x-9 sorts before x-10, not after');

eq(sizeOf({ type: 'dir', totalSize: 42 }), 42, 'a folder sorts by its recursive total');
eq(sizeOf({ type: 'file', size: 7 }), 7, 'a file sorts by its own size');
eq(sizeOf(null), 0, 'a null entry has no size');

group('URL building');
eq(downloadUrl({ path: 'SWG/swg.iso' }), '/files/SWG/swg.iso', 'a plain download URL');
eq(downloadUrl({ path: 'a b/c#d.iso' }), '/files/a%20b/c%23d.iso',
  'spaces and hashes are encoded, separators are not');
eq(downloadUrl({ path: 'x/y&z?q.iso' }), '/files/x/y%26z%3Fq.iso', 'ampersands and question marks are encoded');
eq(browseUrl(''), '/', 'the root browse URL');
eq(browseUrl('repo/dists'), '/browse/repo/dists', 'a nested browse URL');

group('splitName');
deepEq(splitName('aggregator.iso'), { base: 'aggregator', ext: '.iso' }, 'a simple extension');
// Splitting on the last dot would give base "vpn.tar", which matches no
// sibling and made the alias undetectable.
deepEq(splitName('vpn.tar.gz'), { base: 'vpn', ext: '.tar.gz' }, 'a compound extension stays whole');
deepEq(splitName('x.tar.xz'), { base: 'x', ext: '.tar.xz' }, 'tar.xz is compound too');
deepEq(splitName('README'), { base: 'README', ext: '' }, 'no extension at all');

group('isLatestAlias — needs a family, not just a missing timestamp');
const family = [
  { name: 'aggregator-18.04-mini-1655391291.iso', type: 'file' },
  { name: 'aggregator-22.04-mini-1718548800.iso', type: 'file' },
  { name: 'aggregator.iso', type: 'file' },
  { name: 'vpn-client-linux-1715000000.tar.gz', type: 'file' },
  { name: 'vpn.tar.gz', type: 'file' },
  { name: 'CHANGELOG.md', type: 'file' },
  { name: 'README.txt', type: 'file' },
  { name: 'somedir', type: 'dir' },
];
const named = (n) => family.find((e) => e.name === n);

isTrue(isLatestAlias(named('aggregator.iso'), family),
  'aggregator.iso is the alias of the timestamped aggregator family');
isTrue(isLatestAlias(named('vpn.tar.gz'), family),
  'vpn.tar.gz is an alias despite the compound extension');

// The bug this function was rewritten to fix: "has no timestamp" alone flagged
// every ordinary text file in the folder as a release alias.
isFalse(isLatestAlias(named('CHANGELOG.md'), family),
  'CHANGELOG.md is not an alias — it has no timestamped family');
isFalse(isLatestAlias(named('README.txt'), family),
  'README.txt is not an alias');
isFalse(isLatestAlias(named('aggregator-18.04-mini-1655391291.iso'), family),
  'a timestamped member is not itself the alias');
isFalse(isLatestAlias(named('somedir'), family), 'a directory is never an alias');
isFalse(isLatestAlias(named('aggregator.iso'), []), 'with no siblings there is no family');

/* ============================================================ DOM behaviour */

group('file-row renders untrusted filenames as text');

// The canonical vulnerability of a file-listing UI. Filenames on a file server
// are attacker-influenced input; if any of these reach innerHTML, the name is
// stored XSS. The CSP is a second layer — this asserts the first one.
const XSS_NAMES = [
  '<img src=x onerror=alert(1)>.iso',
  '<script>alert(1)</script>.iso',
  '"><svg onload=alert(1)>.iso',
  "';alert(1);//.iso",
  '<iframe src=javascript:alert(1)>.iso',
];

const host = document.createElement('div');
host.style.display = 'none';
document.body.appendChild(host);

for (const name of XSS_NAMES) {
  const row = document.createElement('file-row');
  host.appendChild(row);
  row.entry = { name, type: 'file', path: `x/${name}`, size: 10, mtime: 1655391291 };

  const shadow = row.shadowRoot;
  const rendered = shadow.querySelector('.name').textContent;

  record(rendered === name, `renders literally: ${name.slice(0, 28)}…`,
    `expected the raw name as text, got ${JSON.stringify(rendered)}`);

  // The decisive check. If the name were parsed as markup, these elements
  // would exist in the shadow tree.
  const injected = shadow.querySelectorAll('script, img, svg:not(.icon), iframe, object, embed');
  record(injected.length === 0,
    `no elements injected by: ${name.slice(0, 28)}…`,
    `found ${injected.length} injected element(s): ${[...injected].map((e) => e.tagName).join(', ')}`);
}

// A crafted name must not escape the URL's path structure either.
const tricky = document.createElement('file-row');
host.appendChild(tricky);
tricky.entry = { name: 'a"b.iso', type: 'file', path: 'dir/a"b.iso', size: 1, mtime: 1 };
const href = tricky.shadowRoot.querySelector('.row').getAttribute('href');
record(href === '/files/dir/a%22b.iso', 'a quote in a filename is percent-encoded in the href',
  `got ${href}`);

group('file-row accessibility and structure');
const plain = document.createElement('file-row');
host.appendChild(plain);
plain.entry = { name: 'swg.iso', type: 'file', path: 'SWG/swg.iso', size: 76546048, mtime: 1655391291 };
eq(plain.getAttribute('role'), 'row', 'the host carries role=row');
eq(plain.shadowRoot.querySelectorAll('[role="cell"]').length, 3, 'three cells per row');
eq(plain.shadowRoot.querySelector('.cell--size').textContent, '73.00M', 'the size cell is formatted');
eq(plain.shadowRoot.querySelector('.cell--date').textContent, '16th Jun 2022 14:54', 'the date cell is formatted');
isTrue(plain.shadowRoot.querySelector('.row').getAttribute('aria-label').includes('File swg.iso'),
  'the row has a descriptive aria-label');

const folder = document.createElement('file-row');
host.appendChild(folder);
folder.entry = { name: 'SWG', type: 'dir', path: 'SWG', totalSize: 1024, fileCount: 4, mtime: 1655391291, entries: [] };
eq(folder.shadowRoot.querySelector('.row').getAttribute('href'), '/browse/SWG', 'a folder links to a browse URL');
isTrue(folder.shadowRoot.querySelector('.cell--size').textContent.includes('4 files'),
  'a folder row shows its recursive file count');

host.remove();

/* ==================================================================== tally */

const tally = document.getElementById('tally');
tally.textContent = fail === 0
  ? `${pass} passed, 0 failed`
  : `${pass} passed, ${fail} FAILED`;
tally.className = `tally ${fail === 0 ? 'tally--pass' : 'tally--fail'}`;
document.title = `${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} — tests`;

// Exposed so the headless driver in the QA step can read the outcome without
// scraping the page.
window.__testResults = { pass, fail };

