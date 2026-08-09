// server/routes/emr.js
//
// GET /api/emr/:patientId   → the mock Chameleon EMR record for the patient
// GET /api/emr              → the seeded single-patient record (no id)
//
// POST /api/patients          → open a provisional chart for a bed not in the seed
//
// Mostly a read-only surface over lib/emrStore.getEmr (spec §5 emr-store), plus
// the one mutation that belongs with the patient registry: a real round visits
// beds the demo seed has never heard of, and those need somewhere to commit to.
// The frontend's
// emr-view / patient-header load the BEFORE state from here (spec §7 step 1) and
// re-load the AFTER state following a commit. This is the integration glue that
// exposes the spec'd emr-store.getEmr() function over HTTP — it invents no new
// data contract; it returns the same { patientId, patient, note, auditLog }
// object the commit route already returns as `emrState`.
//
// Never touches LLM keys, so it is always available in MOCK mode.

import { Router } from 'express';
import { getEmr, listPatients, ensurePatient } from '../lib/emrStore.js';

const router = Router();

// GET /api/patients → every bed on the round, for the patient picker.
// Registered before /emr/:patientId so it is never captured by that param.
router.get('/patients', (req, res) => {
  try {
    res.json({ patients: listPatients() });
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'emr_unavailable',
        message: err?.message || 'Could not read the mock EMR.',
      },
    });
  }
});

/**
 * Next free MRN. Derived from existing records rather than random so the store
 * stays deterministic for tests — the ROUTE mints ids, the way it stamps commit
 * timestamps, and lib/emrStore stays free of clock and randomness.
 */
function nextPatientId() {
  const numeric = listPatients()
    .map((p) => Number.parseInt(p.patientId, 10))
    .filter((n) => Number.isFinite(n));
  return String((numeric.length ? Math.max(...numeric) : 5582930) + 1);
}

// POST /api/patients { nameHe?, name?, patientId? } → open a provisional chart.
//
// A real ward round visits beds that are not in the demo seed. Rather than
// silently inventing a chart at commit time — which would let a mis-attributed
// segment create a phantom patient with no one noticing — the reviewer asks for
// it explicitly and the record is marked `provisional`.
router.post('/patients', (req, res) => {
  const { patientId, nameHe, name } = req.body ?? {};

  if (!String(nameHe ?? '').trim() && !String(name ?? '').trim() && !String(patientId ?? '').trim()) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Provide at least a patient name (`nameHe` or `name`) or an explicit `patientId`.',
      },
    });
  }

  try {
    const id = String(patientId ?? '').trim() || nextPatientId();
    const record = ensurePatient(id, {
      ...(nameHe ? { nameHe: String(nameHe).trim() } : {}),
      ...(name ? { name: String(name).trim() } : {}),
    });
    res.status(201).json({
      patientId: record.patientId,
      patient: record.patient,
      provisional: Boolean(record.provisional),
    });
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'patient_create_failed',
        message: `Could not open a chart: ${err.message}`,
      },
    });
  }
});

function handle(req, res) {
  const { patientId } = req.params;
  try {
    // getEmr(undefined) returns the single seeded patient; an explicit id is
    // validated against the seeded patient inside getEmr (throws on mismatch).
    const emrState = getEmr(patientId);
    res.json(emrState);
  } catch (err) {
    res.status(404).json({
      error: {
        code: 'emr_not_found',
        message: err?.message || 'EMR record not found.',
      },
    });
  }
}

router.get('/emr/:patientId', handle);
router.get('/emr', handle);

export default router;
