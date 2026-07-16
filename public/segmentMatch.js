// public/segmentMatch.js — pure span→segment matcher, shared by the browser
// (imported from app.js) and node tests (server/tests/segmentMatch.test.js).
// Whitespace-only normalization, mirroring lib/guardrails.js grounding and
// spanInTranscript() in app.js — Hebrew text is otherwise untouched.

/** Collapse all whitespace runs to single spaces and trim. */
export function normalizeForMatch(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return normalizeForMatch(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
}

const playable = (seg) => seg && seg.startMs != null && seg.endMs != null;

// Minimum share of wanted tokens a segment must contain for a tier-3 match —
// permissive on purpose: worst case is playing a near-miss segment the
// reviewer can scrub away from.
const OVERLAP_THRESHOLD = 0.3;

/**
 * Find the playback window for a field's sourceSpan.
 *
 * Tiers:
 *   1. 'exact'   — normalized substring of a single segment;
 *   2. 'pair'    — substring of two ADJACENT segments' concatenation (spans
 *                  crossing the '\n' transcript join) — window covers both;
 *   3. 'overlap' — best token-overlap segment, scored against span + field
 *                  value tokens. This is what makes the listen button work on
 *                  UNGROUNDED fields, whose span by definition is not in the
 *                  transcript.
 *
 * @returns {{startMs:number, endMs:number, method:string}|null} null means
 *   "no plausible spot — play from the start with the scrub bar".
 */
export function matchSpanToSegments(segments, span, extraText = '') {
  const list = Array.isArray(segments) ? segments : [];
  const nspan = normalizeForMatch(span);

  if (nspan) {
    for (const seg of list) {
      if (playable(seg) && normalizeForMatch(seg.content).includes(nspan)) {
        return { startMs: seg.startMs, endMs: seg.endMs, method: 'exact' };
      }
    }
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (!playable(a) || !playable(b)) continue;
      if (normalizeForMatch(`${a.content} ${b.content}`).includes(nspan)) {
        return { startMs: a.startMs, endMs: b.endMs, method: 'pair' };
      }
    }
  }

  const want = new Set([...tokens(span), ...tokens(extraText)]);
  if (!want.size) return null;
  let best = null;
  let bestScore = 0;
  for (const seg of list) {
    if (!playable(seg)) continue;
    const have = new Set(tokens(seg.content));
    let hits = 0;
    for (const t of want) if (have.has(t)) hits += 1;
    const score = hits / want.size;
    if (score > bestScore) { bestScore = score; best = seg; } // ties → earliest
  }
  return bestScore >= OVERLAP_THRESHOLD
    ? { startMs: best.startMs, endMs: best.endMs, method: 'overlap' }
    : null;
}
