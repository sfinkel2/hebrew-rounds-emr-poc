// server/tests/contract.test.js
//
// Structure/judge contract tests (spec §5, §6, §10). These do NOT call any LLM:
// they assert the GROUNDING INVARIANT directly over the canned mock-llm.json +
// scripted-round.json fixtures, and assert that makeFieldRecord() returns the
// full FieldRecord shape from spec §4.
//
// The grounding invariant is the spine of the safety story:
//   - Every NON-fabricated structure entry's sourceSpan is a literal substring
//     of the transcript.
//   - The single fabricated entry ("no fever / אין חום", objective.vitals.temp)
//     has a sourceSpan that is NOT in the transcript — so the deterministic
//     grounding guardrail can block it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  makeFieldRecord,
  JUDGE_VERDICTS,
  FIELD_STATUSES,
  isKnownField,
} from '../lib/fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

const round = JSON.parse(readFileSync(join(dataDir, 'scripted-round.json'), 'utf8'));
const mock = JSON.parse(readFileSync(join(dataDir, 'mock-llm.json'), 'utf8'));
const TRANSCRIPT = round.transcript;

// The single deliberate hallucination (spec §2): temp value present, but the
// "no fever" rationale span is NOT in the transcript.
const FABRICATED_FIELD_ID = 'objective.vitals.temp';
const FABRICATED_SPAN = 'אין חום';

test('fixtures: transcript and mock structure/judge arrays are present', () => {
  assert.equal(typeof TRANSCRIPT, 'string');
  assert.ok(TRANSCRIPT.length > 0, 'scripted transcript must be non-empty');
  assert.ok(Array.isArray(mock.structure) && mock.structure.length > 0, 'structure[] present');
  assert.ok(Array.isArray(mock.judge) && mock.judge.length > 0, 'judge[] present');
});

test('grounding invariant: every non-fabricated sourceSpan is a substring of the transcript', () => {
  for (const entry of mock.structure) {
    assert.ok(isKnownField(entry.fieldId), `${entry.fieldId} must be a known catalog field`);
    assert.equal(typeof entry.sourceSpan, 'string');
    assert.ok(entry.sourceSpan.length > 0, `${entry.fieldId} must carry a sourceSpan`);

    if (entry.fieldId === FABRICATED_FIELD_ID) continue; // checked separately below

    assert.ok(
      TRANSCRIPT.includes(entry.sourceSpan),
      `sourceSpan for ${entry.fieldId} ("${entry.sourceSpan}") must literally appear in the transcript`,
    );
  }
});

test('grounding invariant: the fabricated "no fever / אין חום" span is NOT in the transcript', () => {
  const fab = mock.structure.find((e) => e.fieldId === FABRICATED_FIELD_ID);
  assert.ok(fab, `mock structure must contain the fabricated field ${FABRICATED_FIELD_ID}`);
  assert.equal(fab.sourceSpan, FABRICATED_SPAN, 'fabricated span must be "אין חום"');
  assert.ok(
    !TRANSCRIPT.includes(FABRICATED_SPAN),
    'the fabricated "אין חום" span must NOT appear in the transcript (so the guardrail blocks it)',
  );

  // And the judge independently marks it ungrounded.
  const judge = mock.judge.find((e) => e.fieldId === FABRICATED_FIELD_ID);
  assert.ok(judge, 'judge must have a verdict for the fabricated field');
  assert.equal(judge.verdict, 'ungrounded', 'judge must mark the fabricated field ungrounded');
});

test('structure entries carry value / sourceSpan / confidence (spec §5 structure contract)', () => {
  for (const entry of mock.structure) {
    assert.equal(typeof entry.value, 'string', `${entry.fieldId}.value must be a string`);
    assert.equal(typeof entry.sourceSpan, 'string', `${entry.fieldId}.sourceSpan must be a string`);
    assert.equal(typeof entry.confidence, 'number', `${entry.fieldId}.confidence must be numeric`);
    assert.ok(
      entry.confidence >= 0 && entry.confidence <= 1,
      `${entry.fieldId}.confidence must be in [0,1]`,
    );
  }
});

test('judge entries carry a valid verdict, reason, and highRisk flag (spec §6)', () => {
  for (const entry of mock.judge) {
    assert.ok(isKnownField(entry.fieldId), `${entry.fieldId} must be a known catalog field`);
    assert.ok(
      JUDGE_VERDICTS.includes(entry.verdict),
      `${entry.fieldId}.verdict "${entry.verdict}" must be one of ${JUDGE_VERDICTS.join(', ')}`,
    );
    assert.equal(typeof entry.reason, 'string', `${entry.fieldId}.reason must be a string`);
    assert.equal(typeof entry.highRisk, 'boolean', `${entry.fieldId}.highRisk must be boolean`);
  }
});

test('makeFieldRecord returns the full FieldRecord shape from spec §4', () => {
  const rec = makeFieldRecord('objective.vitals.hr');

  // Top-level keys.
  for (const key of [
    'fieldId',
    'value',
    'sourceSpan',
    'confidence',
    'judge',
    'guardrail',
    'status',
    'committedValue',
  ]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(rec, key),
      `FieldRecord must have top-level key "${key}"`,
    );
  }

  assert.equal(rec.fieldId, 'objective.vitals.hr');
  assert.equal(typeof rec.value, 'string');
  assert.equal(typeof rec.sourceSpan, 'string');
  assert.equal(typeof rec.confidence, 'number');
  assert.equal(rec.committedValue, null, 'committedValue defaults to null');
  assert.ok(FIELD_STATUSES.includes(rec.status), 'status must be a valid status');

  // judge sub-object.
  assert.ok(rec.judge && typeof rec.judge === 'object');
  for (const key of ['verdict', 'reason', 'highRisk']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(rec.judge, key),
      `judge must have key "${key}"`,
    );
  }
  assert.ok(JUDGE_VERDICTS.includes(rec.judge.verdict), 'judge.verdict must be valid');
  assert.equal(typeof rec.judge.highRisk, 'boolean');

  // guardrail sub-object.
  assert.ok(rec.guardrail && typeof rec.guardrail === 'object');
  for (const key of ['passed', 'requiresConfirmation', 'messages']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(rec.guardrail, key),
      `guardrail must have key "${key}"`,
    );
  }
  assert.equal(typeof rec.guardrail.passed, 'boolean');
  assert.equal(typeof rec.guardrail.requiresConfirmation, 'boolean');
  assert.ok(Array.isArray(rec.guardrail.messages), 'guardrail.messages must be an array');
});

test('makeFieldRecord deep-merges partial overrides without clobbering defaults', () => {
  const rec = makeFieldRecord('decisions.medications', {
    value: 'מורפיום 4 מ"ג IV',
    judge: { verdict: 'grounded' },
  });
  assert.equal(rec.value, 'מורפיום 4 מ"ג IV');
  assert.equal(rec.judge.verdict, 'grounded');
  // highRisk default preserved (medications are high-risk) despite partial judge.
  assert.equal(rec.judge.highRisk, true, 'partial judge override must not clobber highRisk default');
  // guardrail defaults still present.
  assert.equal(rec.guardrail.passed, true);
  assert.deepEqual(rec.guardrail.messages, []);
});
