# Evaluation harness

Repeatable, deterministic scoring of the safety pipeline against hand-annotated
gold standards.

```bash
npm run eval              # every gold file
npm run eval mock-rounds  # one, by filename substring
```

Requires **LIVE** mode (`ANTHROPIC_API_KEY` set, `DEMO_MODE` unset). In mock
mode the pipeline returns canned fixtures keyed to the scripted round, so the
eval refuses to run rather than report a meaningless score.

## Cost, and running on a cheaper model

One full pass over the 4-patient Plaud round is 11 live calls (1 segmentation,
4 patients × structure+judge, 2 baseline). Rough cost per run:

| model | $/run |
|---|---|
| `claude-opus-4-8` (default) | ~$1.15 |
| `claude-sonnet-4-6` | ~$0.70 |
| `claude-haiku-4-5` | ~$0.25 |

`CLAUDE_MODEL` overrides the model for structure and judge (`lib/llm.js` omits
adaptive thinking on Haiku, which predates it):

```bash
CLAUDE_MODEL=claude-haiku-4-5 npm run eval plaud
```

The model is printed in the run header and recorded on each report in
`results/latest.json` — **a Haiku run and an Opus run are not comparable**, so
always check which produced a given number before quoting it.

## Why it exists

The judge is an LLM grading an LLM, and on the mock-rounds transcript it
returned `grounded` for **52 of 52** fields — including several that were
wrong. Every metric here is therefore computed in plain code: no model is asked
to grade another model's output.

## What it measures

Each transcript is run **twice** and the two runs are compared:

| mode | what it does |
|---|---|
| `baseline` | the whole round structured as ONE note (what the POC did before `lib/segment.js`) |
| `segmented` | the round split per patient, each slice through the identical structure → judge → guardrail path |

| metric | question it answers |
|---|---|
| `segmentation` | Did we find the right number of beds, with the right names, as verbatim slices? |
| `recall` | Which gold facts reached the note? (`misfiled` = captured, but under the wrong field) |
| `fabrication` | Did a field appear that was never spoken? |
| `leakage` | Did another patient's numbers/drugs land in this patient's note? |
| `grounding` | Is the `sourceSpan` literally present in the transcript it came from? |
| `spanCoverage` | Does the quote actually *support* its value, or only overlap it? |
| `collisions` | Duplicate `fieldId`s in one note — `emrStore` writes `note[fieldId]`, so extras are silent data loss |
| `judge` | Verdict distribution — how much signal the adversarial pass added |

`spanCoverage` is the one worth understanding. `guardrails.js` checks that the
quote *appears* in the transcript — a substring test. It cannot check that the
quote *supports* the value. So a medications field can read
`Paracetamol… Ibuprofen… Amlodipine 5 מ"ג` while its quote covers only the first
two drugs, pass the guardrail, and be marked `grounded` by the judge. The eval
flags it by extracting numbers and Latin-script tokens (doses, drug names, lab
names) from the value and checking each against the quote. Hebrew wording is
deliberately ignored — clinical rephrasing legitimately changes it, but it must
not invent a dose or a drug.

## Adding a transcript

1. Drop the verbatim Hebrew transcript in `transcripts/`.
2. Add `gold/<name>.json`:

```jsonc
{
  "transcript": "<name>.txt",
  "expectedPatientCount": 2,
  "patients": [{
    "label": "יוסי כהן",
    "labelAliases": ["יוסי"],
    // fieldId "*" = the fact must appear SOMEWHERE, under any field
    "expectedFields": [
      { "fieldId": "objective.vitals.bp", "mustContain": ["128", "78"], "why": "BP 128/78" }
    ],
    // spoken for nobody -> a populated record here is a fabrication
    "forbiddenFields": [
      { "fieldId": "objective.vitals.temp", "why": "no temperature was spoken" }
    ],
    // strings belonging to the OTHER patient -> presence means the round leaked
    "foreignTokens": [
      { "text": "110", "why": "Rachel Levi's systolic BP" }
    ]
  }]
}
```

Annotate from the transcript alone, and record *why* in each entry — the `why`
is what makes a later reviewer able to check the gold standard itself.

Results land in `results/latest.json` (gitignored).
