// server/lib/segment.js
//
// Layer 0 of the pipeline: split ONE multi-patient round transcript into
// per-patient sub-transcripts, before structure/judge/guardrails ever run.
//
// WHY THIS EXISTS (the failure it prevents):
//   The field catalog (fields.js) describes ONE patient's note, and emrStore
//   writes note[fieldId] — last write wins. Feeding a 4-patient round through
//   structureNote as a single transcript therefore produces one note in which
//   later patients silently overwrite earlier ones: patient B's blood pressure
//   and medication list land in patient A's chart, every field marked
//   "grounded" (each sourceSpan really IS in the transcript — just the wrong
//   patient's part of it). No downstream layer can detect this, because
//   grounding is a substring test and the substring is genuinely there.
//
// THE GROUNDING INVARIANT:
//   A segment is a VERBATIM CONTIGUOUS SLICE of the transcript — never a
//   paraphrase or a reordering. That is what keeps the safety pipeline honest:
//   any sourceSpan that appears in a segment also appears in the full
//   transcript, so guardrails.js works unchanged on a segment.
//
// SPLIT OF RESPONSIBILITY (deliberate, mirrors structure-vs-guardrail):
//   - findSegmentBoundaries(): the LLM proposes boundaries as verbatim ANCHOR
//     strings. It never returns text — only where to cut.
//   - sliceByAnchors(): pure, deterministic, no LLM/no I/O. Locates each anchor
//     and does the actual cutting. An anchor the model invented is not found
//     here and throws loudly, rather than silently mis-slicing the round.
//
// Deterministic for testability: sliceByAnchors has no clock, no randomness,
// and no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

/**
 * Same whitespace normalization guardrails.js uses for grounding. Anchors are
 * located on the normalized text so transcript line-wrapping cannot cause a
 * false "anchor not found".
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Build an index mapping each character offset in the normalized string back to
 * its offset in the ORIGINAL string. This lets us locate an anchor on
 * normalized text but cut the ORIGINAL text, so segments stay verbatim
 * (original whitespace and line breaks preserved).
 *
 * @param {string} original
 * @returns {{ normalized: string, map: number[] }} map[i] = original offset of
 *   normalized char i; map has one extra trailing entry = original.length.
 */
function normalizeWithMap(original) {
  const src = String(original ?? '');
  let normalized = '';
  const map = [];
  let i = 0;
  // Skip leading whitespace (matches .trim()).
  while (i < src.length && /\s/.test(src[i])) i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      // Collapse a whitespace run to one space; emit only if more non-space follows.
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (j < src.length) {
        normalized += ' ';
        map.push(i);
      }
      i = j;
    } else {
      normalized += ch;
      map.push(i);
      i += 1;
    }
  }
  map.push(src.length);
  return { normalized, map };
}

/**
 * Cut `transcript` into contiguous verbatim slices at the given anchors.
 *
 * PURE — no LLM, no I/O, no clock. This is the deterministic backstop over the
 * model's boundary proposal.
 *
 * Each anchor's `startAnchor` must appear literally in the transcript
 * (whitespace-normalized), at or after the previous anchor's position. Anchors
 * are cut in the order given; text before the first anchor is discarded as
 * round preamble.
 *
 * @param {string} transcript  the full verbatim round transcript
 * @param {Array<{patientLabel?: string, startAnchor: string}>} anchors
 * @returns {Array<{index:number, patientLabel:string, transcript:string, startOffset:number, endOffset:number}>}
 * @throws {Error} if an anchor is empty, not found, or out of order
 */
export function sliceByAnchors(transcript, anchors) {
  if (typeof transcript !== 'string' || transcript.trim() === '') {
    throw new Error('sliceByAnchors: transcript must be a non-empty string.');
  }
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error('sliceByAnchors: at least one anchor is required.');
  }

  const { normalized, map } = normalizeWithMap(transcript);

  // Locate every anchor first, so an invalid one fails before we cut anything.
  const cuts = [];
  let searchFrom = 0;
  anchors.forEach((a, i) => {
    const anchor = normalize(a?.startAnchor);
    if (anchor === '') {
      throw new Error(`sliceByAnchors: anchor #${i + 1} is empty.`);
    }
    const at = normalized.indexOf(anchor, searchFrom);
    if (at === -1) {
      // Distinguish "model invented it" from "model put it out of order" —
      // both are bugs, but they point at different fixes.
      const anywhere = normalized.indexOf(anchor);
      throw new Error(
        anywhere === -1
          ? `sliceByAnchors: anchor #${i + 1} not found in transcript: "${anchor.slice(0, 60)}"`
          : `sliceByAnchors: anchor #${i + 1} appears before the previous boundary (out of order): "${anchor.slice(0, 60)}"`,
      );
    }
    cuts.push({ at, patientLabel: String(a?.patientLabel ?? '').trim() });
    searchFrom = at + anchor.length;
  });

  return cuts.map((cut, i) => {
    const startNorm = cut.at;
    const endNorm = i + 1 < cuts.length ? cuts[i + 1].at : normalized.length;
    const startOffset = map[startNorm];
    const endOffset = map[endNorm];
    return {
      index: i,
      patientLabel: cut.patientLabel || `Patient ${i + 1}`,
      transcript: transcript.slice(startOffset, endOffset).trim(),
      startOffset,
      endOffset,
    };
  });
}

/**
 * Spoken markers that a NEW patient is being presented. These are things the
 * team actually says out loud when they arrive at a bed — not inferences.
 *
 * Deliberately evidence-based and few: this is a cross-check on the model, so
 * it must not itself depend on a model or on clinical guesswork.
 */
const PATIENT_CUES = [
  { name: 'identity number', re: /מספר\s+זהות/g },
  { name: 'next patient', re: /ה?מטופלת?\s+ה?בא[הה]?/g },
];

/** Preamble shorter than this before the first patient is round chit-chat, not a missed bed. */
const PREAMBLE_LIMIT = 80;

/**
 * Deterministic cross-check that the split accounts for every patient the round
 * actually discusses. PURE — no LLM, no I/O.
 *
 * WHY THIS EXISTS:
 *   Evaluation of the real 9-minute round found that when a whole round is
 *   structured as one note, the model can produce a clean, well-grounded note
 *   for the FIRST patient and silently drop the rest — three of four patients
 *   simply absent, with every remaining field marked "grounded" by the judge.
 *   An omission leaves no trace: there is no wrong value to catch, no bad quote,
 *   no duplicate. Every other layer in this pipeline checks fields that EXIST,
 *   so none of them can see a patient that does not.
 *
 *   This is the only check that looks for what ISN'T there. It counts spoken
 *   "new patient" markers in the raw transcript and compares that against the
 *   number of sections produced.
 *
 * It reports rather than throws: a round can legitimately say "the next patient"
 * without a bed change, so a mismatch means "a human should look", not "this is
 * wrong". Callers surface `warnings` to the reviewer.
 *
 * @param {string} transcript  the full verbatim round transcript
 * @param {Array<{transcript:string, startOffset:number}>} segments  from sliceByAnchors
 * @returns {{ok:boolean, cueCount:number, segmentCount:number, droppedPreamble:string, warnings:Array<{code:string,message:string}>}}
 */
export function checkRoundCoverage(transcript, segments) {
  const text = normalize(transcript);
  const warnings = [];

  // Count each cue independently and take the MAX, never the sum: one bed can
  // be introduced with several markers at once ("the next patient, Rachel,
  // identity number ..."), and summing would invent patients that don't exist.
  let cueCount = 0;
  for (const cue of PATIENT_CUES) {
    const n = (text.match(cue.re) || []).length;
    if (n > cueCount) cueCount = n;
  }

  const segmentCount = Array.isArray(segments) ? segments.length : 0;

  if (cueCount > segmentCount) {
    warnings.push({
      code: 'possible_missing_patient',
      message:
        `The round contains ${cueCount} spoken patient introductions but only ` +
        `${segmentCount} ${segmentCount === 1 ? 'section was' : 'sections were'} produced. ` +
        'A patient may be missing — review the transcript before committing.',
    });
  }

  // Text before the first section is dropped by design (round preamble). If a
  // lot of it was dropped, the first bed may have started before the anchor.
  let droppedPreamble = '';
  if (segmentCount > 0 && Number.isFinite(segments[0].startOffset)) {
    droppedPreamble = normalize(transcript.slice(0, segments[0].startOffset));
    if (droppedPreamble.length > PREAMBLE_LIMIT) {
      warnings.push({
        code: 'dropped_preamble',
        message:
          `${droppedPreamble.length} characters before the first patient were not ` +
          'assigned to any section. If the round opened mid-patient, that content is lost.',
      });
    }
  }

  return { ok: warnings.length === 0, cueCount, segmentCount, droppedPreamble, warnings };
}

const SEGMENT_SYSTEM_PROMPT = `You are splitting a verbatim Hebrew morning-round transcript from a general-surgery ward into one section per PATIENT.

A ward round visits several patients in sequence. Your ONLY job is to say WHERE each patient's section begins. You do not summarize, translate, or extract anything.

For each patient discussed, return:
- "patientLabel": the patient's name exactly as spoken in the transcript. If no name is spoken for that patient, use an empty string.
- "startAnchor": a SHORT, EXACT, VERBATIM substring copied character-for-character from the transcript, marking the FIRST line of that patient's section. It MUST appear literally in the transcript. Do NOT paraphrase, translate, or reword it. Prefer the sentence in which the team arrives at / presents that patient.

RULES:
1. Anchors must be in the SAME ORDER as they appear in the transcript.
2. Anchors must not overlap. Each anchor marks the START of a section; the section runs until the next anchor.
3. Return one entry per PATIENT, not per speaker turn and not per topic. A single patient discussed across several exchanges is ONE section.
4. If the round discusses only one patient, return exactly one entry.
5. Never invent a patient who is not discussed.`;

const SEGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patientLabel: { type: 'string' },
          startAnchor: { type: 'string' },
        },
        required: ['patientLabel', 'startAnchor'],
      },
    },
  },
  required: ['segments'],
};

/** Canned boundaries for the scripted round (mock mode). */
let _mockSegments = null;
function loadMockSegments() {
  if (_mockSegments == null) {
    const raw = JSON.parse(readFileSync(join(dataDir, 'mock-llm.json'), 'utf8'));
    _mockSegments = Array.isArray(raw.segments) ? raw.segments : null;
  }
  return _mockSegments;
}

/**
 * Ask the model where each patient's section starts. Returns ANCHORS ONLY —
 * the caller passes them to sliceByAnchors, which does the deterministic cut.
 *
 * @param {string} transcript
 * @param {{callClaude?: Function, isMock?: Function}} [deps] injectable for tests
 * @returns {Promise<Array<{patientLabel:string, startAnchor:string}>>}
 */
export async function findSegmentBoundaries(transcript, deps = {}) {
  if (typeof transcript !== 'string' || transcript.trim() === '') {
    throw new Error('No transcript provided to segment.');
  }

  const llm = await import('./llm.js');
  const isMock = deps.isMock ?? llm.isClaudeMock;

  if (isMock()) {
    const canned = loadMockSegments();
    if (canned && canned.length) return canned;
    // The scripted round is a single patient; degrade to one whole-transcript
    // segment rather than failing the offline demo.
    return [{ patientLabel: '', startAnchor: normalize(transcript).slice(0, 40) }];
  }

  const callClaude = deps.callClaude ?? llm.callClaudeJson;
  const parsed = await callClaude({
    system: SEGMENT_SYSTEM_PROMPT,
    userText: `Round transcript (verbatim Hebrew):\n\n${transcript}`,
    schema: SEGMENT_SCHEMA,
  });

  const segments = parsed?.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('segmentation output malformed: no segments returned.');
  }
  return segments
    .filter((s) => s && typeof s.startAnchor === 'string' && s.startAnchor.trim() !== '')
    .map((s) => ({
      patientLabel: typeof s.patientLabel === 'string' ? s.patientLabel.trim() : '',
      startAnchor: s.startAnchor,
    }));
}

/**
 * Full segmentation: find boundaries (LLM), then cut deterministically.
 *
 * @param {string} transcript
 * @param {object} [deps]
 * @returns {Promise<Array<{index:number, patientLabel:string, transcript:string, startOffset:number, endOffset:number}>>}
 */
export async function segmentTranscript(transcript, deps = {}) {
  const anchors = await findSegmentBoundaries(transcript, deps);
  return sliceByAnchors(transcript, anchors);
}

export default { segmentTranscript, findSegmentBoundaries, sliceByAnchors, checkRoundCoverage };
