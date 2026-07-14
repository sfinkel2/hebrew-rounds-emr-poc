// server/lib/emrStore.js
//
// Mock Chameleon EMR record + audit log for the single seeded patient
// (spec §5 "emr-store"). Backed by a JSON working-state file
// (server/data/emr-state.json), seeded from patient.seed.json.
//
// Exports:
//   getEmr(patientId)                         → the EMR state object
//   applyCommit(patientId, approvedFields, timestamp) → { emrState, auditEntries }
//   seedEmrState() / resetEmrState()          → (re)seed working state from seed
//
// Design notes:
//   - No DB, no auth (POC). Single patient. The working-state file is the
//     mutable store; the seed file is the immutable baseline.
//   - applyCommit writes ONLY fields whose status === "approved", updates the
//     note, and appends one audit entry per committed field.
//   - Timestamps are passed in by the caller (route) so this module stays
//     deterministic and free of clock/randomness — important for unit tests.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getFieldDef } from './fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const seedPath = join(dataDir, 'patient.seed.json');
const statePath = join(dataDir, 'emr-state.json');

/**
 * (Re)seed the working-state file from patient.seed.json. Validates the seed is
 * parseable JSON before writing so a corrupt seed fails loudly. Returns the
 * freshly-seeded state object.
 * @returns {object} the seeded EMR state
 */
export function seedEmrState() {
  const raw = readFileSync(seedPath, 'utf8');
  const seed = JSON.parse(raw); // parse validates
  writeFileSync(statePath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
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
  if (!existsSync(statePath)) {
    return seedEmrState();
  }
  const raw = readFileSync(statePath, 'utf8');
  return JSON.parse(raw);
}

/** Persist the EMR state object to the working-state file. */
function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Get the full mock EMR record for `patientId`. Throws if the requested patient
 * id does not match the seeded patient (single-patient POC).
 * @param {string} patientId
 * @returns {object} EMR state { patientId, patient, note, auditLog }
 */
export function getEmr(patientId) {
  const state = readState();
  if (patientId != null && String(patientId) !== String(state.patientId)) {
    throw new Error(
      `Unknown patientId "${patientId}" (this POC serves only "${state.patientId}").`,
    );
  }
  return state;
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
  const state = getEmr(patientId);

  if (!Array.isArray(state.auditLog)) state.auditLog = [];
  if (state.note == null || typeof state.note !== 'object') state.note = {};

  const ts = timestamp ?? new Date().toISOString();
  const auditEntries = [];

  for (const field of approvedFields || []) {
    if (!field || field.status !== 'approved') continue;
    if (!getFieldDef(field.fieldId)) continue; // ignore unknown fieldIds

    const prior = state.note[field.fieldId] || {};
    const originalValue = field.value ?? null; // the LLM-extracted value
    // Final value = explicit committedValue if set, else the extracted value.
    const finalValue =
      field.committedValue != null && String(field.committedValue).trim() !== ''
        ? field.committedValue
        : field.value;

    state.note[field.fieldId] = {
      value: finalValue,
      committedValue: finalValue,
    };

    const entry = {
      fieldId: field.fieldId,
      finalValue,
      originalValue,
      sourceSpan: field.sourceSpan ?? '',
      judgeVerdict: field.judge?.verdict ?? null,
      approver: 'clinician (demo)',
      timestamp: ts,
    };
    state.auditLog.push(entry);
    auditEntries.push(entry);
    // priorValue retained for potential future diffing; not part of the spec'd
    // audit shape, so intentionally not emitted.
    void prior;
  }

  writeState(state);
  return { emrState: state, auditEntries };
}

export default { getEmr, applyCommit, seedEmrState, resetEmrState };
