// server/tests/commit.test.js
//
// Unit tests for the commit / emr-store layer (spec §5 emr-store, §6.4-§6.5,
// §10). Verifies the hard-gate semantics:
//   - Only fields with status === "approved" persist into the EMR record.
//   - Non-approved fields (pending / rejected / edited-but-not-approved) are
//     excluded.
//   - An audit entry is created per committed field with the required keys
//     (final value, original extracted value, transcript span, judge verdict,
//     approver, timestamp).
//   - Committing zero approved fields is rejected / produces no writes.
//
// Hermetic: the working state file is reseeded from patient.seed.json before
// and after every test (no API keys, no network).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resetEmrState } from '../scripts/reset.js';
import * as emrStoreModule from '../lib/emrStore.js';
import { makeFieldRecord } from '../lib/fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

const seed = JSON.parse(readFileSync(join(dataDir, 'patient.seed.json'), 'utf8'));
// The seed carries a ward round's worth of patients ({ patients: [...] }); older
// single-patient seeds were a bare record. Commit semantics are per-patient, so
// these tests exercise the first seeded patient either way.
const PATIENT_ID = Array.isArray(seed.patients) ? seed.patients[0].patientId : seed.patientId;

// Resolve the spec §5 emr-store interface whether it is exposed as named
// exports (getEmr / applyCommit), a default object, or a named `emrStore`.
const store = emrStoreModule.emrStore || emrStoreModule.default || emrStoreModule;
const getEmr = (emrStoreModule.getEmr || store.getEmr).bind(store);
const applyCommit = (emrStoreModule.applyCommit || store.applyCommit).bind(store);

// Reseed (and reload, if the store caches) before and after each test so the
// tests are order-independent and leave no residue.
function reseed() {
  resetEmrState();
  // If the store exposes a reload/reset hook, use it so in-memory state matches
  // the freshly reseeded file. Otherwise getEmr is assumed to read the file.
  if (typeof store.reload === 'function') store.reload(PATIENT_ID);
  else if (typeof store.reset === 'function') store.reset(PATIENT_ID);
}

beforeEach(reseed);
afterEach(reseed);

/** Build an approved FieldRecord ready to commit. */
function approvedField(fieldId, value, sourceSpan, verdict = 'grounded') {
  return makeFieldRecord(fieldId, {
    value,
    sourceSpan,
    confidence: 0.9,
    judge: { verdict, reason: 'test', highRisk: false },
    status: 'approved',
  });
}

/** Pull the audit-log array out of whatever shape applyCommit returns / stores. */
function auditEntriesFromResult(result, emrAfter) {
  if (result && Array.isArray(result.auditEntries)) return result.auditEntries;
  if (emrAfter && Array.isArray(emrAfter.auditLog)) return emrAfter.auditLog;
  return [];
}

/** Resolve a value across a set of acceptable key aliases. */
function pick(obj, aliases) {
  for (const k of aliases) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

test('commit persists only approved fields and excludes non-approved ones', () => {
  const fields = [
    approvedField('plan.plan', 'תוכנית מאושרת', 'להתחיל נוזלים צלולים דרך הפה ולעקוב אחרי תפוקת הנקז'),
    approvedField(
      'objective.abdomen',
      'בטן רכה',
      'הבטן רכה, רגישות קלה סביב הצלקת הניתוחית, ללא סימני גירוי צפקי',
    ),
    // NOT approved — must be excluded:
    makeFieldRecord('objective.generalAppearance', {
      value: 'מצב כללי טוב',
      status: 'pending',
    }),
    makeFieldRecord('decisions.imaging', {
      value: 'צילום בטן',
      status: 'rejected',
    }),
  ];

  const result = applyCommit(PATIENT_ID, fields);
  const emr = getEmr(PATIENT_ID);
  const note = emr.note || emr.fields || emr;

  // Approved fields persisted with their committed value.
  assert.ok(note['plan.plan'], 'approved plan.plan must persist into the EMR note');
  assert.ok(note['objective.abdomen'], 'approved objective.abdomen must persist');

  // Non-approved fields were NOT written by this commit.
  assert.equal(
    note['objective.generalAppearance'],
    undefined,
    'a pending field must NOT be committed',
  );
  // decisions.imaging was not in the seed; a rejected field must not appear.
  assert.equal(note['decisions.imaging'], undefined, 'a rejected field must NOT be committed');

  // Sanity: the result reflects the same EMR state.
  if (result && result.emrState) {
    const rNote = result.emrState.note || result.emrState.fields || result.emrState;
    assert.ok(rNote['plan.plan'], 'returned emrState must include the committed field');
  }
});

test('commit creates one audit entry per committed field with the required keys', () => {
  const before = getEmr(PATIENT_ID);
  const beforeLog = (before.auditLog || []).length;

  const fields = [
    approvedField('plan.plan', 'תוכנית מאושרת', 'להתחיל נוזלים צלולים דרך הפה ולעקוב אחרי תפוקת הנקז'),
    approvedField('decisions.bloodTests', 'ספירת דם ואלקטרוליטים', 'ספירת דם ואלקטרוליטים'),
    // Not approved → must not produce an audit entry.
    makeFieldRecord('objective.generalAppearance', { value: 'x', status: 'pending' }),
  ];

  const result = applyCommit(PATIENT_ID, fields);
  const emr = getEmr(PATIENT_ID);
  const entries = auditEntriesFromResult(result, emr);

  // Either the returned auditEntries, or the growth of the persisted log, must
  // equal the number of approved fields (2).
  const newEntries =
    result && Array.isArray(result.auditEntries)
      ? result.auditEntries
      : (emr.auditLog || []).slice(beforeLog);
  assert.equal(newEntries.length, 2, 'exactly one audit entry per committed (approved) field');

  for (const e of newEntries) {
    // final value
    assert.ok(
      pick(e, ['finalValue', 'committedValue', 'value']) !== undefined,
      'audit entry must record the final/committed value',
    );
    // original extracted value
    assert.ok(
      pick(e, ['originalValue', 'extractedValue', 'originalExtractedValue']) !== undefined,
      'audit entry must record the original extracted value',
    );
    // transcript span
    assert.ok(
      pick(e, ['sourceSpan', 'transcriptSpan', 'span']) !== undefined,
      'audit entry must record the transcript source span',
    );
    // judge verdict
    assert.ok(
      pick(e, ['verdict', 'judgeVerdict']) !== undefined,
      'audit entry must record the judge verdict',
    );
    // approver
    assert.ok(
      pick(e, ['approver', 'approvedBy', 'user']) !== undefined,
      'audit entry must record the approver',
    );
    // timestamp
    assert.ok(
      pick(e, ['timestamp', 'committedAt', 'time', 'at']) !== undefined,
      'audit entry must record a timestamp',
    );
    // fieldId for traceability
    assert.ok(pick(e, ['fieldId']) !== undefined, 'audit entry must record the fieldId');
  }
});

test('committing zero approved fields is rejected / writes nothing', () => {
  const before = getEmr(PATIENT_ID);
  const beforeNoteKeys = Object.keys(before.note || {}).length;
  const beforeLog = (before.auditLog || []).length;

  const fields = [
    makeFieldRecord('plan.plan', { value: 'x', status: 'pending' }),
    makeFieldRecord('decisions.imaging', { value: 'y', status: 'rejected' }),
  ];

  let rejected = false;
  let result;
  try {
    result = applyCommit(PATIENT_ID, fields);
  } catch {
    rejected = true; // throwing on zero-approved is an acceptable rejection
  }

  const after = getEmr(PATIENT_ID);
  const afterNoteKeys = Object.keys(after.note || {}).length;
  const afterLog = (after.auditLog || []).length;

  // No new note fields and no new audit entries were written.
  assert.equal(afterNoteKeys, beforeNoteKeys, 'zero-approved commit must not add note fields');
  assert.equal(afterLog, beforeLog, 'zero-approved commit must not add audit entries');

  // And either it threw, OR it returned an empty/no-op result.
  if (!rejected) {
    const committed =
      (result && Array.isArray(result.auditEntries) && result.auditEntries.length) || 0;
    assert.equal(committed, 0, 'zero-approved commit must report no committed entries');
  }
});
