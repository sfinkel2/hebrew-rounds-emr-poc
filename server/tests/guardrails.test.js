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
