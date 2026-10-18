import { z } from "zod";
import { portionUnits, type ObservedFood, type PortionUnit } from "@/lib/domain/food-analysis";

/**
 * Physical serving evidence contract (PR #128, Phase 1).
 *
 * Pipeline:
 *   ObservedFoodRow -> EvidenceClaim -> PhysicalServingCandidate
 *     -> SupportedServingSlot -> ConfirmedServing / UnresolvedServing
 *
 * A model row is an observation, never a serving. Existence, physical
 * identity, family, personal quantity and nutrition eligibility are separate
 * axes. Nothing here is wired into runtime meal, persistence or API paths;
 * this module is the domain foundation only.
 */

export const SERVING_CONTRACT_VERSION = 1 as const;
export const SERVING_ENGINE_VERSION = "milk-serving-engine-1";
export const SERVING_GRAMMAR_VERSION = "milk-serving-grammar-1";
/** Same bound as foodAnalysisSchema.foods. */
export const MAX_OBSERVED_ROWS = 12;
/** Cardinality grammar is bounded to explicit integers 1..9. */
export const MAX_CARDINALITY = 9;

export type Id = string;
export type Digest = string;

export const polarities = ["affirmative", "negative", "questioned", "uncertain", "contradictory"] as const;
export type Polarity = (typeof polarities)[number];

export const milkFamilies = [
  "generic_milk", "dairy", "soy", "oat", "almond", "coconut", "blend", "unknown",
] as const;
export type MilkFamily = (typeof milkFamilies)[number];

export const dairyQualifiers = ["whole", "low_fat", "skim"] as const;
export type DairyQualifier = (typeof dairyQualifiers)[number];

export const vesselKinds = ["glass", "cup", "carton", "bottle", "container", "unknown"] as const;
export type VesselKind = (typeof vesselKinds)[number];

/** Existing photo milk profiles (UserMilkTypeChoice without "other"). */
export const servingProfileIds = ["whole", "low-fat", "oat", "soy"] as const;
export type ServingProfileId = (typeof servingProfileIds)[number];
export const userTypeChoices = [...servingProfileIds, "other"] as const;
export type UserTypeChoice = (typeof userTypeChoices)[number];

export const claimFields = [
  "displayName", "normalizedName", "preparationMethod", "notes", "visibleIngredients",
  "visibleEvidence", "estimatedInformation", "unknownInformation", "uncertaintyReasons",
  "portion", "userDecision",
] as const;
export type ClaimField = (typeof claimFields)[number];

export const claimUses = [
  "existence", "family", "same_identity", "separate_identity", "count", "portion",
] as const;
export type ClaimUse = (typeof claimUses)[number];

export const quantityPurposes = [
  "row_personal_estimate", "user_amount", "aggregate_consumed", "package_capacity",
  "transferred_amount", "stock_amount", "unknown",
] as const;
export type QuantityPurpose = (typeof quantityPurposes)[number];

/** Visual marks that can identify a cup. A milk-family name is not a mark. */
export const distinctiveMarks = ["blue-dot", "star-sticker", "round-handle"] as const;
export type DistinctiveMark = (typeof distinctiveMarks)[number];

export type Referent =
  | { kind: "entity"; entityId: Id }
  | { kind: "population"; scopeId: Id; family: MilkFamily; vessel: VesselKind }
  | { kind: "unbound"; possibleEntityIds: readonly Id[] };

export interface ClaimSource {
  sceneId: Id;
  /** Absent for meal-level fields. */
  rowId?: Id;
  field: ClaimField;
  /** Content key of an array entry; never its array index. */
  entryKey?: Digest;
  /** UTF-16 offsets against the preserved raw field text. */
  span: readonly [number, number];
  origin: "model_reported" | "user_declared";
  grammarRule: string;
  grammarVersion: string;
}

export interface QuantityProposal {
  proposalId: Id;
  target: Referent;
  min: number | null;
  max: number | null;
  unit: PortionUnit;
  purpose: QuantityPurpose;
  claimIds: readonly Id[];
}

export type PresenceContent = "milk" | "white_drink" | "non_drink" | "empty" | "unknown";
export type SpatialRelation = "front" | "back" | "left" | "right" | "view" | "part";

export type ClaimBody =
  | { predicate: "presence"; subject: Referent; content: PresenceContent }
  | { predicate: "family"; subject: Referent; family: MilkFamily; qualifier: DairyQualifier | null }
  | { predicate: "vessel"; subject: Referent; vessel: VesselKind }
  | { predicate: "contains"; vessel: Referent; contentEntity: Referent }
  | { predicate: "same_vessel" | "different_vessel"; left: Referent; right: Referent }
  | {
    predicate: "spatial";
    subject: Referent;
    relativeTo: Referent | "scene";
    relation: SpatialRelation;
  }
  | {
    predicate: "cardinality";
    population: Referent;
    relation: "exact" | "at_least" | "at_most";
    count: number;
  }
  | { predicate: "quantity"; proposal: QuantityProposal }
  | { predicate: "stock_transfer"; from: Referent; into: Referent }
  | { predicate: "anchor"; subject: Referent; mark: DistinctiveMark };

export type ClaimPredicate = ClaimBody["predicate"];

export interface EvidenceClaim {
  claimId: Id;
  source: ClaimSource;
  body: ClaimBody;
  polarity: Polarity;
  scopeId: Id;
  usableFor: readonly ClaimUse[];
  refusalReasons: readonly string[];
  contradictsClaimIds: readonly Id[];
}

export type Assessment<T> =
  | { state: "resolved"; value: T; proofIds: readonly Id[] }
  | { state: "unknown"; claimIds: readonly Id[] }
  | { state: "conflict"; alternatives: readonly T[]; claimIds: readonly Id[] };

export interface FamilyValue {
  family: MilkFamily;
  qualifier: DairyQualifier | null;
}

export interface ObservedFoodRow {
  rowId: Id;
  sceneId: Id;
  /** Audit/display only. Never read by the decision engine. */
  originalIndex: number;
  /** Content fingerprint; excludes index, confidences and app annotations. */
  semanticKey: Digest;
  /** Existing model schema; not a confirmed serving. */
  raw: ObservedFood;
  subject: {
    milkCandidate: boolean;
    exclusionReason: string | null;
  };
}

export interface PhysicalServingCandidate {
  candidateId: Id;
  referent: Referent;
  rowIds: readonly Id[];
  existence: Assessment<"present">;
  family: Assessment<FamilyValue>;
  vessel: Assessment<VesselKind>;
  quantityProposals: readonly QuantityProposal[];
  /** Informational; never a union-find edge. */
  possibleSameAs: readonly Id[];
}

export interface ResolvedPortion {
  min: number;
  max: number;
  unit: PortionUnit;
  origin: "single_anchored_estimate" | "agreed_model_estimate" | "user_amount";
  purpose: "personal" | "aggregate_consumed";
  proofIds: readonly Id[];
}

export type SlotBasis =
  | "direct_witness"
  | "interchangeable_witnesses"
  | "cardinality"
  | "presence_floor"
  | "user_declared";

export interface SupportedServingSlot {
  slotId: Id;
  scopeId: Id;
  basis: SlotBasis;
  proofIds: readonly Id[];
  sourceCandidateIds: readonly Id[];
  /** Units described by this slot; not a nutrition multiplier by itself. */
  multiplicity: number;
  family: Assessment<FamilyValue>;
  portion: Assessment<ResolvedPortion>;
  profile: Assessment<ServingProfileId>;
  status: "confirmed" | "pending" | "dismissed";
  pendingReasons: readonly string[];
}

export interface ConfirmedServing {
  unitId: Id;
  slotIds: readonly Id[];
  profileId: ServingProfileId;
  milkTypeChoice?: UserTypeChoice;
  portion: ResolvedPortion;
  multiplicity: number;
  confirmation: "evidence_admitted" | "user_declared";
  proofIds: readonly Id[];
}

export const unresolvedKinds = [
  "exclusive_candidates", "possible_excess", "family_conflict", "portion_required",
  "unbound_object", "relation_conflict", "unsupported_evidence", "legacy_review_required",
] as const;
export type UnresolvedKind = (typeof unresolvedKinds)[number];

export interface UnresolvedServing {
  groupId: Id;
  kind: UnresolvedKind;
  candidateIds: readonly Id[];
  slotIds: readonly Id[];
  possibleTargetSlotIds: readonly Id[];
  amountAlternatives: readonly QuantityProposal[];
  excludedProposalIds: readonly Id[];
  /** Minimum accounting support, not photo truth. */
  supportedCount: number;
  possibleExtraSlots: number;
  selectedCandidateId: null;
  reasonCodes: readonly string[];
}

export const rowDispositionKinds = [
  "used_as_evidence", "alternative", "possible_excess", "unrelated", "superseded", "conflict",
] as const;
export type RowDispositionKind = (typeof rowDispositionKinds)[number];

export interface RowDisposition {
  rowId: Id;
  disposition: RowDispositionKind;
  slotIds: readonly Id[];
  groupIds: readonly Id[];
  reasonCodes: readonly string[];
}

export interface PortionInput {
  min: number;
  max: number;
  unit: PortionUnit;
}

export type DecisionCommand =
  | { kind: "set_type"; targetId: Id; choice: UserTypeChoice }
  | { kind: "one_serving"; groupId: Id; portion: PortionInput }
  | { kind: "separate_servings"; groupId: Id; unitIds: readonly Id[] }
  | { kind: "set_portion"; unitId: Id; portion: PortionInput }
  | { kind: "dismiss_group"; groupId: Id }
  | { kind: "exclude_option"; groupId: Id; proposalId: Id }
  | { kind: "undo"; decisionId: Id };

export interface UserServingDecision {
  decisionId: Id;
  sourceDigest: Digest;
  expectedDecisionRevision: number;
  command: DecisionCommand;
}

export interface RejectedDecision {
  decisionId: Id;
  reason: string;
}

export interface ServingSummary {
  supportedServingCount: number;
  confirmedServingCount: number;
  pendingSlotCount: number;
  unresolvedGroupCount: number;
  cardinalityReviewRequired: boolean;
  reasonCodes: readonly string[];
}

export interface ServingReconciliation {
  contractVersion: typeof SERVING_CONTRACT_VERSION;
  engineVersion: string;
  grammarVersion: string;
  sceneId: Id;
  sourceDigest: Digest;
  decisionRevision: number;
  rows: readonly ObservedFoodRow[];
  claims: readonly EvidenceClaim[];
  candidates: readonly PhysicalServingCandidate[];
  supportedSlots: readonly SupportedServingSlot[];
  confirmed: readonly ConfirmedServing[];
  unresolved: readonly UnresolvedServing[];
  dispositions: readonly RowDisposition[];
  acceptedDecisions: readonly UserServingDecision[];
  rejectedDecisions: readonly RejectedDecision[];
  summary: ServingSummary;
}

/** Thrown for structurally invalid input. Evidence problems never throw; they fail closed. */
export class ServingContractError extends Error {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message);
    this.name = "ServingContractError";
  }
}

// ---------------------------------------------------------------------------
// Stable identity helpers (pure, deterministic, browser-safe).
// ---------------------------------------------------------------------------

const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64(text: string, offset: bigint): string {
  let hash = offset;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 128-bit content digest from two independent FNV-1a lanes. Identity, not a signature. */
export function stableDigest(text: string): Digest {
  return `${fnv1a64(text, 0xcbf29ce484222325n)}${fnv1a64(text, 0x84222325cbf29ce4n)}`;
}

/** JSON with recursively sorted object keys; undefined members omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Entity for a row's own reported subject. Row identity and entity identity stay distinct. */
export function rowEntityId(rowId: Id): Id {
  return `ent:${rowId}`;
}

export function compareCanonical(left: unknown, right: unknown): number {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Zod schemas. Strict objects: no client-authored admission flags can ride along.
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(200);
const portionUnitSchema = z.enum(portionUnits);
const positiveAmount = z.number().positive().max(5000);

const referentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entity"), entityId: idSchema }),
  z.strictObject({
    kind: z.literal("population"),
    scopeId: idSchema,
    family: z.enum(milkFamilies),
    vessel: z.enum(vesselKinds),
  }),
  z.strictObject({ kind: z.literal("unbound"), possibleEntityIds: z.array(idSchema).max(24) }),
]);

const claimSourceSchema = z.strictObject({
  sceneId: idSchema,
  rowId: idSchema.optional(),
  field: z.enum(claimFields),
  entryKey: idSchema.optional(),
  span: z.tuple([z.number().int().min(0), z.number().int().min(0)])
    .refine(([start, end]) => end >= start, "span end must not precede start"),
  origin: z.enum(["model_reported", "user_declared"]),
  grammarRule: z.string().min(1).max(80),
  grammarVersion: z.string().min(1).max(80),
});

const quantityProposalSchema = z.strictObject({
  proposalId: idSchema,
  target: referentSchema,
  min: positiveAmount.nullable(),
  max: positiveAmount.nullable(),
  unit: portionUnitSchema,
  purpose: z.enum(quantityPurposes),
  claimIds: z.array(idSchema).max(48),
}).superRefine((proposal, context) => {
  if ((proposal.min === null) !== (proposal.max === null)) {
    context.addIssue({ code: "custom", message: "min and max must both be null or both numbers" });
  }
  if (proposal.min !== null && proposal.max !== null && proposal.max < proposal.min) {
    context.addIssue({ code: "custom", message: "max must be >= min" });
  }
});

const claimBodySchema = z.discriminatedUnion("predicate", [
  z.strictObject({
    predicate: z.literal("presence"),
    subject: referentSchema,
    content: z.enum(["milk", "white_drink", "non_drink", "empty", "unknown"]),
  }),
  z.strictObject({
    predicate: z.literal("family"),
    subject: referentSchema,
    family: z.enum(milkFamilies),
    qualifier: z.enum(dairyQualifiers).nullable(),
  }),
  z.strictObject({ predicate: z.literal("vessel"), subject: referentSchema, vessel: z.enum(vesselKinds) }),
  z.strictObject({ predicate: z.literal("contains"), vessel: referentSchema, contentEntity: referentSchema }),
  z.strictObject({ predicate: z.literal("same_vessel"), left: referentSchema, right: referentSchema }),
  z.strictObject({ predicate: z.literal("different_vessel"), left: referentSchema, right: referentSchema }),
  z.strictObject({
    predicate: z.literal("spatial"),
    subject: referentSchema,
    relativeTo: z.union([referentSchema, z.literal("scene")]),
    relation: z.enum(["front", "back", "left", "right", "view", "part"]),
  }),
  z.strictObject({
    predicate: z.literal("cardinality"),
    population: referentSchema,
    relation: z.enum(["exact", "at_least", "at_most"]),
    count: z.number().int().min(1).max(MAX_CARDINALITY),
  }),
  z.strictObject({ predicate: z.literal("quantity"), proposal: quantityProposalSchema }),
  z.strictObject({ predicate: z.literal("stock_transfer"), from: referentSchema, into: referentSchema }),
  z.strictObject({
    predicate: z.literal("anchor"),
    subject: referentSchema,
    mark: z.enum(distinctiveMarks),
  }),
]);

export const evidenceClaimSchema = z.strictObject({
  claimId: idSchema,
  source: claimSourceSchema,
  body: claimBodySchema,
  polarity: z.enum(polarities),
  scopeId: idSchema,
  usableFor: z.array(z.enum(claimUses)).max(claimUses.length),
  refusalReasons: z.array(z.string().min(1).max(80)).max(16),
  contradictsClaimIds: z.array(idSchema).max(48),
}).superRefine((claim, context) => {
  if (claim.polarity !== "affirmative" && claim.usableFor.some(use => use === "count" || use === "existence")) {
    context.addIssue({
      code: "custom",
      message: "non-affirmative claims cannot be usable for count or existence",
    });
  }
  if (claim.usableFor.length === 0 && claim.refusalReasons.length === 0) {
    context.addIssue({ code: "custom", message: "an unusable claim must carry a refusal reason" });
  }
});

function assessmentSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("resolved"), value, proofIds: z.array(idSchema) }),
    z.strictObject({ state: z.literal("unknown"), claimIds: z.array(idSchema) }),
    z.strictObject({ state: z.literal("conflict"), alternatives: z.array(value).min(2), claimIds: z.array(idSchema) }),
  ]);
}

const familyValueSchema = z.strictObject({
  family: z.enum(milkFamilies),
  qualifier: z.enum(dairyQualifiers).nullable(),
});

const resolvedPortionSchema = z.strictObject({
  min: positiveAmount,
  max: positiveAmount,
  unit: portionUnitSchema,
  origin: z.enum(["single_anchored_estimate", "agreed_model_estimate", "user_amount"]),
  purpose: z.enum(["personal", "aggregate_consumed"]),
  proofIds: z.array(idSchema),
}).refine(portion => portion.max >= portion.min, "portion max must be >= min");

const observedFoodRowSchema = z.strictObject({
  rowId: idSchema,
  sceneId: idSchema,
  originalIndex: z.number().int().min(0).max(MAX_OBSERVED_ROWS - 1),
  semanticKey: idSchema,
  raw: z.record(z.string(), z.unknown()),
  subject: z.strictObject({
    milkCandidate: z.boolean(),
    exclusionReason: z.string().min(1).max(80).nullable(),
  }),
});

const candidateSchema = z.strictObject({
  candidateId: idSchema,
  referent: referentSchema,
  rowIds: z.array(idSchema).max(MAX_OBSERVED_ROWS),
  existence: assessmentSchema(z.literal("present")),
  family: assessmentSchema(familyValueSchema),
  vessel: assessmentSchema(z.enum(vesselKinds)),
  quantityProposals: z.array(quantityProposalSchema),
  possibleSameAs: z.array(idSchema),
});

const slotSchema = z.strictObject({
  slotId: idSchema,
  scopeId: idSchema,
  basis: z.enum(["direct_witness", "interchangeable_witnesses", "cardinality", "presence_floor", "user_declared"]),
  proofIds: z.array(idSchema),
  sourceCandidateIds: z.array(idSchema),
  multiplicity: z.number().int().min(1).max(MAX_CARDINALITY),
  family: assessmentSchema(familyValueSchema),
  portion: assessmentSchema(resolvedPortionSchema),
  profile: assessmentSchema(z.enum(servingProfileIds)),
  status: z.enum(["confirmed", "pending", "dismissed"]),
  pendingReasons: z.array(z.string().min(1).max(80)),
}).superRefine((slot, context) => {
  const ready = slot.portion.state === "resolved" && slot.profile.state === "resolved";
  if (slot.status === "confirmed" && (!ready || slot.pendingReasons.length > 0)) {
    context.addIssue({ code: "custom", message: "confirmed slot needs resolved portion and profile, no pending reasons" });
  }
  if (slot.status === "pending" && slot.pendingReasons.length === 0) {
    context.addIssue({ code: "custom", message: "pending slot must state why" });
  }
});

const confirmedSchema = z.strictObject({
  unitId: idSchema,
  slotIds: z.array(idSchema).min(1),
  profileId: z.enum(servingProfileIds),
  milkTypeChoice: z.enum(userTypeChoices).optional(),
  portion: resolvedPortionSchema,
  multiplicity: z.number().int().min(1).max(MAX_CARDINALITY),
  confirmation: z.enum(["evidence_admitted", "user_declared"]),
  proofIds: z.array(idSchema),
});

const unresolvedSchema = z.strictObject({
  groupId: idSchema,
  kind: z.enum(unresolvedKinds),
  candidateIds: z.array(idSchema),
  slotIds: z.array(idSchema),
  possibleTargetSlotIds: z.array(idSchema),
  amountAlternatives: z.array(quantityProposalSchema),
  excludedProposalIds: z.array(idSchema),
  supportedCount: z.number().int().min(0).max(MAX_CARDINALITY * MAX_OBSERVED_ROWS),
  possibleExtraSlots: z.number().int().min(0).max(MAX_CARDINALITY * MAX_OBSERVED_ROWS),
  selectedCandidateId: z.null(),
  reasonCodes: z.array(z.string().min(1).max(80)).min(1),
});

const dispositionSchema = z.strictObject({
  rowId: idSchema,
  disposition: z.enum(rowDispositionKinds),
  slotIds: z.array(idSchema),
  groupIds: z.array(idSchema),
  reasonCodes: z.array(z.string().min(1).max(80)),
});

const portionInputSchema = z.strictObject({
  min: positiveAmount,
  max: positiveAmount,
  unit: portionUnitSchema,
}).refine(portion => portion.max >= portion.min, "portion max must be >= min");

export const decisionCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set_type"), targetId: idSchema, choice: z.enum(userTypeChoices) }),
  z.strictObject({ kind: z.literal("one_serving"), groupId: idSchema, portion: portionInputSchema }),
  z.strictObject({ kind: z.literal("separate_servings"), groupId: idSchema, unitIds: z.array(idSchema).max(MAX_OBSERVED_ROWS) }),
  z.strictObject({ kind: z.literal("set_portion"), unitId: idSchema, portion: portionInputSchema }),
  z.strictObject({ kind: z.literal("dismiss_group"), groupId: idSchema }),
  z.strictObject({ kind: z.literal("exclude_option"), groupId: idSchema, proposalId: idSchema }),
  z.strictObject({ kind: z.literal("undo"), decisionId: idSchema }),
]);

export const userServingDecisionSchema = z.strictObject({
  decisionId: idSchema,
  sourceDigest: idSchema,
  expectedDecisionRevision: z.number().int().min(0).max(1000),
  command: decisionCommandSchema,
});

/** Bounded effective-decision list accepted by the pure engine. */
export const servingDecisionListSchema = z.array(userServingDecisionSchema).max(64);

const summarySchema = z.strictObject({
  supportedServingCount: z.number().int().min(0),
  confirmedServingCount: z.number().int().min(0),
  pendingSlotCount: z.number().int().min(0),
  unresolvedGroupCount: z.number().int().min(0),
  cardinalityReviewRequired: z.boolean(),
  reasonCodes: z.array(z.string().min(1).max(80)),
});

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

export const servingReconciliationSchema = z.strictObject({
  contractVersion: z.literal(SERVING_CONTRACT_VERSION),
  engineVersion: z.literal(SERVING_ENGINE_VERSION),
  grammarVersion: z.literal(SERVING_GRAMMAR_VERSION),
  sceneId: idSchema,
  sourceDigest: idSchema,
  decisionRevision: z.number().int().min(0),
  rows: z.array(observedFoodRowSchema).max(MAX_OBSERVED_ROWS),
  claims: z.array(evidenceClaimSchema),
  candidates: z.array(candidateSchema),
  supportedSlots: z.array(slotSchema),
  confirmed: z.array(confirmedSchema),
  unresolved: z.array(unresolvedSchema),
  dispositions: z.array(dispositionSchema),
  acceptedDecisions: z.array(userServingDecisionSchema),
  rejectedDecisions: z.array(z.strictObject({ decisionId: idSchema, reason: z.string().min(1).max(80) })),
  summary: summarySchema,
}).superRefine((result, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });

  const rowIds = result.rows.map(row => row.rowId);
  const slotIds = result.supportedSlots.map(slot => slot.slotId);
  const groupIds = result.unresolved.map(group => group.groupId);
  const candidateIds = result.candidates.map(candidate => candidate.candidateId);
  for (const [label, ids] of [
    ["row", rowIds], ["claim", result.claims.map(claim => claim.claimId)], ["candidate", candidateIds],
    ["slot", slotIds], ["group", groupIds], ["unit", result.confirmed.map(unit => unit.unitId)],
  ] as const) {
    for (const repeated of duplicates(ids)) issue(`duplicate ${label} id ${repeated}`);
  }
  for (const row of result.rows) {
    if (row.sceneId !== result.sceneId) issue(`row ${row.rowId} belongs to another scene`);
  }

  const slotSet = new Set(slotIds);
  const groupSet = new Set(groupIds);
  const candidateSet = new Set(candidateIds);
  const rowSet = new Set(rowIds);

  // Every row has exactly one explicit disposition; there is no default confirmed.
  const dispositionRows = result.dispositions.map(item => item.rowId);
  for (const repeated of duplicates(dispositionRows)) issue(`row ${repeated} has more than one disposition`);
  for (const rowId of rowIds) {
    if (!dispositionRows.includes(rowId)) issue(`row ${rowId} has no disposition`);
  }
  for (const disposition of result.dispositions) {
    if (!rowSet.has(disposition.rowId)) issue(`disposition for unknown row ${disposition.rowId}`);
    for (const slotId of disposition.slotIds) if (!slotSet.has(slotId)) issue(`disposition references unknown slot ${slotId}`);
    for (const groupId of disposition.groupIds) if (!groupSet.has(groupId)) issue(`disposition references unknown group ${groupId}`);
  }

  const claimIds = new Set(result.claims.map(claim => claim.claimId));
  const requireClaims = (ids: readonly string[] | undefined, label: string) => {
    for (const id of ids ?? []) if (!claimIds.has(id)) issue(`${label} references unknown claim ${id}`);
  };
  const entityIds = new Set(rowIds.map(rowEntityId));
  const concreteEntityIds = (referent: { kind: string; entityId?: string; possibleEntityIds?: readonly string[] }) => {
    if (referent.kind === "entity" && referent.entityId) return [referent.entityId];
    if (referent.kind === "unbound") return [...(referent.possibleEntityIds ?? [])];
    return [];
  };
  const checkReferent = (referent: { kind: string; entityId?: string; possibleEntityIds?: readonly string[] } | "scene", label: string) => {
    if (referent === "scene" || referent.kind === "population") return;
    for (const id of concreteEntityIds(referent)) {
      if (!entityIds.has(id)) issue(`${label} references unknown entity ${id}`);
    }
  };
  for (const claim of result.claims) {
    if (claim.source.sceneId !== result.sceneId) issue(`claim ${claim.claimId} belongs to another scene`);
    if (claim.source.rowId !== undefined && !rowSet.has(claim.source.rowId)) {
      issue(`claim ${claim.claimId} cites unknown row`);
    }
    for (const id of claim.contradictsClaimIds) {
      if (!claimIds.has(id)) issue(`claim ${claim.claimId} contradicts unknown claim ${id}`);
    }
    const body = claim.body;
    if (body.predicate === "presence" || body.predicate === "family" || body.predicate === "vessel" || body.predicate === "anchor") {
      checkReferent(body.subject, claim.claimId);
    }
    else if (body.predicate === "spatial") {
      checkReferent(body.subject, claim.claimId);
      if (body.relativeTo !== "scene") checkReferent(body.relativeTo, claim.claimId);
    } else if (body.predicate === "contains") {
      checkReferent(body.vessel, claim.claimId);
      checkReferent(body.contentEntity, claim.claimId);
    } else if (body.predicate === "same_vessel" || body.predicate === "different_vessel") {
      checkReferent(body.left, claim.claimId);
      checkReferent(body.right, claim.claimId);
    } else if (body.predicate === "cardinality") checkReferent(body.population, claim.claimId);
    else if (body.predicate === "quantity") {
      checkReferent(body.proposal.target, claim.claimId);
      for (const id of body.proposal.claimIds) if (!claimIds.has(id)) issue(`quantity cites unknown claim ${id}`);
    } else if (body.predicate === "stock_transfer") {
      checkReferent(body.from, claim.claimId);
      checkReferent(body.into, claim.claimId);
    }
  }

  for (const candidate of result.candidates) {
    for (const rowId of candidate.rowIds) if (!rowSet.has(rowId)) issue(`candidate cites unknown row ${rowId}`);
    checkReferent(candidate.referent, candidate.candidateId);
    for (const same of candidate.possibleSameAs) {
      if (!candidateSet.has(same)) issue(`candidate ${candidate.candidateId} possibleSameAs references unknown candidate ${same}`);
    }
    for (const assessment of [candidate.existence, candidate.family, candidate.vessel]) {
      if (assessment.state === "resolved") requireClaims(assessment.proofIds, candidate.candidateId);
      else requireClaims(assessment.claimIds, candidate.candidateId);
    }
    for (const proposal of candidate.quantityProposals) {
      checkReferent(proposal.target, candidate.candidateId);
      for (const id of proposal.claimIds) if (!claimIds.has(id)) issue(`candidate quantity cites unknown claim ${id}`);
    }
  }

  const confirmedSlots = new Set<string>();
  for (const unit of result.confirmed) {
    for (const slotId of unit.slotIds) {
      const slot = result.supportedSlots.find(item => item.slotId === slotId);
      if (!slot) issue(`confirmed unit references unknown slot ${slotId}`);
      else if (slot.status !== "confirmed") issue(`confirmed unit references ${slot.status} slot ${slotId}`);
      else {
        if (slot.family.state === "conflict") issue(`confirmed slot ${slotId} still has a family conflict`);
        if (slot.profile.state !== "resolved" || slot.profile.value !== unit.profileId) {
          issue(`confirmed profile does not match slot ${slotId}`);
        }
        if (slot.multiplicity !== unit.multiplicity) issue(`confirmed unit multiplicity does not match slot ${slotId}`);
        if (slot.portion.state !== "resolved") issue(`confirmed unit references unresolved portion on ${slotId}`);
        else if (slot.portion.value.min !== unit.portion.min || slot.portion.value.max !== unit.portion.max
          || slot.portion.value.unit !== unit.portion.unit || slot.portion.value.purpose !== unit.portion.purpose) {
          issue(`confirmed unit portion does not match slot ${slotId}`);
        }
      }
      if (unit.milkTypeChoice === "other") issue(`confirmed unit ${unit.unitId} cannot record milk type other`);
      if (unit.milkTypeChoice && unit.milkTypeChoice !== "other" && unit.milkTypeChoice !== unit.profileId) {
        issue(`confirmed unit ${unit.unitId} milk type does not match its profile`);
      }
      requireClaims(unit.proofIds, unit.unitId);
      requireClaims(unit.portion.proofIds, unit.unitId);
      confirmedSlots.add(slotId);
    }
  }
  for (const slot of result.supportedSlots) {
    if (slot.status === "confirmed" && !confirmedSlots.has(slot.slotId)) {
      issue(`confirmed slot ${slot.slotId} has no confirmed unit`);
    }
    if (slot.status === "confirmed" && slot.family.state === "conflict") {
      issue(`confirmed slot ${slot.slotId} still has a family conflict`);
    }
    requireClaims(slot.proofIds, slot.slotId);
    if (slot.family.state === "resolved") requireClaims(slot.family.proofIds, slot.slotId);
    else requireClaims(slot.family.claimIds, slot.slotId);
    if (slot.portion.state === "resolved") {
      requireClaims(slot.portion.proofIds, slot.slotId);
      requireClaims(slot.portion.value.proofIds, slot.slotId);
    } else if (slot.portion.state === "conflict") {
      requireClaims(slot.portion.claimIds, slot.slotId);
      for (const alternative of slot.portion.alternatives) requireClaims(alternative.proofIds, slot.slotId);
    } else requireClaims(slot.portion.claimIds, slot.slotId);
    if (slot.profile.state === "resolved") requireClaims(slot.profile.proofIds, slot.slotId);
    else requireClaims(slot.profile.claimIds, slot.slotId);
    for (const id of slot.sourceCandidateIds) if (!candidateSet.has(id)) issue(`slot cites unknown candidate ${id}`);
  }

  for (const group of result.unresolved) {
    for (const slotId of [...group.slotIds, ...group.possibleTargetSlotIds]) {
      if (!slotSet.has(slotId)) issue(`group ${group.groupId} references unknown slot ${slotId}`);
    }
    for (const id of group.candidateIds) if (!candidateSet.has(id)) issue(`group cites unknown candidate ${id}`);
    const proposalIds = new Set(group.amountAlternatives.map(item => item.proposalId));
    for (const id of group.excludedProposalIds) {
      if (!proposalIds.has(id)) issue(`group ${group.groupId} excludes unknown proposal ${id}`);
    }
    for (const alternative of group.amountAlternatives) requireClaims(alternative.claimIds, group.groupId);
    for (const slotId of group.slotIds) {
      const slot = result.supportedSlots.find(item => item.slotId === slotId);
      if (slot?.status === "confirmed") issue(`unresolved group ${group.groupId} contains confirmed slot ${slotId}`);
    }
  }

  const live = result.supportedSlots.filter(slot => slot.status !== "dismissed");
  if (result.summary.confirmedServingCount !== result.confirmed.length) issue("summary confirmed count mismatch");
  if (result.summary.unresolvedGroupCount !== result.unresolved.length) issue("summary unresolved count mismatch");
  if (result.summary.supportedServingCount !== live.reduce((sum, slot) => sum + slot.multiplicity, 0)) {
    issue("summary supported count mismatch");
  }
  if (result.summary.pendingSlotCount !== live.filter(slot => slot.status === "pending").length) {
    issue("summary pending count mismatch");
  }
  if (result.decisionRevision !== result.acceptedDecisions.length) issue("decision revision mismatch");
  result.acceptedDecisions.forEach((decision, index) => {
    if (decision.expectedDecisionRevision !== index) issue(`decision ${decision.decisionId} has a stale revision`);
    if (decision.sourceDigest !== result.sourceDigest) issue(`decision ${decision.decisionId} has a stale source digest`);
    const command = decision.command;
    if (command.kind === "set_type" && !slotSet.has(command.targetId)) issue(`decision ${decision.decisionId} targets an unknown slot`);
    if (command.kind === "set_portion" && !slotSet.has(command.unitId)) issue(`decision ${decision.decisionId} targets an unknown slot`);
    // one_serving, dismiss and separate consume their group, so it leaves `unresolved`.
    // exclude_option keeps the group open and must still name it.
    if (command.kind === "exclude_option" && !groupSet.has(command.groupId)) {
      issue(`decision ${decision.decisionId} targets an unknown group`);
    }
    if (command.kind === "separate_servings") {
      for (const unitId of command.unitIds) if (!candidateSet.has(unitId)) issue(`decision ${decision.decisionId} targets an unknown candidate`);
    }
    if (command.kind === "undo") issue(`decision ${decision.decisionId} cannot store an undo as an accepted resolution`);
  });
});

export function validateServingReconciliation(value: unknown): ServingReconciliation {
  return servingReconciliationSchema.parse(value) as unknown as ServingReconciliation;
}

// ---------------------------------------------------------------------------
// Index-free projections for comparison, audit and later integration gates.
// ---------------------------------------------------------------------------

/**
 * Canonical semantic output. Drops audit-only array indices so row
 * permutations of one scene compare equal.
 */
export function semanticDecisionView(result: ServingReconciliation): unknown {
  return JSON.parse(canonicalJson({
    ...result,
    rows: result.rows.map(row => ({ ...row, originalIndex: undefined })),
  }));
}

export interface ConfirmedPortionLine {
  profileId: ServingProfileId;
  min: number;
  max: number;
  unit: PortionUnit;
  purpose: ResolvedPortion["purpose"];
  multiplicity: number;
}

/**
 * Sorted list of eligible confirmed portions. This is the only input a later
 * nutrition integration may read; pending slots never appear here.
 */
export function confirmedPortionPlan(result: ServingReconciliation): ConfirmedPortionLine[] {
  return result.confirmed
    .map(unit => ({
      profileId: unit.profileId,
      min: unit.portion.min,
      max: unit.portion.max,
      unit: unit.portion.unit,
      purpose: unit.portion.purpose,
      multiplicity: unit.multiplicity,
    }))
    .sort(compareCanonical);
}
