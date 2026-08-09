// server/tests/segment.test.js
//
// Covers lib/segment.js — the per-patient splitter that runs BEFORE
// structure/judge/guardrails.
//
// The contract that matters for safety: a segment is a VERBATIM CONTIGUOUS
// SLICE of the round transcript. If that ever stops being true, every
// sourceSpan the structurer quotes from a segment could fail the grounding
// guardrail (or, worse, pass against text that was never spoken).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sliceByAnchors,
  findSegmentBoundaries,
  segmentTranscript,
  checkRoundCoverage,
} from '../lib/segment.js';

const ROUND = [
  'טוב, מתחילים סיבוב.',
  'יוסי כהן, בן 58, יום אחד אחרי כולציסטקטומיה לפרוסקופית.',
  'לחץ דם 128 על 78, דופק 82.',
  'רחל לוי, בת 72, יום שלישי אחרי המיקולוקטומי ימנית.',
  'לחץ דם 110 על 68, דופק 94.',
].join('\n');

const ANCHORS = [
  { patientLabel: 'יוסי כהן', startAnchor: 'יוסי כהן, בן 58' },
  { patientLabel: 'רחל לוי', startAnchor: 'רחל לוי, בת 72' },
];

test('slices the round into one contiguous segment per patient', () => {
  const segs = sliceByAnchors(ROUND, ANCHORS);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].patientLabel, 'יוסי כהן');
  assert.equal(segs[1].patientLabel, 'רחל לוי');
});

test('every segment is a verbatim substring of the round transcript', () => {
  // This is THE grounding-preserving invariant: guardrails.js checks a
  // sourceSpan against the segment it was extracted from, so the segment must
  // itself be real transcript text.
  for (const seg of sliceByAnchors(ROUND, ANCHORS)) {
    assert.ok(
      ROUND.includes(seg.transcript),
      `segment ${seg.index} is not a verbatim substring of the transcript`,
    );
  }
});

test("each patient's own vitals land in their segment and the other's do not", () => {
  // The cross-patient contamination this module exists to prevent.
  const [yossi, rachel] = sliceByAnchors(ROUND, ANCHORS);
  assert.ok(yossi.transcript.includes('128 על 78'));
  assert.ok(!yossi.transcript.includes('110 על 68'));
  assert.ok(rachel.transcript.includes('110 על 68'));
  assert.ok(!rachel.transcript.includes('128 על 78'));
});

test('preamble before the first anchor is dropped, not attached to patient 1', () => {
  const [yossi] = sliceByAnchors(ROUND, ANCHORS);
  assert.ok(!yossi.transcript.includes('מתחילים סיבוב'));
});

test('segments cover the transcript from the first anchor to the end', () => {
  const segs = sliceByAnchors(ROUND, ANCHORS);
  const rejoined = segs.map((s) => s.transcript).join('\n');
  assert.ok(rejoined.includes('דופק 82'));
  assert.ok(rejoined.includes('דופק 94'));
});

test('an anchor the model invented is rejected, not silently mis-sliced', () => {
  assert.throws(
    () => sliceByAnchors(ROUND, [{ patientLabel: 'רפאים', startAnchor: 'משה ישראלי, בן 40' }]),
    /not found in transcript/,
  );
});

test('out-of-order anchors are rejected', () => {
  assert.throws(
    () => sliceByAnchors(ROUND, [ANCHORS[1], ANCHORS[0]]),
    /out of order/,
  );
});

test('an empty anchor is rejected', () => {
  assert.throws(() => sliceByAnchors(ROUND, [{ startAnchor: '   ' }]), /is empty/);
});

test('no anchors at all is rejected', () => {
  assert.throws(() => sliceByAnchors(ROUND, []), /at least one anchor/);
});

test('anchors are matched across transcript line wrapping', () => {
  // The transcript may wrap mid-anchor; grounding normalizes whitespace, and so
  // must anchor lookup, or a correct boundary would be rejected.
  const wrapped = ROUND.replace('יוסי כהן, בן 58', 'יוסי כהן,\n   בן 58');
  const segs = sliceByAnchors(wrapped, ANCHORS);
  assert.equal(segs.length, 2);
  assert.ok(wrapped.includes(segs[0].transcript));
});

test('a single-patient round yields exactly one segment', () => {
  const solo = 'יוסי כהן, בן 58, יום אחד אחרי הניתוח. לחץ דם 128 על 78.';
  const segs = sliceByAnchors(solo, [{ patientLabel: 'יוסי כהן', startAnchor: 'יוסי כהן' }]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].transcript, solo);
});

test('a missing patientLabel falls back to a positional label', () => {
  const segs = sliceByAnchors(ROUND, [{ startAnchor: 'יוסי כהן, בן 58' }]);
  assert.equal(segs[0].patientLabel, 'Patient 1');
});

test('findSegmentBoundaries passes model anchors through without inventing text', async () => {
  const calls = [];
  const anchors = await findSegmentBoundaries(ROUND, {
    isMock: () => false,
    callClaude: async (args) => {
      calls.push(args);
      return { segments: ANCHORS };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].userText, /יוסי כהן/);
  assert.deepEqual(anchors, ANCHORS);
});

test('segmentTranscript rejects malformed model output rather than returning a partial round', async () => {
  await assert.rejects(
    () => segmentTranscript(ROUND, { isMock: () => false, callClaude: async () => ({ segments: [] }) }),
    /no segments returned/,
  );
});

test('segmentTranscript refuses an empty transcript', async () => {
  await assert.rejects(() => segmentTranscript('   '), /No transcript provided/);
});

// ── checkRoundCoverage — the only layer that looks for what ISN'T there ──────
//
// Evaluating the real 9-minute round showed the failure this guards against:
// structuring a whole round at once, the model produced a clean, fully-grounded
// note for the FIRST patient and silently dropped the other three. Nothing else
// in the pipeline can see that — every other check inspects fields that exist.

// Shaped like the real recording: each bed is introduced out loud with an
// identity number, which is what makes a deterministic count possible.
const FOUR_BED_ROUND = [
  'יש לנו כאן את יוסי כהן, מספר זהות 1234, יום לאחר הניתוח. לחץ דם 128 על 78.',
  'אוקיי, כאן יש לנו עכשיו את אחמד. מספר זהות 5, 6, 7, 8. יומיים אחרי תאונה.',
  'המטופל הבא, רחלי, מספר זהות 9, 10, 11, 12. יום שלישי אחרי הניתוח.',
  'מטופל אבא, מספר מיכאל, מספר זהות 13, 14, 15, 16. בן 45.',
].join('\n');

const FOUR_ANCHORS = [
  { patientLabel: 'יוסי כהן', startAnchor: 'יש לנו כאן את יוסי כהן' },
  { patientLabel: 'אחמד', startAnchor: 'כאן יש לנו עכשיו את אחמד' },
  { patientLabel: 'רחלי', startAnchor: 'המטופל הבא, רחלי' },
  { patientLabel: 'מיכאל', startAnchor: 'מטופל אבא, מספר מיכאל' },
];

test('a round where every patient got a section passes coverage', () => {
  const segs = sliceByAnchors(FOUR_BED_ROUND, FOUR_ANCHORS);
  const cov = checkRoundCoverage(FOUR_BED_ROUND, segs);
  assert.equal(cov.ok, true);
  assert.equal(cov.cueCount, 4);
  assert.equal(cov.segmentCount, 4);
  assert.deepEqual(cov.warnings, []);
});

test('THE REGRESSION: a round that produced only the first patient is flagged', () => {
  // Exactly what the evaluation caught — one tidy section, three beds vanished.
  const onlyFirst = sliceByAnchors(FOUR_BED_ROUND, [FOUR_ANCHORS[0]]);
  const cov = checkRoundCoverage(FOUR_BED_ROUND, onlyFirst);

  assert.equal(cov.ok, false);
  assert.equal(cov.cueCount, 4);
  assert.equal(cov.segmentCount, 1);
  assert.equal(cov.warnings[0].code, 'possible_missing_patient');
  assert.match(cov.warnings[0].message, /4 spoken patient introductions but only 1 section was produced/);
});

test('dropping a middle patient is flagged too, not just a truncated round', () => {
  const missingMiddle = sliceByAnchors(FOUR_BED_ROUND, [
    FOUR_ANCHORS[0], FOUR_ANCHORS[2], FOUR_ANCHORS[3],
  ]);
  const cov = checkRoundCoverage(FOUR_BED_ROUND, missingMiddle);
  assert.equal(cov.ok, false);
  assert.equal(cov.segmentCount, 3);
  assert.equal(cov.warnings[0].code, 'possible_missing_patient');
});

test('several cues for ONE bed do not invent extra patients', () => {
  // "the next patient, Rachel, identity number ..." is two markers, one bed.
  // Summing cue counts here would fabricate a missing patient on a correct split.
  const solo = 'המטופל הבא, רחלי, מספר זהות 9, 10, 11, 12. יום שלישי אחרי הניתוח.';
  const segs = sliceByAnchors(solo, [{ patientLabel: 'רחלי', startAnchor: 'המטופל הבא, רחלי' }]);
  const cov = checkRoundCoverage(solo, segs);
  assert.equal(cov.cueCount, 1, 'two markers on one bed must count as one patient');
  assert.equal(cov.ok, true);
});

test('more sections than spoken cues is not a warning', () => {
  // A bed can be presented without saying "identity number". Over-splitting is
  // visible to the reviewer as an extra tab; under-splitting is what hides.
  const segs = sliceByAnchors(FOUR_BED_ROUND, FOUR_ANCHORS);
  const cov = checkRoundCoverage(FOUR_BED_ROUND, segs.concat(segs[3]));
  assert.equal(cov.ok, true);
});

test('a long stretch before the first patient is flagged as dropped', () => {
  const preamble =
    'טוב חברים, בוקר טוב לכולם, מתחילים את הסיבוב, שנייה רק שאני אקח את הניירת ואת המחשב הנייד. ' +
    'מי היה תורן אתמול בלילה? בסדר, אז נתחיל.\n';
  const withPreamble = preamble + FOUR_BED_ROUND;
  const segs = sliceByAnchors(withPreamble, FOUR_ANCHORS);
  const cov = checkRoundCoverage(withPreamble, segs);

  assert.ok(cov.warnings.some((w) => w.code === 'dropped_preamble'));
  assert.ok(cov.droppedPreamble.includes('מתחילים את הסיבוב'));
});

test('a short preamble is round chit-chat, not a missing bed', () => {
  const withPreamble = 'בוקר טוב.\n' + FOUR_BED_ROUND;
  const segs = sliceByAnchors(withPreamble, FOUR_ANCHORS);
  const cov = checkRoundCoverage(withPreamble, segs);
  assert.ok(!cov.warnings.some((w) => w.code === 'dropped_preamble'));
});

test('coverage is pure — it never throws on a single-patient round', () => {
  const solo = 'יוסי כהן, בן 58, יום אחד אחרי הניתוח. לחץ דם 128 על 78.';
  const segs = sliceByAnchors(solo, [{ patientLabel: 'יוסי כהן', startAnchor: 'יוסי כהן' }]);
  const cov = checkRoundCoverage(solo, segs);
  assert.equal(cov.ok, true);
  assert.equal(cov.cueCount, 0);
});
