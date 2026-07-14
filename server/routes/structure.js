// server/routes/structure.js
//
// POST /api/structure  { transcript } → { fields: FieldRecord[] }
//
// Runs the Claude grounded-extraction pass (lib/llm.js → structureNote) over the
// Hebrew transcript. Returns FieldRecord[] with value / sourceSpan / confidence
// populated and judge / guardrail / committedValue at their default/empty values
// (spec §5). The judge verdicts and guardrail results are attached later by the
// separate POST /api/judge call.
//
// On malformed LLM output structureNote throws; we surface a clear error rather
// than a partial or guessed note (spec §5 / §8).

import { Router } from 'express';
import { structureNote } from '../lib/llm.js';

const router = Router();

router.post('/structure', async (req, res) => {
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
    // structureNote returns { fields: FieldRecord[] } (lib/llm.js contract).
    const result = await structureNote(transcript);
    const fields = result?.fields;

    if (!Array.isArray(fields)) {
      return res.status(502).json({
        error: {
          code: 'structure_malformed',
          message: 'The structuring model did not return a fields array.',
        },
      });
    }

    res.json({ fields });
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'structure_failed',
        message: `Structuring failed: ${err.message}`,
      },
    });
  }
});

export default router;
