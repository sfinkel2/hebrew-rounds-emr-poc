// server/routes/judge.js
//
// POST /api/judge  { transcript, fields } → { fields: FieldRecord[] }
//
// Three server-side steps, in order (spec §5 — the judge route OWNS merging the
// verdicts and running the guardrails):
//   1. judgeNote(transcript, fields) — the separate adversarial Claude call.
//      Per lib/llm.js it returns VERDICTS ONLY: [{ fieldId, verdict, reason,
//      highRisk }], NOT full records.
//   2. Merge each verdict into its draft FieldRecord's `judge` sub-object,
//      keyed by fieldId (the judge owns the `judge` sub-object).
//   3. applyGuardrails(transcript, fields) — pure deterministic checks. Owns the
//      `guardrail` sub-object: grounding (sourceSpan literally in transcript),
//      high-risk force-confirm, and vitals range checks.
//
// Returns the fully-populated FieldRecord[] (judge verdicts + guardrail results
// merged in). On malformed LLM output judgeNote throws and we return a clear
// error rather than a partial note (spec §5 / §8).

import { Router } from 'express';
import { judgeNote } from '../lib/llm.js';
import { applyGuardrails } from '../lib/guardrails.js';
import { makeFieldRecord } from '../lib/fields.js';

const router = Router();

router.post('/judge', async (req, res) => {
  const { transcript, fields } = req.body ?? {};

  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Request body must include a non-empty `transcript` string.',
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

  try {
    // 1. Adversarial Claude judge returns verdicts only: [{ fieldId, verdict,
    //    reason, highRisk }].
    const verdicts = await judgeNote(transcript, fields);

    if (!Array.isArray(verdicts)) {
      return res.status(502).json({
        error: {
          code: 'judge_malformed',
          message: 'The judge model did not return a verdicts array.',
        },
      });
    }

    // 2. Merge each verdict into its draft record's `judge` sub-object, keyed by
    //    fieldId. makeFieldRecord deep-merges judge/guardrail so we preserve the
    //    draft's value/sourceSpan/confidence while overlaying the verdict.
    const verdictsById = new Map(
      verdicts.filter((v) => v && v.fieldId).map((v) => [v.fieldId, v]),
    );
    const merged = fields.map((f) => {
      const v = verdictsById.get(f.fieldId);
      if (!v) return f;
      return makeFieldRecord(f.fieldId, {
        ...f,
        judge: {
          ...(f.judge || {}),
          verdict: v.verdict,
          reason: v.reason,
          highRisk: v.highRisk,
        },
      });
    });

    // 3. Deterministic guardrails run server-side (spec §5: judge owns this).
    const guarded = applyGuardrails(transcript, merged);

    res.json({ fields: guarded });
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'judge_failed',
        message: `Judging failed: ${err.message}`,
      },
    });
  }
});

export default router;
