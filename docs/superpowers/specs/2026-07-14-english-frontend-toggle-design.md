# English Frontend Language Toggle — Design

**Date:** 2026-07-14
**Status:** Approved by user (toggle mechanism, English default)
**Scope:** `public/index.html`, `public/app.js` only. No server changes.

## Goal

Add an EN/HE language toggle to the prototype frontend so the app can be
demoed to an English-speaking audience. UI chrome (headings, buttons,
statuses, error messages, chips, group titles, footer) switches between
English and Hebrew. Clinical content — the Hebrew transcript, verbatim
source quotes, field values, and judge reasons — always remains Hebrew and
RTL, because it is real data and the grounding guardrail quotes it verbatim.

## Non-goals

- No translation of transcript, field values, sourceSpans, or judge reasons.
- No changes to `/server` (routes, lib, data, tests all untouched).
- No changes to the legacy Chameleon EMR window (already English; authentic
  to the real Chameleon).
- No URL-based locale routing and no separate English page.

## Decisions (user-approved)

1. **Delivery:** single app with a header language toggle (not a separate
   page, not a replacement).
2. **Default:** English on first visit. Afterwards, the last choice wins.
3. **Persistence:** `localStorage` key `lang`, values `'en' | 'he'`.

## Design

### 1. String dictionary (`app.js`)

A top-level constant:

```js
const STRINGS = {
  en: { appTitle: 'Hebrew Voice Rounds → Chameleon Record', btnRecord: 'Record round', ... },
  he: { appTitle: 'סבב קולי בעברית ← רשומת כמליאון', btnRecord: 'הקלט סבב', ... },
};
let currentLang = 'en'; // resolved at init from localStorage, default 'en'
function t(key, vars) { /* lookup in STRINGS[currentLang], interpolate {name} vars */ }
```

- Every UI string currently hardcoded in Hebrew in `app.js` (~50) moves into
  the dictionary under a stable key. The Hebrew entries are the existing
  strings verbatim; English entries are new translations.
- Parameterized strings (e.g. the review summary
  `סה"כ {total} שדות · {approved} אושרו …`) use `{placeholder}` tokens
  interpolated by `t()`. HTML-bearing summaries keep their markup in the
  template string; interpolated values are escaped with the existing `esc()`.
- Group titles (`GROUP_LABELS`) and status labels (pending/approved/
  rejected/edited), confidence tiers (high/mid/low), and judge verdict
  labels (grounded/ungrounded/contradicted/ambiguous) become per-language
  maps resolved through `t()` or a language-keyed lookup.

### 2. Static HTML keyed by `data-i18n` (`index.html`)

- Elements with fixed text get `data-i18n="key"` (text content) — title,
  stepper items, section headings, transcript placeholder, commit hint,
  footer, etc.
- `applyLanguage(lang)` in `app.js`:
  - sets `document.documentElement.lang` (`en`/`he`) and `dir`
    (`ltr`/`rtl`),
  - walks `[data-i18n]` and assigns `textContent = t(key)`,
  - updates the toggle button label,
  - re-renders dynamic panes via existing render functions when data is
    present: patient header, field cards, review summary, commit hint, mode
    badge.
- Panels that must stay RTL regardless of UI language keep an explicit
  `dir="rtl"`: the transcript panel, source-quote blocks, Hebrew field
  values, and the procedure line in the patient header. In English mode the
  patient header labels are English but Hebrew values (name, procedure,
  lines/drains) remain RTL-isolated (`dir="rtl"` / `unicode-bidi: isolate`
  via existing markup patterns).

### 3. Toggle button (header)

- Placed next to the mode badge in the header.
- Label shows the language you would switch TO: `עברית` when the UI is
  English, `English` when the UI is Hebrew.
- Click → `setLanguage(other)` → persist to `localStorage.lang` →
  `applyLanguage()`.

### 4. Field labels

`FIELD_META` in `app.js` (accessed via `fieldMeta(id)`) already holds
`{ he, en }` per fieldId. Field cards currently render Hebrew primary +
English subtitle; in English mode they flip (English primary, Hebrew
subtitle). No new label data needed.

### 5. Runtime messages

Error/status messages are built through `t()` at display time, so any
message raised after a flip appears in the current language. Messages
already on screen re-render only where a render function exists (field
cards, summary, patient header, mode badge); transient capture/review error
banners are cleared on language switch or simply show in the new language
the next time they fire.

### 6. Details (from spec review)

- **Directional glyphs:** the stepper `←` separators and arrows embedded in
  button labels / the app title point the other way in LTR; separators get
  `data-i18n` keys so English shows `→`.
- **State-dependent labels:** `applyLanguage()` also refreshes the record
  button label according to recording state, so a mid-recording flip shows
  the right "Stop recording" text. Transient button texts ("Structuring…",
  "Committing…") come from `t()` at the moment they're set.
- **`document.title`** gets a per-language value via the dictionary.
- **Audit-log timestamps** in the legacy pane keep `he-IL` formatting —
  legacy window is explicitly untouched.

## Error handling

- Unknown `localStorage.lang` values fall back to `'en'`; reads/writes are
  wrapped in try/catch for privacy modes where storage throws.
- `t()` falls back to the English string, then to the key itself, so a
  missing translation can never blank out a control.

## Testing / verification

- `npm test` (server-side) must still pass — expected untouched.
- Browser verification via Playwright against the running app:
  1. Fresh load (cleared storage) → UI in English, `dir="ltr"`.
  2. Run scripted round → structure → verify field cards show English
     labels, Hebrew quotes still RTL.
  3. Flip to Hebrew mid-flow → all chrome re-renders Hebrew, `dir="rtl"`,
     state (fields, approvals) preserved.
  4. Approve a field, commit → legacy EMR + audit update as before.
  5. Reload → language persisted.
