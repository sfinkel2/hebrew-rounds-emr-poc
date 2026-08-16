// server/tests/guardrails.test.js
//
// Safety-critical, LLM-independent unit tests for the deterministic guardrails
// (spec §6.3 + §10). These exercise applyGuardrails(transcript, fields) against
// the real scripted round and the canned mock-llm structure output, asserting
// the three deterministic rules:
//   1. Grounding   — sourceSpan must literally appear in the transcript.
//   2. High-risk   — medications/imaging/procedures always force confirmation.
//   3. Vitals range — numeric vitals validated against plausible ranges.
//
// These run in MOCK mode with NO API keys and NO network: applyGuardrails is a
// pure deterministic function over (transcript, fields).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import applyGuardrails from '../lib/guardrails.js';
import { makeFieldRecord, getVitalRange } from '../lib/fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

const round = JSON.parse(readFileSync(join(dataDir, 'scripted-round.json'), 'utf8'));
const mock = JSON.parse(readFileSync(join(dataDir, 'mock-llm.json'), 'utf8'));
const TRANSCRIPT = round.transcript;

/** Look up the canned structure entry for a fieldId from mock-llm.json. */
function structFor(fieldId) {
  const s = mock.structure.find((f) => f.fieldId === fieldId);
  assert.ok(s, `mock-llm.json must contain a structure entry for ${fieldId}`);
  return s;
}

/** Look up the canned judge verdict for a fieldId from mock-llm.json. */
function judgeFor(fieldId) {
  const j = mock.judge.find((f) => f.fieldId === fieldId);
  assert.ok(j, `mock-llm.json must contain a judge entry for ${fieldId}`);
  return j;
}

/**
 * Build a FieldRecord seeded from the mock structure + judge entries, the way
 * the real /api/judge route would before calling guardrails.
 */
function recordFor(fieldId) {
  const s = structFor(fieldId);
  const j = judgeFor(fieldId);
  return makeFieldRecord(fieldId, {
    value: s.value,
    sourceSpan: s.sourceSpan,
    confidence: s.confidence,
    judge: { verdict: j.verdict, reason: j.reason, highRisk: j.highRisk },
  });
}

/** Run applyGuardrails over one record and return the (single) updated record. */
function guardOne(record) {
  const out = applyGuardrails(TRANSCRIPT, [record]);
  assert.ok(Array.isArray(out), 'applyGuardrails must return an array of fields');
  assert.equal(out.length, 1, 'applyGuardrails must return one record per input');
  const g = out[0].guardrail;
  assert.ok(g && typeof g === 'object', 'each field must carry a guardrail sub-object');
  return out[0];
}

// ── (1) Grounded field: sourceSpan IS a substring of the transcript → passes ──
test('grounding: a field whose sourceSpan appears in the transcript passes', () => {
  // objective.vitals.hr: sourceSpan "דופק 96" is literally in the transcript.
  const field = recordFor('objective.vitals.hr');
  assert.ok(
    TRANSCRIPT.includes(field.sourceSpan),
    'precondition: hr sourceSpan must be a literal substring of the transcript',
  );

  const out = guardOne(field);
  assert.equal(out.guardrail.passed, true, 'grounded in-range vital must pass the grounding check');
  assert.equal(
    out.guardrail.requiresConfirmation,
    false,
    'a grounded, in-range, non-high-risk vital must not require confirmation',
  );
});

// ── (2) Ungrounded field: fabricated sourceSpan NOT in transcript → flagged ───
test('grounding: the fabricated "אין חום" field is flagged and forced to confirm', () => {
  // objective.vitals.temp in the mock is the single hallucination: value "37.8"
  // but sourceSpan "אין חום" (no fever), which is NOT in the transcript.
  const field = recordFor('objective.vitals.temp');
  assert.equal(field.sourceSpan, 'אין חום', 'precondition: temp is the fabricated span');
  assert.ok(
    !TRANSCRIPT.includes('אין חום'),
    'precondition: the fabricated span must NOT appear in the transcript',
  );

  const out = guardOne(field);
  assert.equal(
    out.guardrail.passed,
    false,
    'an ungrounded sourceSpan must fail the grounding check',
  );
  assert.equal(
    out.guardrail.requiresConfirmation,
    true,
    'a field with fabricated grounding must require explicit confirmation',
  );
  assert.ok(
    Array.isArray(out.guardrail.messages) && out.guardrail.messages.length > 0,
    'a flagged field must carry at least one guardrail message explaining why',
  );
});

// ── (3) High-risk field forces confirmation even when correctly grounded ──────
test('high-risk: the grounded opioid medication still requires confirmation', () => {
  // decisions.medications: "מורפיום 4 מ\"ג IV" is correctly grounded (the span IS
  // in the transcript) AND high-risk → must still force confirmation.
  const field = recordFor('decisions.medications');
  assert.ok(
    TRANSCRIPT.includes(field.sourceSpan),
    'precondition: the opioid medication span IS grounded in the transcript',
  );
  assert.equal(field.judge.verdict, 'grounded', 'precondition: judge marks the opioid grounded');
  assert.equal(field.judge.highRisk, true, 'precondition: the opioid is flagged high-risk');

  const out = guardOne(field);
  assert.equal(
    out.guardrail.requiresConfirmation,
    true,
    'a high-risk field must require confirmation regardless of being grounded',
  );
  assert.ok(
    Array.isArray(out.guardrail.messages) && out.guardrail.messages.length > 0,
    'a high-risk field must carry a guardrail message',
  );
});

// ── (4) Vitals range: in-range passes, out-of-range is flagged ────────────────
test('vitals range: an in-range vital is ok, an out-of-range vital is flagged', () => {
  // In range: spo2 = 97 (range 50–100).
  const inRange = recordFor('objective.vitals.spo2');
  const inOut = guardOne(inRange);
  // An in-range, grounded, non-high-risk vital is fully clean: grounded (passed)
  // and needs no confirmation.
  assert.equal(inOut.guardrail.passed, true, 'an in-range, grounded vital must stay grounded');
  assert.equal(
    inOut.guardrail.requiresConfirmation,
    false,
    'an in-range, grounded vital must not require confirmation',
  );

  // Out of range: fabricate an HR of 999 (range max 220) while keeping a real,
  // grounded sourceSpan so the ONLY failing rule is the numeric range check.
  const range = getVitalRange('objective.vitals.hr');
  assert.ok(range, 'hr must have a numeric range defined in the catalog');
  const outOfRangeValue = String(range.max + 100);
  const badVital = makeFieldRecord('objective.vitals.hr', {
    value: outOfRangeValue,
    sourceSpan: 'דופק 96', // grounded span, so only the range rule can fail
    confidence: 0.95,
    judge: { verdict: 'grounded', reason: 'grounded', highRisk: false },
  });
  assert.ok(
    TRANSCRIPT.includes(badVital.sourceSpan),
    'precondition: the out-of-range vital still has a grounded span',
  );

  const badOut = guardOne(badVital);
  // The grounding gate (`passed`) reflects only "is the span real?" — the span
  // is grounded, so passed stays true; the range failure surfaces as a forced
  // confirmation plus an explanatory message (spec §6 vitals-range rule).
  assert.equal(
    badOut.guardrail.requiresConfirmation,
    true,
    'an out-of-range vital must be flagged (require confirmation)',
  );
  assert.ok(
    Array.isArray(badOut.guardrail.messages) && badOut.guardrail.messages.length > 0,
    'an out-of-range vital must carry a guardrail message explaining the range failure',
  );
  assert.ok(
    badOut.guardrail.messages.some((m) => /range/i.test(m)),
    'the out-of-range message should mention the range failure',
  );
});

// ── Check 1b: does the quote actually SUPPORT the value? ────────────────────
//
// Check 1 is a substring test: "is this quote real?" It cannot ask "does this
// quote back up what the note claims?" Evaluating the real ward round caught
// exactly that gap — a blood pressure of "128/78" written from audio saying
// "לחץ דם ה-28 ל-78". The quote was genuine, so check 1 passed it and the judge
// called it grounded, and a fabricated vital reached the note with real
// provenance. Worse, a faithful systolic of 28 is out of range and would have
// been held by check 3; "repairing" it to 128 routed it around that safeguard.

/** Build a record with an arbitrary value/span pair against a given transcript. */
function guardPair(fieldId, value, sourceSpan, transcript) {
  const rec = makeFieldRecord(fieldId, {
    value,
    sourceSpan,
    confidence: 0.95,
    judge: { verdict: 'grounded', reason: '', highRisk: false },
  });
  return applyGuardrails(transcript, [rec])[0];
}

test('THE REGRESSION: a vital "repaired" to a plausible number is caught', () => {
  const spoken = 'יוסי כהן, מספר זהות 1234, לחץ דם ה-28 ל-78, דופק 82';
  const out = guardPair('objective.vitals.bp', '128/78', 'לחץ דם ה-28 ל-78', spoken);

  assert.equal(out.guardrail.passed, true, 'the quote is real — grounding itself did not fail');
  assert.equal(
    out.guardrail.requiresConfirmation,
    true,
    'a value whose quote never mentions 128 must be held for a human',
  );
  assert.ok(
    out.guardrail.messages.some((m) => m.includes('128')),
    'the message must name the unsupported number',
  );
});

test('a drug named in the value but absent from the quote is caught', () => {
  // The other half of the same failure: a medications value that fuses two
  // separate parts of the round while quoting only one of them.
  const spoken = 'תן לו Paracetamol 1 גרם כל 6 שעות ו-Ibuprofen 400 כל 8 שעות. תוסיף 5 מיליגרם Amlodipine.';
  const out = guardPair(
    'decisions.medications',
    'Paracetamol 1 גרם כל 6 שעות, Ibuprofen 400 כל 8 שעות, Amlodipine 5 מ"ג',
    'Paracetamol 1 גרם כל 6 שעות ו-Ibuprofen 400 כל 8 שעות',
    spoken,
  );
  assert.equal(out.guardrail.requiresConfirmation, true);
  assert.ok(out.guardrail.messages.some((m) => m.includes('Amlodipine')));
});

test('a value fully backed by its quote is not flagged', () => {
  const spoken = 'לחץ דם 128 על 78, דופק 82';
  const out = guardPair('objective.vitals.bp', '128/78', 'לחץ דם 128 על 78', spoken);
  assert.equal(out.guardrail.requiresConfirmation, false, 'reformatting 128 על 78 → 128/78 is legitimate');
  assert.deepEqual(out.guardrail.messages, []);
});

test('units the speaker never said are not treated as unsupported', () => {
  // "110/68 mmHg" from "לחץ דם 110 על 68" is a unit spelled out, not an
  // invented fact. Flagging it would bury the real findings in noise.
  const spoken = 'לחץ דם 110 על 68, דופק 94';
  const out = guardPair('objective.vitals.bp', '110/68 mmHg', 'לחץ דם 110 על 68', spoken);
  assert.equal(out.guardrail.requiresConfirmation, false);
});

test('clinically meaningful abbreviations are NOT exempt', () => {
  // CT is not a unit. If the note orders a scan the quote never mentions,
  // that is precisely what this check exists to catch.
  const spoken = 'הכאב העמוק שהיא מתארת, צריך לשלול אבצס. תיקח תרביות מהפצע עכשיו.';
  const out = guardPair('decisions.imaging', 'CT בטן עם חומר ניגוד', 'תיקח תרביות מהפצע עכשיו', spoken);
  assert.equal(out.guardrail.requiresConfirmation, true);
  assert.ok(out.guardrail.messages.some((m) => m.includes('CT')));
});

test('Hebrew rewording alone never triggers the check', () => {
  // The structurer is instructed to rewrite spoken Hebrew into clinical
  // register, so differing Hebrew words are expected and must not be flagged.
  const spoken = 'יש לי כאב בבטן, קשה לי לזוז';
  const out = guardPair('subjective.chiefComplaint', 'המטופל מדווח על כאב בטני וקושי בתנועה', 'יש לי כאב בבטן, קשה לי לזוז', spoken);
  assert.equal(out.guardrail.requiresConfirmation, false);
  assert.deepEqual(out.guardrail.messages, []);
});

test('an already-ungrounded field is not double-reported', () => {
  // If the quote is not in the transcript at all, check 1 owns that failure —
  // adding "the quote does not mention X" on top would just be noise.
  const spoken = 'לחץ דם 128 על 78';
  const out = guardPair('objective.vitals.bp', '128/78', 'ציטוט שמעולם לא נאמר', spoken);
  assert.equal(out.guardrail.passed, false);
  assert.equal(out.guardrail.messages.length, 1, 'only the grounding failure should be reported');
  assert.ok(/not grounded/i.test(out.guardrail.messages[0]));
});

test('THE SECOND REGRESSION: a BP split out of a run-together number is caught', () => {
  // Found by evaluating the 2026-08-11 round. The audio says "לחץ דם יציב 12274";
  // the note claimed "122/74". A plain substring test passed it, because both
  // "122" and "74" occur inside "12274" — so the note invented a split the
  // recording never contained and the check waved it through. Digits must not
  // be flanked by digits.
  const spoken = 'לחץ דם יציב 12274, דופק 88, חום 37.8';
  const out = guardPair('objective.vitals.bp', '122/74', 'לחץ דם יציב 12274', spoken);

  assert.equal(
    out.guardrail.requiresConfirmation,
    true,
    '122/74 is not supported by a quote that only contains 12274',
  );
  assert.ok(out.guardrail.messages.some((m) => /122/.test(m)));
});

test('a number genuinely present is still accepted at a digit boundary', () => {
  const spoken = 'לחץ דם 122 על 74';
  const out = guardPair('objective.vitals.bp', '122/74', 'לחץ דם 122 על 74', spoken);
  assert.equal(out.guardrail.requiresConfirmation, false);
});

test('a Latin word embedded in a longer word does not count as support', () => {
  const spoken = 'המטופל מקבל Augmentin ופלג׳יל';
  const out = guardPair('decisions.medications', 'Augment 500', 'המטופל מקבל Augmentin', spoken);
  assert.equal(out.guardrail.requiresConfirmation, true, '"Augment" must not be satisfied by "Augmentin"');
});
