// server/lib/fields.js
//
// Canonical field catalog + FieldRecord factory for the Hebrew Rounds → Mock
// Chameleon EMR POC. This is the SINGLE SOURCE OF TRUTH for the note's data
// model (spec §4). Every other module (structure, judge, guardrails, emrStore,
// frontend) imports from here and must not redefine the schema.
//
// A FieldRecord has the shape (spec §4):
//   {
//     fieldId, value, sourceSpan, confidence,
//     judge:     { verdict, reason, highRisk },
//     guardrail: { passed, requiresConfirmation, messages },
//     status, committedValue
//   }
//
// FIELD_DEFS is the ordered catalog. Each definition carries:
//   fieldId   - dotted id, e.g. "subjective.chiefComplaint", "objective.vitals.hr"
//   label     - English human label
//   labelHe   - Hebrew (RTL) human label
//   group     - one of: subjective | objective | plan | decisions | administrative
//   highRisk  - true for medications, procedures, imaging (spec §6)
//   isVital   - true for the five vitals; vitals also carry `range {min,max,unit}`

/** Allowed judge verdicts (spec §4 / §6). */
export const JUDGE_VERDICTS = ['grounded', 'ungrounded', 'contradicted', 'ambiguous'];

/** Allowed field statuses (spec §4). */
export const FIELD_STATUSES = ['pending', 'approved', 'rejected', 'edited'];

/** Group ids in render order. */
export const GROUPS = ['subjective', 'objective', 'plan', 'decisions', 'administrative'];

/**
 * Ordered catalog of every field in the rounds note (spec §4).
 * Order here is the canonical render/iteration order.
 */
export const FIELD_DEFS = [
  // ── Subjective ────────────────────────────────────────────────────────────
  {
    fieldId: 'subjective.chiefComplaint',
    label: 'Chief complaint (pre-surgery)',
    labelHe: 'תלונה עיקרית (טרום-ניתוחית)',
    group: 'subjective',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'subjective.relevantHistory',
    label: 'Relevant medical history',
    labelHe: 'רקע רפואי רלוונטי',
    group: 'subjective',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'subjective.currentIllness',
    label: 'Current illness / status',
    labelHe: 'מחלה נוכחית / סטטוס',
    group: 'subjective',
    highRisk: false,
    isVital: false,
  },

  // ── Objective / physical exam ──────────────────────────────────────────────
  // Vitals — each is its own FieldRecord (spec §4) with a numeric range.
  {
    fieldId: 'objective.vitals.temp',
    label: 'Temperature',
    labelHe: 'חום',
    group: 'objective',
    highRisk: false,
    isVital: true,
    range: { min: 30, max: 43, unit: '°C' },
  },
  {
    fieldId: 'objective.vitals.hr',
    label: 'Heart rate',
    labelHe: 'דופק',
    group: 'objective',
    highRisk: false,
    isVital: true,
    range: { min: 20, max: 220, unit: 'bpm' },
  },
  {
    fieldId: 'objective.vitals.bp',
    label: 'Blood pressure',
    labelHe: 'לחץ דם',
    group: 'objective',
    highRisk: false,
    isVital: true,
    // BP is "systolic/diastolic"; range applies to the systolic component.
    range: { min: 50, max: 260, unit: 'mmHg' },
  },
  {
    fieldId: 'objective.vitals.rr',
    label: 'Respiratory rate',
    labelHe: 'קצב נשימה',
    group: 'objective',
    highRisk: false,
    isVital: true,
    range: { min: 4, max: 60, unit: '/min' },
  },
  {
    fieldId: 'objective.vitals.spo2',
    label: 'SpO₂',
    labelHe: 'סטורציה',
    group: 'objective',
    highRisk: false,
    isVital: true,
    range: { min: 50, max: 100, unit: '%' },
  },
  {
    fieldId: 'objective.generalAppearance',
    label: 'General appearance',
    labelHe: 'מצב כללי',
    group: 'objective',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'objective.abdomen',
    label: 'Abdomen check',
    labelHe: 'בדיקת בטן',
    group: 'objective',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'objective.ports',
    label: 'Ports',
    labelHe: 'פורטים',
    group: 'objective',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'objective.linesAndDrains',
    label: 'Central line & drains',
    labelHe: 'צנתר מרכזי ונקזים',
    group: 'objective',
    highRisk: false,
    isVital: false,
  },

  // ── Plan ───────────────────────────────────────────────────────────────────
  {
    fieldId: 'plan.plan',
    label: 'Plan',
    labelHe: 'תוכנית',
    group: 'plan',
    highRisk: false,
    isVital: false,
  },

  // ── Attending decisions / orders ─────────────────────────────────────────────
  // High-risk group (spec §6): imaging, medications, procedures/surgery.
  {
    fieldId: 'decisions.imaging',
    label: 'Imaging',
    labelHe: 'הדמיה',
    group: 'decisions',
    highRisk: true,
    isVital: false,
  },
  {
    fieldId: 'decisions.bloodTests',
    label: 'Blood tests',
    labelHe: 'בדיקות דם',
    group: 'decisions',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'decisions.medications',
    label: 'Medications',
    labelHe: 'תרופות',
    group: 'decisions',
    highRisk: true,
    isVital: false,
  },
  {
    fieldId: 'decisions.procedures',
    label: 'Procedures / surgery',
    labelHe: 'פרוצדורות / ניתוח',
    group: 'decisions',
    highRisk: true,
    isVital: false,
  },

  // ── Administrative ───────────────────────────────────────────────────────────
  {
    fieldId: 'administrative.discharge',
    label: 'Discharge',
    labelHe: 'שחרור',
    group: 'administrative',
    highRisk: false,
    isVital: false,
  },
  {
    fieldId: 'administrative.requestMoreInfo',
    label: 'Request for more information',
    labelHe: 'בקשה למידע נוסף',
    group: 'administrative',
    highRisk: false,
    isVital: false,
  },
];

/** Fast lookup map: fieldId -> definition. */
export const FIELD_DEFS_BY_ID = Object.freeze(
  Object.fromEntries(FIELD_DEFS.map((d) => [d.fieldId, d])),
);

/** Ordered list of all valid fieldIds. */
export const FIELD_IDS = FIELD_DEFS.map((d) => d.fieldId);

/** Returns the definition for a fieldId, or undefined if unknown. */
export function getFieldDef(fieldId) {
  return FIELD_DEFS_BY_ID[fieldId];
}

/** True if the fieldId is a known field in the catalog. */
export function isKnownField(fieldId) {
  return Object.prototype.hasOwnProperty.call(FIELD_DEFS_BY_ID, fieldId);
}

/** True if the field is flagged high-risk (medications, imaging, procedures). */
export function isHighRiskField(fieldId) {
  return Boolean(FIELD_DEFS_BY_ID[fieldId]?.highRisk);
}

/** True if the field is one of the five vitals. */
export function isVitalField(fieldId) {
  return Boolean(FIELD_DEFS_BY_ID[fieldId]?.isVital);
}

/** Returns the {min,max,unit} range for a vital, or undefined otherwise. */
export function getVitalRange(fieldId) {
  return FIELD_DEFS_BY_ID[fieldId]?.range;
}

/**
 * Build a fully-shaped FieldRecord (spec §4) for `fieldId`, merging in any
 * `partial` overrides. Nested `judge` / `guardrail` objects are deep-merged so
 * callers can pass e.g. { judge: { verdict: 'grounded' } } without clobbering
 * the other defaults.
 *
 * @param {string} fieldId
 * @param {object} [partial]
 * @returns {object} FieldRecord
 */
export function makeFieldRecord(fieldId, partial = {}) {
  const { judge: judgeOverride, guardrail: guardrailOverride, ...rest } = partial;

  return {
    fieldId,
    value: '',
    sourceSpan: '',
    confidence: 0,
    judge: {
      verdict: 'ungrounded',
      reason: '',
      highRisk: isHighRiskField(fieldId),
      ...(judgeOverride || {}),
    },
    guardrail: {
      passed: true,
      requiresConfirmation: false,
      messages: [],
      ...(guardrailOverride || {}),
    },
    status: 'pending',
    committedValue: null,
    ...rest,
  };
}
