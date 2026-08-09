// server/tests/emrMultiPatient.test.js
//
// Covers the multi-patient EMR store: several beds on one round, each with its
// own note and audit log.
//
// The failure these tests exist to prevent: before per-patient notes existed,
// a whole round went into ONE note keyed by fieldId, so a later patient's
// blood pressure and medications silently overwrote an earlier patient's. That
// is cross-patient contamination — clinically the worst thing this system
// could do, and invisible to the grounding guardrail (every quote really is in
// the transcript, just from the wrong bed).

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `node --test` runs each test FILE in its own process. This file resets the
// EMR working state in beforeEach, so it must not share a state file with
// commit.test.js — two processes truncating and re-reading one file produce
// torn reads. Must be set BEFORE emrStore is imported.
const __testDir = dirname(fileURLToPath(import.meta.url));
process.env.EMR_STATE_PATH = join(__testDir, '..', 'data', 'emr-state.multipatient-test.json');

import { resetEmrState } from '../scripts/reset.js';
import {
  getEmr,
  listPatients,
  ensurePatient,
  applyCommit,
} from '../lib/emrStore.js';
import { makeFieldRecord } from '../lib/fields.js';

const TS = '2026-08-08T06:30:00.000Z';

function approved(fieldId, value, sourceSpan = 'ציטוט') {
  return makeFieldRecord(fieldId, {
    value,
    sourceSpan,
    status: 'approved',
    committedValue: value,
  });
}

test.beforeEach(() => {
  resetEmrState();
});

test('the seed exposes the whole round, not a single bed', () => {
  const patients = listPatients();
  assert.ok(patients.length >= 2, 'expected multiple seeded patients');
  const ids = patients.map((p) => p.patientId);
  assert.equal(new Set(ids).size, ids.length, 'patient ids must be unique');
});

test('getEmr with no id still returns the first patient (single-patient behaviour preserved)', () => {
  const first = listPatients()[0];
  assert.equal(getEmr().patientId, first.patientId);
});

test('getEmr rejects an unknown patient and names the known ones', () => {
  assert.throws(() => getEmr('does-not-exist'), /Unknown patientId/);
});

test("committing to one patient does not touch another patient's note", () => {
  const [a, b] = listPatients();

  applyCommit(a.patientId, [approved('objective.vitals.bp', 'לחץ דם 128/78')], TS);
  applyCommit(b.patientId, [approved('objective.vitals.bp', 'לחץ דם 110/68')], TS);

  // The exact contamination that a single shared note produced.
  assert.equal(getEmr(a.patientId).note['objective.vitals.bp'].committedValue, 'לחץ דם 128/78');
  assert.equal(getEmr(b.patientId).note['objective.vitals.bp'].committedValue, 'לחץ דם 110/68');
});

test("one patient's medications never appear in another's chart", () => {
  const [a, b] = listPatients();

  applyCommit(a.patientId, [approved('decisions.medications', 'Paracetamol 1 גרם כל 6 שעות')], TS);
  applyCommit(b.patientId, [approved('decisions.medications', 'Metronidazole ו-Cefuroxime')], TS);

  const noteA = JSON.stringify(getEmr(a.patientId).note);
  const noteB = JSON.stringify(getEmr(b.patientId).note);
  assert.ok(!noteA.includes('Metronidazole'), "patient A's chart must not contain B's antibiotics");
  assert.ok(!noteB.includes('Paracetamol'), "patient B's chart must not contain A's analgesia");
});

test('each patient keeps a separate audit log', () => {
  const [a, b] = listPatients();

  applyCommit(a.patientId, [approved('plan.plan', 'שתי הליכות היום')], TS);
  applyCommit(b.patientId, [approved('plan.plan', 'לעיסת מסטיק כל שלוש שעות')], TS);

  const auditA = getEmr(a.patientId).auditLog;
  const auditB = getEmr(b.patientId).auditLog;
  assert.equal(auditA.length, 1);
  assert.equal(auditB.length, 1);
  assert.equal(auditA[0].finalValue, 'שתי הליכות היום');
  assert.equal(auditB[0].finalValue, 'לעיסת מסטיק כל שלוש שעות');
});

test('several distinct findings for one field are all kept, not silently overwritten', () => {
  // A round genuinely produces three separate plan items for one patient. The
  // old note[fieldId] = ... assignment kept only the last, losing two orders.
  const { patientId } = listPatients()[0];
  const { auditEntries } = applyCommit(
    patientId,
    [
      approved('plan.plan', 'לעיסת מסטיק כל שלוש שעות'),
      approved('plan.plan', 'ייעוץ גסטרואנטרולוגיה אם אין פעילות מעיים עד מחר'),
      approved('plan.plan', 'לוודא ביקור מרדימים בנוגע לאפידורל'),
    ],
    TS,
  );

  const value = getEmr(patientId).note['plan.plan'].committedValue;
  assert.ok(value.includes('מסטיק'), 'first plan item must survive');
  assert.ok(value.includes('גסטרואנטרולוגיה'), 'second plan item must survive');
  assert.ok(value.includes('אפידורל'), 'third plan item must survive');

  // Provenance stays per-utterance: three orders, three audit entries, each
  // with its own value rather than the merged note text.
  assert.equal(auditEntries.length, 3);
  assert.equal(auditEntries[0].finalValue, 'לעיסת מסטיק כל שלוש שעות');
});

test('a later commit replaces the field rather than appending forever', () => {
  const { patientId } = listPatients()[0];
  applyCommit(patientId, [approved('objective.vitals.hr', 'דופק 82')], TS);
  applyCommit(patientId, [approved('objective.vitals.hr', 'דופק 88')], TS);
  assert.equal(getEmr(patientId).note['objective.vitals.hr'].committedValue, 'דופק 88');
});

test('ensurePatient opens a provisional chart for a bed that is not seeded', () => {
  const before = listPatients().length;
  const rec = ensurePatient('9990001', { nameHe: 'משה ישראלי' });

  assert.equal(rec.patientId, '9990001');
  assert.equal(rec.provisional, true);
  assert.equal(listPatients().length, before + 1);

  applyCommit('9990001', [approved('plan.plan', 'ניטור')], TS);
  assert.equal(getEmr('9990001').note['plan.plan'].committedValue, 'ניטור');
});

test('ensurePatient is idempotent and never clobbers an existing chart', () => {
  const { patientId } = listPatients()[0];
  applyCommit(patientId, [approved('plan.plan', 'תוכנית קיימת')], TS);

  const again = ensurePatient(patientId, { nameHe: 'שם אחר' });
  assert.equal(again.note['plan.plan'].committedValue, 'תוכנית קיימת');
  assert.equal(again.provisional, undefined, 'a seeded patient must not become provisional');
});

test('committing to an unknown patient throws instead of creating one silently', () => {
  assert.throws(
    () => applyCommit('no-such-bed', [approved('plan.plan', 'x')], TS),
    /Unknown patientId/,
  );
});
