// server/routes/emr.js
//
// GET /api/emr/:patientId   → the mock Chameleon EMR record for the patient
// GET /api/emr              → the seeded single-patient record (no id)
//
// Read-only surface over lib/emrStore.getEmr (spec §5 emr-store). The frontend's
// emr-view / patient-header load the BEFORE state from here (spec §7 step 1) and
// re-load the AFTER state following a commit. This is the integration glue that
// exposes the spec'd emr-store.getEmr() function over HTTP — it invents no new
// data contract; it returns the same { patientId, patient, note, auditLog }
// object the commit route already returns as `emrState`.
//
// Never touches LLM keys, so it is always available in MOCK mode.

import { Router } from 'express';
import { getEmr } from '../lib/emrStore.js';

const router = Router();

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
