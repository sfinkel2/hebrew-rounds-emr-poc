// ============================================================================
// app.js — single-page controller for the Hebrew Voice Rounds → Mock Chameleon
// EMR POC (spec §5 frontend). No build step; ES module loaded directly.
//
// Areas (spec §5):
//   patient-header — seeded patient (Hebrew RTL name, MRN, age, POD, procedure)
//   capture-view   — Plaud pull + scripted-round fallback + live transcript
//   review-view    — structured fields w/ source quote, confidence, judge verdict,
//                    guardrail flag, per-field approve/reject + force-confirm
//   emr-view       — legacy Chameleon record (before → after), audit log
//
// Backend contract (spec §5):
//   GET  /api/scripted-round      -> { transcript, audioUrl }
//   GET  /api/plaud/status         -> { connected }
//   GET  /api/plaud/recordings     -> { recordings }
//   GET  /api/plaud/recordings/:id/transcript -> { transcript, segments, audioUrl }
//   POST /api/structure  { transcript }    -> { fields: FieldRecord[] }
//   POST /api/judge      { transcript, fields } -> { fields: FieldRecord[] }
//   POST /api/commit     { patientId, fields }  -> { emrState, auditEntries }
//   (EMR read for the before-view: GET /api/emr/:patientId — see loadEmr())
// Error envelope on all API routes: { error: { code, message } }.
//
// The FieldRecord schema is owned by server/lib/fields.js; the frontend only
// consumes it and never redefines it. We import the field catalog metadata
// (labels, groups, order) from a lightweight client mirror generated below from
// the same fieldIds so render order/labels match the server catalog.
// ============================================================================

'use strict';

import { matchSpanToSegments } from './segmentMatch.js';

// ---------------------------------------------------------------------------
// Field catalog mirror (labels + group order). fieldIds and Hebrew labels match
// server/lib/fields.js exactly; the server remains the source of truth for the
// schema/records — this is presentation metadata only, keyed by fieldId.
// ---------------------------------------------------------------------------
const GROUP_ORDER = ['subjective', 'objective', 'plan', 'decisions', 'administrative'];
const GROUP_LABELS = {
  subjective: { he: 'סובייקטיבי', en: 'Subjective' },
  objective: { he: 'אובייקטיבי / בדיקה גופנית', en: 'Objective / Physical exam' },
  plan: { he: 'תוכנית', en: 'Plan' },
  decisions: { he: 'החלטות / הוראות הרופא הבכיר', en: 'Attending decisions / orders' },
  administrative: { he: 'מנהלי', en: 'Administrative' },
};
function groupLabel(g) {
  const l = GROUP_LABELS[g];
  return l ? (currentLang === 'he' ? l.he : l.en) : g;
}
const FIELD_META = {
  'subjective.chiefComplaint':   { he: 'תלונה עיקרית (טרום-ניתוחית)', en: 'Chief complaint', group: 'subjective' },
  'subjective.relevantHistory':  { he: 'רקע רפואי רלוונטי',          en: 'Relevant history', group: 'subjective' },
  'subjective.currentIllness':   { he: 'מחלה נוכחית / סטטוס',         en: 'Current illness', group: 'subjective' },
  'objective.vitals.temp':       { he: 'חום',        en: 'Temperature', group: 'objective' },
  'objective.vitals.hr':         { he: 'דופק',       en: 'Heart rate',  group: 'objective' },
  'objective.vitals.bp':         { he: 'לחץ דם',     en: 'Blood pressure', group: 'objective' },
  'objective.vitals.rr':         { he: 'קצב נשימה',  en: 'Resp. rate',  group: 'objective' },
  'objective.vitals.spo2':       { he: 'סטורציה',    en: 'SpO₂',        group: 'objective' },
  'objective.generalAppearance': { he: 'מצב כללי',   en: 'General appearance', group: 'objective' },
  'objective.abdomen':           { he: 'בדיקת בטן',  en: 'Abdomen', group: 'objective' },
  'objective.ports':             { he: 'פורטים',     en: 'Ports', group: 'objective' },
  'objective.linesAndDrains':    { he: 'צנתר מרכזי ונקזים', en: 'Lines & drains', group: 'objective' },
  'plan.plan':                   { he: 'תוכנית',     en: 'Plan', group: 'plan' },
  'decisions.imaging':           { he: 'הדמיה',      en: 'Imaging', group: 'decisions' },
  'decisions.bloodTests':        { he: 'בדיקות דם',  en: 'Blood tests', group: 'decisions' },
  'decisions.medications':       { he: 'תרופות',     en: 'Medications', group: 'decisions' },
  'decisions.procedures':        { he: 'פרוצדורות / ניתוח', en: 'Procedures', group: 'decisions' },
  'administrative.discharge':    { he: 'שחרור',      en: 'Discharge', group: 'administrative' },
  'administrative.requestMoreInfo': { he: 'בקשה למידע נוסף', en: 'Request more info', group: 'administrative' },
};
function fieldMeta(id) {
  return FIELD_META[id] || { he: id, en: id, group: id.split('.')[0] };
}

// ---------------------------------------------------------------------------
// i18n — UI chrome only. Clinical content (transcript, sourceSpans, field
// values, judge reasons) is Hebrew data and is NEVER translated; the grounding
// guardrail quotes it verbatim. Default language: English; persisted choice
// wins (localStorage 'lang').
// ---------------------------------------------------------------------------
const STRINGS = {
  en: {
    docTitle: 'Hebrew Rounds → Chameleon EMR (POC)',
    appTitle: 'Hebrew Voice Rounds → Chameleon Record',
    toggleLabel: 'עברית',
    modeChecking: '● Checking connection…',
    modeMock: '● MOCK mode (offline)',
    modeLive: '● LIVE mode (Claude)',
    modeError: '● Connection error',
    patientLoading: 'Loading patient data…',
    patientLoadFailed: 'Could not load patient data from the server.',
    lblAge: 'Age',
    lblPod: 'Post-op day',
    lblProcedure: 'Procedure',
    lblLines: 'Lines/drains:',
    step1: '1 · Pull / Transcribe',
    step2: '2 · Structure & Check',
    step3: '3 · Chameleon Record',
    stepArrow: '→',
    captureTitle: 'Capture the round',
    btnPlaud: 'Pull from Plaud',
    plaudPickerTitle: 'Choose a Plaud recording',
    plaudPickerClose: 'Close',
    plaudLoading: 'Loading recordings…',
    plaudEmpty: 'No recordings found on this Plaud account.',
    plaudNotConnectedHint: 'Plaud is not connected. Run the Plaud MCP login on this machine first.',
    plaudNoTranscript: 'This recording has no transcript yet. Transcribe it in the Plaud app, then try again.',
    plaudPullFailed: 'Pulling from Plaud failed: {msg}',
    listenTitle: 'Play this quote from the recording',
    listenTitleApprox: 'Quote not found verbatim — play the closest matching part',
    audioBarLabel: 'Recording',
    audioBarClose: 'Hide player',
    audioLoadFailed: 'Could not play the recording — the audio link may have expired. Try again or pull the recording again.',
    btnScripted: 'Use scripted round',
    transcriptLabel: 'Transcript (Hebrew)',
    transcriptPlaceholder: 'The transcript will appear here after pulling from Plaud or choosing the scripted round…',
    btnStructure: 'Structure & check →',
    loading: 'Loading…',
    reviewTitle: 'Review & approve',
    reviewEmpty: 'Structured fields will appear here after clicking “Structure & check”.',
    structuring: 'Structuring…',
    structProgress: 'Structuring the note and running judge + safety checks…',
    segmenting: 'Splitting the round by patient…',
    btnPaste: 'Paste a transcript',
    pasteLabel: 'Paste the round transcript (Hebrew)',
    pasteCancel: 'Cancel',
    pasteUse: 'Use this transcript',
    patientsOnRound: 'Patients on this round',
    patientsHint: 'Each bed is structured, checked and committed separately.',
    commitToChart: 'Commit to chart:',
    segmentPending: 'not structured yet',
    segmentReady: '{n} fields',
    segmentCommitted: 'committed ✓',
    errSegmentFailed: 'Could not split the round by patient.',
    coverageTitle: 'Possible missing patient',
    roundProgress: '{done} of {total} patients committed',
    newChartFor: '＋ Open a new chart for {name}',
    newChart: '＋ Open a new chart',
    chooseChart: '— no matching chart — choose one —',
    errNoChart: 'Choose a chart for this patient, or open a new one, before committing.',
    reviewErrorEmpty: 'An error occurred while structuring the note.',
    errNoFields: 'Structuring returned no fields.',
    errNoTranscript: 'There is no transcript to structure. Pull from Plaud or choose the scripted round.',
    retry: 'Try again',
    steerHtml: 'You can continue with the <button id="err-use-scripted" class="underline font-semibold">scripted round</button>.',
    errScriptedLoad: 'Could not load the scripted round: {msg}',
    errNetwork: 'Network problem — cannot reach the server.',
    errServer: 'Server error (HTTP {status}).',
    errStructureFailed: 'Structuring the note failed.',
    errCommit: 'Commit failed: {msg}',
    highRisk: '⚠ High risk',
    confHigh: 'High', confMid: 'Medium', confLow: 'Low',
    verdictGrounded: 'Grounded', verdictUngrounded: 'Ungrounded',
    verdictContradicted: 'Contradicted', verdictAmbiguous: 'Ambiguous',
    statusPending: 'Pending', statusApproved: 'Approved',
    statusRejected: 'Rejected', statusEdited: 'Edited',
    srcFromTranscript: 'Source from transcript',
    srcMissing: '✕ Source not found in transcript',
    judgePrefix: 'Judge:',
    confirmBlockedReason: 'This field was blocked by the grounding check — explicit confirmation required.',
    confirmHighRiskReason: 'High-risk field — explicit confirmation required before approval.',
    confirmedLabel: '✓ Confirmed after review',
    btnConfirm: 'Confirm manually',
    btnApprove: '✓ Approve',
    btnReject: '✕ Reject',
    approveTooltip: 'Manually confirm the warning before approving this field.',
    summaryHtml: 'Total {total} fields · <span class="text-emerald-600 font-semibold">{approved} approved</span> · <span class="text-rose-600">{rejected} rejected</span> · <span class="text-amber-600">{flagged} require confirmation</span>',
    commitHintNone: 'Approve at least one field to commit.',
    commitHintReady: '{approved} approved field(s) ready to commit.',
    btnCommit: 'Commit approved → Chameleon',
    committing: 'Committing…',
    footerNote: 'Synthetic data only · Classroom POC · No real PHI · Nothing is written to the record without human approval',
  },
  he: {
    docTitle: 'סבב קולי בעברית ← רשומת כמליאון (POC)',
    appTitle: 'סבב קולי בעברית ← רשומת כמליאון',
    toggleLabel: 'English',
    modeChecking: '● בודק חיבור…',
    modeMock: '● מצב MOCK (לא מקוון)',
    modeLive: '● מצב LIVE (Claude)',
    modeError: '● שגיאת חיבור',
    patientLoading: 'טוען נתוני מטופל…',
    patientLoadFailed: 'לא ניתן לטעון את נתוני המטופל מהשרת.',
    lblAge: 'גיל',
    lblPod: 'יום פוסט-ניתוחי',
    lblProcedure: 'ניתוח',
    lblLines: 'קווים/נקזים:',
    step1: '1 · משיכה / תמלול',
    step2: '2 · מבנה ובדיקה',
    step3: '3 · רשומת כמליאון',
    stepArrow: '←',
    captureTitle: 'לכידת הסבב',
    btnPlaud: 'משוך מ-Plaud',
    plaudPickerTitle: 'בחר הקלטת Plaud',
    plaudPickerClose: 'סגור',
    plaudLoading: 'טוען הקלטות…',
    plaudEmpty: 'לא נמצאו הקלטות בחשבון ה-Plaud.',
    plaudNotConnectedHint: 'Plaud אינו מחובר. יש להריץ תחילה התחברות Plaud MCP במחשב זה.',
    plaudNoTranscript: 'להקלטה זו אין עדיין תמלול. יש לתמלל אותה באפליקציית Plaud ולנסות שוב.',
    plaudPullFailed: 'המשיכה מ-Plaud נכשלה: {msg}',
    listenTitle: 'השמע את הציטוט מההקלטה',
    listenTitleApprox: 'הציטוט לא נמצא מילה במילה — השמע את הקטע הקרוב ביותר',
    audioBarLabel: 'הקלטה',
    audioBarClose: 'הסתר נגן',
    audioLoadFailed: 'לא ניתן להשמיע את ההקלטה — ייתכן שקישור השמע פג. נסה שוב או משוך את ההקלטה מחדש.',
    btnScripted: 'השתמש בסבב מתוסרט',
    transcriptLabel: 'תמלול (עברית)',
    transcriptPlaceholder: 'התמלול יופיע כאן לאחר משיכה מ-Plaud או בחירת הסבב המתוסרט…',
    btnStructure: 'בנה הערה ובדוק ←',
    loading: 'טוען…',
    reviewTitle: 'סקירה ואישור',
    reviewEmpty: 'השדות המובנים יופיעו כאן לאחר לחיצה על «בנה הערה ובדוק».',
    structuring: 'מבנה…',
    structProgress: 'מבנה הערה ומריץ שופט + בדיקות בטיחות…',
    segmenting: 'מחלק את הסבב לפי מטופלים…',
    btnPaste: 'הדבק תמלול',
    pasteLabel: 'הדבק את תמלול הסבב (עברית)',
    pasteCancel: 'ביטול',
    pasteUse: 'השתמש בתמלול זה',
    patientsOnRound: 'מטופלים בסבב זה',
    patientsHint: 'כל מיטה נבנית, נבדקת ונשמרת בנפרד.',
    commitToChart: 'שמירה לתיק:',
    segmentPending: 'טרם נבנה',
    segmentReady: '{n} שדות',
    segmentCommitted: 'נשמר ✓',
    errSegmentFailed: 'לא ניתן לחלק את הסבב לפי מטופלים.',
    coverageTitle: 'ייתכן שחסר מטופל',
    roundProgress: '{done} מתוך {total} מטופלים נשמרו',
    newChartFor: '＋ פתח תיק חדש עבור {name}',
    newChart: '＋ פתח תיק חדש',
    chooseChart: '— אין תיק תואם — יש לבחור —',
    errNoChart: 'יש לבחור תיק עבור מטופל זה, או לפתוח תיק חדש, לפני השמירה.',
    reviewErrorEmpty: 'אירעה שגיאה בעת בניית ההערה.',
    errNoFields: 'המבנה לא החזיר שדות.',
    errNoTranscript: 'אין תמלול לבנות ממנו. משוך מ-Plaud או בחר את הסבב המתוסרט.',
    retry: 'נסה שוב',
    steerHtml: 'אפשר להמשיך בעזרת <button id="err-use-scripted" class="underline font-semibold">הסבב המתוסרט</button>.',
    errScriptedLoad: 'לא ניתן לטעון את הסבב המתוסרט: {msg}',
    errNetwork: 'בעיית רשת — לא ניתן להגיע לשרת.',
    errServer: 'שגיאת שרת (HTTP {status}).',
    errStructureFailed: 'בניית ההערה נכשלה.',
    errCommit: 'הקומיט נכשל: {msg}',
    highRisk: '⚠ סיכון גבוה',
    confHigh: 'גבוה', confMid: 'בינוני', confLow: 'נמוך',
    verdictGrounded: 'מבוסס', verdictUngrounded: 'לא מבוסס',
    verdictContradicted: 'סותר', verdictAmbiguous: 'עמום',
    statusPending: 'ממתין', statusApproved: 'אושר',
    statusRejected: 'נדחה', statusEdited: 'נערך',
    srcFromTranscript: 'מקור מהתמלול',
    srcMissing: '✕ מקור שלא נמצא בתמלול',
    judgePrefix: 'שופט:',
    confirmBlockedReason: 'שדה זה נחסם על ידי בדיקת ההיתכנות (grounding) — נדרש אישור מפורש.',
    confirmHighRiskReason: 'שדה בסיכון גבוה — נדרש אישור מפורש לפני אישור.',
    confirmedLabel: '✓ אושר לאחר בדיקה',
    btnConfirm: 'אשר ידנית',
    btnApprove: '✓ אשר',
    btnReject: '✕ דחה',
    approveTooltip: 'יש לאשר ידנית את האזהרה לפני אישור השדה.',
    summaryHtml: 'סה"כ {total} שדות · <span class="text-emerald-600 font-semibold">{approved} אושרו</span> · <span class="text-rose-600">{rejected} נדחו</span> · <span class="text-amber-600">{flagged} דורשים אישור</span>',
    commitHintNone: 'יש לאשר לפחות שדה אחד כדי לבצע קומיט.',
    commitHintReady: '{approved} שדות מאושרים מוכנים לקומיט.',
    btnCommit: 'בצע קומיט מאושר ← כמליאון',
    committing: 'מבצע קומיט…',
    footerNote: 'נתונים סינתטיים בלבד · POC לכיתה · ללא PHI אמיתי · אין כתיבה אוטומטית לרשומה ללא אישור אנושי',
  },
};

let currentLang = 'en';

/** Translate `key` in the current language; falls back to English, then the key. */
function t(key, vars) {
  let s = (STRINGS[currentLang] || {})[key];
  if (s == null) s = STRINGS.en[key];
  if (s == null) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** Read the persisted language; unknown/unreadable values fall back to 'en'. */
function storedLang() {
  try {
    const v = localStorage.getItem('lang');
    if (v === 'he' || v === 'en') return v;
  } catch { /* storage unavailable (privacy mode) */ }
  return 'en';
}

/**
 * Switch the UI language: document direction, static chrome (data-i18n),
 * state-dependent button labels, and every dynamic pane that has data.
 */
function applyLanguage(lang) {
  currentLang = lang === 'he' ? 'he' : 'en';
  try { localStorage.setItem('lang', currentLang); } catch { /* privacy mode */ }

  document.documentElement.lang = currentLang;
  document.documentElement.dir = currentLang === 'he' ? 'rtl' : 'ltr';
  document.title = t('docTitle');

  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });

  // State-dependent labels (not covered by the data-i18n walk).
  const plaudBtn = $('#btn-plaud');
  if (plaudBtn) plaudBtn.title = state.plaudConnected ? '' : t('plaudNotConnectedHint');
  closePlaudPicker(); // row timestamps are locale-formatted; reopen re-renders them
  const barClose = $('#audio-bar-close');
  if (barClose) barClose.title = t('audioBarClose');
  $('#btn-scripted').textContent = t('btnScripted');
  $('#btn-structure').textContent = t('btnStructure');
  $('#btn-commit').textContent = t('btnCommit');
  const toggle = $('#lang-toggle');
  if (toggle) toggle.textContent = t('toggleLabel');

  // Re-render dynamic panes in the new language (legacy EMR pane is
  // intentionally untouched — it is English by design).
  setModeBadge(lastBadgeMode);
  if (state.emrState) renderPatientHeader(state.emrState);
  if (!state.transcript) setTranscript('');
  if (state.fields.length) renderFields(); else refreshCommitState();
}

// ---------------------------------------------------------------------------
// App state (kept in app.js per the brief)
// ---------------------------------------------------------------------------
const state = {
  mode: 'unknown',        // 'mock' | 'live' | 'unknown'
  patientId: null,
  emrState: null,         // last-known EMR record { patientId, patient, note, auditLog }
  transcript: '',         // the FULL round transcript as captured
  // A ward round visits several beds. /api/segment cuts the round into one
  // verbatim slice per patient; each slice is structured, judged and committed
  // against its OWN chart, so two patients can never collide on note[fieldId].
  segments: [],           // [{ index, patientLabel, transcript, patientId, fields, loaded, committed }]
  activeSegment: 0,
  coverage: null,         // deterministic missing-patient check from /api/segment
  patients: [],           // [{ patientId, patient }] from /api/patients
  fields: [],             // FieldRecord[] currently under review (active segment)
  committedFieldIds: [],  // fieldIds committed in the most recent commit (for flash)
  plaudConnected: false,
  // Audio playback for the pulled Plaud recording (empty for scripted rounds).
  audio: { url: null, recordingId: null, recordingName: '', segments: [] },
  playingFieldId: null,   // fieldId whose matched window is currently playing
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// API helper — uniform handling of the { error: { code, message } } envelope.
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const opts = { method };
  if (body != null) {
    if (isForm) {
      opts.body = body; // FormData — let the browser set the multipart boundary
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    const err = new Error(t('errNetwork'));
    err.code = 'NETWORK';
    throw err;
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON */ } }

  if (!res.ok || (data && data.error)) {
    const env = data && data.error ? data.error : {};
    const err = new Error(env.message || t('errServer', { status: res.status }));
    err.code = env.code || `HTTP_${res.status}`;
    throw err;
  }
  return data == null ? {} : data;
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------
function setStep(active) {
  const order = ['capture', 'review', 'emr'];
  const ai = order.indexOf(active);
  document.querySelectorAll('#stepper .step-pill').forEach((pill) => {
    const i = order.indexOf(pill.dataset.step);
    pill.classList.toggle('is-active', i === ai);
    pill.classList.toggle('is-done', i < ai);
  });
}

// ---------------------------------------------------------------------------
// Mode badge
// ---------------------------------------------------------------------------
let lastBadgeMode = 'unknown';
function setModeBadge(mode) {
  lastBadgeMode = mode;
  const b = $('#mode-badge');
  b.classList.remove('mode-mock', 'mode-live', 'mode-err');
  if (mode === 'mock') { b.classList.add('mode-mock'); b.textContent = t('modeMock'); }
  else if (mode === 'live') { b.classList.add('mode-live'); b.textContent = t('modeLive'); }
  else if (mode === 'error') { b.classList.add('mode-err'); b.textContent = t('modeError'); }
  else { b.textContent = t('modeChecking'); }
}

// ===========================================================================
// PATIENT HEADER + EMR LOAD
// ===========================================================================

// Try a few likely EMR-read endpoints (the spec defines emr-store.getEmr but
// the exact GET route is owned by the backend agent). Degrade gracefully.
async function loadEmr() {
  const candidates = [];
  if (state.patientId) {
    candidates.push(`/api/emr/${encodeURIComponent(state.patientId)}`);
  }
  candidates.push('/api/emr', '/api/patient', '/api/scripted-round'); // last is not EMR; filtered below
  for (const url of candidates) {
    if (url === '/api/scripted-round') continue;
    try {
      const data = await api(url);
      const emr = normalizeEmr(data);
      if (emr) return emr;
    } catch { /* try next */ }
  }
  return null;
}

// Accept either a raw EMR object, { emrState }, or { patient, ... }.
function normalizeEmr(data) {
  if (!data) return null;
  const emr = data.emrState ? data.emrState : data;
  if (emr && (emr.patient || emr.note)) {
    if (emr.patientId) state.patientId = emr.patientId;
    return emr;
  }
  return null;
}

function renderPatientHeader(emr) {
  const p = emr && emr.patient ? emr.patient : null;
  const body = $('#patient-header-body');
  if (!p) {
    body.className = 'text-amber-600 text-sm';
    // Keep the failure text translatable on language flips via the data-i18n walk.
    body.dataset.i18n = 'patientLoadFailed';
    body.textContent = t('patientLoadFailed');
    return;
  }
  body.className = '';
  body.removeAttribute('data-i18n');
  const procHe = p.procedureHe || p.procedure || '';
  const lines = (p.linesHe || p.lines || []).join(' · ');
  body.innerHTML = `
    <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
      <div class="min-w-[10rem]">
        <div class="text-lg font-bold text-slate-900" dir="rtl">${esc(p.nameHe || p.name || '')}</div>
        <div class="text-xs text-slate-500" dir="ltr">${esc(p.name || '')}</div>
      </div>
      <div class="h-9 w-px bg-slate-200 hidden sm:block"></div>
      <div class="text-sm"><span class="text-slate-400 text-xs block">MRN</span><span class="font-semibold tabular-nums" dir="ltr">${esc(p.mrn || emr.patientId || '')}</span></div>
      <div class="text-sm"><span class="text-slate-400 text-xs block">${esc(t('lblAge'))}</span><span class="font-semibold">${esc(p.age)}</span></div>
      <div class="text-sm"><span class="text-slate-400 text-xs block">${esc(t('lblPod'))}</span><span class="font-semibold">POD ${esc(p.postOpDay)}</span></div>
      <div class="text-sm flex-1 min-w-[14rem]"><span class="text-slate-400 text-xs block">${esc(t('lblProcedure'))}</span><span class="font-medium text-slate-700" dir="rtl">${esc(procHe)}</span></div>
    </div>
    ${lines ? `<div class="mt-2 text-xs text-slate-500">${esc(t('lblLines'))} <span dir="rtl">${esc(lines)}</span></div>` : ''}
  `;
}

// ===========================================================================
// EMR VIEW (legacy)
// ===========================================================================
function renderEmrView(emr) {
  state.emrState = emr || state.emrState;
  const data = state.emrState;
  const strip = $('#legacy-patient-strip');
  const noteBody = $('#emr-note-body');
  const auditBody = $('#emr-audit-body');
  const statusFields = $('#legacy-status-fields');

  if (!data) {
    strip.innerHTML = '<span class="legacy-loading">Patient record unavailable.</span>';
    noteBody.innerHTML = '<tr><td colspan="2" class="legacy-empty">No record loaded.</td></tr>';
    return;
  }

  const p = data.patient || {};
  strip.innerHTML = `
    <span class="legacy-demo-item"><b>Name:</b> <span class="legacy-demo-he">${esc(p.nameHe || p.name || '')}</span></span>
    <span class="legacy-demo-item"><b>MRN:</b> ${esc(p.mrn || data.patientId || '')}</span>
    <span class="legacy-demo-item"><b>Age/Sex:</b> ${esc(p.age || '')}/${esc(p.sex || '')}</span>
    <span class="legacy-demo-item"><b>POD:</b> ${esc(p.postOpDay)}</span>
    <span class="legacy-demo-item"><b>Ward:</b> ${esc(p.ward || 'General Surgery')}</span>
  `;

  // Note table — iterate the catalog order, show committed values present in the EMR.
  const note = data.note || {};
  const justCommitted = new Set(state.committedFieldIds);
  let rows = '';
  let count = 0;
  for (const fieldId of Object.keys(FIELD_META)) {
    const entry = note[fieldId];
    if (!entry) continue;
    const v = entry.committedValue != null && entry.committedValue !== ''
      ? entry.committedValue
      : entry.value;
    if (v == null || v === '') continue;
    count++;
    const meta = fieldMeta(fieldId);
    const isNew = justCommitted.has(fieldId);
    rows += `<tr class="${isNew ? 'legacy-row-new' : ''}">
      <td class="legacy-field-name">${esc(meta.en)}</td>
      <td class="legacy-val-he">${esc(v)}${isNew ? '<span class="legacy-new-tag">NEW</span>' : ''}</td>
    </tr>`;
  }
  noteBody.innerHTML = rows || '<tr><td colspan="2" class="legacy-empty">No round note documented yet.</td></tr>';
  if (statusFields) statusFields.textContent = `Fields: ${count}`;

  // Audit log
  const log = Array.isArray(data.auditLog) ? data.auditLog : [];
  if (!log.length) {
    auditBody.innerHTML = '<tr><td colspan="5" class="legacy-empty">No audit entries yet.</td></tr>';
  } else {
    auditBody.innerHTML = log.map((a) => {
      const meta = fieldMeta(a.fieldId);
      const verdict = a.judgeVerdict || a.verdict || (a.judge && a.judge.verdict) || '';
      const t = a.timestamp ? new Date(a.timestamp) : null;
      const tStr = t && !isNaN(t) ? t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : (a.timestamp || '');
      const vcls = verdict ? `legacy-verdict-${esc(verdict)}` : '';
      return `<tr>
        <td dir="ltr">${esc(tStr)}</td>
        <td class="legacy-field-name">${esc(meta.en)}</td>
        <td class="legacy-val-he">${esc(a.finalValue != null ? a.finalValue : (a.value != null ? a.value : ''))}</td>
        <td class="${vcls}">${esc(verdict)}</td>
        <td>${esc(a.approver || 'clinician')}</td>
      </tr>`;
    }).join('');
  }
}

// ===========================================================================
// CAPTURE VIEW
// ===========================================================================
function showCaptureError(msg, steer = true) {
  const box = $('#capture-error');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="font-medium mb-1">⚠ ${esc(msg)}</div>${
    steer ? `<div>${t('steerHtml')}</div>` : ''
  }`;
  const b = $('#err-use-scripted');
  if (b) b.addEventListener('click', useScriptedRound);
}
function clearCaptureError() { $('#capture-error').classList.add('hidden'); }

function setTranscript(text) {
  state.transcript = text || '';
  // A new round invalidates the previous round's per-patient split and any
  // fields still under review — otherwise the next commit could write one
  // round's findings into the chart selected for a different round.
  state.segments = [];
  state.activeSegment = 0;
  state.fields = [];
  $('#patient-bar')?.classList.add('hidden');
  const panel = $('#transcript-panel');
  if (state.transcript) {
    panel.textContent = state.transcript;
  } else {
    panel.innerHTML = `<span class="text-slate-400" dir="auto" data-i18n="transcriptPlaceholder">${esc(t('transcriptPlaceholder'))}</span>`;
  }
  $('#btn-structure').disabled = !state.transcript;
}

async function useScriptedRound() {
  clearCaptureError();
  $('#btn-scripted').disabled = true;
  $('#btn-scripted').textContent = t('loading');
  try {
    const data = await api('/api/scripted-round');
    setTranscript(data.transcript || '');
    clearRecordingAudio(); // scripted round has no audio asset — no listen UI
    setStep('capture');
  } catch (e) {
    showCaptureError(t('errScriptedLoad', { msg: e.message }), false);
  } finally {
    $('#btn-scripted').disabled = false;
    $('#btn-scripted').textContent = t('btnScripted');
  }
}

// --- Plaud pull ---
async function initPlaudButton() {
  const btn = $('#btn-plaud');
  try {
    const s = await api('/api/plaud/status');
    state.plaudConnected = Boolean(s.connected);
  } catch {
    state.plaudConnected = false;
  }
  btn.disabled = !state.plaudConnected;
  btn.title = state.plaudConnected ? '' : t('plaudNotConnectedHint');
}

function closePlaudPicker() {
  $('#plaud-picker').classList.add('hidden');
}

function plaudErrorMessage(e) {
  if (e.code === 'plaud_not_connected') return t('plaudNotConnectedHint');
  if (e.code === 'plaud_no_transcript') return t('plaudNoTranscript');
  if (e.code === 'NETWORK') return e.message; // api() already localized it
  return t('plaudPullFailed', { msg: e.message });
}

function formatDurationMs(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function openPlaudPicker() {
  clearCaptureError();
  const btn = $('#btn-plaud');
  btn.disabled = true; // guard against a double-click racing two list fetches
  const body = $('#plaud-picker-body');
  $('#plaud-picker').classList.remove('hidden');
  body.innerHTML = `<div class="text-sm text-slate-400">${esc(t('plaudLoading'))}</div>`;
  try {
    const data = await api('/api/plaud/recordings');
    renderPlaudRecordings(data.recordings || []);
  } catch (e) {
    closePlaudPicker();
    showCaptureError(plaudErrorMessage(e));
  } finally {
    btn.disabled = !state.plaudConnected;
  }
}

function renderPlaudRecordings(recordings) {
  const body = $('#plaud-picker-body');
  if (!recordings.length) {
    body.innerHTML = `<div class="text-sm text-slate-400">${esc(t('plaudEmpty'))}</div>`;
    return;
  }
  body.innerHTML = '';
  for (const r of recordings) {
    const row = el('button',
      'w-full flex items-center justify-between gap-3 rounded-lg bg-white ring-1 ring-slate-200 hover:ring-brand-400 px-3 py-2 text-start text-sm transition disabled:opacity-60');
    const when = r.startAt
      ? new Date(r.startAt).toLocaleString(currentLang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
      : '';
    const meta = [when, formatDurationMs(r.durationMs)].filter(Boolean).join(' · ');
    // Recording names are user data — rendered verbatim, dir="auto".
    row.innerHTML = `<span class="font-medium text-slate-700 truncate" dir="auto">${esc(r.name)}</span>
      <span class="shrink-0 text-xs tabular-nums text-slate-500" dir="ltr">${esc(meta)}</span>`;
    row.addEventListener('click', () => pullPlaudTranscript(r.id, r.name));
    body.appendChild(row);
  }
}

async function pullPlaudTranscript(id, name) {
  const rows = [...document.querySelectorAll('#plaud-picker-body button')];
  rows.forEach((b) => { b.disabled = true; }); // one pull at a time
  try {
    const data = await api(`/api/plaud/recordings/${encodeURIComponent(id)}/transcript`);
    setTranscript(data.transcript || '');
    setRecordingAudio({
      recordingId: id,
      recordingName: name || '',
      audioUrl: data.audioUrl || null,
      segments: Array.isArray(data.segments) ? data.segments : [],
    });
    closePlaudPicker();
    clearCaptureError();
    setStep('capture');
  } catch (e) {
    // Transcript pane deliberately untouched on failure (spec: no partial state).
    showCaptureError(plaudErrorMessage(e));
  } finally {
    rows.forEach((b) => { b.disabled = false; });
  }
}

// --- Audio playback (Plaud recordings only) -------------------------------
// One shared <audio> element in the fixed #audio-bar. A field's 🔊 button
// plays its matched segment window [start−1s, end+1s]; the native controls
// remain available for full-file scrubbing. Scripted rounds have no audio.
const AUDIO_PAD_MS = 1000;
let windowEndSec = Infinity;   // stop point for the current field window
let programmaticSeek = false;  // distinguishes our seeks from user scrubbing
let audioUrlRetried = false;   // one presigned-URL refresh per failure episode

function hasAudio() {
  return Boolean(state.audio.url && state.audio.segments.length);
}

function showAudioBar(show) {
  const bar = $('#audio-bar');
  bar.classList.toggle('hidden', !show);
  bar.classList.toggle('flex', show);
}

function setRecordingAudio({ recordingId, recordingName, audioUrl, segments }) {
  stopFieldWindow(true);
  state.audio = { url: audioUrl, recordingId, recordingName, segments };
  const a = $('#audio-el');
  if (audioUrl) a.src = audioUrl; else { a.removeAttribute('src'); a.load(); }
  $('#audio-bar-name').textContent = recordingName;
  showAudioBar(Boolean(audioUrl));
}

function clearRecordingAudio() {
  const a = $('#audio-el');
  a.pause();
  a.removeAttribute('src');
  a.load();
  state.audio = { url: null, recordingId: null, recordingName: '', segments: [] };
  stopFieldWindow(false);
  showAudioBar(false);
}

function stopFieldWindow(pause) {
  windowEndSec = Infinity;
  state.playingFieldId = null;
  if (pause) $('#audio-el').pause();
  syncListenButtons();
}

function syncListenButtons() {
  document.querySelectorAll('.listen-btn').forEach((b) => {
    b.classList.toggle('is-playing', Boolean(state.playingFieldId) && b.dataset.fieldId === state.playingFieldId);
  });
}

// Memoized per field: segments are immutable for the lifetime of a pull.
function fieldAudioWindow(f) {
  if (f._audioWindow === undefined) {
    f._audioWindow = matchSpanToSegments(state.audio.segments, f.sourceSpan, f.value);
  }
  return f._audioWindow;
}

async function seekTo(a, sec) {
  if (a.readyState < 1) { // metadata not loaded yet
    await new Promise((resolve) => a.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  programmaticSeek = true;
  a.currentTime = sec;
}

async function toggleFieldAudio(f) {
  if (state.playingFieldId === f.fieldId) { stopFieldWindow(true); return; } // same button = stop
  const a = $('#audio-el');
  const m = fieldAudioWindow(f);
  state.playingFieldId = f.fieldId; // another field = switch
  syncListenButtons();
  try {
    await seekTo(a, m ? Math.max(0, (m.startMs - AUDIO_PAD_MS) / 1000) : 0);
    windowEndSec = m ? (m.endMs + AUDIO_PAD_MS) / 1000 : Infinity; // past-duration just ends naturally
    await a.play();
  } catch {
    stopFieldWindow(false);
  }
}

// Presigned URL is good for 24h; a session left open overnight will 403.
// On the first media error refetch the SAME transcript endpoint for a fresh
// URL and resume; take ONLY audioUrl from the response (never touch
// state.transcript or fields mid-review).
async function onAudioError() {
  const a = $('#audio-el');
  if (!state.audio.recordingId || audioUrlRetried) { showReviewError(t('audioLoadFailed')); return; }
  audioUrlRetried = true;
  const wasAt = a.currentTime;
  const wasPlaying = Boolean(state.playingFieldId);
  try {
    const data = await api(`/api/plaud/recordings/${encodeURIComponent(state.audio.recordingId)}/transcript`);
    if (!data.audioUrl) throw new Error('no url');
    state.audio.url = data.audioUrl;
    a.src = data.audioUrl;
    await seekTo(a, wasAt);
    if (wasPlaying) await a.play();
  } catch {
    showReviewError(t('audioLoadFailed'));
  }
}

function initAudioBar() {
  const a = $('#audio-el');
  a.addEventListener('timeupdate', () => {
    if (state.playingFieldId && a.currentTime >= windowEndSec) stopFieldWindow(true);
  });
  // User scrub cancels the window but keeps playing. Cancel on 'seeking'
  // (fires before any timeupdate at the new position) — cancelling on
  // 'seeked' loses a race where a scrub past the window end pauses first.
  a.addEventListener('seeking', () => {
    if (programmaticSeek) return;
    windowEndSec = Infinity;
    state.playingFieldId = null;
    syncListenButtons();
  });
  a.addEventListener('seeked', () => { programmaticSeek = false; });
  a.addEventListener('ended', () => stopFieldWindow(false));
  a.addEventListener('playing', () => { audioUrlRetried = false; });
  a.addEventListener('error', onAudioError);
  $('#audio-bar-close').addEventListener('click', () => { stopFieldWindow(true); showAudioBar(false); });
  $('#audio-bar-close').title = t('audioBarClose');
}

// ===========================================================================
// REVIEW VIEW — structure + judge, render field cards, approve/reject/confirm
// ===========================================================================
function showReviewError(msg) {
  const box = $('#review-error');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="font-medium mb-1">⚠ ${esc(msg)}</div>
    <div class="flex gap-3 mt-1">
      <button id="rv-retry" class="underline font-semibold">${esc(t('retry'))}</button>
      <button id="rv-scripted" class="underline font-semibold">${esc(t('btnScripted'))}</button>
    </div>`;
  $('#rv-retry')?.addEventListener('click', () => { box.classList.add('hidden'); structureAndJudge(); });
  $('#rv-scripted')?.addEventListener('click', () => { box.classList.add('hidden'); useScriptedRound(); });
}
function clearReviewError() { $('#review-error').classList.add('hidden'); }

/** The transcript the CURRENT review is grounded against (one patient's slice). */
function activeTranscript() {
  const seg = state.segments[state.activeSegment];
  return seg ? seg.transcript : state.transcript;
}

/**
 * Step 0: cut the round into one slice per patient, then structure the first.
 * Slices are verbatim, so /api/structure and /api/judge are unchanged — they
 * simply see one bed at a time instead of the whole ward.
 */
async function structureAndJudge() {
  if (!state.transcript) { showReviewError(t('errNoTranscript')); return; }
  clearReviewError();
  const btn = $('#btn-structure');
  btn.disabled = true; btn.textContent = t('structuring');
  $('#review-empty')?.remove();
  $('#fields-container').innerHTML = `<div class="text-sm text-slate-400 py-8 text-center">${esc(t('segmenting'))}</div>`;
  setStep('review');

  try {
    let segments;
    let coverage = null;
    try {
      const seg = await api('/api/segment', { method: 'POST', body: { transcript: state.transcript } });
      segments = Array.isArray(seg.segments) && seg.segments.length ? seg.segments : null;
      coverage = seg.coverage || null;
    } catch {
      segments = null; // segmentation unavailable — fall back to one whole-round note
    }
    if (!segments) {
      segments = [{ index: 0, patientLabel: '', transcript: state.transcript }];
    }
    state.coverage = coverage;
    renderCoverageWarning();

    state.segments = segments.map((s, i) => ({
      index: i,
      patientLabel: s.patientLabel || '',
      transcript: s.transcript,
      // Match the spoken name to an existing chart. Deliberately left NULL when
      // nothing matches: a real round visits beds that are not in the EMR, and
      // silently defaulting to the first chart would file this patient's round
      // into a different patient's record — the exact mis-attribution the whole
      // segmentation layer exists to prevent. The reviewer must pick a chart or
      // open a new one before commit is allowed.
      patientId: matchPatientId(s.patientLabel),
      fields: [],
      loaded: false,
    }));
    state.activeSegment = 0;
    renderPatientBar();
    await loadSegment(0);
  } catch (e) {
    $('#fields-container').innerHTML = '';
    const ed = el('div', 'text-sm text-slate-400 py-8 text-center', esc(t('reviewErrorEmpty')));
    ed.id = 'review-empty';
    ed.dataset.i18n = 'reviewErrorEmpty';
    $('#fields-container').appendChild(ed);
    showReviewError(e.message || t('errStructureFailed'));
  } finally {
    btn.disabled = !state.transcript; btn.textContent = t('btnStructure');
  }
}

/** Run structure + judge for one segment, caching the result on the segment. */
async function loadSegment(i) {
  const seg = state.segments[i];
  if (!seg) return;
  state.activeSegment = i;
  syncChartSelector();

  if (seg.loaded) {
    state.fields = seg.fields;
    renderPatientBar();
    renderFields();
    return;
  }

  $('#review-empty')?.remove();
  $('#fields-container').innerHTML = `<div class="text-sm text-slate-400 py-8 text-center">${esc(t('structProgress'))}</div>`;
  renderPatientBar();

  // Pass 1: structure — against this patient's slice only.
  const sres = await api('/api/structure', { method: 'POST', body: { transcript: seg.transcript } });
  let fields = Array.isArray(sres.fields) ? sres.fields : [];
  if (!fields.length) throw Object.assign(new Error(t('errNoFields')), { code: 'EMPTY' });

  // Pass 2: judge (+ server-side guardrails merged in).
  const jres = await api('/api/judge', { method: 'POST', body: { transcript: seg.transcript, fields } });
  fields = Array.isArray(jres.fields) ? jres.fields : fields;

  seg.fields = fields.map(normalizeRecord);
  seg.loaded = true;
  state.fields = seg.fields;
  renderPatientBar();
  renderFields();
}

/** Match a spoken patient name to a seeded chart id (Hebrew or English name). */
function matchPatientId(label) {
  const name = String(label || '').trim();
  if (!name) return null;
  const hit = state.patients.find((p) => {
    const he = String(p.patient?.nameHe || '').trim();
    const en = String(p.patient?.name || '').trim();
    return (he && (he === name || name.includes(he) || he.includes(name)))
      || (en && en.toLowerCase() === name.toLowerCase());
  });
  return hit ? hit.patientId : null;
}

/**
 * Surface the deterministic missing-patient check. An omission is the one
 * failure no other layer can see — there is no wrong value to catch and no bad
 * quote — so this banner is the only signal the reviewer gets.
 */
function renderCoverageWarning() {
  const box = $('#coverage-warning');
  if (!box) return;
  const warnings = state.coverage?.warnings || [];
  if (!warnings.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="font-semibold mb-1">⚠ ${esc(t('coverageTitle'))}</div>` +
    warnings.map((w) => `<div>${esc(w.message)}</div>`).join('');
}

/** One tab per bed; hidden entirely for a single-patient round. */
function renderPatientBar() {
  const bar = $('#patient-bar');
  const tabs = $('#patient-tabs');
  if (!bar || !tabs) return;

  if (state.segments.length < 2) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  tabs.innerHTML = '';

  // Round-level progress: which beds still have nothing in their chart. Without
  // this, "I committed a patient" and "I committed the round" look identical.
  const done = state.segments.filter((s) => s.committed).length;
  const hint = $('#patient-bar-hint');
  if (hint) {
    hint.textContent = t('roundProgress', { done, total: state.segments.length });
    hint.removeAttribute('data-i18n');   // now dynamic; applyLanguage must not overwrite it
    hint.className = done === state.segments.length
      ? 'text-[11px] font-semibold text-emerald-700'
      : 'text-[11px] text-amber-700';
  }

  state.segments.forEach((seg, i) => {
    const active = i === state.activeSegment;
    const chart = state.patients.find((p) => p.patientId === seg.patientId);
    const name = seg.patientLabel || chart?.patient?.nameHe || chart?.patient?.name || `#${i + 1}`;
    const sub = seg.committed
      ? t('segmentCommitted')
      : (seg.loaded ? t('segmentReady', { n: seg.fields.length }) : t('segmentPending'));

    const b = el('button', `rounded-xl px-3 py-2 text-start ring-1 transition ${
      active ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
    }`);
    b.type = 'button';
    b.innerHTML =
      `<span class="block text-sm font-medium" dir="rtl">${esc(name)}</span>` +
      `<span class="block text-[11px] ${active ? 'text-white/80' : 'text-slate-500'}">${esc(sub)}</span>`;
    b.addEventListener('click', async () => {
      if (i === state.activeSegment && seg.loaded) return;
      try {
        clearReviewError();
        await loadSegment(i);
      } catch (e) {
        showReviewError(e.message || t('errStructureFailed'));
      }
    });
    tabs.appendChild(b);
  });
}

/** Sentinel value for the "open a new chart" option in the selector. */
const NEW_CHART = '__new__';

/** Chart selector reflects and edits the active segment's commit target. */
function syncChartSelector() {
  const sel = $('#patient-chart');
  if (!sel) return;
  const seg = state.segments[state.activeSegment];
  sel.innerHTML = '';
  for (const p of state.patients) {
    const o = document.createElement('option');
    o.value = p.patientId;
    const nm = p.patient?.nameHe || p.patient?.name || p.patientId;
    o.textContent = `${nm} · ${p.patientId}${p.provisional ? ' · new' : ''}`;
    if (seg && p.patientId === seg.patientId) o.selected = true;
    sel.appendChild(o);
  }
  // A real round visits beds the seed has never heard of. Without this the
  // presenter can only commit to a pre-seeded chart, so an unrecognised patient
  // would have to be filed under someone else's record.
  const label = seg?.patientLabel?.trim();
  const o = document.createElement('option');
  o.value = NEW_CHART;
  o.textContent = label ? t('newChartFor', { name: label }) : t('newChart');
  sel.appendChild(o);

  // No chart matched the spoken name — surface that instead of quietly
  // pointing at whichever chart happened to be first.
  if (seg && !seg.patientId) {
    const unset = document.createElement('option');
    unset.value = '';
    unset.textContent = t('chooseChart');
    unset.selected = true;
    sel.insertBefore(unset, sel.firstChild);
  }
}

/** Open a provisional chart for the active segment's spoken name, and select it. */
async function openChartForActiveSegment() {
  const seg = state.segments[state.activeSegment];
  const name = seg?.patientLabel?.trim();
  try {
    const created = await api('/api/patients', {
      method: 'POST',
      body: name ? { nameHe: name } : { name: `Patient ${state.activeSegment + 1}` },
    });
    const pl = await api('/api/patients');
    state.patients = Array.isArray(pl.patients) ? pl.patients : state.patients;
    if (seg) seg.patientId = created.patientId;
    syncChartSelector();
    renderPatientBar();
  } catch (e) {
    showReviewError(e.message || t('errStructureFailed'));
    syncChartSelector();   // revert the selector to the segment's real target
  }
}

// Defensive defaults so the UI never crashes on a slightly-off record.
function normalizeRecord(r) {
  const j = r.judge || {};
  const g = r.guardrail || {};
  return {
    fieldId: r.fieldId,
    value: r.value != null ? r.value : '',
    originalValue: r.value != null ? r.value : '',
    sourceSpan: r.sourceSpan || '',
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    judge: {
      verdict: j.verdict || 'ambiguous',
      reason: j.reason || '',
      highRisk: !!j.highRisk,
    },
    guardrail: {
      passed: g.passed !== false,
      requiresConfirmation: !!g.requiresConfirmation,
      messages: Array.isArray(g.messages) ? g.messages : [],
    },
    status: r.status || 'pending',
    committedValue: r.committedValue != null ? r.committedValue : null,
    // UI-local:
    _confirmed: false,
    _edited: false,
  };
}

function confClass(c) {
  if (c >= 0.85) return ['conf-high', t('confHigh')];
  if (c >= 0.65) return ['conf-mid', t('confMid')];
  return ['conf-low', t('confLow')];
}
const VERDICT_KEYS = {
  grounded: 'verdictGrounded', ungrounded: 'verdictUngrounded',
  contradicted: 'verdictContradicted', ambiguous: 'verdictAmbiguous',
};
function verdictLabel(v) {
  return VERDICT_KEYS[v] ? t(VERDICT_KEYS[v]) : v;
}

// substring check mirroring the server grounding idea, for the highlight only.
// Checked against the ACTIVE PATIENT'S slice, not the whole round — a quote
// from the next bed must not light up as grounded on this patient's note.
function spanInTranscript(span) {
  if (!span) return false;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  return norm(activeTranscript()).includes(norm(span));
}

function renderFields() {
  const container = $('#fields-container');
  container.innerHTML = '';
  // group fields preserving catalog order within each group
  const byGroup = {};
  for (const f of state.fields) {
    const g = fieldMeta(f.fieldId).group;
    (byGroup[g] = byGroup[g] || []).push(f);
  }
  for (const g of GROUP_ORDER) {
    const list = byGroup[g];
    if (!list || !list.length) continue;
    const section = el('div', 'group-block');
    section.appendChild(el('div', 'group-heading', esc(groupLabel(g))));
    const inner = el('div', 'space-y-3');
    for (const f of list) inner.appendChild(renderFieldCard(f));
    section.appendChild(inner);
    container.appendChild(section);
  }
  updateReviewSummary();
}

function renderFieldCard(f) {
  const meta = fieldMeta(f.fieldId);
  const card = el('div', 'field-card');
  card.dataset.fieldId = f.fieldId;
  applyCardState(card, f);

  const [cc, clabel] = confClass(f.confidence);
  const verdict = f.judge.verdict;
  const grounded = spanInTranscript(f.sourceSpan);
  const needsConfirm = f.guardrail.requiresConfirmation;

  // header row — primary label follows the UI language, the other language is
  // shown as the small subtitle (both come from the bilingual field catalog).
  const isHe = currentLang === 'he';
  const header = el('div', 'flex items-start justify-between gap-2 mb-2');
  header.innerHTML = `
    <div class="field-label" dir="${isHe ? 'rtl' : 'ltr'}">${esc(isHe ? meta.he : meta.en)}<span class="field-label-en" dir="${isHe ? 'ltr' : 'rtl'}">${esc(isHe ? meta.en : meta.he)}</span></div>
    <div class="flex items-center gap-1.5 flex-wrap justify-end">
      ${f.judge.highRisk ? `<span class="risk-chip">${esc(t('highRisk'))}</span>` : ''}
      <span class="verdict-badge verdict-${esc(verdict)}">${esc(verdictLabel(verdict))}</span>
      <span class="conf-chip ${cc}"><span class="conf-dot"></span>${Math.round((f.confidence || 0) * 100)}% · ${clabel}</span>
      <span class="status-pill status-${esc(f.status)}" data-role="status">${statusLabel(f.status)}</span>
    </div>`;
  card.appendChild(header);

  // editable value
  const ta = el('textarea', 'field-value' + (f._edited ? ' is-edited' : ''));
  ta.setAttribute('dir', 'rtl');
  ta.setAttribute('rows', '2');
  ta.value = f.value;
  ta.addEventListener('input', () => {
    f.value = ta.value;
    f._edited = ta.value !== f.originalValue;
    ta.classList.toggle('is-edited', f._edited);
    if (f._edited && f.status !== 'rejected') { f.status = 'edited'; }
    updateStatusPill(card, f);
  });
  card.appendChild(ta);

  // source quote — the quote itself is verbatim Hebrew, always RTL.
  const sq = el('div', 'source-quote mt-2' + (grounded ? '' : ' is-missing'));
  sq.setAttribute('dir', 'rtl');
  sq.innerHTML = `<span class="src-label" dir="${isHe ? 'rtl' : 'ltr'}">${esc(grounded ? t('srcFromTranscript') : t('srcMissing'))}</span>«${esc(f.sourceSpan || '—')}»`;
  // listen button — plays the matched segment of the Plaud recording (absent
  // for scripted rounds, which have no audio).
  if (hasAudio()) {
    const m = fieldAudioWindow(f);
    const lb = el('button', 'listen-btn' + (state.playingFieldId === f.fieldId ? ' is-playing' : ''), '🔊');
    lb.type = 'button';
    lb.dataset.fieldId = f.fieldId;
    lb.title = m && m.method !== 'overlap' ? t('listenTitle') : t('listenTitleApprox');
    lb.setAttribute('aria-label', lb.title);
    lb.addEventListener('click', () => toggleFieldAudio(f));
    sq.appendChild(lb);
  }
  card.appendChild(sq);

  // judge reason — the reason text is Hebrew data; only the prefix translates.
  if (f.judge.reason) {
    const rr = el('div', 'mt-2 text-xs text-slate-500', `<span class="font-semibold text-slate-600">${esc(t('judgePrefix'))}</span> <span dir="rtl">${esc(f.judge.reason)}</span>`);
    rr.setAttribute('dir', isHe ? 'rtl' : 'ltr');
    card.appendChild(rr);
  }

  // guardrail messages (server-generated, English) — dir=auto resolves per content.
  for (const m of f.guardrail.messages) {
    const block = !f.guardrail.passed;
    const gm = el('div', 'guardrail-msg mt-2' + (block ? ' is-block' : ''), `<span>🛡</span><span dir="auto">${esc(m)}</span>`);
    card.appendChild(gm);
  }

  // needs-confirmation row
  if (needsConfirm) {
    const row = el('div', 'confirm-row mt-2' + (f._confirmed ? ' is-confirmed' : ''));
    row.setAttribute('dir', isHe ? 'rtl' : 'ltr');
    const reason = !f.guardrail.passed ? t('confirmBlockedReason') : t('confirmHighRiskReason');
    row.innerHTML = `<span>${esc(f._confirmed ? t('confirmedLabel') : '⚠ ' + reason)}</span>`;
    if (!f._confirmed) {
      const cb = el('button', 'btn-confirm', esc(t('btnConfirm')));
      cb.addEventListener('click', () => {
        f._confirmed = true;
        renderFields(); // re-render to unlock approve
      });
      row.appendChild(cb);
    }
    card.appendChild(row);
  }

  // action buttons
  const actions = el('div', 'field-actions mt-3');
  const approveBtn = el('button', 'btn-approve' + (f.status === 'approved' ? ' is-on' : ''), esc(t('btnApprove')));
  const rejectBtn = el('button', 'btn-reject' + (f.status === 'rejected' ? ' is-on' : ''), esc(t('btnReject')));

  const approveBlocked = needsConfirm && !f._confirmed;
  approveBtn.disabled = approveBlocked;
  if (approveBlocked) approveBtn.title = t('approveTooltip');

  approveBtn.addEventListener('click', () => {
    if (approveBtn.disabled) return;
    f.status = 'approved';
    rerenderCard(card, f);
    refreshCommitState();
  });
  rejectBtn.addEventListener('click', () => {
    f.status = 'rejected';
    rerenderCard(card, f);
    refreshCommitState();
  });
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  return card;
}

function statusLabel(s) {
  const key = { pending: 'statusPending', approved: 'statusApproved', rejected: 'statusRejected', edited: 'statusEdited' }[s];
  return key ? t(key) : s;
}
function updateStatusPill(card, f) {
  const pill = card.querySelector('[data-role="status"]');
  if (pill) { pill.className = `status-pill status-${f.status}`; pill.textContent = statusLabel(f.status); }
  applyCardState(card, f);
}
function applyCardState(card, f) {
  card.classList.toggle('is-approved', f.status === 'approved');
  card.classList.toggle('is-rejected', f.status === 'rejected');
  card.classList.toggle('needs-confirm', f.guardrail.requiresConfirmation && !f._confirmed && f.status !== 'approved' && f.status !== 'rejected');
  card.classList.toggle('is-blocked', f.guardrail.passed === false && !f._confirmed);
}
function rerenderCard(card, f) {
  const fresh = renderFieldCard(f);
  card.replaceWith(fresh);
  updateReviewSummary();
}

function updateReviewSummary() {
  const summary = $('#review-summary');
  const total = state.fields.length;
  const approved = state.fields.filter((f) => f.status === 'approved').length;
  const flagged = state.fields.filter((f) => f.guardrail.requiresConfirmation).length;
  const rejected = state.fields.filter((f) => f.status === 'rejected').length;
  if (!total) { summary.classList.add('hidden'); return; }
  summary.classList.remove('hidden');
  summary.innerHTML = t('summaryHtml', { total, approved, rejected, flagged });
  refreshCommitState();
}

function refreshCommitState() {
  const approved = state.fields.filter((f) => f.status === 'approved').length;
  const btn = $('#btn-commit');
  btn.disabled = approved === 0;
  $('#commit-hint').textContent = approved === 0
    ? t('commitHintNone')
    : t('commitHintReady', { approved });
}

// ===========================================================================
// COMMIT
// ===========================================================================
async function commitApproved() {
  const approved = state.fields.filter((f) => f.status === 'approved');
  if (!approved.length) return;
  clearReviewError();   // a prior "choose a chart" refusal must not outlive the fix
  const btn = $('#btn-commit');
  btn.disabled = true; btn.textContent = t('committing');
  $('#legacy-menu-status').textContent = 'Committing…';

  // Send all fields with their (possibly edited) values + status; backend commits only approved.
  const payload = state.fields.map((f) => ({
    fieldId: f.fieldId,
    value: f.value,
    sourceSpan: f.sourceSpan,
    confidence: f.confidence,
    judge: f.judge,
    guardrail: f.guardrail,
    status: f.status,
    committedValue: f.committedValue,
  }));

  // Commit goes to THIS segment's chart, not a single global patient.
  const seg = state.segments[state.activeSegment];
  const targetPatientId = seg ? seg.patientId : state.patientId;

  // Refuse rather than guess. Committing a round to an unconfirmed chart is
  // how one patient's medications end up in another patient's record.
  if (!targetPatientId) {
    showReviewError(t('errNoChart'));
    btn.disabled = false; btn.textContent = t('btnCommit');
    refreshCommitState();
    return;
  }

  try {
    const res = await api('/api/commit', {
      method: 'POST',
      body: { patientId: targetPatientId, fields: payload },
    });
    if (seg) { seg.committed = true; renderPatientBar(); }
    const emr = normalizeEmr(res) || (res.emrState ? res.emrState : null);
    state.committedFieldIds = approved.map((f) => f.fieldId);
    if (emr) {
      renderEmrView(emr);
      renderPatientHeader(emr);
    } else {
      // No emrState returned — fall back to a fresh EMR read.
      const fresh = await loadEmr();
      if (fresh) { renderEmrView(fresh); renderPatientHeader(fresh); }
    }
    setStep('emr');
    $('#legacy-menu-status').textContent = 'Saved';
    $('#legacy-status-main').textContent = `Chameleon EMR — committed ${approved.length} field(s)`;
    // Scroll the legacy record into view for the demo.
    $('#emr-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Clear the just-committed flash markers after the animation.
    setTimeout(() => { state.committedFieldIds = []; }, 2600);
  } catch (e) {
    $('#legacy-menu-status').textContent = 'Error';
    showReviewError(t('errCommit', { msg: e.message }));
  } finally {
    btn.textContent = t('btnCommit');
    refreshCommitState();
  }
}

// ===========================================================================
// INIT / WIRING
// ===========================================================================
async function detectMode() {
  // Mode is inferred from the scripted-round/health if exposed; otherwise we
  // probe a lightweight endpoint. The backend may expose /api/health or include
  // a `mode` on scripted-round; both are optional, so we degrade gracefully.
  try {
    const h = await api('/api/health');
    if (h && h.mode) { state.mode = h.mode; setModeBadge(h.mode); return; }
  } catch { /* no health route — fine */ }
  // Unknown but reachable: leave neutral until first call reveals behavior.
  setModeBadge('unknown');
}

async function init() {
  applyLanguage(storedLang());
  setStep('capture');
  setModeBadge('unknown');

  // Seed patientId guess (matches patient.seed.json) so /api/emr/:id can resolve.
  state.patientId = '5582931';

  // Wire capture controls
  $('#lang-toggle').addEventListener('click', () => applyLanguage(currentLang === 'he' ? 'en' : 'he'));
  $('#btn-plaud').addEventListener('click', openPlaudPicker);
  $('#plaud-picker-close').addEventListener('click', closePlaudPicker);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlaudPicker(); });
  $('#btn-scripted').addEventListener('click', useScriptedRound);
  $('#btn-paste').addEventListener('click', () => {
    $('#paste-panel').classList.toggle('hidden');
    $('#paste-text').focus();
  });
  $('#paste-cancel').addEventListener('click', () => $('#paste-panel').classList.add('hidden'));
  $('#paste-use').addEventListener('click', () => {
    const text = $('#paste-text').value.trim();
    if (!text) return;
    clearCaptureError();
    clearRecordingAudio();   // a pasted round has no audio to play back
    setTranscript(text);
    $('#paste-panel').classList.add('hidden');
  });
  $('#btn-structure').addEventListener('click', structureAndJudge);
  $('#btn-commit').addEventListener('click', commitApproved);
  $('#patient-chart').addEventListener('change', (e) => {
    if (e.target.value === NEW_CHART) { openChartForActiveSegment(); return; }
    const seg = state.segments[state.activeSegment];
    if (seg) seg.patientId = e.target.value;
    renderPatientBar();
  });

  // The round's beds, for tab labels and the commit-target selector.
  try {
    const pl = await api('/api/patients');
    state.patients = Array.isArray(pl.patients) ? pl.patients : [];
  } catch { state.patients = []; }
  $('#legacy-audit-btn').addEventListener('click', () => {
    $('#legacy-audit-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Load patient + EMR (before-state)
  const emr = await loadEmr();
  if (emr) {
    renderPatientHeader(emr);
    renderEmrView(emr);
  } else {
    renderPatientHeader(null);
    renderEmrView(null);
  }

  initAudioBar();
  detectMode();
  initPlaudButton();
}

document.addEventListener('DOMContentLoaded', init);
