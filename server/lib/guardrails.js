// server/lib/guardrails.js
//
// Layer 3 of the safety pipeline (spec §6): pure, deterministic guardrails.
// NO LLM, NO I/O. Given the raw transcript and the draft FieldRecords (with
// judge verdicts already attached), populate each field's `guardrail`
// sub-object: { passed, requiresConfirmation, messages[] }.
//
// This is the LLM-independent backstop — it catches the structurer/judge
// fabricating grounding, fires on every high-risk field regardless of what the
// LLM said, and range-checks numeric vitals. These three checks are the
// safety-critical, unit-testable core of the malpractice-prevention story.
//
// Owns the `guardrail` sub-object ONLY. Does not touch value/sourceSpan/judge.

import { FIELD_DEFS_BY_ID } from './fields.js';

/**
 * Light normalization for grounding comparison (spec §6 layer 3):
 *   - trim leading/trailing whitespace
 *   - collapse any run of internal whitespace (incl. newlines/tabs) to a
 *     single ASCII space
 * Hebrew letters, punctuation, and digits are preserved untouched — we ONLY
 * normalize whitespace so that transcript line-wrapping or double spaces don't
 * cause a false "not grounded" failure.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeForGrounding(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True if `value` is present (non-empty after trim). Used to decide whether a
 * field is "populated" and therefore subject to the grounding check.
 * @param {*} value
 * @returns {boolean}
 */
function hasValue(value) {
  return value != null && String(value).trim() !== '';
}

/**
 * Parse the leading numeric component of a vital value.
 * Handles "37.8", "98", "128/76" (systolic 128), "97 אחוז" → 97, etc.
 * Returns NaN if no leading number is present.
 * @param {*} value
 * @returns {number}
 */
function parseLeadingNumber(value) {
  if (value == null) return NaN;
  const m = String(value).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

/**
 * Apply the three deterministic guardrail checks to every field and populate
 * `field.guardrail`. Mutates and returns the same array.
 *
 * Pure: depends only on its arguments + the static FIELD_DEFS catalog. No I/O,
 * no randomness, no clock.
 *
 * @param {string} transcript  raw Hebrew transcript (verbatim)
 * @param {Array<object>} fields  draft FieldRecords (judge verdicts attached)
 * @returns {Array<object>} the same fields, with guardrail populated
 */
export function applyGuardrails(transcript, fields) {
  const normalizedTranscript = normalizeForGrounding(transcript);

  for (const field of fields) {
    const def = FIELD_DEFS_BY_ID[field.fieldId];
    const messages = [];
    let requiresConfirmation = false;
    let grounded = true; // grounding sub-result; drives `passed`

    const populated = hasValue(field.value);

    // ── Check 1: Grounding ────────────────────────────────────────────────
    // A populated field must have a sourceSpan that literally appears in the
    // transcript (after whitespace normalization). Empty or not-found span on a
    // populated field → not grounded → force confirmation. This kills
    // fabricated grounding (the core malpractice-prevention guardrail).
    if (populated) {
      const span = normalizeForGrounding(field.sourceSpan);
      if (span === '') {
        grounded = false;
        requiresConfirmation = true;
        messages.push('Field has a value but no source quote — not grounded in transcript.');
      } else if (!normalizedTranscript.includes(span)) {
        grounded = false;
        requiresConfirmation = true;
        messages.push('Source quote not found in transcript — not grounded in transcript.');
      }
    }

    // ── Check 2: High-risk fields always confirm ─────────────────────────
    // Medications/doses, imaging, procedures/surgery require explicit human
    // confirmation regardless of grounding or judge verdict (spec §6).
    if (def?.highRisk && populated) {
      requiresConfirmation = true;
      messages.push('High-risk field — explicit confirmation required before approval.');
    }

    // ── Check 3: Vitals range ────────────────────────────────────────────
    // Numeric vitals validated against plausible {min,max}. Out-of-range or
    // unparseable-but-populated → flag + force confirmation.
    if (def?.isVital && populated) {
      const range = def.range;
      const num = parseLeadingNumber(field.value);
      if (Number.isNaN(num)) {
        requiresConfirmation = true;
        messages.push('Vital value is not numeric — cannot range-check.');
      } else if (range && (num < range.min || num > range.max)) {
        requiresConfirmation = true;
        const unit = range.unit ? ` ${range.unit}` : '';
        messages.push(
          `Vital out of plausible range (${range.min}–${range.max}${unit}): ${num}.`,
        );
      }
    }

    field.guardrail = {
      // `passed` reflects the grounding gate specifically (the deterministic
      // "is this real?" check). High-risk confirmation and an out-of-range
      // vital still set requiresConfirmation, but a grounded value hasn't
      // "failed" — it just needs a human to sign off.
      passed: grounded,
      requiresConfirmation,
      messages,
    };
  }

  return fields;
}

export default applyGuardrails;
