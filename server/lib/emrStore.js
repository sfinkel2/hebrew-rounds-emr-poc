// server/lib/emrStore.js
//
// Mock Chameleon EMR records + audit logs (spec §5 "emr-store"). Backed by a
// JSON working-state file (server/data/emr-state.json), seeded from
// patient.seed.json.
//
// Exports:
//   listPatients()                            → [{ patientId, patient }]
//   getEmr(patientId)                         → one patient's EMR state object
//   ensurePatient(patientId, demographics)    → create a provisional record
//   applyCommit(patientId, approvedFields, timestamp) → { emrState, auditEntries }
//   seedEmrState() / resetEmrState()          → (re)seed working state from seed
//
// MULTI-PATIENT (a ward round visits several beds):
//   State is { patients: [ { patientId, patient, note, auditLog }, ... ] }.
//   Each patient keeps their OWN note and audit log — notes are never merged.
//   This is what makes per-patient segmentation (lib/segment.js) safe: two
//   patients' rounds can never collide on note[fieldId], because they are not
//   in the same note.
//
//   Legacy single-patient state/seed files (a bare { patientId, patient, note,
//   auditLog } object) are normalized on read, so an old emr-state.json or a
//   fork's seed still loads.
//
// Design notes:
//   - No DB, no auth (POC). The working-state file is the mutable store; the
//     seed file is the immutable baseline.
//   - applyCommit writes ONLY fields whose status === "approved", updates the
//     note, and appends one audit entry per committed field.
//   - Timestamps are passed in by the caller (route) so this module stays
//     deterministic and free of clock/randomness — important for unit tests.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getFieldDef } from './fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const seedPath = join(dataDir, 'patient.seed.json');

/**
 * Working-state file. Resolved per call (not captured at import) so a test file
 * can point at its own copy via EMR_STATE_PATH: `node --test` runs each test
 * FILE in its own process, and two processes resetting one shared state file
 * produce torn reads and lost updates.
 */
export function getStatePath() {
  return process.env.EMR_STATE_PATH || join(dataDir, 'emr-state.json');
}

/**
 * (Re)seed the working-state file from patient.seed.json. Validates the seed is
 * parseable JSON before writing so a corrupt seed fails loudly. Returns the
 * freshly-seeded state object.
 * @returns {object} the seeded EMR state
 */
export function seedEmrState() {
  const raw = readFileSync(seedPath, 'utf8');
  const seed = JSON.parse(raw); // parse validates
  writeStateFile(seed);
  return seed;
}

/** Alias matching the reset-script vocabulary (spec §9 `npm run reset`). */
export const resetEmrState = seedEmrState;

/**
 * Read the working EMR state from disk. If the working-state file is missing on
 * first read (e.g. fresh checkout, never started), seed it from the seed file
 * automatically.
 * @returns {object} the EMR state object
 */
function readState() {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    return seedEmrState();
  }
  const raw = readFileSync(statePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Persist the EMR state atomically: write a temp file alongside the target and
 * rename it into place. rename() is atomic, so a concurrent reader sees either
 * the old file or the new one — never a half-written one. A plain writeFileSync
 * truncates first, so any reader landing in that window gets invalid JSON.
 */
function writeStateFile(state) {
  const statePath = getStatePath();
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, statePath);
}

/** Persist the EMR state object to the working-state file. */
function writeState(state) {
  writeStateFile(state);
}

/**
 * Coerce either shape into the multi-patient shape:
 *   { patients: [ { patientId, patient, note, auditLog }, ... ] }
 * A legacy bare single-patient object becomes a one-element list.
 * @param {object} state
 * @returns {{patients: object[]}}
 */
function normalizeState(state) {
  if (state && Array.isArray(state.patients)) return state;
  if (state && state.patientId) return { patients: [state] };
  return { patients: [] };
}

/** Ensure a patient record has its mutable sub-objects. */
function hydrate(record) {
  if (record.note == null || typeof record.note !== 'object') record.note = {};
  if (!Array.isArray(record.auditLog)) record.auditLog = [];
  return record;
}

/**
 * All patients on the round, for the patient picker.
 * @returns {Array<{patientId: string, patient: object}>}
 */
export function listPatients() {
  return normalizeState(readState()).patients.map((p) => ({
    patientId: p.patientId,
    patient: p.patient ?? {},
    provisional: Boolean(p.provisional),
  }));
}

/**
 * Get the full mock EMR record for `patientId`. With no id, returns the FIRST
 * seeded patient (preserves the original single-patient behaviour).
 * @param {string} [patientId]
 * @returns {object} EMR state { patientId, patient, note, auditLog }
 */
export function getEmr(patientId) {
  const { patients } = normalizeState(readState());
  if (patients.length === 0) {
    throw new Error('The mock EMR has no seeded patients.');
  }
  if (patientId == null) return hydrate(patients[0]);

  const found = patients.find((p) => String(p.patientId) === String(patientId));
  if (!found) {
    const known = patients.map((p) => p.patientId).join(', ');
    throw new Error(`Unknown patientId "${patientId}" (known patients: ${known}).`);
  }
  return hydrate(found);
}

/**
 * Create a provisional record for a patient who was discussed on the round but
 * is not in the seed — e.g. a bed from an arbitrary Plaud recording. Returns
 * the existing record unchanged if the id is already known.
 *
 * Marked `provisional: true` so the UI can show that this chart was opened by
 * the demo rather than pre-existing in the mock EMR.
 *
 * @param {string} patientId
 * @param {{nameHe?: string, name?: string}} [demographics]
 * @returns {object} the patient's EMR record
 */
export function ensurePatient(patientId, demographics = {}) {
  if (typeof patientId !== 'string' || patientId.trim() === '') {
    throw new Error('ensurePatient requires a non-empty patientId.');
  }
  const state = normalizeState(readState());
  const existing = state.patients.find((p) => String(p.patientId) === String(patientId));
  if (existing) return hydrate(existing);

  const record = hydrate({
    patientId,
    provisional: true,
    patient: {
      name: demographics.name ?? '',
      nameHe: demographics.nameHe ?? '',
      mrn: patientId,
      ward: 'General Surgery',
      wardHe: 'כירורגיה כללית',
      lines: [],
      linesHe: [],
      ...demographics,
    },
    note: {},
    auditLog: [],
  });
  state.patients.push(record);
  writeState(state);
  return record;
}

/**
 * Commit approved fields into the EMR note and append audit entries.
 *
 * Only fields with status === "approved" are written; all others are ignored
 * (the route/UI hard gate already filters, but we enforce it here too). Each
 * committed field:
 *   - writes note[fieldId] = { value, committedValue }  (the approved value)
 *   - appends one audit entry capturing the before/after + provenance
 *
 * The field's `committedValue` (its final approved/edited value) is the value
 * written. We fall back to `value` when `committedValue` is null/empty so the
 * caller can either set committedValue explicitly or rely on value.
 *
 * @param {string} patientId
 * @param {Array<object>} approvedFields  FieldRecords (only approved are written)
 * @param {string} timestamp  ISO timestamp supplied by the caller (route)
 * @returns {{ emrState: object, auditEntries: Array<object> }}
 */
export function applyCommit(patientId, approvedFields, timestamp) {
  const state = normalizeState(readState());
  const record = state.patients.find((p) => String(p.patientId) === String(patientId));
  if (!record) {
    const known = state.patients.map((p) => p.patientId).join(', ');
    throw new Error(`Unknown patientId "${patientId}" (known patients: ${known}).`);
  }
  hydrate(record);

  const ts = timestamp ?? new Date().toISOString();
  const auditEntries = [];
  // Field ids already written by THIS commit. A round legitimately produces
  // several distinct records for one field (three separate plan items, say).
  // Overwriting would silently drop all but the last, so within one commit we
  // APPEND. Across separate commits, a later commit still replaces (that is an
  // edit of the note, not a second finding).
  const writtenThisCommit = new Set();

  for (const field of approvedFields || []) {
    if (!field || field.status !== 'approved') continue;
    if (!getFieldDef(field.fieldId)) continue; // ignore unknown fieldIds

    const originalValue = field.value ?? null; // the LLM-extracted value
    // Final value = explicit committedValue if set, else the extracted value.
    const committed =
      field.committedValue != null && String(field.committedValue).trim() !== ''
        ? field.committedValue
        : field.value;

    const priorThisCommit = writtenThisCommit.has(field.fieldId)
      ? record.note[field.fieldId]?.committedValue
      : null;
    const finalValue =
      priorThisCommit != null && String(priorThisCommit).trim() !== ''
        ? `${priorThisCommit}; ${committed}`
        : committed;

    record.note[field.fieldId] = {
      value: finalValue,
      committedValue: finalValue,
    };
    writtenThisCommit.add(field.fieldId);

    // The audit entry records THIS field's own value and quote, not the merged
    // note text — provenance stays per-utterance even when the note merges.
    const entry = {
      fieldId: field.fieldId,
      finalValue: committed,
      originalValue,
      sourceSpan: field.sourceSpan ?? '',
      judgeVerdict: field.judge?.verdict ?? null,
      approver: 'clinician (demo)',
      timestamp: ts,
    };
    record.auditLog.push(entry);
    auditEntries.push(entry);
  }

  writeState(state);
  return { emrState: record, auditEntries };
}

export default { getEmr, listPatients, ensurePatient, applyCommit, seedEmrState, resetEmrState };
