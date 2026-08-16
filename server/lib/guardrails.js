// server/lib/guardrails.js
//
// Layer 3 of the safety pipeline (spec §6): pure, deterministic guardrails.
// NO LLM, NO I/O. Given the raw transcript and the draft FieldRecords (with
// judge verdicts already attached), populate each field's `guardrail`
// sub-object: { passed, requiresConfirmation, messages[] }.
//
// This is the LLM-independent backstop — it catches the structurer/judge
// fabricating grounding, catches a quote that does not support the value it is
// attached to, fires on every high-risk field regardless of what the LLM said,
// and range-checks numeric vitals. These checks are the safety-critical,
// unit-testable core of the malpractice-prevention story.
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
 * Units of measure and formatting tokens. A value may legitimately spell out a
 * unit the speaker never said ("110/68 mmHg" from "לחץ דם 110 על 68"), so these
 * are exempt from the coverage check below. Clinically meaningful abbreviations
 * (CT, MRI, IV, PRN) are deliberately NOT here — if the note claims a CT and the
 * quote never mentions one, that is exactly what we want to catch.
 */
const UNIT_TOKENS = new Set([
  'mmhg', 'bpm', 'mg', 'mcg', 'ml', 'cc', 'kg', 'cm', 'mm', 'iu', 'meq', 'hg',
]);

/**
 * Tokens in a value that its source quote ought to account for: numbers and
 * Latin-script words (doses, drug names, lab names).
 *
 * Hebrew wording is deliberately ignored — the structurer is instructed to
 * rewrite spoken Hebrew into clinical register, so the words legitimately
 * differ from the transcript. What it must NOT do is introduce a number or a
 * drug the quote never mentions.
 *
 * @param {*} text
 * @returns {string[]} unique risk-bearing tokens
 */
function riskTokens(text) {
  const s = String(text ?? '');
  const numbers = s.match(/\d+(?:\.\d+)?/g) || [];
  // 2+ letters, so two-letter clinical abbreviations (CT, IV, PO) are covered —
  // an imaging order the quote never mentions is exactly what this must catch.
  const latin = s.match(/[A-Za-z][A-Za-z-]+/g) || [];
  const all = [...numbers, ...latin].filter((tk) => !UNIT_TOKENS.has(tk.toLowerCase()));
  return [...new Set(all)];
}

/**
 * Is `token` present in `haystack` as a standalone token rather than buried
 * inside a longer run of the same character class?
 *
 * A plain substring test is not enough, and the failure is real: a blood
 * pressure written as "122/74" from audio that says "לחץ דם יציב 12274" passed,
 * because both "122" and "74" are substrings of "12274". The note invented a
 * split the recording never contained, and the check waved it through.
 *
 * Digits must therefore not be flanked by digits, and Latin words must not be
 * flanked by letters.
 */
function containsToken(haystack, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = /^\d/.test(token) ? '\\d' : '[A-Za-z]';
  return new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`).test(haystack);
}

/**
 * Apply the deterministic guardrail checks to every field and populate
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

    // ── Check 1b: Does the quote actually SUPPORT the value? ─────────────
    // Check 1 asks "is this quote real?" — a substring test. It cannot ask
    // "does this quote back up what the note claims?", and that gap is not
    // theoretical: evaluating the real ward round caught a blood pressure of
    // "128/78" written from audio that says "לחץ דם ה-28 ל-78". The 128 was
    // never spoken. The quote was genuine, so check 1 passed it; the judge
    // called it grounded; and a fabricated vital reached the note wearing
    // real provenance.
    //
    // Worse, it fabricated its way AROUND check 3: a faithful systolic of 28
    // is out of range and would have been held for a human. "Repairing" it to
    // 128 made it plausible enough to sail through.
    //
    // So: every number and Latin-script token in the value must appear in the
    // quote. This forces confirmation rather than failing grounding — the
    // quote IS real, which is what `passed` records; what is unverified is
    // whether it supports the claim, and that is a human's call.
    if (populated && grounded) {
      const span = normalizeForGrounding(field.sourceSpan);
      const missing = riskTokens(field.value).filter((tk) => !containsToken(span, tk));
      if (missing.length) {
        requiresConfirmation = true;
        messages.push(
          `Source quote does not mention: ${missing.join(', ')} — value not fully supported by its quote.`,
        );
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
