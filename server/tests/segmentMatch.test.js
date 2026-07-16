// server/tests/segmentMatch.test.js
//
// Unit tests for the pure span→segment matcher at public/segmentMatch.js —
// the module is shared: the browser imports it from app.js (ES module, no
// bundler) and node tests import it here via relative path.
//
// Plaud segments recordings by SPEAKER TURN, so a near-monologue round can
// produce a single 30+ second segment. The matcher therefore interpolates the
// span's character position within the segment into a time window — playback
// must start at the sentence, not at the segment boundary.

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

test('tier 1: span at the start of a segment starts at the segment start', () => {
  const m = matchSpanToSegments(SEGMENTS, 'לחץ הדם התייצב');
  assert.equal(m.method, 'exact');
  assert.equal(m.startMs, 5000);
  assert.ok(m.endMs < 12000, `end interpolated inside the segment, got ${m.endMs}`);
});

test('tier 1: span mid-segment interpolates INTO the segment (not its start)', () => {
  // 'דופק 76' sits ~60% into segment 2 (5000–12000ms) — the whole point of
  // interpolation: a long speaker turn must not play from its beginning.
  const m = matchSpanToSegments(SEGMENTS, 'דופק 76');
  assert.equal(m.method, 'exact');
  assert.ok(m.startMs > 8000 && m.startMs < 11500, `expected mid-segment start, got ${m.startMs}`);
  assert.ok(m.endMs > m.startMs && m.endMs <= 12000);
});

test('tier 1: later spans start later (monotonic within a segment)', () => {
  const early = matchSpanToSegments(SEGMENTS, 'לחץ הדם');
  const late = matchSpanToSegments(SEGMENTS, 'ואין חום');
  assert.ok(early.startMs < late.startMs);
});

test('tier 1: span covering the whole segment returns the full window', () => {
  const m = matchSpanToSegments(SEGMENTS, 'המדידה האחרונה הייתה 36.8.');
  assert.deepEqual(m, { startMs: 12200, endMs: 15000, method: 'exact' });
});

test('tier 1: matches despite differing internal whitespace/newlines', () => {
  const m = matchSpanToSegments(SEGMENTS, 'לחץ הדם\nהתייצב   על 120-80');
  assert.equal(m.method, 'exact');
  assert.equal(m.startMs, 5000);
});

test('tier 2: span crossing two adjacent segments interpolates both ends', () => {
  // The transcript joins segments with \n, so a verbatim quote can cross the seam.
  const m = matchSpanToSegments(SEGMENTS, 'ואין חום. המדידה האחרונה');
  assert.equal(m.method, 'pair');
  // Starts near the END of segment 2, not at its beginning…
  assert.ok(m.startMs > 9000 && m.startMs < 12000, `expected late-segment-2 start, got ${m.startMs}`);
  // …and ends inside segment 3.
  assert.ok(m.endMs > 12200 && m.endMs <= 15000, `expected end inside segment 3, got ${m.endMs}`);
});

test('tier 3: ungrounded span falls back to token overlap, window around the matched tokens', () => {
  // Fabricated/reworded span: not verbatim anywhere, but its tokens
  // (המדידה, האחרונה) overlap segment 3 best — and sit at its start.
  const m = matchSpanToSegments(SEGMENTS, 'המדידה האחרונה של החום הייתה תקינה');
  assert.equal(m.method, 'overlap');
  assert.equal(m.startMs, 12200);
  assert.ok(m.endMs <= 15000);
});

test('tier 3: field value tokens (extraText) contribute to the match', () => {
  const m = matchSpanToSegments(SEGMENTS, '', 'אוקסיקודון 5 מיליגרם לפי הצורך');
  assert.equal(m.method, 'overlap');
  // Matched tokens are in the second half of segment 4 (15200–22000ms).
  assert.ok(m.startMs >= 15200 && m.startMs < 22000);
  assert.ok(m.endMs > m.startMs && m.endMs <= 22000);
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
  assert.equal(m.method, 'exact');
  assert.equal(m.startMs, 100); // span at content start
  assert.ok(m.endMs > 100 && m.endMs <= 200);
});

test('interpolated windows never invert or escape the segment', () => {
  for (const span of ['בוקר טוב', 'דופק 76', 'לפי הצורך', '36.8']) {
    const m = matchSpanToSegments(SEGMENTS, span);
    assert.ok(m, `no match for ${span}`);
    assert.ok(m.startMs < m.endMs, `inverted window for ${span}`);
    const seg = SEGMENTS.find((s) => s.startMs <= m.startMs && m.endMs <= s.endMs)
      || (m.method === 'pair');
    assert.ok(seg, `window escaped segment bounds for ${span}`);
  }
});

test('empty segment list returns null', () => {
  assert.equal(matchSpanToSegments([], 'דופק 76'), null);
  assert.equal(matchSpanToSegments(null, 'דופק 76'), null);
});
