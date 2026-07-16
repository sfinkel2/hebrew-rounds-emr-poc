// server/lib/llm.js
//
// LLM + STT client wrappers and prompts (spec §5, §6). Three exports:
//
//   transcribeAudio(audioBuffer)        → Hebrew transcript (OpenAI Whisper)
//   structureNote(transcript)           → { fields: FieldRecord[] } (Claude extract)
//   judgeNote(transcript, fields)       → judge verdicts as { fieldId, verdict, reason, highRisk }[]
//
// MODE SELECTION (spec §2 mock mode):
//   Each function runs in MOCK mode when its relevant API key is absent OR
//   process.env.DEMO_MODE === "mock". In mock mode it returns the canned,
//   deterministic responses tied to the scripted round (server/data/mock-llm.json
//   for structure/judge; scripted-round.json.transcript for transcribe).
//   Otherwise it calls the real API.
//
// SAFETY (spec §6 layer 1 & 2):
//   - structureNote's system prompt FORBIDS inferring unstated facts and
//     REQUIRES per field: value + exact verbatim Hebrew sourceSpan + confidence.
//   - judgeNote is a SEPARATE adversarial Claude call that distrusts the
//     extractor.
//   Both request STRUCTURED JSON output. On malformed model output we throw a
//   clear Error (routes convert it to the spec §5 error envelope).
//
// This module owns value/sourceSpan/confidence (structure) and the judge
// sub-object (judge). It does NOT run guardrails (that's guardrails.js, called
// by the judge route) and does NOT touch the EMR store.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeFieldRecord, isKnownField, JUDGE_VERDICTS } from './fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

// Claude model id (current Anthropic guidance: default to Opus 4.8; use the
// bare alias, never a date-suffixed variant). Overridable per demo via the
// CLAUDE_MODEL env var (e.g. claude-haiku-4-5 for a cheaper/faster run).
// A current fallback is used if the exact id is unavailable in the account.
//
// Opus 4.7+ API constraints honored throughout this module — keep them when
// editing (each would return HTTP 400 if violated):
//   - thinking must be { type: "adaptive" } (budget_tokens is removed);
//     Haiku 4.5 predates adaptive thinking, so the param is omitted there
//   - no temperature / top_p / top_k sampling parameters
//   - no assistant-turn prefills; structured output goes through
//     output_config.format (json_schema) instead
const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || '').trim() || 'claude-opus-4-8';
const CLAUDE_MODEL_FALLBACK = 'claude-sonnet-4-6';
const WHISPER_MODEL = 'whisper-1';

// Non-streaming max_tokens. Adaptive-thinking tokens count against this cap,
// so a low value can truncate mid-thought; ~16K is the recommended ceiling for
// non-streaming requests (above that, stream instead).
const CLAUDE_MAX_TOKENS = 16000;

// ── Data loaders (lazy + cached) ───────────────────────────────────────────

let _mockLlm = null;
function loadMockLlm() {
  if (_mockLlm == null) {
    _mockLlm = JSON.parse(readFileSync(join(dataDir, 'mock-llm.json'), 'utf8'));
  }
  return _mockLlm;
}

let _scriptedRound = null;
function loadScriptedRound() {
  if (_scriptedRound == null) {
    _scriptedRound = JSON.parse(
      readFileSync(join(dataDir, 'scripted-round.json'), 'utf8'),
    );
  }
  return _scriptedRound;
}

// ── Mode helpers ───────────────────────────────────────────────────────────

/** True if mock mode is forced via DEMO_MODE=mock. */
function forcedMock() {
  return String(process.env.DEMO_MODE || '').toLowerCase() === 'mock';
}

function hasAnthropicKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** Transcribe uses mock when forced or when no OpenAI key is present. */
export function isTranscribeMock() {
  return forcedMock() || !hasOpenAIKey();
}

/** Structure/judge use mock when forced or when no Anthropic key is present. */
export function isClaudeMock() {
  return forcedMock() || !hasAnthropicKey();
}

// ── Lazy SDK client construction (only when going live) ─────────────────────

let _anthropic = null;
async function getAnthropic() {
  if (_anthropic == null) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

let _openai = null;
async function getOpenAI() {
  if (_openai == null) {
    const { default: OpenAI } = await import('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// ── Prompts ──────────────────────────────────────────────────────────────

const STRUCTURE_SYSTEM_PROMPT = `You are a clinical scribe that converts a verbatim Hebrew morning-round transcript from a general-surgery ward into a structured rounds note.

ABSOLUTE RULES — these protect patient safety:
1. NEVER infer, normalize, assume, or invent any clinical fact that is not EXPLICITLY stated in the transcript. If a field was not spoken, OMIT it entirely (do not output a record for it).
2. For every field you DO output, provide:
   - "value": the clinical content, in Hebrew, written in professional EMR register: third person only (never first/second person — "המטופל מדווח על כאב", not "יש לי כאב"), accepted clinical terminology instead of colloquial phrasing, concise chart style (no conversational filler, greetings, or hedging). Rephrase the WORDING into clinical language, but the FACTS must remain exactly what was said — no added, dropped, or normalized clinical content (rule 1 still applies to facts).
   - "sourceSpan": an EXACT, VERBATIM substring copied character-for-character from the transcript that supports the value. It MUST appear literally in the transcript. Do NOT paraphrase, translate, summarize, or reword the sourceSpan. If you cannot find a verbatim supporting span, OMIT the field.
   - "confidence": a number from 0 to 1 reflecting how clearly the transcript supports the value.
3. Do NOT add negative findings (e.g. "no fever", "אין חום") unless that exact negation was spoken. Absence of a statement is NOT evidence of a negative finding.
4. Each of the five vitals (temperature, heart rate, blood pressure, respiratory rate, SpO2) is its own separate field with its own verbatim sourceSpan.

Output ONLY structured data conforming to the provided schema. Use these field ids exactly:
- subjective.chiefComplaint, subjective.relevantHistory, subjective.currentIllness
- objective.vitals.temp, objective.vitals.hr, objective.vitals.bp, objective.vitals.rr, objective.vitals.spo2
- objective.generalAppearance, objective.abdomen, objective.ports, objective.linesAndDrains
- plan.plan
- decisions.imaging, decisions.bloodTests, decisions.medications, decisions.procedures
- administrative.discharge, administrative.requestMoreInfo`;

const JUDGE_SYSTEM_PROMPT = `You are an ADVERSARIAL clinical safety auditor. A separate AI extractor has produced a draft rounds note from a Hebrew transcript. ASSUME THE EXTRACTOR MAY BE WRONG. Your job is to independently verify each field against the raw transcript and catch hallucinations, ungrounded claims, and contradictions before they could reach a patient chart.

For EACH field in the draft note, return a verdict:
- "grounded": the value is explicitly supported by the transcript and the sourceSpan genuinely appears there.
- "ungrounded": the value (or its sourceSpan) is NOT supported by the transcript — the extractor inferred or fabricated it. This includes negative findings (e.g. "אין חום" / "no fever") that were never actually spoken.
- "contradicted": the transcript states something that conflicts with the value.
- "ambiguous": the transcript is unclear or only partially supports the value.

Also provide:
- "reason": a short Hebrew explanation of your verdict.
- "highRisk": true if the field is clinically dangerous if wrong — medications/doses, imaging, or procedures/surgery — otherwise false.

Note: values are deliberately written in clinical EMR register (third person, medical terminology), so their WORDING will differ from the spoken transcript — that alone is not ungrounded. Judge whether the FACTS in the value are supported; flag any fact that was added, changed, or contradicted by the rephrasing.

Be skeptical. If a sourceSpan does not literally appear in the transcript, the field is ungrounded. Output ONLY structured data conforming to the provided schema, one verdict per field id given to you.`;

// ── JSON schemas for structured output (Claude output_config.format) ────────

const STRUCTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fieldId: { type: 'string' },
          value: { type: 'string' },
          sourceSpan: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['fieldId', 'value', 'sourceSpan', 'confidence'],
      },
    },
  },
  required: ['fields'],
};

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fieldId: { type: 'string' },
          verdict: { type: 'string', enum: JUDGE_VERDICTS },
          reason: { type: 'string' },
          highRisk: { type: 'boolean' },
        },
        required: ['fieldId', 'verdict', 'reason', 'highRisk'],
      },
    },
  },
  required: ['verdicts'],
};

// ── Helpers to map raw model/mock output → spec shapes ──────────────────────

/**
 * Map an array of raw structure records ({fieldId,value,sourceSpan,confidence})
 * into fully-shaped FieldRecords via makeFieldRecord. Unknown/ malformed
 * records are skipped defensively; if NOTHING maps, throw (malformed output).
 */
function toFieldRecords(rawRecords) {
  if (!Array.isArray(rawRecords)) {
    throw new Error('structure output malformed: expected an array of field records.');
  }
  const fields = [];
  for (const r of rawRecords) {
    if (!r || typeof r.fieldId !== 'string' || !isKnownField(r.fieldId)) continue;
    fields.push(
      makeFieldRecord(r.fieldId, {
        value: typeof r.value === 'string' ? r.value : String(r.value ?? ''),
        sourceSpan: typeof r.sourceSpan === 'string' ? r.sourceSpan : '',
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      }),
    );
  }
  if (fields.length === 0) {
    throw new Error('structure output malformed: no valid field records produced.');
  }
  return fields;
}

/**
 * Normalize an array of raw judge verdicts. Drops unknown fieldIds / invalid
 * verdicts; throws if nothing valid remains.
 */
function toVerdicts(rawVerdicts) {
  if (!Array.isArray(rawVerdicts)) {
    throw new Error('judge output malformed: expected an array of verdicts.');
  }
  const verdicts = [];
  for (const v of rawVerdicts) {
    if (!v || typeof v.fieldId !== 'string') continue;
    if (!JUDGE_VERDICTS.includes(v.verdict)) continue;
    verdicts.push({
      fieldId: v.fieldId,
      verdict: v.verdict,
      reason: typeof v.reason === 'string' ? v.reason : '',
      highRisk: Boolean(v.highRisk),
    });
  }
  if (verdicts.length === 0) {
    throw new Error('judge output malformed: no valid verdicts produced.');
  }
  return verdicts;
}

/** Extract parsed JSON from a Claude structured-output response. */
function parseClaudeJson(response) {
  // Prefer the SDK's parsed_output when present (messages.parse); otherwise
  // pull the first text block and JSON.parse it.
  if (response && response.parsed_output != null) {
    return response.parsed_output;
  }
  const block = Array.isArray(response?.content)
    ? response.content.find((b) => b.type === 'text')
    : null;
  const text = block?.text;
  if (!text) {
    throw new Error('Claude returned no text content to parse.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Claude returned non-JSON output.');
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Transcribe a Hebrew audio buffer to text.
 * MOCK: returns the scripted-round transcript verbatim.
 * LIVE: OpenAI Whisper (whisper-1), language "he".
 *
 * @param {Buffer} audioBuffer
 * @returns {Promise<string>} the Hebrew transcript
 */
export async function transcribeAudio(audioBuffer) {
  if (isTranscribeMock()) {
    return loadScriptedRound().transcript;
  }

  if (!audioBuffer || !audioBuffer.length) {
    throw new Error('No audio provided to transcribe.');
  }

  const openai = await getOpenAI();
  // OpenAI SDK expects a File/Blob-like object. Node 18+/24 has global File.
  const file = await toUploadableFile(audioBuffer);
  const result = await openai.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    language: 'he',
  });
  const text = result?.text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Whisper returned an empty transcript.');
  }
  return text;
}

/** Wrap a Buffer in an OpenAI-uploadable File (uses the SDK's `toFile`). */
async function toUploadableFile(audioBuffer) {
  const openaiPkg = await import('openai');
  if (typeof openaiPkg.toFile === 'function') {
    return openaiPkg.toFile(audioBuffer, 'round.webm', { type: 'audio/webm' });
  }
  // Fallback: global File (Node 20+).
  return new File([audioBuffer], 'round.webm', { type: 'audio/webm' });
}

/**
 * Structure a Hebrew transcript into draft FieldRecords with grounding +
 * confidence (spec §6 layer 1).
 * MOCK: canned structure records from mock-llm.json.
 * LIVE: Claude with the grounding-enforcing system prompt + JSON schema.
 *
 * Returns FieldRecords with value/sourceSpan/confidence populated and
 * judge/guardrail/committedValue at defaults (spec §5).
 *
 * @param {string} transcript
 * @returns {Promise<{ fields: object[] }>}
 */
export async function structureNote(transcript) {
  if (!transcript || String(transcript).trim() === '') {
    throw new Error('No transcript provided to structure.');
  }

  if (isClaudeMock()) {
    const fields = toFieldRecords(loadMockLlm().structure);
    return { fields };
  }

  const anthropic = await getAnthropic();
  const response = await callClaude(anthropic, {
    system: STRUCTURE_SYSTEM_PROMPT,
    userText: `Transcript (verbatim Hebrew):\n\n${transcript}`,
    schema: STRUCTURE_SCHEMA,
  });
  const parsed = parseClaudeJson(response);
  const fields = toFieldRecords(parsed?.fields);
  return { fields };
}

/**
 * Adversarially judge draft fields against the transcript (spec §6 layer 2).
 * MOCK: canned judge verdicts from mock-llm.json.
 * LIVE: a SEPARATE Claude call with the adversarial system prompt + JSON schema.
 *
 * Returns the per-field verdicts ONLY ({ fieldId, verdict, reason, highRisk }).
 * The judge route merges these into the records and then runs guardrails.
 *
 * @param {string} transcript
 * @param {Array<object>} fields  draft FieldRecords from structureNote
 * @returns {Promise<Array<{fieldId,verdict,reason,highRisk}>>}
 */
export async function judgeNote(transcript, fields) {
  if (!transcript || String(transcript).trim() === '') {
    throw new Error('No transcript provided to judge.');
  }
  if (!Array.isArray(fields)) {
    throw new Error('No draft fields provided to judge.');
  }

  if (isClaudeMock()) {
    return toVerdicts(loadMockLlm().judge);
  }

  const anthropic = await getAnthropic();
  const draft = fields.map((f) => ({
    fieldId: f.fieldId,
    value: f.value,
    sourceSpan: f.sourceSpan,
  }));
  const response = await callClaude(anthropic, {
    system: JUDGE_SYSTEM_PROMPT,
    userText:
      `Raw transcript (verbatim Hebrew):\n\n${transcript}\n\n` +
      `Draft note to verify (one verdict required per field):\n\n` +
      JSON.stringify(draft, null, 2),
    schema: JUDGE_SCHEMA,
  });
  const parsed = parseClaudeJson(response);
  return toVerdicts(parsed?.verdicts);
}

/**
 * Shared Claude call. Requests structured JSON output (output_config.format),
 * uses adaptive thinking (per claude-api guidance), and falls back to a current
 * model id if the preferred one is unavailable (404/not_found).
 */
async function callClaude(anthropic, { system, userText, schema }) {
  // Haiku 4.5 rejects { type: "adaptive" } (it predates adaptive thinking);
  // structure/judge are structured-output tasks and run fine without thinking.
  const supportsAdaptiveThinking = !/haiku/i.test(CLAUDE_MODEL);
  const baseParams = {
    max_tokens: CLAUDE_MAX_TOKENS,
    ...(supportsAdaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
    system,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema } },
  };

  try {
    return await anthropic.messages.create({ model: CLAUDE_MODEL, ...baseParams });
  } catch (err) {
    // If the preferred model id is not found for this account, retry once on a
    // current fallback model rather than failing the demo. Use the SDK's typed
    // error fields (status / type) rather than string-matching the message.
    const notFound = err?.status === 404 || err?.type === 'not_found_error';
    if (notFound) {
      return anthropic.messages.create({ model: CLAUDE_MODEL_FALLBACK, ...baseParams });
    }
    throw err;
  }
}

export default { transcribeAudio, structureNote, judgeNote, isTranscribeMock, isClaudeMock };
