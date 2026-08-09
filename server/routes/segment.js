// server/routes/segment.js
//
// POST /api/segment  { transcript } → { segments: [{ index, patientLabel, transcript, startOffset, endOffset }] }
//
// Step 0 of the pipeline, ahead of /api/structure. Splits a ward round into one
// verbatim slice per patient so each bed is structured, judged and committed
// against its OWN chart (see lib/segment.js for why this must exist).
//
// The route deliberately returns slices only — it does NOT structure them. The
// client then runs the existing /api/structure + /api/judge pair once per
// segment, so the safety pipeline is unchanged and unaware it is being applied
// per patient.
//
// A model-invented boundary throws inside sliceByAnchors and surfaces as the
// shared { error: { code, message } } envelope rather than a mis-cut round.

import { Router } from 'express';
import { segmentTranscript, checkRoundCoverage } from '../lib/segment.js';

const router = Router();

router.post('/segment', async (req, res) => {
  const { transcript } = req.body ?? {};

  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Request body must include a non-empty `transcript` string.',
      },
    });
  }

  try {
    const segments = await segmentTranscript(transcript);

    // Belt and braces: every slice must be verbatim transcript text, or the
    // grounding guardrail downstream is checking spans against invented text.
    for (const seg of segments) {
      if (!transcript.includes(seg.transcript)) {
        return res.status(502).json({
          error: {
            code: 'segment_not_verbatim',
            message: `Segment ${seg.index + 1} is not a verbatim slice of the transcript.`,
          },
        });
      }
    }

    // Deterministic cross-check for a bed the model dropped. Reported, not
    // enforced: a missing patient is a "a human must look" signal, not a
    // malformed response, and refusing the whole round would lose the sections
    // that ARE correct.
    const coverage = checkRoundCoverage(transcript, segments);

    res.json({ segments, coverage });
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'segment_failed',
        message: `Segmentation failed: ${err.message}`,
      },
    });
  }
});

export default router;
