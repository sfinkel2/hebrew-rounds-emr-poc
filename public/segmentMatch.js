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
 * Interpolate a character range within a segment's normalized content into a
 * time window. Plaud segments recordings by SPEAKER TURN — a near-monologue
 * round yields 30+ second segments, so playing "the segment" would start most
 * quotes at the beginning of the recording. Linear chars→time interpolation
 * is approximate but lands playback at the sentence, and the caller pads ±1s.
 */
function interpolateWindow(seg, contentLength, fromChar, toChar) {
  const L = Math.max(1, contentLength);
  const dur = seg.endMs - seg.startMs;
  return {
    startMs: seg.startMs + Math.round(dur * Math.min(1, Math.max(0, fromChar / L))),
    endMs: seg.startMs + Math.round(dur * Math.min(1, Math.max(0, toChar / L))),
  };
}

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
      if (!playable(seg)) continue;
      const ncontent = normalizeForMatch(seg.content);
      const idx = ncontent.indexOf(nspan);
      if (idx !== -1) {
        const { startMs, endMs } = interpolateWindow(seg, ncontent.length, idx, idx + nspan.length);
        return { startMs, endMs, method: 'exact' };
      }
    }
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (!playable(a) || !playable(b)) continue;
      const na = normalizeForMatch(a.content);
      const nb = normalizeForMatch(b.content);
      const idx = `${na} ${nb}`.indexOf(nspan);
      if (idx !== -1) {
        // Start interpolated within a; end interpolated within b (the span
        // crosses the join, so its tail lands (idx+len − |a|−1) chars into b).
        const { startMs } = interpolateWindow(a, na.length, idx, idx);
        const tailInB = idx + nspan.length - (na.length + 1);
        const { endMs } = interpolateWindow(b, nb.length, tailInB, tailInB);
        return { startMs, endMs, method: 'pair' };
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
  if (bestScore < OVERLAP_THRESHOLD) return null;
  // Window around the matched tokens' positions inside the best segment —
  // not the whole (possibly 30s+) segment.
  const ncontent = normalizeForMatch(best.content);
  let first = Infinity;
  let last = -1;
  for (const tk of want) {
    const i = ncontent.indexOf(tk);
    if (i !== -1) {
      first = Math.min(first, i);
      last = Math.max(last, i + tk.length);
    }
  }
  const { startMs, endMs } = last > -1
    ? interpolateWindow(best, ncontent.length, first, last)
    : { startMs: best.startMs, endMs: best.endMs };
  return { startMs, endMs, method: 'overlap' };
}
