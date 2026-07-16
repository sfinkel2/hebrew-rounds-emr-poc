# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A classroom proof-of-concept (MBA healthcare-innovation practicum): a spoken **Hebrew** general-surgery morning round is transcribed, structured into a rounds note by an LLM, safety-checked by an adversarial LLM judge plus deterministic guardrails, reviewed/approved by a human, and committed into a **mock Chameleon EMR** with an audit log. Single synthetic patient, no auth, no database, no real PHI.

## Commands

```bash
npm start        # reseeds the mock EMR from patient.seed.json, serves http://localhost:3000
npm test         # node --test — guardrails, commit rules, structure/judge contracts
node --test server/tests/guardrails.test.js   # run a single test file
npm run reset    # reseed server/data/emr-state.json on demand (npm start does this too)
```

No build step, no bundler, no linter. Frontend is vanilla ES modules served statically from `/public`; Tailwind comes from a CDN. Setup is `npm install` + copy `.env.example` → `.env`.

## MOCK vs LIVE mode

The app runs fully offline with **blank API keys** (the classroom-demo default). Mode is resolved per capability in `server/lib/llm.js`: `DEMO_MODE=mock` forces mock; otherwise transcribe is live only with `OPENAI_API_KEY` (Whisper), and structure/judge are live only with `ANTHROPIC_API_KEY` (Claude) (the transcribe capability still resolves this way in `lib/llm.js`, but the UI no longer calls it — see Plaud capability below). Mock responses are canned in `server/data/mock-llm.json` and keyed to the scripted round — they are **not** generic fixtures (see grounding invariant below).

## Plaud capability (live-only)

`server/lib/plaud.js` + `routes/plaud.js` pull a round's Hebrew transcript from
the presenter's Plaud account (`GET /api/plaud/status | /recordings |
/recordings/:id/transcript`). Auth reuses the OAuth token the **Plaud MCP
login** cached at `~/.plaud/tokens-mcp.json` (refresh-and-persist on expiry/401);
there is no in-app OAuth flow — "not connected" means run the MCP login again.
The token file location/shape is an internal detail of `@plaud-ai/mcp`
(verified v0.3.5) — if it moves, update `DEFAULT_TOKEN_PATH` in `lib/plaud.js`.
Plaud has no mock mode: offline demos use the scripted round. The browser-mic
recording path was removed from the UI (Whisper transcribe code remains
server-side but nothing calls it), so LIVE mode is resolved from
`ANTHROPIC_API_KEY` alone (`resolveMode()` in `server/index.js`).

## Architecture — the safety pipeline

The core design is a three-layer safety pipeline; each layer owns one sub-object of the `FieldRecord` and must not touch the others:

1. **Structure** (`lib/llm.js` → `POST /api/structure`): Claude extracts fields. Owns `value`, `sourceSpan` (a verbatim Hebrew quote from the transcript), and `confidence`. The system prompt forbids inferring unstated facts.
2. **Judge** (`lib/llm.js` → `POST /api/judge`): a **separate** adversarial Claude call that distrusts the extractor. Returns verdicts only (`grounded | ungrounded | contradicted | ambiguous`); the judge **route** (`routes/judge.js`) merges them into each record's `judge` sub-object and then runs guardrails.
3. **Guardrails** (`lib/guardrails.js`): pure, deterministic, no LLM/no I/O. Owns the `guardrail` sub-object. Three checks: sourceSpan must literally appear in the transcript (whitespace-normalized), high-risk fields (medications/imaging/procedures) always force confirmation, numeric vitals are range-checked.

After the human approves fields in the UI, `POST /api/commit` (`routes/commit.js` + `lib/emrStore.js`) persists **only** records with `status: "approved"`, stamps a server-side timestamp, and appends one audit entry per field. Zero approved fields → HTTP 400.

**`server/lib/fields.js` is the single source of truth** for the field catalog and `FieldRecord` shape. The frontend keeps a presentation-only mirror (`FIELD_META` in `public/app.js`) — if you add/rename a field, update both, plus `patient.seed.json`/`mock-llm.json` if it should appear in the demo.

Modules are deliberately deterministic for testability: `emrStore.applyCommit` takes its timestamp from the caller; guardrails have no clock/randomness. `server/index.js` exports the Express `app` without listening so tests drive it in-process.

## The grounding invariant (don't break the demo)

`mock-llm.json` + `scripted-round.json` encode a planted trap: **every** sourceSpan is an exact substring of the scripted transcript **except one** — the fabricated temperature span `"אין חום"` — which the guardrail must visibly catch during the demo. Tests enforce both directions (`contract.test.js`). If you edit the transcript or the mock structure output, keep this invariant or the safety-layer demo moment (and the tests) break.

`server/data/emr-state.json` is generated working state (gitignored, reseeded from `patient.seed.json` on every `npm start`) — never hand-edit it.

## Frontend notes

- `public/app.js` is a single-file controller; `public/index.html` is static markup. Legacy Chameleon styling lives in `legacy-emr.css`, modern panes use Tailwind + `modern.css`.
- **i18n:** UI chrome is bilingual via the `STRINGS` dict + `t()` + `applyLanguage()` in `app.js` (static HTML keyed by `data-i18n`; default English, persisted in `localStorage.lang`). **Clinical content — transcript, sourceSpans, field values, judge reasons — is Hebrew data and is never translated**; the grounding check quotes it verbatim. The legacy EMR pane is intentionally English-only.
- RTL: Hebrew values stay `dir="rtl"`-isolated even in English/LTR mode.

## Claude API conventions (server/lib/llm.js)

All LLM calls follow current Anthropic guidance for the Opus 4.x family — keep these when editing:

- Model: `claude-opus-4-8` with a `claude-sonnet-4-6` fallback on 404/not-found;
  overridable via the `CLAUDE_MODEL` env var (e.g. `claude-haiku-4-5` for a
  cheap classroom run).
- `thinking: { type: "adaptive" }` — never `budget_tokens` (400s on Opus 4.7+).
  Haiku 4.5 predates adaptive thinking, so `callClaude` omits the param there.
- **No** `temperature`/`top_p`/`top_k` and **no** assistant-turn prefills (both 400 on Opus 4.7+).
- Structured output via `output_config: { format: { type: "json_schema", schema } }` (the canonical param; top-level `output_format` is deprecated).
- Malformed model output throws; routes convert to the shared `{ error: { code, message } }` envelope rather than returning a partial note.
- Keys are read server-side only and never sent to the browser.

## Design docs

Approved specs live in `docs/superpowers/specs/` (original POC design + the English-toggle design). `docs/how-to-use-the-demo.html` is the presenter-facing usage guide.
