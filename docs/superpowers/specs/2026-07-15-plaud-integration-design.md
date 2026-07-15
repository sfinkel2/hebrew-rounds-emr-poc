# Plaud Integration — Pull the Round Transcript from a Plaud Device

**Date:** 2026-07-15
**Status:** Approved by user (Approach A: direct REST, reuse MCP login)
**Branch:** `plaud-integration` (worktree)
**Scope:** new `server/lib/plaud.js`, new `server/routes/plaud.js`, `server/index.js`
(mount route), `public/index.html`, `public/app.js`, `server/tests/plaud.test.js`,
`CLAUDE.md`. Pipeline files (`llm.js` structure/judge, `guardrails.js`,
`fields.js`, commit path) untouched.

## Goal

Replace the browser-mic "Record round" step with pulling a real Hebrew round
transcript from the presenter's Plaud device, fetched **by the Express app
itself at demo time**. The user records the round on the Plaud hardware,
transcribes it in the Plaud app, then clicks "Pull from Plaud" in our UI,
picks the recording, and the transcript drops into the existing
structure → judge → guardrails → approve → commit pipeline unchanged.

## Decisions (user-approved)

1. **Mechanism:** direct REST calls from Express to Plaud's developer API,
   reusing the OAuth token the Plaud MCP login already cached on this machine
   (Approach A). No MCP client dependency, no child processes.
2. **LLMs:** Claude for both structure and judge (existing `llm.js` calls,
   no Groq). Plaud demo runs with a live `ANTHROPIC_API_KEY`.
3. **Selection UX:** a small picker listing recent recordings; the presenter
   clicks the round they just recorded.
4. **Mic button removed:** Plaud replaces browser-mic recording. "Scripted
   round" stays as the offline/mock fallback. Server-side Whisper code stays
   but nothing in the UI calls it.

## Non-goals

- No mock-mode Plaud fixtures (Plaud is a live-only capability; offline demos
  use the scripted round).
- No speaker labels in the transcript, no pagination beyond the newest 10
  recordings, no audio playback, no changes to the safety pipeline or the
  grounding invariant.
- No standalone OAuth flow in the app: connecting Plaud = running the MCP
  `login` once (documented recovery path).

## Plaud API facts (verified against `@plaud-ai/mcp` v0.3.5 source)

- Base: `https://platform.plaud.ai/developer/api`
- `GET /open/third-party/files/?page=1&page_size=10` — recording list
  (`{type:"list", data:[{id, name, start_at, duration, ...}], page, page_size}`;
  `duration` is milliseconds).
- `GET /open/third-party/files/{fileId}` — file detail: an array of data
  items; the transcript is the item with `data_type: "transaction"`, whose
  `data_content` is a **JSON string** encoding
  `[{content, speaker, start_time, end_time}, ...]`. Untranscribed recordings
  have no `transaction` item.
- Auth: `Authorization: Bearer <access_token>`.
- Token cache: `~/.plaud/tokens-mcp.json` =
  `{access_token, refresh_token, token_type, expires_at}` (`expires_at` in ms
  epoch, may be absent). Written by the MCP; we read it and write back on
  refresh in the same shape.
- Refresh: when `expires_at` present and `Date.now() > expires_at - 60_000`
  (or on a 401), `POST /oauth/third-party/access-token/refresh` with
  form-urlencoded body `refresh_token=<token>`; response
  `{access_token, refresh_token?, expires_in?}`; keep the old `refresh_token`
  if the response omits it; persist the new set.

**Fragility note:** the token file location/shape is an internal detail of the
MCP package. If a future MCP version moves it, the app degrades to
"Plaud not connected" and the fix is a one-line path/shape update.

## Backend design

### `server/lib/plaud.js`

Follows `llm.js` conventions: one vendor per lib file, tokens never sent to
the browser, deterministic core for testability.

- `createPlaudClient({ fetchImpl, tokenPath } = {})` — dependency-injected
  factory (defaults: global `fetch`, `join(homedir(), ".plaud",
  "tokens-mcp.json")`). Tests pass fakes; routes use the default singleton.
- `listRecordings()` → trimmed `[{id, name, startAt, durationMs}]`, newest
  10\. Recording names are user data — passed through verbatim.
- `getTranscript(fileId)` → `{ transcript }` where `transcript` is the
  segment `content` strings joined with `"\n"`, in segment order, no speaker
  prefixes. This exact string is what the UI displays and what `/api/structure`
  receives — the grounding guardrail depends on display text === structure
  input, same as the scripted round today.
- Auth flow per request: load token file → refresh if stale (60s skew, same
  rule as the MCP) → call API → on 401, refresh once and retry once.
- Typed failures (mapped to the shared error envelope by the route):
  - `plaud_not_connected` — token file missing/unreadable, or refresh failed.
  - `plaud_no_transcript` — file detail has no `transaction` item (not yet
    transcribed in the Plaud app).
  - `plaud_upstream_error` — non-401 API failure or malformed payload.
- Pure exported helpers, unit-tested directly:
  - `parseTranscriptPayload(fileDetailJson)` → segments or `null`
  - `joinSegments(segments)` → transcript string
  - `isTokenStale(tokenSet, nowMs)` → boolean

### `server/routes/plaud.js`

- `GET /api/plaud/status` → `{ connected: boolean }` (token file exists and
  parses; no network call — cheap enough to hit on page load).
- `GET /api/plaud/recordings` → `{ recordings: [...] }`.
- `GET /api/plaud/recordings/:id/transcript` → `{ transcript }`.
- Errors → HTTP 502 (`plaud_not_connected` → 503) with
  `{ error: { code, message } }`, matching the existing route convention that
  failures never produce partial results.

Mounted in `server/index.js` alongside the existing routes.

## Frontend design

- **Removed:** `#btn-record`, MediaRecorder capture code, recording state
  (`isRecording`, mic labels), and the UI call to `/api/transcribe`. The
  `STRINGS` keys used only by mic recording are deleted (both languages).
- **Added:** `#btn-plaud` ("Pull from Plaud") next to "Scripted round" in the
  capture panel.
  - On init, `GET /api/plaud/status`; if not connected the button is disabled
    with a hint string ("Connect Plaud first (MCP login)"), so a keyless/
    offline classroom machine sees a clean capture panel, not an error.
  - Click → `GET /api/plaud/recordings` → inline picker panel (not a modal)
    under the capture controls: one row per recording — name (verbatim,
    `dir="auto"`), start time (locale-formatted), duration (`m:ss`). Rows are
    buttons; Escape or a close button dismisses.
  - Row click → `GET /api/plaud/recordings/:id/transcript` → on success:
    `setTranscript(transcript)`, close picker, enable "Structure & check" —
    the exact post-transcript state the scripted round produces.
  - Failures (incl. `plaud_no_transcript`) → existing capture status line, in
    the current UI language; transcript pane untouched.
- **i18n:** new `STRINGS` keys (EN + HE): button label, picker title, loading,
  empty list, not-connected hint, no-transcript message, generic pull error.
  Clinical/data content (recording names, transcript) is never translated.
- The transcript pane already renders `dir="rtl"` Hebrew — unchanged.

## Error handling summary

| Failure | Where surfaced | Message intent |
|---|---|---|
| No token file / refresh failed | button disabled (status) or capture status line (mid-flow) | "Plaud not connected — run the MCP login" |
| Recording not yet transcribed | capture status line | "No transcript yet — transcribe it in the Plaud app, then retry" |
| Upstream/network error | capture status line | generic retry message |
| Zero recordings | picker body | empty-state string |

## Testing

`server/tests/plaud.test.js` (node --test, in-process app like existing tests):

1. Pure helpers: real captured response shape → correct joined transcript;
   missing `transaction` item → `null`; `isTokenStale` boundary cases
   (absent `expires_at` → not stale; 60s skew honored).
2. Route contracts with injected fake fetch + temp token file:
   - happy path list + transcript
   - no token file → 503 `plaud_not_connected`
   - stale token → refresh called, rotated token persisted, request retried
   - 401 → single refresh+retry, then success
   - file without transcript → `plaud_no_transcript`
3. Full existing suite must pass unchanged (`npm test`) — pipeline and
   grounding invariant are untouched.

Manual verification: live end-to-end pull of a real device recording
(e.g. the 2026-07-15 09:57 test clip) with `ANTHROPIC_API_KEY` set, driving
structure → judge → approve → commit in the browser.

## Docs

- `CLAUDE.md`: short "Plaud capability" section — live-only, auth reuses the
  MCP login's token file, path + fragility caveat, mic path removed from UI.
- `docs/how-to-use-the-demo.html`: replace the mic step with the Plaud flow
  (record on device → transcribe in Plaud app → Pull from Plaud).
