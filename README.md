# Hebrew Voice Rounds → Mock Chameleon EMR (POC)

A proof-of-concept that captures a spoken **Hebrew** general-surgery morning round through a chat-style voice-to-text interface, structures it into the ward's note format with an LLM, validates it with an **LLM-as-judge plus deterministic guardrails** so no clinical information is entered incorrectly, and integrates the human-approved note into a **mock Chameleon EMR** (rendered in a legacy 90s/2000s aesthetic). Built for an MBA healthcare-innovation practicum class demo on a single synthetic patient — no real PHI, no auth, no database.

## Prerequisites

- **Node.js 18+** (developed on Node 24) and npm. No frontend build step.

## Setup

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Leave the keys in `.env` **blank** to run fully offline in mock mode (recommended for the demo), or add real keys for the live path (see below).

## Run

```bash
npm start
```

Then open **http://localhost:3000**. `npm start` reseeds the mock EMR from `patient.seed.json` so every rehearsal starts from the same clean patient record.

## MOCK vs LIVE mode

The app runs end-to-end **with no API keys and no network** — this is the reliable classroom fallback.

- **MOCK mode (default when keys are absent):** `transcribe`, `structure`, and `judge` return canned, deterministic responses tied to the scripted Hebrew round (`server/data/mock-llm.json`). Fully runnable, demoable, and testable offline. You can also **force** mock mode even when keys are present by setting `DEMO_MODE=mock` in `.env`.
- **LIVE mode (when keys are present and `DEMO_MODE` is not `mock`):** uses **OpenAI Whisper** for Hebrew speech-to-text and **Anthropic Claude** for the structuring and adversarial judge passes. Keys are read server-side only and never sent to the browser.

| | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | `DEMO_MODE` |
|---|---|---|
| **Mock (offline)** | blank | anything |
| **Mock (forced)** | set | `mock` |
| **Live** | set | blank |

## Test

```bash
npm test
```

Runs the Node built-in test runner (`node --test`): guardrail checks (grounded vs. fabricated span, high-risk force-confirm, vitals ranges), commit rules (only approved fields persist; audit entries created), and structure/judge contract tests.

## Reset

```bash
npm run reset
```

Restores the mock EMR working state (`server/data/emr-state.json`) from `patient.seed.json` on demand. (`npm start` does this automatically too.)

## Demo script (~3 min, happy path)

1. Show the legacy Chameleon screen for the seeded post-op patient — sparse/empty round note.
2. Click **Record round**, speak the Hebrew round (or hit **Use scripted round**). Live Hebrew transcript appears.
3. Click **Structure** → fields populate with highlighted source quotes, confidence colors, and judge verdicts.
4. Point out a **flagged** item (e.g., a medication forced to confirm; or a deliberately ungrounded line the guardrail caught) — the safety story.
5. Approve the good fields, fix/reject the flagged one.
6. Click **Commit → Chameleon**; the legacy EMR updates before → after; show the audit log.

A deliberately tricky line is included in the scripted round so the judge/guardrail visibly catches something — proving the safety layer does real work.

## Repository layout

```
/server
  index.js            # Express app, static serving, startup key check
  routes/             # transcribe, structure, judge, commit, scriptedRound
  lib/
    fields.js         # canonical field catalog + FieldRecord factory (shared schema)
    guardrails.js     # pure deterministic checks
    emrStore.js       # mock Chameleon record + audit log
    llm.js            # Anthropic + OpenAI client wrappers, prompts
  data/
    patient.seed.json
    scripted-round.json
    mock-llm.json     # canned deterministic LLM outputs for the scripted round
  scripts/
    reset.js          # reseed emr-state.json from patient.seed.json
/public
  index.html, app.js, modern.css, legacy-emr.css
.env.example
README.md
```

> Synthetic data only. This POC does not integrate with any real hospital system and must never be used with real patient information.
