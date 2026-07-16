// server/tests/segmentMatch.test.js
//
// Unit tests for the pure span→segment matcher at public/segmentMatch.js —
// the module is shared: the browser imports it from app.js (ES module, no
// bundler) and node tests import it here via relative path.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeForMatch, matchSpanToSegments } from '../../public/segmentMatch.js';

const SEGMENTS = [
  { content: 'בוקר טוב, עומר. אנחנו בביקור של הבוקר.', startMs: 140, endMs: 5000 },
  { content: 'לחץ הדם התייצב על 120-80, דופק 76 ואין חום.', startMs: 5000, endMs: 12000 },
  { content: 'המדידה האחרונה הייתה 36.8.', startMs: 12200, endMs: 15000 },
  { content: 'תנו לו אופטלגין נוזלי שש שעות ואוקסיקודון 5 מיליגרם לפי הצורך.', startMs: 15200, endMs: 22000 },
];

test('normalizeForMatch collapses whitespace only', () => {
  assert.equal(normalizeForMatch('  לחץ   הדם\n התייצב '), 'לחץ הדם התייצב');
  assert.equal(normalizeForMatch(null), '');
});

test('tier 1: exact substring within one segment', () => {
  const m = matchSpanToSegments(SEGMENTS, 'דופק 76');
  assert.deepEqual(m, { startMs: 5000, endMs: 12000, method: 'exact' });
});

test('tier 1: matches despite differing internal whitespace/newlines', () => {
  const m = matchSpanToSegments(SEGMENTS, 'לחץ הדם\nהתייצב   על 120-80');
  assert.equal(m.method, 'exact');
  assert.equal(m.startMs, 5000);
});

test('tier 2: span crossing two adjacent segments spans both windows', () => {
  // The transcript joins segments with \n, so a verbatim quote can cross the seam.
  const m = matchSpanToSegments(SEGMENTS, 'ואין חום. המדידה האחרונה');
  assert.deepEqual(m, { startMs: 5000, endMs: 15000, method: 'pair' });
});

test('tier 3: ungrounded span falls back to best token overlap', () => {
  // Fabricated/reworded span: not verbatim anywhere, but its tokens
  // (המדידה, האחרונה) overlap segment 3 best.
  const m = matchSpanToSegments(SEGMENTS, 'המדידה האחרונה של החום הייתה תקינה');
  assert.equal(m.method, 'overlap');
  assert.equal(m.startMs, 12200);
});

test('tier 3: field value tokens (extraText) contribute to the match', () => {
  const m = matchSpanToSegments(SEGMENTS, '', 'אוקסיקודון 5 מיליגרם לפי הצורך');
  assert.equal(m.method, 'overlap');
  assert.equal(m.startMs, 15200);
});

test('no match: garbage span with zero overlap returns null', () => {
  assert.equal(matchSpanToSegments(SEGMENTS, 'קטטר שתן הוסר אתמול בערב לגמרי'), null);
});

test('no match: empty span and extraText return null', () => {
  assert.equal(matchSpanToSegments(SEGMENTS, ''), null);
  assert.equal(matchSpanToSegments(SEGMENTS, '', ''), null);
});

test('segments with null times are skipped, next playable wins', () => {
  const segs = [
    { content: 'דופק 76 נמדד', startMs: null, endMs: null },
    { content: 'דופק 76 נמדד שוב', startMs: 100, endMs: 200 },
  ];
  const m = matchSpanToSegments(segs, 'דופק 76');
  assert.deepEqual(m, { startMs: 100, endMs: 200, method: 'exact' });
});

test('empty segment list returns null', () => {
  assert.equal(matchSpanToSegments([], 'דופק 76'), null);
  assert.equal(matchSpanToSegments(null, 'דופק 76'), null);
});
