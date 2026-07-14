# Hebrew Voice Rounds → Mock Chameleon EMR — POC Design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)
**Context:** MBA healthcare-innovation practicum. Proof-of-concept prototype to address medical-documentation burden and error risk in a general-surgery ward. Demoed live in class.

---

## 1. Problem & Goal

General-surgery ward rounds generate dense, repetitive documentation that residents must research, transcribe onto paper, and re-enter into the hospital EMR (Eitan Health **Chameleon**). The burden is high and — critically — a large share of malpractice claims involve information that *was already present* but was missed or mis-recorded. 

**Goal:** A proof-of-concept that captures a spoken Hebrew round via a chat-style voice-to-text interface, structures it into the ward's note format with an LLM, validates it with an LLM-as-judge plus deterministic guardrails so **no clinical information is entered incorrectly**, and integrates the approved note into a mock Chameleon EMR — live, on one patient.

**Non-goals (YAGNI for this POC):** real Chameleon API integration; multi-patient rounds; user accounts/auth; persistence beyond a local store; mobile; production-grade STT tuning; real PHI.

---

## 2. Foundational Decisions (locked)

| Decision | Choice |
|----------|--------|
| Voice capture | Live mic with real STT, **plus a scripted Hebrew round as on-stage fallback** |
| EMR target | **Mock Chameleon UI** (no real hospital system) |
| Structuring + judge LLM | **Anthropic Claude** |
| Hebrew STT engine | **OpenAI Whisper API** (best Hebrew accuracy) |
| Safety model | **Human approves before commit** — hard gate, nothing auto-writes to the EMR |
| Demo scope | **One general-surgery patient, full round** (capture → structure → judge → approve → EMR) |
| Deliverable | **Local runnable web app** |
| Visual style | Modern capture/review UI; **mock Chameleon EMR rendered in a legacy 90s/2000s aesthetic** to reflect integrating into existing hospital systems |

### Demo content (chosen)

- **Seeded patient (synthetic, no real PHI):** "דוד כהן", age 58, MRN 5582931. **Post-op day 2**, status-post exploratory laparotomy with **small-bowel resection** for adhesive small-bowel obstruction. Has an NG tube, a JP abdominal drain, and a right IJ central line — so the *ports*, *central line & drains* fields are clinically meaningful.
- **Deliberately-flagged lines (so the safety layer visibly works on stage):**
  1. **High-risk medication (correctly grounded, still confirms):** the attending orders an opioid (e.g. *מורפיום 4 מ"ג IV*). It is correctly extracted and grounded, but the high-risk guardrail **forces explicit human confirmation** before it can be approved — demonstrating "high-risk fields always confirm."
  2. **Ungrounded hallucination (blocked):** the structurer output includes one field the round never actually stated (e.g. "אין חום" / *no fever*) whose `sourceSpan` does **not** appear in the transcript. The deterministic grounding guardrail catches it and blocks approval — the core malpractice-prevention story (an LLM error caught before it reaches the chart).
- **Mock mode (demo reliability + offline verification):** when API keys are absent, `transcribe`/`structure`/`judge` return **canned, deterministic responses** tied to the scripted round (stored in `server/data/mock-llm.json`). This makes the full pipeline runnable and testable with **no keys and no network**, and gives the most reliable classroom fallback. With keys present, the live Whisper + Claude path is used. Mock mode is selected automatically when keys are missing, or forced via `DEMO_MODE=mock`.

---

## 3. End-to-End Flow

```
[Mic: live Hebrew speech]
   │  (scripted fallback transcript if live STT fails on stage)
   ▼
Whisper STT  ──► Hebrew transcript (RTL), with the raw text retained verbatim
   ▼
Claude STRUCTURING pass ──► draft note: per field { value, verbatim source span, confidence }
   ▼
Claude JUDGE pass (separate, adversarial) ──► per field { verdict, reason, risk flag }
   ▼
Deterministic GUARDRAILS (plain code) ──► enforce grounding, high-risk confirmation, vitals ranges
   ▼
Clinician REVIEW & APPROVE screen (field-by-field, source quote highlighted)
   │  ── HARD GATE: explicit approve click required ──
   ▼
Mock Chameleon EMR updates (before → after), each committed field logged to an audit trail
```

The hard gate (no EMR write without an explicit human approve action) is the spine of the "no incorrect clinical information" claim.

---

## 4. Rounds Note Data Model

Mirrors the ward note described by the clinical team. All fields optional (absent = not stated in the round). Each populated field carries grounding + judge metadata (see §6).

| Group | Fields |
|-------|--------|
| **Subjective** | chief complaint (pre-surgery); relevant medical history; current illness / status. *Sources: patient/family, ER records.* |
| **Objective / physical exam** | vital signs; general appearance; abdomen check; ports; central line & drains |
| **Plan** | plan (≈2 sentences) |
| **Attending decisions / orders** | imaging; blood tests; medications; procedures / surgery |
| **Administrative** | discharge; request for more information |

`vital signs` is itself a small structured object (temp, HR, BP, RR, SpO₂); **each vital is its own `FieldRecord`** (e.g. `objective.vitals.hr`) with its own `sourceSpan`, so the grounding check and numeric range checks run per vital. All other fields are free text for the POC.

### Field record shape

```json
{
  "fieldId": "objective.vitals.hr",
  "value": "98",
  "sourceSpan": "<verbatim Hebrew substring from the transcript>",
  "confidence": 0.0,
  "judge": { "verdict": "grounded | ungrounded | contradicted | ambiguous", "reason": "", "highRisk": false },
  "guardrail": { "passed": true, "requiresConfirmation": false, "messages": [] },
  "status": "pending | approved | rejected | edited",
  "committedValue": null
}
```

---

## 5. Components & Interfaces

The app is split into small, independently testable units. Each communicates through a defined HTTP or function interface; none reaches into another's internals.

### Backend (Node.js + Express) — holds both API keys server-side

| Unit | Responsibility | Interface |
|------|----------------|-----------|
| `transcribe` | Audio blob → Hebrew transcript via Whisper. | `POST /api/transcribe` (multipart audio) → `{ transcript }` |
| `structure` | Transcript → draft note with per-field grounding + confidence, via Claude. **Prompt forbids inferring unstated facts.** Returns `FieldRecord`s with `value`/`sourceSpan`/`confidence` populated and `judge`/`guardrail`/`committedValue` at their default/empty values. | `POST /api/structure` `{ transcript }` → `{ fields: FieldRecord[] }` |
| `judge` | Transcript + draft note → per-field verdicts, via a *separate* adversarial Claude call that distrusts the extractor. Owns the `judge` sub-object only, then **runs `guardrails` server-side** and returns the fully-populated records. | `POST /api/judge` `{ transcript, fields }` → `{ fields: FieldRecord[] }` (judge verdicts + guardrail results merged in) |
| `guardrails` | Pure deterministic function (no LLM), called by `judge` server-side after verdicts are attached. Owns the `guardrail` sub-object. Applies grounding, high-risk, and range rules (see §6). | `applyGuardrails(transcript, fields) → fields` |
| `commit` | Approved fields → mock EMR store + audit log. Rejects any field lacking `status: "approved"`. | `POST /api/commit` `{ patientId, fields }` → `{ emrState, auditEntries }` |
| `emr-store` | In-memory + JSON-file mock Chameleon record for one seeded patient. | `getEmr(patientId)`, `applyCommit(patientId, fields)` |
| `scripted-round` | Serves the canned Hebrew transcript + matching audio for the fallback path. | `GET /api/scripted-round` → `{ transcript, audioUrl }` |

`structure` and `judge` each request structured JSON output (tool / response-format) so no brittle parsing is needed; on malformed output they return a clear error rather than a partial note.

**Common error envelope.** All four API routes return errors as `{ error: { code, message } }` (HTTP 4xx/5xx), so the frontend's retry / "use scripted round" affordances stay uniform.

### Frontend (single-page, vanilla HTML/CSS/JS, RTL Hebrew, Tailwind via CDN — no build step)

| Unit | Responsibility |
|------|----------------|
| `capture-view` (modern) | "Record round" (MediaRecorder + waveform) and "Use scripted round" buttons; live Hebrew transcript panel (RTL). |
| `review-view` (modern) | Renders each field with its highlighted verbatim source quote, confidence color, judge verdict, and guardrail flag; per-field edit / approve / reject controls; "Commit approved → Chameleon" button (disabled until at least one field approved). |
| `emr-view` (**legacy 90s/2000s**) | Mock Chameleon screen: chunky gray chrome, system/serif fonts, beveled buttons, dense bordered tables. Shows the patient record **before → after** commit; newly committed fields briefly highlighted. |
| `patient-header` | Seeded mock post-op patient: name, MRN, post-op day, procedure. (Synthetic data only.) |

---

## 6. Safety Pipeline (the differentiator)

Three independent layers; a failure in any one is caught by the next, and the human gate sits above all of them.

1. **Grounded extraction (Claude).** For every field, return `value` + the **exact verbatim transcript span** that supports it + a `confidence`. System prompt: never infer or normalize clinical facts not explicitly stated; if absent, leave the field empty.

2. **Adversarial LLM-judge (separate Claude call).** Given the raw transcript and the draft note, independently verify each field against the transcript. Assigns a verdict (`grounded` / `ungrounded` / `contradicted` / `ambiguous`), a short reason, and a `highRisk` flag for clinically dangerous fields. The judge is told to assume the extractor may be wrong.

3. **Deterministic guardrails (plain code — catches the LLM itself failing).**
   - **Grounding check:** every field's `sourceSpan` must literally appear in the transcript (normalized substring match). Fail → field forced to `requiresConfirmation` and visually flagged. Kills fabricated grounding.
   - **High-risk fields always confirm:** medications/doses, imaging laterality, and procedures/surgery require explicit human confirmation regardless of confidence or verdict.
   - **Vitals range check:** numeric vitals validated against plausible ranges; out-of-range → flagged.

4. **Human review & approve (hard gate).** Each field is shown with its highlighted source quote, confidence, judge verdict, and any guardrail message. The clinician edits, approves, or rejects per field. `commit` writes **only** `approved` fields.

5. **Audit trail.** Each committed value logs: final value, original extracted value, transcript span, judge verdict, approver, timestamp. Rendered as a viewable log to evidence traceability.

---

## 7. Demo Script (happy path, ~3 min)

1. Show the legacy Chameleon screen for the seeded post-op patient — sparse/empty round note.
2. Click **Record round**, speak the Hebrew round (or hit **Use scripted round**). Live Hebrew transcript appears.
3. Click **Structure** → fields populate with highlighted source quotes, confidence colors, and judge verdicts.
4. Point out a **flagged** item (e.g., a medication forced to confirm; or a deliberately ungrounded line the guardrail caught) — the safety story.
5. Approve the good fields, fix/reject the flagged one.
6. Click **Commit → Chameleon**; the legacy EMR updates before → after; show the audit log.

A deliberately tricky line is included in the scripted round so the judge/guardrail visibly catches something — proving the safety layer does real work.

---

## 8. Error Handling

| Failure | Behavior |
|---------|----------|
| Mic permission denied / no device | `capture-view` shows a clear prompt and offers the scripted-round path. |
| Live STT fails or low quality | One-click switch to the scripted round; live transcript panel shows the error, never a silent hang. |
| Whisper / Claude API error or timeout | Endpoint returns a structured error; UI shows a retry + "use scripted round" affordance. |
| Claude returns malformed JSON | `structure`/`judge` return an explicit error (no partial/guessed note). |
| Field lacks grounding | Guardrail flags it; it cannot be approved without explicit confirmation. |
| Commit attempted with zero approved fields | Button disabled; backend rejects. |
| Missing API keys at startup | Server fails fast with a readable message pointing to `.env`. |

---

## 9. Tech Stack & Running Locally

- **Runtime:** Node.js + Express (single process serves API + static frontend).
- **Frontend:** vanilla HTML/CSS/JS, RTL Hebrew support, Tailwind via CDN; legacy EMR styling in hand-written CSS. No bundler/build step.
- **Audio:** browser `MediaRecorder` → backend → Whisper.
- **Keys:** `.env` with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, loaded server-side only; never sent to the browser.
- **Mock/live mode:** auto-selects **mock** (canned deterministic responses for the scripted round) when keys are absent or `DEMO_MODE=mock`; uses **live** Whisper + Claude when keys are present. The app is fully runnable, demoable, and testable in mock mode with no keys or network.
- **Mock EMR:** in-memory object seeded from a JSON file, persisted to a separate working-state file on commit. **`npm start` reseeds from `patient.seed.json`** so every class rehearsal starts clean; a `npm run reset` script also restores the seed on demand.
- **Run:** `npm install` → `npm start` → open `http://localhost:3000`.
- **README:** setup, keys, run, and demo-script steps.

---

## 10. Testing

- **Guardrails unit tests** (pure function): grounded vs. fabricated span; high-risk field forces confirmation; in/out-of-range vitals. These are the safety-critical, LLM-independent checks.
- **Commit unit tests:** only `approved` fields persist; audit entries created; non-approved fields rejected.
- **Structure/judge contract tests:** with a fixed sample transcript and a stubbed LLM response, assert the `FieldRecord` shape and that the UI-consumed fields are present.
- **Manual demo rehearsal:** full happy path + the deliberately-flagged line, on the scripted round, before class.

---

## 11. Repository Layout

```
/server
  index.js            # Express app, static serving, startup key check
  routes/
    transcribe.js     # POST /api/transcribe   (Whisper)
    structure.js      # POST /api/structure     (Claude extraction)
    judge.js          # POST /api/judge         (Claude adversarial)
    commit.js         # POST /api/commit
    scriptedRound.js  # GET  /api/scripted-round
  lib/
    guardrails.js     # pure deterministic checks
    emrStore.js       # mock Chameleon record + audit log
    llm.js            # Anthropic + OpenAI client wrappers, prompts
  data/
    patient.seed.json
    scripted-round.json  (+ scripted-round audio asset)
/public
  index.html
  app.js              # capture-view, review-view, emr-view, patient-header
  modern.css
  legacy-emr.css      # 90s/2000s Chameleon styling
.env.example
README.md
```
