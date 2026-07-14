// server/routes/commit.js
//
// POST /api/commit  { patientId, fields } → { emrState, auditEntries }
//
// The hard gate's write step (spec §5 / §6). Only fields with status:"approved"
// may be persisted. We:
//   1. Validate the request and select the approved fields.
//   2. Reject with HTTP 400 if zero fields are approved (spec §8 — "Commit
//      attempted with zero approved fields: backend rejects").
//   3. Stamp a SERVER-provided ISO timestamp (the client never sets commit time).
//   4. Delegate to emrStore.applyCommit, which updates the mock Chameleon record
//      and appends audit entries. Returns the new EMR state + the audit entries
//      created by this commit.

import { Router } from 'express';
import { applyCommit } from '../lib/emrStore.js';

const router = Router();

router.post('/commit', async (req, res) => {
  const { patientId, fields } = req.body ?? {};

  if (typeof patientId !== 'string' || patientId.length === 0) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Request body must include a non-empty `patientId` string.',
      },
    });
  }
  if (!Array.isArray(fields)) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Request body must include a `fields` array.',
      },
    });
  }

  // Only approved fields are eligible for commit (spec §5/§6 hard gate).
  const approvedFields = fields.filter((f) => f && f.status === 'approved');

  if (approvedFields.length === 0) {
    return res.status(400).json({
      error: {
        code: 'no_approved_fields',
        message: 'Commit rejected: at least one field must have status "approved".',
      },
    });
  }

  // Server-provided timestamp — the client must not control the audit time.
  const committedAt = new Date().toISOString();

  try {
    const result = await applyCommit(patientId, approvedFields, committedAt);
    const { emrState, auditEntries } = result ?? {};

    res.json({ emrState, auditEntries });
  } catch (err) {
    // Unknown patient or store failure surfaces through the common envelope.
    res.status(500).json({
      error: {
        code: 'commit_failed',
        message: `Commit failed: ${err.message}`,
      },
    });
  }
});

export default router;
