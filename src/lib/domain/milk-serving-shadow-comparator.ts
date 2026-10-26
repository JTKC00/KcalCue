import { z } from "zod";
import {
  foodAnalysisSchema,
  portionUnits,
  type FoodAnalysis,
  type ObservedFood,
  type PortionUnit,
} from "@/lib/domain/food-analysis";
import {
  canonicalJson,
  confirmedPortionPlan,
  MAX_OBSERVED_ROWS,
  semanticDecisionView,
  SERVING_CONTRACT_VERSION,
  SERVING_ENGINE_VERSION,
  SERVING_GRAMMAR_VERSION,
  servingDecisionListSchema,
  ServingContractError,
  validateServingReconciliation,
  type Digest,
  type Id,
  type ObservedFoodRow,
  type ServingProfileId,
  type ServingReconciliation,
  type SupportedServingSlot,
  type UserServingDecision,
} from "@/lib/domain/milk-serving-contract";
import { interpretServingEvidence } from "@/lib/domain/milk-serving-evidence";
import {
  reconcileMilkServingScene,
  reconcileServingEvidence,
} from "@/lib/domain/milk-serving-reconciliation";
import {
  isMilkDrink,
  MERGED_DUPLICATE_MILK_NOTICE,
} from "@/lib/domain/milk-dedupe";
import { preparePhotoMilkAnalysis } from "@/lib/domain/photo-milk-analysis";
import {
  assignEntrySource,
  createEditableFoodItems,
  hasKnownPortion,
  renameFoodItem,
  type EditableFoodItem,
} from "@/lib/domain/editable-meal";
import {
  PHOTO_MILK_CHOICES,
  type UserMilkTypeChoice,
} from "@/lib/nutrition/photo-milk";
import {
  explicitLowFatMilk,
  mealPlantMilkContext,
} from "@/lib/nutrition/canonical";
import { PHOTO_MILK_OTHER_REASON } from "@/lib/nutrition/negative-rules";
import { localNutritionProfiles } from "@/lib/nutrition/local-data";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  calculateNutritionRanges,
  classifyMealCoverage,
  type MealCoverage,
} from "@/lib/nutrition/calculation";
import type { NutritionProfile } from "@/lib/nutrition/types";

/**
 * Offline synthetic Shadow Comparator (PR #128, Phase 2B1).
 *
 * Strictly offline domain comparison between the existing legacy photo-milk
 * preparation/nutrition projection and the Phase 1 physical serving
 * reconciliation engine. Never wired into /api/analyze, UI state, meal
 * persistence, or external providers in this phase.
 */

export const SHADOW_COMPARATOR_VERSION = "milk-serving-shadow-comparator-1" as const;
export const SHADOW_CATALOG_VERSION = "kcalcue-local-catalog-1" as const;
export const PUBLIC_SHADOW_DIAGNOSTIC_VERSION = "milk-serving-shadow-diagnostic-1" as const;
export const NUTRIENT_COMPARISON_TOLERANCE = 1e-6 as const;

export const unknownReasonCodes = [
  "not_observed",
  "unbound",
  "unsupported_reference",
] as const;
export type UnknownReasonCode = (typeof unknownReasonCodes)[number];

export type Known<T> =
  | { state: "known"; value: T }
  | { state: "unknown"; reason: UnknownReasonCode };

export function known<T>(value: T): Known<T> {
  return { state: "known", value };
}

export function unknownValue<T = never>(reason: UnknownReasonCode): Known<T> {
  return { state: "unknown", reason };
}

export interface NutrientRangeValue {
  min: number;
  max: number;
}

export interface ShadowNutrients {
  kcal: NutrientRangeValue;
  protein: NutrientRangeValue;
  carbs: NutrientRangeValue;
  fat: NutrientRangeValue;
}

export interface PortionMeaning {
  purpose: "personal" | "aggregate_consumed";
  amount: NutrientRangeValue;
  unit: PortionUnit;
  multiplicity: number;
}

export const verifiedMilkCatalogIds = [
  "whole-milk",
  "oat-milk",
  "unsweetened-soy-milk",
] as const;
export type VerifiedMilkCatalogId = (typeof verifiedMilkCatalogIds)[number];

export const catalogReferenceAssumptions = [
  "usda_sr_legacy_whole_milk",
  "usda_fndds_oat_milk_generic_reference",
  "usda_sr_legacy_unsweetened_soy_milk_reference",
] as const;
export type CatalogReferenceAssumption = (typeof catalogReferenceAssumptions)[number];

export interface VerifiedCatalogReference {
  servingProfileId: "whole" | "oat" | "soy";
  catalogId: VerifiedMilkCatalogId;
  catalogVersion: string;
  sourceId: string;
  referenceAssumption: CatalogReferenceAssumption;
}

export const bindingRelations = [
  "single_observation",
  "same_serving_merge",
  "aggregate_population",
] as const;
export type BindingRelation = (typeof bindingRelations)[number];

export interface PrivateServingBinding {
  relation: BindingRelation;
  observationRowIds: readonly Id[];
  observationSemanticKeys: readonly Digest[];
}

export interface ShadowUnitProjection {
  binding: Known<PrivateServingBinding>;
  portion: Known<PortionMeaning>;
  profile: Known<VerifiedCatalogReference>;
  includedInConfirmedSubtotal: boolean;
  nutrients: Known<ShadowNutrients>;
}

export interface ShadowNonMilkSummary {
  unitCount: number;
  includedCount: number;
  subtotal: Known<ShadowNutrients>;
}

export const mealCoverages = [
  "complete",
  "partial",
  "insufficient",
  "none",
] as const;

export interface ShadowSideProjection {
  observedMilkRows: number;
  physicalServingCount: Known<number>;
  confirmedUnitCount: number;
  confirmedPhysicalServingCount: Known<number>;
  supportedPhysicalServingCount: Known<number>;
  pendingSlotCount: Known<number>;
  pendingPhysicalServingCount: Known<number>;
  unresolvedGroupCount: Known<number>;
  units: readonly ShadowUnitProjection[];
  confirmedSubtotal: Known<ShadowNutrients>;
  fullMilkNutrition: Known<ShadowNutrients>;
  coverage: Known<MealCoverage>;
  coverageDenominator: Known<number>;
  unresolved: boolean;
  hasExclusiveOrConflictHypothesis: boolean;
  nonMilk: ShadowNonMilkSummary;
}

export const semanticDifferenceCodes = [
  "observed_row_count_mismatch",
  "physical_serving_count_mismatch",
  "confirmed_unit_count_mismatch",
  "confirmed_physical_serving_count_mismatch",
  "supported_physical_serving_count_mismatch",
  "unresolved_group_count_mismatch",
  "provenance_binding_mismatch",
  "portion_amount_mismatch",
  "portion_unit_mismatch",
  "portion_purpose_mismatch",
  "profile_mismatch",
  "kcal_mismatch",
  "protein_mismatch",
  "carbs_mismatch",
  "fat_mismatch",
  "coverage_mismatch",
  "non_milk_preservation_mismatch",
] as const;
export type SemanticDifferenceCode = (typeof semanticDifferenceCodes)[number];

export const uncomparableReasonCodes = [
  "unknown_binding",
  "unknown_portion",
  "unknown_profile",
  "pending_state",
  "unsupported_reference",
] as const;
export type UncomparableReasonCode = (typeof uncomparableReasonCodes)[number];

export const shadowFailureStages = [
  "input",
  "engine",
  "output",
  "projection",
  "comparison",
] as const;
export type ShadowFailureStage = (typeof shadowFailureStages)[number];

export type ShadowComparisonOutcome =
  | {
    kind: "semantically_equivalent";
  }
  | {
    kind: "investigation_required";
    reason: "invalid_contract" | "semantic_difference" | "execution_failure";
    failureStage?: ShadowFailureStage;
    differences: readonly SemanticDifferenceCode[];
    uncomparableReasons: readonly UncomparableReasonCode[];
  }
  | {
    kind: "uncomparable_without_user_decision";
    reason: UncomparableReasonCode;
    uncomparableReasons: readonly UncomparableReasonCode[];
  };

export interface ShadowComparisonResult {
  comparatorVersion: typeof SHADOW_COMPARATOR_VERSION;
  contractVersion: typeof SERVING_CONTRACT_VERSION;
  engineVersion: typeof SERVING_ENGINE_VERSION;
  grammarVersion: typeof SERVING_GRAMMAR_VERSION;
  catalogVersion: typeof SHADOW_CATALOG_VERSION;
  sceneId: string;
  outcome: ShadowComparisonOutcome;
  legacy: ShadowSideProjection | null;
  shadow: ShadowSideProjection | null;
}

export interface PublicShadowComparisonCounters {
  observedMilkRows: number | null;
  legacyConfirmedUnits: number | null;
  shadowConfirmedUnits: number | null;
  legacyPendingSlots: number | null;
  shadowPendingSlots: number | null;
  legacyUnresolvedGroups: number | null;
  shadowUnresolvedGroups: number | null;
}

export interface PublicShadowComparisonDiagnostic {
  diagnosticVersion: typeof PUBLIC_SHADOW_DIAGNOSTIC_VERSION;
  comparatorVersion: typeof SHADOW_COMPARATOR_VERSION;
  contractVersion: typeof SERVING_CONTRACT_VERSION;
  engineVersion: typeof SERVING_ENGINE_VERSION;
  grammarVersion: typeof SERVING_GRAMMAR_VERSION;
  catalogVersion: typeof SHADOW_CATALOG_VERSION;
  outcomeKind: ShadowComparisonOutcome["kind"];
  outcomeReason:
    | "equivalent"
    | "invalid_contract"
    | "semantic_difference"
    | "execution_failure"
    | UncomparableReasonCode;
  failureStage: ShadowFailureStage | null;
  differences: readonly SemanticDifferenceCode[];
  uncomparableReasons: readonly UncomparableReasonCode[];
  counters: PublicShadowComparisonCounters | null;
}

export interface ShadowLegacyOptions {
  sceneId?: string;
  /**
   * Optional explicit user milk-type choices keyed by canonical raw `rowId`
   * (or by `semanticKey`). Never inferred from model names.
   */
  userMilkTypeChoices?: Readonly<Record<string, UserMilkTypeChoice>>;
}

export interface ReconciledShadowProjectionOptions {
  /**
   * Optional expected `sceneId`. When supplied, must match `reconciliation.sceneId`.
   */
  sceneId?: string;
  /**
   * Caller-authorized serving decisions. This array is the only input that
   * may authorize milk-profile selection, dismissal, or cardinality changes.
   *
   * Omitted decisions and an empty array both mean the caller authorized no
   * user decisions. `acceptedDecisions` on a reconciliation is an output of
   * reconciliation and is never a decision source.
   */
  decisions?: readonly UserServingDecision[];
}

export interface ShadowComparisonInput {
  sceneId?: string;
  analysis: FoodAnalysis;
  decisions?: readonly UserServingDecision[];
  legacyUserMilkTypeChoices?: Readonly<Record<string, UserMilkTypeChoice>>;
  /**
   * Optional precomputed reconciliation to test strict output/plan validation
   * against forged or corrupted reconciliations before nutrition projection.
   */
  reconciliation?: ServingReconciliation;
}

// ---------------------------------------------------------------------------
// Strict runtime Zod schemas
// ---------------------------------------------------------------------------

function knownSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("known"),
      value: valueSchema,
    }),
    z.strictObject({
      state: z.literal("unknown"),
      reason: z.enum(unknownReasonCodes),
    }),
  ]);
}

const finiteNonNegativeRangeSchema = z.strictObject({
  min: z.number().finite().min(0),
  max: z.number().finite().min(0),
}).refine(range => range.min <= range.max + 1e-12, "min must not exceed max");

export const shadowNutrientsSchema = z.strictObject({
  kcal: finiteNonNegativeRangeSchema,
  protein: finiteNonNegativeRangeSchema,
  carbs: finiteNonNegativeRangeSchema,
  fat: finiteNonNegativeRangeSchema,
});

export const portionMeaningSchema = z.strictObject({
  purpose: z.enum(["personal", "aggregate_consumed"]),
  amount: finiteNonNegativeRangeSchema,
  unit: z.enum(portionUnits),
  multiplicity: z.number().int().min(1).max(9),
}).refine(
  portion => portion.purpose === "aggregate_consumed" || portion.multiplicity === 1,
  "personal portion must have multiplicity 1",
);

export const verifiedCatalogReferenceSchema = z.strictObject({
  servingProfileId: z.enum(["whole", "oat", "soy"]),
  catalogId: z.enum(verifiedMilkCatalogIds),
  catalogVersion: z.string().min(1),
  sourceId: z.string().min(1),
  referenceAssumption: z.enum(catalogReferenceAssumptions),
});

export const privateServingBindingSchema = z.strictObject({
  relation: z.enum(bindingRelations),
  observationRowIds: z.array(z.string().min(1)).min(1).max(MAX_OBSERVED_ROWS),
  observationSemanticKeys: z.array(z.string().min(1)).min(1).max(MAX_OBSERVED_ROWS),
});

export const shadowUnitProjectionSchema = z.strictObject({
  binding: knownSchema(privateServingBindingSchema),
  portion: knownSchema(portionMeaningSchema),
  profile: knownSchema(verifiedCatalogReferenceSchema),
  includedInConfirmedSubtotal: z.boolean(),
  nutrients: knownSchema(shadowNutrientsSchema),
}).superRefine((unit, ctx) => {
  if (unit.includedInConfirmedSubtotal) {
    if (unit.portion.state !== "known" || unit.profile.state !== "known" || unit.nutrients.state !== "known") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unit included in confirmed subtotal must have known portion, profile, and nutrients",
      });
    }
  }
});

export const shadowNonMilkSummarySchema = z.strictObject({
  unitCount: z.number().int().min(0).max(MAX_OBSERVED_ROWS),
  includedCount: z.number().int().min(0).max(MAX_OBSERVED_ROWS),
  subtotal: knownSchema(shadowNutrientsSchema),
}).refine(item => item.includedCount <= item.unitCount, "includedCount cannot exceed unitCount");

export const shadowSideProjectionSchema = z.strictObject({
  observedMilkRows: z.number().int().min(0).max(MAX_OBSERVED_ROWS),
  physicalServingCount: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9)),
  confirmedUnitCount: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9),
  confirmedPhysicalServingCount: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9)),
  supportedPhysicalServingCount: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9)),
  pendingSlotCount: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9)),
  pendingPhysicalServingCount: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9)),
  unresolvedGroupCount: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9)),
  units: z.array(shadowUnitProjectionSchema).max(MAX_OBSERVED_ROWS * 9),
  confirmedSubtotal: knownSchema(shadowNutrientsSchema),
  fullMilkNutrition: knownSchema(shadowNutrientsSchema),
  coverage: knownSchema(z.enum(mealCoverages)),
  coverageDenominator: knownSchema(z.number().int().min(0).max(MAX_OBSERVED_ROWS * 10)),
  unresolved: z.boolean(),
  hasExclusiveOrConflictHypothesis: z.boolean(),
  nonMilk: shadowNonMilkSummarySchema,
}).superRefine((side, ctx) => {
  const includedUnits = side.units.filter(unit => unit.includedInConfirmedSubtotal);
  if (includedUnits.length > side.confirmedUnitCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "included unit count cannot exceed confirmedUnitCount",
    });
  }
  if (side.unresolved && side.fullMilkNutrition.state === "known") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unresolved side projection cannot claim known fullMilkNutrition",
    });
  }
  if (side.pendingSlotCount.state === "known" && side.pendingSlotCount.value > 0 && side.fullMilkNutrition.state === "known") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "side projection with pending slots cannot claim known fullMilkNutrition",
    });
  }
});

export const shadowComparisonOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("semantically_equivalent"),
  }),
  z.strictObject({
    kind: z.literal("investigation_required"),
    reason: z.enum(["invalid_contract", "semantic_difference", "execution_failure"]),
    failureStage: z.enum(shadowFailureStages).optional(),
    differences: z.array(z.enum(semanticDifferenceCodes)),
    uncomparableReasons: z.array(z.enum(uncomparableReasonCodes)),
  }).superRefine((outcome, ctx) => {
    if (outcome.reason === "semantic_difference" && outcome.differences.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantic_difference outcome must list at least one SemanticDifferenceCode",
      });
    }
    if (outcome.reason === "semantic_difference" && outcome.failureStage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantic_difference outcome must not specify failureStage",
      });
    }
    if (outcome.reason !== "semantic_difference" && !outcome.failureStage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid_contract and execution_failure outcomes must specify failureStage",
      });
    }
  }),
  z.strictObject({
    kind: z.literal("uncomparable_without_user_decision"),
    reason: z.enum(uncomparableReasonCodes),
    uncomparableReasons: z.array(z.enum(uncomparableReasonCodes)).min(1),
  }).superRefine((outcome, ctx) => {
    if (!outcome.uncomparableReasons.includes(outcome.reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "primary uncomparable reason must be present in uncomparableReasons",
      });
    }
  }),
]);

export const shadowComparisonResultSchema = z.strictObject({
  comparatorVersion: z.literal(SHADOW_COMPARATOR_VERSION),
  contractVersion: z.literal(SERVING_CONTRACT_VERSION),
  engineVersion: z.literal(SERVING_ENGINE_VERSION),
  grammarVersion: z.literal(SERVING_GRAMMAR_VERSION),
  catalogVersion: z.literal(SHADOW_CATALOG_VERSION),
  sceneId: z.string().min(1).max(200).refine(value => value.trim().length > 0, "sceneId must not be whitespace"),
  outcome: shadowComparisonOutcomeSchema,
  legacy: shadowSideProjectionSchema.nullable(),
  shadow: shadowSideProjectionSchema.nullable(),
}).superRefine((result, ctx) => {
  if (result.outcome.kind === "semantically_equivalent") {
    if (!result.legacy || !result.shadow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantically_equivalent result requires non-null legacy and shadow projections",
      });
      return;
    }
    if (
      result.legacy.unresolved ||
      result.shadow.unresolved ||
      result.legacy.hasExclusiveOrConflictHypothesis ||
      result.shadow.hasExclusiveOrConflictHypothesis
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantically_equivalent result cannot have unresolved or conflicting servings on either side",
      });
    }
    if (
      result.legacy.fullMilkNutrition.state !== "known" ||
      result.shadow.fullMilkNutrition.state !== "known" ||
      result.legacy.confirmedSubtotal.state !== "known" ||
      result.shadow.confirmedSubtotal.state !== "known" ||
      result.legacy.physicalServingCount.state !== "known" ||
      result.shadow.physicalServingCount.state !== "known" ||
      result.legacy.confirmedPhysicalServingCount.state !== "known" ||
      result.shadow.confirmedPhysicalServingCount.state !== "known" ||
      result.legacy.supportedPhysicalServingCount.state !== "known" ||
      result.shadow.supportedPhysicalServingCount.state !== "known" ||
      result.legacy.pendingSlotCount.state !== "known" ||
      result.shadow.pendingSlotCount.state !== "known" ||
      result.legacy.pendingPhysicalServingCount.state !== "known" ||
      result.shadow.pendingPhysicalServingCount.state !== "known" ||
      result.legacy.unresolvedGroupCount.state !== "known" ||
      result.shadow.unresolvedGroupCount.state !== "known" ||
      result.legacy.coverage.state !== "known" ||
      result.shadow.coverage.state !== "known"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantically_equivalent result requires all core counts, nutrients, and coverage to be known",
      });
    } else if (
      result.legacy.pendingSlotCount.value !== 0 ||
      result.shadow.pendingSlotCount.value !== 0 ||
      result.legacy.pendingPhysicalServingCount.value !== 0 ||
      result.shadow.pendingPhysicalServingCount.value !== 0 ||
      result.legacy.unresolvedGroupCount.value !== 0 ||
      result.shadow.unresolvedGroupCount.value !== 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantically_equivalent result requires zero pending slots and zero unresolved groups",
      });
    }
    const allUnits = [...result.legacy.units, ...result.shadow.units];
    if (
      allUnits.some(
        unit =>
          unit.binding.state !== "known" ||
          unit.portion.state !== "known" ||
          unit.profile.state !== "known" ||
          unit.nutrients.state !== "known" ||
          !unit.includedInConfirmedSubtotal,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantically_equivalent result requires every unit to have known binding, portion, profile, and nutrients",
      });
    }
    return;
  }

  if (result.outcome.kind === "uncomparable_without_user_decision") {
    if (!result.legacy || !result.shadow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uncomparable_without_user_decision result requires non-null legacy and shadow projections",
      });
    }
    return;
  }

  if (result.outcome.reason === "semantic_difference") {
    if (!result.legacy || !result.shadow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantic_difference result requires non-null legacy and shadow projections",
      });
    }
    return;
  }

  if (result.outcome.failureStage === "input" && (result.legacy !== null || result.shadow !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "input failure stage must have null legacy and shadow projections",
    });
  }
  if (
    (result.outcome.failureStage === "engine" || result.outcome.failureStage === "output") &&
    result.shadow !== null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "engine and output failure stages must have null shadow projection",
    });
  }
});

export function validateShadowComparisonResult(value: unknown): ShadowComparisonResult {
  const parsed = shadowComparisonResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ServingContractError(
      "invalid shadow comparison result",
      parsed.error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export const publicShadowComparisonCountersSchema = z.strictObject({
  observedMilkRows: z.number().int().min(0).max(MAX_OBSERVED_ROWS).nullable(),
  legacyConfirmedUnits: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9).nullable(),
  shadowConfirmedUnits: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9).nullable(),
  legacyPendingSlots: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9).nullable(),
  shadowPendingSlots: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9).nullable(),
  legacyUnresolvedGroups: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9).nullable(),
  shadowUnresolvedGroups: z.number().int().min(0).max(MAX_OBSERVED_ROWS * 9).nullable(),
});

export const publicShadowComparisonDiagnosticSchema = z.strictObject({
  diagnosticVersion: z.literal(PUBLIC_SHADOW_DIAGNOSTIC_VERSION),
  comparatorVersion: z.literal(SHADOW_COMPARATOR_VERSION),
  contractVersion: z.literal(SERVING_CONTRACT_VERSION),
  engineVersion: z.literal(SERVING_ENGINE_VERSION),
  grammarVersion: z.literal(SERVING_GRAMMAR_VERSION),
  catalogVersion: z.literal(SHADOW_CATALOG_VERSION),
  outcomeKind: z.enum([
    "semantically_equivalent",
    "investigation_required",
    "uncomparable_without_user_decision",
  ]),
  outcomeReason: z.enum([
    "equivalent",
    "invalid_contract",
    "semantic_difference",
    "execution_failure",
    ...uncomparableReasonCodes,
  ]),
  failureStage: z.enum(shadowFailureStages).nullable(),
  differences: z.array(z.enum(semanticDifferenceCodes)),
  uncomparableReasons: z.array(z.enum(uncomparableReasonCodes)),
  counters: publicShadowComparisonCountersSchema.nullable(),
}).superRefine((diag, ctx) => {
  if (
    diag.outcomeKind === "investigation_required" &&
    (diag.outcomeReason === "invalid_contract" || diag.outcomeReason === "execution_failure")
  ) {
    if (!diag.failureStage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failure diagnostic must specify failureStage",
      });
    }
    if (diag.counters !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failure diagnostic must not carry successful counters",
      });
    }
  }
});

/**
 * Redacted, allowlisted public diagnostic projection (`toPublicShadowComparisonDiagnostic`).
 *
 * Strips all private provenance identifiers (`sceneId`, `rowId`, `slotId`,
 * `unitId`, `groupId`, `claimId`, `sourceDigest`, `semanticKey`), raw food
 * names/notes/evidence text, portion amounts, and nutrient values.
 */
export function toPublicShadowComparisonDiagnostic(
  result: ShadowComparisonResult,
): PublicShadowComparisonDiagnostic {
  const validated = validateShadowComparisonResult(result);
  const { outcome, legacy, shadow } = validated;

  const isFailure =
    outcome.kind === "investigation_required" &&
    (outcome.reason === "invalid_contract" || outcome.reason === "execution_failure");

  const counters: PublicShadowComparisonCounters | null = isFailure
    ? null
    : {
      observedMilkRows: shadow?.observedMilkRows ?? legacy?.observedMilkRows ?? null,
      legacyConfirmedUnits: legacy ? legacy.confirmedUnitCount : null,
      shadowConfirmedUnits: shadow ? shadow.confirmedUnitCount : null,
      legacyPendingSlots:
        legacy && legacy.pendingSlotCount.state === "known" ? legacy.pendingSlotCount.value : null,
      shadowPendingSlots:
        shadow && shadow.pendingSlotCount.state === "known" ? shadow.pendingSlotCount.value : null,
      legacyUnresolvedGroups:
        legacy && legacy.unresolvedGroupCount.state === "known"
          ? legacy.unresolvedGroupCount.value
          : null,
      shadowUnresolvedGroups:
        shadow && shadow.unresolvedGroupCount.state === "known"
          ? shadow.unresolvedGroupCount.value
          : null,
    };

  if (outcome.kind === "semantically_equivalent") {
    return publicShadowComparisonDiagnosticSchema.parse({
      diagnosticVersion: PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
      comparatorVersion: validated.comparatorVersion,
      contractVersion: validated.contractVersion,
      engineVersion: validated.engineVersion,
      grammarVersion: validated.grammarVersion,
      catalogVersion: validated.catalogVersion,
      outcomeKind: "semantically_equivalent",
      outcomeReason: "equivalent",
      failureStage: null,
      differences: [],
      uncomparableReasons: [],
      counters,
    });
  }

  if (outcome.kind === "uncomparable_without_user_decision") {
    return publicShadowComparisonDiagnosticSchema.parse({
      diagnosticVersion: PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
      comparatorVersion: validated.comparatorVersion,
      contractVersion: validated.contractVersion,
      engineVersion: validated.engineVersion,
      grammarVersion: validated.grammarVersion,
      catalogVersion: validated.catalogVersion,
      outcomeKind: "uncomparable_without_user_decision",
      outcomeReason: outcome.reason,
      failureStage: null,
      differences: [],
      uncomparableReasons: [...outcome.uncomparableReasons],
      counters,
    });
  }

  return publicShadowComparisonDiagnosticSchema.parse({
    diagnosticVersion: PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
    comparatorVersion: validated.comparatorVersion,
    contractVersion: validated.contractVersion,
    engineVersion: validated.engineVersion,
    grammarVersion: validated.grammarVersion,
    catalogVersion: validated.catalogVersion,
    outcomeKind: "investigation_required",
    outcomeReason: outcome.reason,
    failureStage: outcome.failureStage ?? null,
    differences: [...outcome.differences],
    uncomparableReasons: [...outcome.uncomparableReasons],
    counters,
  });
}

// ---------------------------------------------------------------------------
// Catalog & nutrient calculation helpers (read-only over localNutritionProfiles)
// ---------------------------------------------------------------------------

const CATALOG_BY_ID = new Map<string, NutritionProfile>(
  localNutritionProfiles.map(profile => [profile.id, profile]),
);

const SUPPORTED_MILK_PORTION_UNITS: ReadonlySet<PortionUnit> = new Set<PortionUnit>(["ml", "g"]);

function isSupportedMilkPortionUnit(unit: PortionUnit): boolean {
  return SUPPORTED_MILK_PORTION_UNITS.has(unit);
}

const VERIFIED_REFERENCES: Readonly<Record<"whole" | "oat" | "soy", VerifiedCatalogReference>> = {
  whole: {
    servingProfileId: "whole",
    catalogId: "whole-milk",
    catalogVersion: SHADOW_CATALOG_VERSION,
    sourceId: "sr-legacy:milk-whole",
    referenceAssumption: "usda_sr_legacy_whole_milk",
  },
  oat: {
    servingProfileId: "oat",
    catalogId: "oat-milk",
    catalogVersion: SHADOW_CATALOG_VERSION,
    sourceId: "2705412",
    referenceAssumption: "usda_fndds_oat_milk_generic_reference",
  },
  soy: {
    servingProfileId: "soy",
    catalogId: "unsweetened-soy-milk",
    catalogVersion: SHADOW_CATALOG_VERSION,
    sourceId: "175215",
    referenceAssumption: "usda_sr_legacy_unsweetened_soy_milk_reference",
  },
};

export function resolveCatalogReferenceByServingProfile(
  profileId: ServingProfileId,
): Known<VerifiedCatalogReference> {
  if (profileId === "low-fat") {
    return unknownValue("unsupported_reference");
  }
  const ref = VERIFIED_REFERENCES[profileId];
  const catalogProfile = CATALOG_BY_ID.get(ref.catalogId);
  if (!catalogProfile) {
    return unknownValue("unsupported_reference");
  }
  return known(ref);
}

export function resolveCatalogReferenceByCatalogId(
  catalogId: string,
): Known<VerifiedCatalogReference> {
  if (catalogId === "whole-milk") return known(VERIFIED_REFERENCES.whole);
  if (catalogId === "oat-milk") return known(VERIFIED_REFERENCES.oat);
  if (catalogId === "unsweetened-soy-milk") return known(VERIFIED_REFERENCES.soy);
  return unknownValue("unsupported_reference");
}

function zeroNutrients(): ShadowNutrients {
  return {
    kcal: { min: 0, max: 0 },
    protein: { min: 0, max: 0 },
    carbs: { min: 0, max: 0 },
    fat: { min: 0, max: 0 },
  };
}

function addNutrients(left: ShadowNutrients, right: ShadowNutrients): ShadowNutrients {
  return {
    kcal: { min: left.kcal.min + right.kcal.min, max: left.kcal.max + right.kcal.max },
    protein: { min: left.protein.min + right.protein.min, max: left.protein.max + right.protein.max },
    carbs: { min: left.carbs.min + right.carbs.min, max: left.carbs.max + right.carbs.max },
    fat: { min: left.fat.min + right.fat.min, max: left.fat.max + right.fat.max },
  };
}

/**
 * Calculate nutrients for a single portion meaning and catalog reference.
 *
 * Total consumed amount on a plan line is its min/max exactly once;
 * multiplicity describes how many physical servings that unit represents and
 * must NEVER be multiplied into the consumed amount again.
 */
function calculateUnitNutrients(
  portion: PortionMeaning,
  reference: VerifiedCatalogReference,
): Known<ShadowNutrients> {
  const profile = CATALOG_BY_ID.get(reference.catalogId);
  if (!profile) return unknownValue("unsupported_reference");
  const gramsPerUnit = profile.gramsPerUnit[portion.unit];
  if (typeof gramsPerUnit !== "number" || !Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0) {
    return unknownValue("unsupported_reference");
  }
  const grams = {
    min: portion.amount.min * gramsPerUnit,
    max: portion.amount.max * gramsPerUnit,
  };
  const ranges = calculateNutritionRanges(profile.nutrientsPer100g, grams);
  return known({
    kcal: { min: ranges.calories.min, max: ranges.calories.max },
    protein: { min: ranges.protein.min, max: ranges.protein.max },
    carbs: { min: ranges.carbs.min, max: ranges.carbs.max },
    fat: { min: ranges.fat.min, max: ranges.fat.max },
  });
}

function sortedUnique<T extends string>(items: readonly T[]): T[] {
  return [...new Set(items)].sort();
}

function cloneFood(food: ObservedFood): ObservedFood {
  return {
    ...food,
    ...(food.visibleIngredients ? { visibleIngredients: [...food.visibleIngredients] } : {}),
    uncertaintyReasons: [...food.uncertaintyReasons],
  };
}

function cloneFoodAnalysis(analysis: FoodAnalysis): FoodAnalysis {
  return {
    ...analysis,
    foods: analysis.foods.map(cloneFood),
    visibleEvidence: [...analysis.visibleEvidence],
    uncertaintyReasons: [...analysis.uncertaintyReasons],
    estimatedInformation: [...analysis.estimatedInformation],
    unknownInformation: [...analysis.unknownInformation],
  };
}

function makeBinding(
  relation: BindingRelation,
  rows: readonly ObservedFoodRow[],
): PrivateServingBinding {
  const sortedRows = [...rows].sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  return {
    relation,
    observationRowIds: sortedRows.map(row => row.rowId),
    observationSemanticKeys: sortedRows.map(row => row.semanticKey),
  };
}

function unitSortKey(unit: ShadowUnitProjection): string {
  return canonicalJson(unit);
}

// ---------------------------------------------------------------------------
// Non-milk projection helper (shared read-only catalog evaluation)
// ---------------------------------------------------------------------------

function projectNonMilkFoods(foods: readonly EditableFoodItem[]): ShadowNonMilkSummary {
  if (foods.length === 0) {
    return {
      unitCount: 0,
      includedCount: 0,
      subtotal: known(zeroNutrients()),
    };
  }
  const provider = new LocalNutritionProvider();
  const matches = foods.map(food => (hasKnownPortion(food) ? provider.resolve(food) : null));
  let subtotal = zeroNutrients();
  let includedCount = 0;
  for (let index = 0; index < foods.length; index += 1) {
    const calculated = calculateFoodNutrition(foods[index], matches[index] ?? null);
    if (calculated.includedInTotal && calculated.ranges) {
      includedCount += 1;
      subtotal = addNutrients(subtotal, {
        kcal: calculated.ranges.calories,
        protein: calculated.ranges.protein,
        carbs: calculated.ranges.carbs,
        fat: calculated.ranges.fat,
      });
    }
  }
  return {
    unitCount: foods.length,
    includedCount,
    subtotal: includedCount === foods.length ? known(subtotal) : unknownValue("not_observed"),
  };
}

// ---------------------------------------------------------------------------
// Legacy milk preparation & nutrition projection
// ---------------------------------------------------------------------------

const VALID_USER_MILK_TYPE_CHOICES: ReadonlySet<string> = new Set<string>(
  PHOTO_MILK_CHOICES.map(entry => entry.id),
);

function validateUserMilkTypeChoices(
  choices: unknown,
): Readonly<Record<string, UserMilkTypeChoice>> {
  if (choices === undefined) return {};
  if (typeof choices !== "object" || choices === null || Array.isArray(choices)) {
    throw new ServingContractError("userMilkTypeChoices must be a plain object");
  }
  const validated: Record<string, UserMilkTypeChoice> = {};
  for (const [key, value] of Object.entries(choices as Record<string, unknown>)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new ServingContractError("userMilkTypeChoices key must be a non-empty string");
    }
    if (typeof value !== "string" || !VALID_USER_MILK_TYPE_CHOICES.has(value)) {
      throw new ServingContractError(`invalid userMilkTypeChoice for ${key}`);
    }
    validated[key] = value as UserMilkTypeChoice;
  }
  return validated;
}

function applyLegacyMilkChoice(
  item: EditableFoodItem,
  choice: UserMilkTypeChoice,
): EditableFoodItem {
  if (!VALID_USER_MILK_TYPE_CHOICES.has(choice)) {
    throw new ServingContractError(`invalid userMilkTypeChoice: ${String(choice)}`);
  }
  if (choice === "other") {
    return {
      ...item,
      userMilkTypeChoice: "other",
      otherMilkNotice: PHOTO_MILK_OTHER_REASON,
    };
  }
  const option = PHOTO_MILK_CHOICES.find(entry => entry.id === choice);
  if (!option || option.id === "other") return item;
  return renameFoodItem(
    { ...item, userMilkTypeChoice: option.id },
    option.displayName,
    item,
  );
}

/**
 * Detect blended milk labels (e.g. `燕麥豆漿`, `燕麥混合豆漿`, `blended oat soy milk`)
 * that combine multiple distinct milk families on the item's own label and have
 * no single supported catalog profile in `localNutritionProfiles`.
 */
function hasBlendedMilkIdentity(
  food: Pick<ObservedFood, "displayName" | "normalizedName">,
): boolean {
  const text = `${food.displayName} ${food.normalizedName}`.toLowerCase();
  const families = new Set<string>();
  if (/燕麥|燕麦|\boats?\b/u.test(text)) families.add("oat");
  if (/豆漿|豆浆|豆奶|\bsoya?\b|soymilk/u.test(text)) families.add("soy");
  if (/杏仁|\balmond\b/u.test(text)) families.add("almond");
  if (/椰奶|椰子|\bcoconut\b/u.test(text)) families.add("coconut");
  if (/低脂|脫脂|脱脂|\blow[-\s]?fat\b|\bskim(?:med)?\b|\breduced[-\s]?fat\b/u.test(text)) families.add("low-fat");
  if (/全脂|鮮奶|鲜奶|\bwhole\s*milk\b|\bfull[-\s]?cream\b|\bfresh\s*milk\b/u.test(text)) families.add("whole");

  const hasUncertaintyDisjunction = /可能|或者|還是|或是|抑或|\bor\b|\bmaybe\b|\bwhether\b/u.test(text);
  if (families.size >= 2 && !hasUncertaintyDisjunction) {
    return true;
  }
  if (families.size >= 1 && /混合|混和|\bblend(?:ed)?\b|\bmix(?:ed)?\b/u.test(text)) {
    return true;
  }
  return false;
}

function legacyMilkUnsupportedFamily(food: EditableFoodItem): boolean {
  if (food.userMilkTypeChoice === "low-fat" || food.userMilkTypeChoice === "other") {
    return true;
  }
  if (food.userMilkTypeChoice === "whole" || food.userMilkTypeChoice === "oat" || food.userMilkTypeChoice === "soy") {
    return false;
  }
  if (hasBlendedMilkIdentity(food) || explicitLowFatMilk(food)) {
    return true;
  }
  const text = `${food.displayName} ${food.normalizedName}`.toLowerCase();
  return /低脂|脫脂|脱脂|杏仁|椰奶|椰子|朱古力|巧克力|low[-\s]?fat|skim|reduced[-\s]?fat|almond|coconut|chocolate/.test(text);
}

function legacyPortionAndFamilyAgree(left: ObservedFood, right: ObservedFood): boolean {
  if (left.portionMin !== right.portionMin || left.portionMax !== right.portionMax || left.unit !== right.unit) {
    return false;
  }
  const familyTag = (food: ObservedFood): string => {
    const text = `${food.displayName} ${food.normalizedName}`.toLowerCase();
    if (/燕麥|燕麦|\boat\b/.test(text)) return "oat";
    if (/豆漿|豆浆|豆奶|\bsoy(?:a)?\b/.test(text)) return "soy";
    if (/杏仁|\balmond\b/.test(text)) return "almond";
    if (/椰奶|椰子|\bcoconut\b/.test(text)) return "coconut";
    if (/低脂|脫脂|脱脂|low[-\s]?fat|skim/.test(text)) return "low-fat";
    if (/全脂|鮮奶|鲜奶|whole milk|fresh milk/.test(text)) return "whole";
    return "generic";
  };
  return familyTag(left) === familyTag(right);
}

function legacySingleRowHasMultiServingCue(food: ObservedFood, analysis: FoodAnalysis): boolean {
  if (food.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE) return true;
  const text = [
    food.displayName,
    food.normalizedName,
    food.notes ?? "",
    food.preparationMethod ?? "",
    ...analysis.visibleEvidence,
  ].join(" ");
  return /(?:[二兩两三四五六七八九2-9]|two|three|four|five|six|seven|eight|nine)\s*(?:個|个|隻|只)?\s*(?:玻璃杯|杯|紙盒|纸盒|盒|包|瓶|樽|glasses|cups?|cartons?|packages?|bottles?)/i.test(text);
}

/**
 * Replicate Legacy `milk-dedupe.ts` candidate milk grouping so that `suspectedDuplicateMilk`
 * unbinding is scoped strictly to the duplicate group that had an ambiguous tie-break,
 * preserving known `single_observation` bindings on unrelated confirmed servings in the scene.
 */
function legacyCandidateMilkGroups(
  foods: readonly ObservedFood[],
  milkIndexes: readonly number[],
  mergedTwoIntoOne: boolean,
): number[][] {
  if (milkIndexes.length < 2 || mergedTwoIntoOne) return [];
  if (milkIndexes.length === 2) return [[...milkIndexes]];

  type LegacyFamily = "oat" | "soy" | "almond" | "coconut" | "dairy" | "generic";
  type LegacyVessel = "carton" | "bottle" | "glass";
  type LegacyContainerKind = LegacyVessel | "package" | "unknown" | "mixed";

  const familyOfFood = (food: ObservedFood): LegacyFamily => {
    const text = [
      food.displayName,
      food.normalizedName,
      food.notes ?? "",
      food.preparationMethod ?? "",
      ...(food.visibleIngredients ?? []),
      ...food.uncertaintyReasons,
    ]
      .join(" ")
      .toLowerCase();
    if (/燕麥奶|燕麦奶|(?:^|\s)oat milk(?:$|\s)/.test(text)) return "oat";
    if (/豆漿|豆浆|豆奶|(?:^|\s)soy(?:a)? milk(?:$|\s)/.test(text)) return "soy";
    if (/杏仁奶|(?:^|\s)almond milk(?:$|\s)/.test(text)) return "almond";
    if (/椰奶|(?:^|\s)coconut milk(?:$|\s)/.test(text)) return "coconut";
    if (
      /全脂|低脂|脫脂|脱脂|鮮奶|鲜奶|(?:^|\s)(?:whole milk|fresh milk|skim milk|low-fat milk|low fat milk)(?:$|\s)/.test(
        text,
      )
    ) {
      return "dairy";
    }
    return "generic";
  };

  const ownContainerKinds = (food: ObservedFood): Set<LegacyVessel> => {
    const identityText = [
      food.displayName,
      food.normalizedName,
      food.preparationMethod ?? "",
    ]
      .join(" ")
      .toLowerCase();
    const kinds = new Set<LegacyVessel>();
    if (/紙盒|纸盒|紙包|纸包|利樂|利乐|carton|一盒|盒裝|盒装/.test(identityText)) kinds.add("carton");
    if (/瓶子|玻璃樽|一瓶|一樽|瓶裝|瓶装|(?:^|\s)bottle(?:$|\s)/.test(identityText)) kinds.add("bottle");
    if (/玻璃杯|杯裝|杯装|另一(?:個|个|隻|只)?杯|第二(?:個|个|隻|只)?杯|(?<!同)一杯|(?:^|\s)(?:glass|cup)(?:$|\s)/.test(identityText)) {
      kinds.add("glass");
    }
    return kinds;
  };

  const inferNoteVessels = (food: ObservedFood): Set<LegacyVessel> => {
    const found = new Set<LegacyVessel>();
    const clauses = (food.notes ?? "")
      .split(/[，,。；;!！]/)
      .map(clause => clause.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (/[?？]/.test(clause)) continue;
      const kinds = new Set<LegacyVessel>();
      if (/carton|package|紙盒|纸盒|紙包|纸包|利樂|利乐|盒裝|盒装/i.test(clause)) kinds.add("carton");
      if (/bottle|瓶|樽/i.test(clause)) kinds.add("bottle");
      if (/玻璃杯|杯子|杯裝|杯装|\bglass\b|\bcup\b|另一(?:個|个|隻|只)?杯|第二(?:個|个|隻|只)?杯/i.test(clause)) {
        kinds.add("glass");
      }
      if (kinds.size === 1) {
        found.add([...kinds][0]);
      }
    }
    return found;
  };

  const kindOfFood = (food: ObservedFood): LegacyContainerKind => {
    const own = [...ownContainerKinds(food)];
    if (own.length > 1) return "mixed";
    if (own.length === 1) return own[0];
    const inferred = inferNoteVessels(food);
    if (inferred.size === 1) return [...inferred][0];
    return "unknown";
  };

  const entries = milkIndexes.map(index => ({
    index,
    family: familyOfFood(foods[index]),
    kind: kindOfFood(foods[index]),
  }));

  const resolved = entries.map(entry => {
    if (entry.family !== "generic") return { ...entry };
    const eligible = new Set(
      entries
        .filter(
          other =>
            other.family !== "generic" &&
            entry.kind !== "unknown" &&
            entry.kind !== "mixed" &&
            other.kind === entry.kind,
        )
        .map(other => other.family),
    );
    return { ...entry, family: eligible.size === 1 ? [...eligible][0] : entry.family };
  });

  const groups = new Map<string, number[]>();
  for (const entry of resolved) {
    const possibleKinds = new Set(
      resolved
        .filter(
          other =>
            other.family === entry.family &&
            other.kind !== "unknown" &&
            other.kind !== "mixed",
        )
        .map(other => other.kind),
    );
    const effectiveKind =
      entry.kind === "unknown" && possibleKinds.size === 1 ? [...possibleKinds][0] : entry.kind;
    const key = `${entry.family}:${effectiveKind}`;
    groups.set(key, [...(groups.get(key) ?? []), entry.index]);
  }
  return [...groups.values()].filter(group => group.length >= 2);
}

export function projectLegacyMilkShadow(
  analysis: FoodAnalysis,
  options: ShadowLegacyOptions = {},
): ShadowSideProjection {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ServingContractError("legacy shadow options must be an object");
  }
  if (
    options.sceneId !== undefined &&
    (typeof options.sceneId !== "string" || options.sceneId.trim().length === 0 || options.sceneId.length > 200)
  ) {
    throw new ServingContractError("sceneId must be a non-empty string of at most 200 characters");
  }
  const sceneId = options.sceneId ? options.sceneId.trim() : "shadow-scene";
  const choices = validateUserMilkTypeChoices(options.userMilkTypeChoices);

  const parsedAnalysis = foodAnalysisSchema.safeParse(analysis);
  if (!parsedAnalysis.success || parsedAnalysis.data.foods.length > MAX_OBSERVED_ROWS) {
    throw new ServingContractError("invalid FoodAnalysis supplied to projectLegacyMilkShadow");
  }

  const clonedInput = cloneFoodAnalysis(parsedAnalysis.data);
  const interpreted = interpretServingEvidence({ sceneId, analysis: clonedInput });
  const rowByOriginalIndex = new Map<number, ObservedFoodRow>(
    interpreted.rows.map(row => [row.originalIndex, row]),
  );

  const rawMilkIndices = clonedInput.foods.flatMap((food, index) => (isMilkDrink(food) ? [index] : []));
  const prepared = preparePhotoMilkAnalysis(clonedInput);
  const editableAll = assignEntrySource(createEditableFoodItems(prepared.foods), prepared);

  // Determine how `dedupeIdenticalContainerMilk` mapped raw indices to prepared rows.
  const mergedTwoIntoOne = prepared.foods.length < clonedInput.foods.length && rawMilkIndices.length === 2;

  // Map each prepared index to the raw index(es) that produced it.
  const preparedRawIndices: number[][] = [];
  if (mergedTwoIntoOne) {
    let milkEmitted = false;
    for (let index = 0; index < clonedInput.foods.length; index += 1) {
      if (rawMilkIndices.includes(index)) {
        if (!milkEmitted) {
          preparedRawIndices.push([...rawMilkIndices]);
          milkEmitted = true;
        }
      } else {
        preparedRawIndices.push([index]);
      }
    }
  } else {
    for (let index = 0; index < prepared.foods.length; index += 1) {
      preparedRawIndices.push([index]);
    }
  }

  // Apply optional user milk type choices (keyed by canonical rowId or semanticKey).
  const chosenItems = editableAll.map((item, prepIndex) => {
    const rawIdxs = preparedRawIndices[prepIndex] ?? [];
    const rawRows = rawIdxs.map(idx => rowByOriginalIndex.get(idx)).filter((r): r is ObservedFoodRow => r !== undefined);
    const matchedChoice = rawRows
      .map(row => choices[row.rowId] ?? choices[row.semanticKey])
      .find((value): value is UserMilkTypeChoice => value !== undefined);
    return matchedChoice ? applyLegacyMilkChoice(item, matchedChoice) : item;
  });

  const provider = new LocalNutritionProvider();
  const mealContext = mealPlantMilkContext({ analysis: prepared });
  const matches = chosenItems.map(food =>
    provider.resolve(
      {
        ...food,
        portionMin: food.portionMin ?? 1,
        portionMax: food.portionMax ?? 1,
      },
      mealContext,
    ),
  );
  const calculatedFoods = chosenItems.map((food, index) =>
    calculateFoodNutrition(food, hasKnownPortion(food) ? (matches[index] ?? null) : null),
  );
  const calculatedMeal = calculateMealNutrition(calculatedFoods);

  // Detect which candidate duplicate group(s) actually had a `suspectedDuplicateMilk` tie-break.
  const suspectedIndicesInPrepared = new Set<number>();
  chosenItems.forEach((item, index) => {
    if (item.suspectedDuplicateMilk === true) suspectedIndicesInPrepared.add(index);
  });

  const candidateGroups = legacyCandidateMilkGroups(
    clonedInput.foods,
    rawMilkIndices,
    mergedTwoIntoOne,
  );
  const ambiguousDuplicateRawIndices = new Set<number>();
  let ambiguousDuplicateGroupCount = 0;
  for (const group of candidateGroups) {
    if (group.some(rawIdx => suspectedIndicesInPrepared.has(rawIdx))) {
      ambiguousDuplicateGroupCount += 1;
      for (const rawIdx of group) {
        ambiguousDuplicateRawIndices.add(rawIdx);
      }
    }
  }
  if (suspectedIndicesInPrepared.size > 0 && ambiguousDuplicateGroupCount === 0) {
    ambiguousDuplicateGroupCount = 1;
    for (const rawIdx of suspectedIndicesInPrepared) {
      ambiguousDuplicateRawIndices.add(rawIdx);
    }
  }

  const units: ShadowUnitProjection[] = [];
  const nonMilkItems: EditableFoodItem[] = [];

  let confirmedUnitCount = 0;
  let pendingCount = 0;
  let hasUnsupportedConfirmedUnit = false;
  let hasUnsupportedPendingUnit = false;
  let confirmedSubtotalValue = zeroNutrients();

  for (let prepIndex = 0; prepIndex < chosenItems.length; prepIndex += 1) {
    const item = chosenItems[prepIndex];
    if (!isMilkDrink(item)) {
      nonMilkItems.push(item);
      continue;
    }

    const rawIdxs = preparedRawIndices[prepIndex] ?? [];
    const rawRows = rawIdxs
      .map(idx => rowByOriginalIndex.get(idx))
      .filter((row): row is ObservedFoodRow => row !== undefined);
    const match = matches[prepIndex] ?? null;

    // Provenance binding analysis for this legacy milk row:
    let binding: Known<PrivateServingBinding>;
    if (rawRows.length === 0) {
      binding = unknownValue("unbound");
    } else if (mergedTwoIntoOne && rawRows.length === 2) {
      const [first, second] = rawRows;
      if (legacyPortionAndFamilyAgree(first.raw, second.raw)) {
        binding = known(makeBinding("same_serving_merge", rawRows));
      } else {
        // Legacy mergeMilkRows discarded one of two conflicting portions/identities.
        binding = unknownValue("unbound");
      }
    } else if (
      item.suspectedDuplicateMilk === true ||
      rawIdxs.some(idx => ambiguousDuplicateRawIndices.has(idx))
    ) {
      // Scoped strictly to the candidate duplicate group that had a suspectedDuplicateMilk
      // tie-break; unrelated milk servings in other groups preserve their known binding.
      binding = unknownValue("unbound");
    } else if (rawRows.length === 1 && legacySingleRowHasMultiServingCue(item, clonedInput)) {
      // Single row that swallowed multiple containers or describes an aggregate count:
      // provenance to the single raw observation is known, or if it has merge notice it is unbound.
      binding = item.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE
        ? unknownValue("unbound")
        : known(makeBinding("single_observation", rawRows));
    } else {
      binding = known(makeBinding("single_observation", rawRows));
    }

    // Portion meaning on legacy side:
    const hasPortion =
      typeof item.portionMin === "number" &&
      typeof item.portionMax === "number" &&
      Number.isFinite(item.portionMin) &&
      Number.isFinite(item.portionMax) &&
      item.portionMin >= 0 &&
      item.portionMax >= item.portionMin;
    const unsupportedUnit = !isSupportedMilkPortionUnit(item.unit);

    const portion: Known<PortionMeaning> = hasPortion
      ? known({
        purpose: "personal",
        amount: { min: item.portionMin!, max: item.portionMax! },
        unit: item.unit,
        multiplicity: 1,
      })
      : unsupportedUnit
        ? unknownValue("unsupported_reference")
        : unknownValue("not_observed");

    const unsupportedFamily = legacyMilkUnsupportedFamily(item);

    // Profile & nutrients on legacy side:
    if (item.suspectedDuplicateMilk === true) {
      pendingCount += 1;
      const suspectedUnsupported =
        unsupportedFamily ||
        unsupportedUnit ||
        (portion.state === "unknown" && portion.reason === "unsupported_reference");
      if (suspectedUnsupported) {
        hasUnsupportedPendingUnit = true;
      }
      units.push({
        binding,
        portion,
        profile: unsupportedFamily
          ? unknownValue("unsupported_reference")
          : unknownValue("not_observed"),
        includedInConfirmedSubtotal: false,
        nutrients: suspectedUnsupported
          ? unknownValue("unsupported_reference")
          : unknownValue("not_observed"),
      });
      continue;
    }
    const matchedProfileId = match?.profile?.id ?? null;
    const unitConversionMissing = match?.coverageReason === "UNIT_CONVERSION_MISSING";

    // When unit conversion is missing on whole/oat/soy, resolver sets profile: null
    // with coverageReason === "UNIT_CONVERSION_MISSING". Recover the intended catalog
    // profile by probing with a supported unit ("ml") so generic milk never defaults to whole.
    let profile: Known<VerifiedCatalogReference>;
    if (matchedProfileId) {
      profile = resolveCatalogReferenceByCatalogId(matchedProfileId);
    } else if (unitConversionMissing && !unsupportedFamily) {
      const mlProbe = provider.resolve(
        {
          ...item,
          unit: "ml",
          portionMin: 1,
          portionMax: 1,
        },
        mealContext,
      );
      if (mlProbe?.profile?.id) {
        profile = resolveCatalogReferenceByCatalogId(mlProbe.profile.id);
      } else {
        profile = unknownValue("not_observed");
      }
    } else if (unsupportedFamily) {
      profile = unknownValue("unsupported_reference");
    } else {
      profile = unknownValue("not_observed");
    }

    // A legacy row is a confirmed accounting unit when it is not suspectedDuplicateMilk,
    // has a known portion, and has a resolved catalog profile (even if unit conversion fails).
    if (portion.state === "known" && profile.state === "known") {
      confirmedUnitCount += 1;
      const nutrients = calculateUnitNutrients(portion.value, profile.value);
      if (nutrients.state === "known") {
        confirmedSubtotalValue = addNutrients(confirmedSubtotalValue, nutrients.value);
        units.push({
          binding,
          portion,
          profile,
          includedInConfirmedSubtotal: true,
          nutrients,
        });
      } else {
        hasUnsupportedConfirmedUnit = true;
        units.push({
          binding,
          portion,
          profile,
          includedInConfirmedSubtotal: false,
          nutrients,
        });
      }
    } else {
      pendingCount += 1;
      const pendingUnsupported =
        (profile.state === "unknown" && profile.reason === "unsupported_reference") ||
        (portion.state === "unknown" && portion.reason === "unsupported_reference") ||
        unsupportedUnit;
      if (pendingUnsupported) {
        hasUnsupportedPendingUnit = true;
      }
      units.push({
        binding,
        portion,
        profile,
        includedInConfirmedSubtotal: false,
        nutrients: pendingUnsupported
          ? unknownValue("unsupported_reference")
          : unknownValue("not_observed"),
      });
    }
  }

  units.sort((left, right) => (unitSortKey(left) < unitSortKey(right) ? -1 : unitSortKey(left) > unitSortKey(right) ? 1 : 0));

  const hasSuspectedDuplicates = suspectedIndicesInPrepared.size > 0;
  const singleRowMultiCue =
    rawMilkIndices.length === 1 &&
    chosenItems.some(item => isMilkDrink(item) && legacySingleRowHasMultiServingCue(item, clonedInput));
  const mergeHadConflict =
    mergedTwoIntoOne &&
    rawMilkIndices.length === 2 &&
    !legacyPortionAndFamilyAgree(clonedInput.foods[rawMilkIndices[0]], clonedInput.foods[rawMilkIndices[1]]);

  const physicalCountKnown =
    !hasSuspectedDuplicates &&
    !singleRowMultiCue &&
    !mergeHadConflict &&
    units.every(unit => unit.binding.state === "known");

  const totalPreparedMilkRows = confirmedUnitCount + pendingCount;
  const physicalServingCount: Known<number> =
    rawMilkIndices.length === 0
      ? known(0)
      : physicalCountKnown
        ? known(totalPreparedMilkRows)
        : unknownValue("not_observed");

  const confirmedPhysicalServingCount: Known<number> =
    confirmedUnitCount === 0
      ? known(0)
      : !singleRowMultiCue && !mergeHadConflict
        ? known(confirmedUnitCount)
        : unknownValue("not_observed");

  const supportedPhysicalServingCount: Known<number> = physicalServingCount;
  const pendingSlotCount: Known<number> = known(pendingCount);
  const pendingPhysicalServingCount: Known<number> =
    pendingCount === 0
      ? known(0)
      : !hasSuspectedDuplicates && !singleRowMultiCue
        ? known(pendingCount)
        : unknownValue("not_observed");

  const unresolved = hasSuspectedDuplicates || pendingCount > 0 || hasUnsupportedConfirmedUnit;

  const unresolvedGroupCount: Known<number> = hasSuspectedDuplicates
    ? known(ambiguousDuplicateGroupCount)
    : !unresolved && !mergeHadConflict
      ? known(0)
      : unknownValue("not_observed");

  const confirmedSubtotal: Known<ShadowNutrients> = hasUnsupportedConfirmedUnit
    ? unknownValue("unsupported_reference")
    : known(confirmedSubtotalValue);

  const fullMilkNutrition: Known<ShadowNutrients> =
    confirmedSubtotal.state === "unknown"
      ? confirmedSubtotal
      : unresolved
        ? unknownValue(hasUnsupportedPendingUnit ? "unsupported_reference" : "not_observed")
        : confirmedSubtotal;

  const coverage: Known<MealCoverage> = hasUnsupportedConfirmedUnit
    ? unknownValue("unsupported_reference")
    : known(calculatedMeal.coverage);

  const coverageDenominator: Known<number> = known(
    chosenItems.filter(item => item.suspectedDuplicateMilk !== true).length,
  );

  return shadowSideProjectionSchema.parse({
    observedMilkRows: rawMilkIndices.length,
    physicalServingCount,
    confirmedUnitCount,
    confirmedPhysicalServingCount,
    supportedPhysicalServingCount,
    pendingSlotCount,
    pendingPhysicalServingCount,
    unresolvedGroupCount,
    units,
    confirmedSubtotal,
    fullMilkNutrition,
    coverage,
    coverageDenominator,
    unresolved,
    hasExclusiveOrConflictHypothesis: false,
    nonMilk: projectNonMilkFoods(nonMilkItems),
  });
}

// ---------------------------------------------------------------------------
// Reconciled milk serving & nutrition projection
// ---------------------------------------------------------------------------

function slotSourceRows(
  slot: SupportedServingSlot,
  rowById: ReadonlyMap<string, ObservedFoodRow>,
): ObservedFoodRow[] {
  return slot.sourceCandidateIds
    .filter(candidateId => candidateId.startsWith("cand:") && !candidateId.startsWith("cand:obj:"))
    .map(candidateId => rowById.get(candidateId.slice("cand:".length)))
    .filter((row): row is ObservedFoodRow => row !== undefined);
}

function deriveSlotBinding(
  slot: SupportedServingSlot,
  rowById: ReadonlyMap<string, ObservedFoodRow>,
  liveSlotsInSamePool: readonly SupportedServingSlot[],
): Known<PrivateServingBinding> {
  const sourceRows = slotSourceRows(slot, rowById);

  if (sourceRows.length === 0) {
    return unknownValue("unbound");
  }

  const resolvedPortion = slot.portion.state === "resolved" ? slot.portion.value : null;
  if (resolvedPortion?.purpose === "aggregate_consumed" || slot.multiplicity > 1) {
    return known(makeBinding("aggregate_population", sourceRows));
  }

  if (sourceRows.length === 1) {
    return known(makeBinding("single_observation", sourceRows));
  }

  // Multiple source rows in pool:
  if (liveSlotsInSamePool.length === 1) {
    // Multiple observations merged into a single supported serving slot.
    return known(makeBinding("same_serving_merge", sourceRows));
  }

  // Multiple slots share the same candidate pool (e.g. cardinality expansion).
  // Bijective attribution is only possible when slot count equals source row count
  // and all source rows in the pool have identical semanticKeys.
  const uniqueSemanticKeys = new Set(sourceRows.map(row => row.semanticKey));
  if (liveSlotsInSamePool.length === sourceRows.length && uniqueSemanticKeys.size === 1) {
    const orderedPoolSlots = [...liveSlotsInSamePool].sort((a, b) => (a.slotId < b.slotId ? -1 : 1));
    const orderedPoolRows = [...sourceRows].sort((a, b) => (a.rowId < b.rowId ? -1 : 1));
    const slotIndex = orderedPoolSlots.findIndex(candidate => candidate.slotId === slot.slotId);
    if (slotIndex >= 0 && slotIndex < orderedPoolRows.length) {
      return known(makeBinding("single_observation", [orderedPoolRows[slotIndex]]));
    }
  }

  return unknownValue("unbound");
}

/**
 * Caller-supplied decisions are the only authorization for milk-profile
 * selection, dismissal, and cardinality changes.
 *
 * Omitted decisions and an empty array both authorize nothing.
 * `acceptedDecisions` on the reconciliation under verification is an output
 * and must never be read as this value.
 */
function callerAuthorizedDecisions(
  options: ReconciledShadowProjectionOptions | undefined,
): readonly UserServingDecision[] | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ServingContractError("invalid ReconciledShadowProjectionOptions");
  }
  if (options.decisions === undefined) return undefined;
  if (!Array.isArray(options.decisions)) {
    throw new ServingContractError("caller-authorized decisions must be an array");
  }
  const parsed = servingDecisionListSchema.safeParse(options.decisions);
  if (!parsed.success) {
    throw new ServingContractError(
      "invalid caller-authorized decisions",
      parsed.error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return [...parsed.data];
}

/**
 * Verify that `validated` is exactly the reconciliation produced from trusted
 * `rawAnalysis`, independently interpreted serving evidence, and
 * caller-authorized decisions.
 *
 * Trust boundary:
 * - Nutrition projection requires an independently supplied FoodAnalysis.
 *   Reconciliation rows, claims, sourceDigest, and acceptedDecisions are
 *   outputs under test. None of them can establish source authenticity or
 *   decision authorization.
 * - Missing rawAnalysis fails closed. It is not repaired from the payload.
 * - Omitted and empty caller decisions both recompute with no user decisions.
 */
function verifyAuthenticReconciliation(
  validated: ServingReconciliation,
  rawAnalysis: unknown,
  options?: ReconciledShadowProjectionOptions,
): void {
  if (rawAnalysis === undefined || rawAnalysis === null) {
    throw new ServingContractError(
      "trusted rawAnalysis is required to project reconciled milk nutrition",
    );
  }

  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new ServingContractError("invalid ReconciledShadowProjectionOptions");
  }

  if (options?.sceneId !== undefined) {
    if (
      typeof options.sceneId !== "string" ||
      options.sceneId.trim().length === 0 ||
      options.sceneId.length > 200 ||
      options.sceneId.trim() !== validated.sceneId
    ) {
      throw new ServingContractError(
        "reconciliation sceneId does not match caller sceneId",
      );
    }
  }

  const parsedAnalysis = foodAnalysisSchema.safeParse(rawAnalysis);
  if (!parsedAnalysis.success || parsedAnalysis.data.foods.length > MAX_OBSERVED_ROWS) {
    throw new ServingContractError("invalid rawAnalysis supplied to projectReconciledMilkShadow");
  }

  const authorizedDecisions = callerAuthorizedDecisions(options);
  const expectedEvidence = interpretServingEvidence({
    sceneId: validated.sceneId,
    analysis: cloneFoodAnalysis(parsedAnalysis.data),
  });
  const authoritative = reconcileServingEvidence({
    sceneId: expectedEvidence.sceneId,
    rows: expectedEvidence.rows,
    claims: expectedEvidence.claims,
    decisions: authorizedDecisions,
  });

  if (validated.sourceDigest !== authoritative.sourceDigest) {
    throw new ServingContractError(
      "reconciliation sourceDigest does not match authoritative evidence from rawAnalysis",
    );
  }
  if (canonicalJson(validated.acceptedDecisions) !== canonicalJson(authoritative.acceptedDecisions)) {
    throw new ServingContractError(
      "reconciliation acceptedDecisions are not authorized by the caller",
    );
  }
  if (canonicalJson(validated.rejectedDecisions) !== canonicalJson(authoritative.rejectedDecisions)) {
    throw new ServingContractError(
      "reconciliation rejectedDecisions do not match authoritative reconciliation",
    );
  }
  if (
    canonicalJson(confirmedPortionPlan(validated)) !==
    canonicalJson(confirmedPortionPlan(authoritative))
  ) {
    throw new ServingContractError(
      "reconciliation confirmed portion ownership does not match authoritative reconciliation",
    );
  }
  if (
    canonicalJson(semanticDecisionView(validated)) !==
    canonicalJson(semanticDecisionView(authoritative))
  ) {
    throw new ServingContractError(
      "reconciliation semanticDecisionView does not match authoritative reconciliation for rawAnalysis and decisions",
    );
  }
  if (canonicalJson(validated) !== canonicalJson(authoritative)) {
    throw new ServingContractError(
      "reconciliation payload does not match authoritative reconciliation for rawAnalysis and decisions",
    );
  }
}

/**
 * Project reconciled milk nutrition.
 *
 * `rawAnalysis` is mandatory trusted source evidence. `options.decisions`,
 * when supplied, is the only user-decision authorization. The reconciliation
 * argument is compared with a fresh authoritative reconciliation and is never
 * used as the source of rows, claims, or accepted decisions.
 */
export function projectReconciledMilkShadow(
  reconciliation: ServingReconciliation,
  rawAnalysis: FoodAnalysis,
  options?: ReconciledShadowProjectionOptions,
): ShadowSideProjection {
  // Enforce strict reconciliation validation, confirmedPortionPlan ownership,
  // and authoritative evidence/decision binding before any nutrition calculation.
  let validated: ServingReconciliation;
  let verifiedPlan: ReturnType<typeof confirmedPortionPlan>;
  try {
    validated = validateServingReconciliation(reconciliation);
    verifiedPlan = confirmedPortionPlan(validated);
    verifyAuthenticReconciliation(validated, rawAnalysis, options);
  } catch (error) {
    if (error instanceof ServingContractError) throw error;
    if (error instanceof z.ZodError) {
      throw new ServingContractError(
        "invalid serving reconciliation contract",
        error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      );
    }
    throw error;
  }

  const rowById = new Map<string, ObservedFoodRow>(
    validated.rows.map(row => [row.rowId, row]),
  );
  const slotById = new Map<string, SupportedServingSlot>(
    validated.supportedSlots.map(slot => [slot.slotId, slot]),
  );

  const liveSlots = validated.supportedSlots.filter(slot => slot.status !== "dismissed");
  const slotsByScope = new Map<string, SupportedServingSlot[]>();
  for (const slot of liveSlots) {
    slotsByScope.set(slot.scopeId, [...(slotsByScope.get(slot.scopeId) ?? []), slot]);
  }

  const units: ShadowUnitProjection[] = [];
  let confirmedSubtotalValue = zeroNutrients();
  let hasUnsupportedConfirmedUnit = false;
  let hasUnsupportedPendingUnit = false;
  let confirmedPhysicalCount = 0;

  // 1. Project confirmed accounting units (cross-checked against confirmedPortionPlan)
  if (verifiedPlan.length !== validated.confirmed.length) {
    throw new ServingContractError("confirmedPortionPlan length mismatch with validated.confirmed");
  }

  for (const confirmedUnit of validated.confirmed) {
    const slotId = confirmedUnit.slotIds[0];
    const slot = slotById.get(slotId);
    if (!slot) {
      throw new ServingContractError(`confirmed unit ${confirmedUnit.unitId} missing slot ${slotId}`);
    }
    const poolSlots = slotsByScope.get(slot.scopeId) ?? [slot];
    const binding = deriveSlotBinding(slot, rowById, poolSlots);
    const portionValue: PortionMeaning = {
      purpose: confirmedUnit.portion.purpose,
      amount: { min: confirmedUnit.portion.min, max: confirmedUnit.portion.max },
      unit: confirmedUnit.portion.unit,
      multiplicity: confirmedUnit.multiplicity,
    };
    const portion = known(portionValue);
    const profile = resolveCatalogReferenceByServingProfile(confirmedUnit.profileId);

    confirmedPhysicalCount += confirmedUnit.multiplicity;

    if (profile.state === "known") {
      const nutrients = calculateUnitNutrients(portionValue, profile.value);
      if (nutrients.state === "known") {
        confirmedSubtotalValue = addNutrients(confirmedSubtotalValue, nutrients.value);
        units.push({
          binding,
          portion,
          profile,
          includedInConfirmedSubtotal: true,
          nutrients,
        });
      } else {
        hasUnsupportedConfirmedUnit = true;
        units.push({
          binding,
          portion,
          profile,
          includedInConfirmedSubtotal: false,
          nutrients,
        });
      }
    } else {
      hasUnsupportedConfirmedUnit = true;
      units.push({
        binding,
        portion,
        profile,
        includedInConfirmedSubtotal: false,
        nutrients: unknownValue("unsupported_reference"),
      });
    }
  }

  // 2. Project pending supported slots (`status === "pending"`)
  const pendingSlots = liveSlots.filter(slot => slot.status === "pending");
  const pendingPhysicalCount = pendingSlots.reduce((sum, slot) => sum + slot.multiplicity, 0);

  for (const slot of pendingSlots) {
    const poolSlots = slotsByScope.get(slot.scopeId) ?? [slot];
    const binding = deriveSlotBinding(slot, rowById, poolSlots);
    const sourceRows = slotSourceRows(slot, rowById);

    const hasUnsupportedRawUnit =
      sourceRows.length > 0 &&
      sourceRows.every(row => !isSupportedMilkPortionUnit(row.raw.unit));

    const portion: Known<PortionMeaning> =
      slot.portion.state === "resolved"
        ? known({
          purpose: slot.portion.value.purpose,
          amount: { min: slot.portion.value.min, max: slot.portion.value.max },
          unit: slot.portion.value.unit,
          multiplicity: slot.multiplicity,
        })
        : hasUnsupportedRawUnit
          ? unknownValue("unsupported_reference")
          : unknownValue("not_observed");

    const hasBlendedSourceRow =
      slot.profile.state !== "resolved" &&
      sourceRows.some(row => hasBlendedMilkIdentity(row.raw));

    const unsupportedProfile =
      slot.pendingReasons.includes("profile_unavailable") ||
      slot.pendingReasons.includes("user_type_other") ||
      hasBlendedSourceRow;

    const profile: Known<VerifiedCatalogReference> = unsupportedProfile
      ? unknownValue("unsupported_reference")
      : slot.profile.state === "resolved"
        ? resolveCatalogReferenceByServingProfile(slot.profile.value)
        : unknownValue("not_observed");

    const unsupportedPortionUnit =
      (portion.state === "known" && !isSupportedMilkPortionUnit(portion.value.unit)) ||
      (portion.state === "unknown" && portion.reason === "unsupported_reference");

    const pendingUnsupported =
      (profile.state === "unknown" && profile.reason === "unsupported_reference") ||
      unsupportedPortionUnit;

    if (pendingUnsupported) {
      hasUnsupportedPendingUnit = true;
    }

    units.push({
      binding,
      portion,
      profile,
      includedInConfirmedSubtotal: false,
      nutrients: pendingUnsupported
        ? unknownValue("unsupported_reference")
        : unknownValue("not_observed"),
    });
  }

  units.sort((left, right) => (unitSortKey(left) < unitSortKey(right) ? -1 : unitSortKey(left) > unitSortKey(right) ? 1 : 0));

  const effectiveUnresolvedGroups = validated.summary.unresolvedGroupCount;
  const hasOpenAmbiguity =
    effectiveUnresolvedGroups > 0 ||
    validated.summary.cardinalityReviewRequired;

  const hasExclusiveOrConflictHypothesis = validated.unresolved.some(
    group =>
      group.kind === "exclusive_candidates" ||
      group.kind === "family_conflict" ||
      group.kind === "relation_conflict" ||
      group.reasonCodes.includes("competing_maximum_cliques"),
  );

  const observedMilkRows = validated.rows.filter(row => row.subject.milkCandidate).length;

  const physicalServingCount: Known<number> = hasOpenAmbiguity
    ? unknownValue("not_observed")
    : known(validated.summary.supportedServingCount);

  const confirmedUnitCount = validated.confirmed.length;
  const confirmedPhysicalServingCount: Known<number> = known(confirmedPhysicalCount);
  const supportedPhysicalServingCount: Known<number> = known(validated.summary.supportedServingCount);
  const pendingSlotCount: Known<number> = known(validated.summary.pendingSlotCount);
  const pendingPhysicalServingCount: Known<number> = known(pendingPhysicalCount);
  const unresolvedGroupCount: Known<number> = known(effectiveUnresolvedGroups);

  const unresolved =
    validated.summary.pendingSlotCount > 0 ||
    hasOpenAmbiguity ||
    hasUnsupportedConfirmedUnit;

  const confirmedSubtotal: Known<ShadowNutrients> = hasUnsupportedConfirmedUnit
    ? unknownValue("unsupported_reference")
    : known(confirmedSubtotalValue);

  const fullMilkNutrition: Known<ShadowNutrients> =
    confirmedSubtotal.state === "unknown"
      ? confirmedSubtotal
      : unresolved
        ? unknownValue(hasUnsupportedPendingUnit ? "unsupported_reference" : "not_observed")
        : confirmedSubtotal;

  // Non-milk rows from validated.rows
  const nonMilkRawFoods = validated.rows
    .filter(row => !row.subject.milkCandidate)
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map(row => cloneFood(row.raw));
  const nonMilkEditable = createEditableFoodItems(nonMilkRawFoods).map(item => ({
    ...item,
    entrySource: "photo" as const,
  }));
  const nonMilk = projectNonMilkFoods(nonMilkEditable);

  // Derive Shadow meal coverage with explicit eligible/unsupported/pending accounting
  const includedMilkUnits = units.filter(unit => unit.includedInConfirmedSubtotal).length;
  const activeMilkSlotUnits =
    confirmedUnitCount +
    validated.summary.pendingSlotCount +
    (confirmedUnitCount + validated.summary.pendingSlotCount === 0 && hasOpenAmbiguity ? 1 : 0);
  const totalDenominator = nonMilk.unitCount + activeMilkSlotUnits;
  const totalNumerator = nonMilk.includedCount + includedMilkUnits;

  let coverage: Known<MealCoverage>;
  if (hasUnsupportedConfirmedUnit) {
    coverage = unknownValue("unsupported_reference");
  } else {
    const baseCoverage = classifyMealCoverage(totalNumerator, totalDenominator);
    const adjustedCoverage: MealCoverage =
      hasOpenAmbiguity && baseCoverage === "complete" ? "partial" : baseCoverage;
    coverage = known(adjustedCoverage);
  }

  return shadowSideProjectionSchema.parse({
    observedMilkRows,
    physicalServingCount,
    confirmedUnitCount,
    confirmedPhysicalServingCount,
    supportedPhysicalServingCount,
    pendingSlotCount,
    pendingPhysicalServingCount,
    unresolvedGroupCount,
    units,
    confirmedSubtotal,
    fullMilkNutrition,
    coverage,
    coverageDenominator: known(totalDenominator),
    unresolved,
    hasExclusiveOrConflictHypothesis,
    nonMilk,
  });
}

// ---------------------------------------------------------------------------
// Semantic comparison engine
// ---------------------------------------------------------------------------

function withinTolerance(left: number, right: number, tolerance = NUTRIENT_COMPARISON_TOLERANCE): boolean {
  return Math.abs(left - right) <= tolerance;
}

function rangeMatches(
  left: NutrientRangeValue,
  right: NutrientRangeValue,
  tolerance = NUTRIENT_COMPARISON_TOLERANCE,
): boolean {
  return withinTolerance(left.min, right.min, tolerance) && withinTolerance(left.max, right.max, tolerance);
}

function collectNutrientDifferences(
  left: ShadowNutrients,
  right: ShadowNutrients,
  differences: Set<SemanticDifferenceCode>,
): void {
  if (!rangeMatches(left.kcal, right.kcal)) differences.add("kcal_mismatch");
  if (!rangeMatches(left.protein, right.protein)) differences.add("protein_mismatch");
  if (!rangeMatches(left.carbs, right.carbs)) differences.add("carbs_mismatch");
  if (!rangeMatches(left.fat, right.fat)) differences.add("fat_mismatch");
}

function bindingMatches(left: PrivateServingBinding, right: PrivateServingBinding): boolean {
  return (
    left.relation === right.relation &&
    canonicalJson(left.observationRowIds) === canonicalJson(right.observationRowIds) &&
    canonicalJson(left.observationSemanticKeys) === canonicalJson(right.observationSemanticKeys)
  );
}

function profileMatches(left: VerifiedCatalogReference, right: VerifiedCatalogReference): boolean {
  return (
    left.servingProfileId === right.servingProfileId &&
    left.catalogId === right.catalogId &&
    left.catalogVersion === right.catalogVersion &&
    left.sourceId === right.sourceId &&
    left.referenceAssumption === right.referenceAssumption
  );
}

function compareUnitPair(
  legacyUnit: ShadowUnitProjection,
  shadowUnit: ShadowUnitProjection,
  differences: Set<SemanticDifferenceCode>,
): void {
  if (legacyUnit.binding.state === "known" && shadowUnit.binding.state === "known") {
    if (!bindingMatches(legacyUnit.binding.value, shadowUnit.binding.value)) {
      differences.add("provenance_binding_mismatch");
    }
  }

  if (legacyUnit.portion.state === "known" && shadowUnit.portion.state === "known") {
    const lp = legacyUnit.portion.value;
    const sp = shadowUnit.portion.value;
    if (!rangeMatches(lp.amount, sp.amount)) {
      differences.add("portion_amount_mismatch");
    }
    if (lp.unit !== sp.unit) {
      differences.add("portion_unit_mismatch");
    }
    if (lp.purpose !== sp.purpose || lp.multiplicity !== sp.multiplicity) {
      differences.add("portion_purpose_mismatch");
    }
  }

  if (legacyUnit.profile.state === "known" && shadowUnit.profile.state === "known") {
    if (!profileMatches(legacyUnit.profile.value, shadowUnit.profile.value)) {
      differences.add("profile_mismatch");
    }
  }

  if (legacyUnit.nutrients.state === "known" && shadowUnit.nutrients.state === "known") {
    collectNutrientDifferences(legacyUnit.nutrients.value, shadowUnit.nutrients.value, differences);
  }
}

function confirmedAccountingUnits(side: ShadowSideProjection): ShadowUnitProjection[] {
  return side.units.filter(
    unit => unit.portion.state === "known" && unit.profile.state === "known",
  );
}

function pairConfirmedUnits(
  legacyUnits: readonly ShadowUnitProjection[],
  shadowUnits: readonly ShadowUnitProjection[],
  differences: Set<SemanticDifferenceCode>,
): Array<readonly [ShadowUnitProjection, ShadowUnitProjection]> {
  if (legacyUnits.length === 0 || shadowUnits.length === 0) return [];

  // Single confirmed unit on each side with known bindings: pair directly and compare all known fields.
  if (
    legacyUnits.length === 1 &&
    shadowUnits.length === 1 &&
    legacyUnits[0].binding.state === "known" &&
    shadowUnits[0].binding.state === "known"
  ) {
    return [[legacyUnits[0], shadowUnits[0]]];
  }

  const usedShadow = new Set<number>();
  const pairs: Array<readonly [ShadowUnitProjection, ShadowUnitProjection]> = [];

  // Pass 1: pair by exact known observationRowIds + relation + semanticKeys
  for (let lIdx = 0; lIdx < legacyUnits.length; lIdx += 1) {
    const lUnit = legacyUnits[lIdx];
    if (lUnit.binding.state !== "known") continue;
    const lBinding = lUnit.binding.value;
    const matchIdx = shadowUnits.findIndex(
      (sUnit, sIdx) =>
        !usedShadow.has(sIdx) &&
        sUnit.binding.state === "known" &&
        bindingMatches(lBinding, sUnit.binding.value),
    );
    if (matchIdx >= 0) {
      usedShadow.add(matchIdx);
      pairs.push([lUnit, shadowUnits[matchIdx]]);
    }
  }

  // Pass 2: pair by uniquely 1-to-1 overlapping observationRowIds (e.g. single_observation vs aggregate_population on same row).
  // Never greedily pair a merged unit against one of multiple split units by array position.
  const pairedLegacy = new Set(pairs.map(pair => pair[0]));
  const remainingLegacyKnown = legacyUnits.filter(
    unit => !pairedLegacy.has(unit) && unit.binding.state === "known",
  );
  const remainingShadowKnownIndices = shadowUnits
    .map((unit, idx) => ({ unit, idx }))
    .filter(({ unit, idx }) => !usedShadow.has(idx) && unit.binding.state === "known")
    .map(({ idx }) => idx);

  let hasAmbiguousOverlap = false;
  for (const lUnit of remainingLegacyKnown) {
    if (lUnit.binding.state !== "known") continue;
    const lRows = new Set(lUnit.binding.value.observationRowIds);
    const matchingShadowIndices = remainingShadowKnownIndices.filter(sIdx => {
      if (usedShadow.has(sIdx)) return false;
      const sUnit = shadowUnits[sIdx];
      return (
        sUnit.binding.state === "known" &&
        sUnit.binding.value.observationRowIds.some(rowId => lRows.has(rowId))
      );
    });

    if (matchingShadowIndices.length > 1) {
      hasAmbiguousOverlap = true;
      continue;
    }

    if (matchingShadowIndices.length === 1) {
      const candidateShadowIdx = matchingShadowIndices[0];
      const sUnit = shadowUnits[candidateShadowIdx];
      if (sUnit.binding.state !== "known") continue;
      const sRows = new Set(sUnit.binding.value.observationRowIds);
      const matchingLegacyForShadow = remainingLegacyKnown.filter(otherLegacy => {
        if (pairedLegacy.has(otherLegacy) || otherLegacy.binding.state !== "known") return false;
        return otherLegacy.binding.value.observationRowIds.some(rowId => sRows.has(rowId));
      });

      if (matchingLegacyForShadow.length === 1 && matchingLegacyForShadow[0] === lUnit) {
        usedShadow.add(candidateShadowIdx);
        pairedLegacy.add(lUnit);
        pairs.push([lUnit, sUnit]);
      } else {
        hasAmbiguousOverlap = true;
      }
    }
  }

  // Any ambiguous row-overlap (1-to-many / many-to-1) or remaining unpaired units where
  // both sides still have known bindings demonstrates a provenance binding mismatch.
  // Unbound units are never paired by array index.
  const remainingLegacy = legacyUnits.filter(unit => !pairedLegacy.has(unit));
  const remainingShadow = shadowUnits.filter((_, idx) => !usedShadow.has(idx));
  if (
    hasAmbiguousOverlap ||
    (remainingLegacy.some(unit => unit.binding.state === "known") &&
      remainingShadow.some(unit => unit.binding.state === "known"))
  ) {
    differences.add("provenance_binding_mismatch");
  }

  return pairs;
}

function collectUncomparableReasons(
  legacy: ShadowSideProjection,
  shadow: ShadowSideProjection,
): { primary: UncomparableReasonCode; all: UncomparableReasonCode[] } | null {
  const reasons = new Set<UncomparableReasonCode>();
  const allUnits = [...legacy.units, ...shadow.units];

  const hasUnsupportedReference =
    allUnits.some(
      unit =>
        (unit.profile.state === "unknown" && unit.profile.reason === "unsupported_reference") ||
        (unit.portion.state === "unknown" && unit.portion.reason === "unsupported_reference") ||
        (unit.nutrients.state === "unknown" && unit.nutrients.reason === "unsupported_reference"),
    ) ||
    (legacy.confirmedSubtotal.state === "unknown" && legacy.confirmedSubtotal.reason === "unsupported_reference") ||
    (shadow.confirmedSubtotal.state === "unknown" && shadow.confirmedSubtotal.reason === "unsupported_reference") ||
    (legacy.fullMilkNutrition.state === "unknown" && legacy.fullMilkNutrition.reason === "unsupported_reference") ||
    (shadow.fullMilkNutrition.state === "unknown" && shadow.fullMilkNutrition.reason === "unsupported_reference") ||
    (legacy.coverage.state === "unknown" && legacy.coverage.reason === "unsupported_reference") ||
    (shadow.coverage.state === "unknown" && shadow.coverage.reason === "unsupported_reference");

  if (hasUnsupportedReference) {
    reasons.add("unsupported_reference");
  }

  const hasUnknownBinding = allUnits.some(unit => unit.binding.state === "unknown");
  if (hasUnknownBinding) {
    reasons.add("unknown_binding");
  }

  const hasUnknownPortion = allUnits.some(
    unit => unit.portion.state === "unknown" && unit.portion.reason === "not_observed",
  );
  if (hasUnknownPortion) {
    reasons.add("unknown_portion");
  }

  const hasUnknownProfile = allUnits.some(
    unit => unit.profile.state === "unknown" && unit.profile.reason === "not_observed",
  );
  if (hasUnknownProfile) {
    reasons.add("unknown_profile");
  }

  const incompatibleCoverageDenominators =
    legacy.coverageDenominator.state === "known" &&
    shadow.coverageDenominator.state === "known" &&
    legacy.coverageDenominator.value !== shadow.coverageDenominator.value;

  const hasPendingState =
    legacy.unresolved ||
    shadow.unresolved ||
    legacy.hasExclusiveOrConflictHypothesis ||
    shadow.hasExclusiveOrConflictHypothesis ||
    (legacy.pendingSlotCount.state === "known" && legacy.pendingSlotCount.value > 0) ||
    (shadow.pendingSlotCount.state === "known" && shadow.pendingSlotCount.value > 0) ||
    (legacy.unresolvedGroupCount.state === "known" && legacy.unresolvedGroupCount.value > 0) ||
    (shadow.unresolvedGroupCount.state === "known" && shadow.unresolvedGroupCount.value > 0) ||
    legacy.physicalServingCount.state === "unknown" ||
    shadow.physicalServingCount.state === "unknown" ||
    legacy.confirmedPhysicalServingCount.state === "unknown" ||
    shadow.confirmedPhysicalServingCount.state === "unknown" ||
    legacy.supportedPhysicalServingCount.state === "unknown" ||
    shadow.supportedPhysicalServingCount.state === "unknown" ||
    legacy.unresolvedGroupCount.state === "unknown" ||
    shadow.unresolvedGroupCount.state === "unknown" ||
    legacy.fullMilkNutrition.state === "unknown" ||
    shadow.fullMilkNutrition.state === "unknown" ||
    legacy.coverage.state === "unknown" ||
    shadow.coverage.state === "unknown" ||
    incompatibleCoverageDenominators;

  if (hasPendingState) {
    reasons.add("pending_state");
  }

  if (reasons.size === 0) return null;

  let primary: UncomparableReasonCode;
  if (reasons.has("unsupported_reference")) {
    primary = "unsupported_reference";
  } else if (reasons.has("unknown_binding")) {
    primary = "unknown_binding";
  } else if (
    (legacy.hasExclusiveOrConflictHypothesis || shadow.hasExclusiveOrConflictHypothesis) &&
    reasons.has("pending_state")
  ) {
    primary = "pending_state";
  } else if (reasons.has("unknown_portion")) {
    primary = "unknown_portion";
  } else if (reasons.has("unknown_profile")) {
    primary = "unknown_profile";
  } else {
    primary = "pending_state";
  }

  return {
    primary,
    all: sortedUnique([...reasons]),
  };
}

export function compareShadowProjections(
  legacyInput: ShadowSideProjection,
  shadowInput: ShadowSideProjection,
  options: { sceneId?: string } = {},
): ShadowComparisonResult {
  const sceneId = options.sceneId && options.sceneId.trim().length > 0 ? options.sceneId : "shadow-scene";

  const parsedLegacy = shadowSideProjectionSchema.safeParse(legacyInput);
  const parsedShadow = shadowSideProjectionSchema.safeParse(shadowInput);
  if (!parsedLegacy.success || !parsedShadow.success) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId,
      outcome: {
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "projection",
        differences: [],
        uncomparableReasons: [],
      },
      legacy: parsedLegacy.success ? parsedLegacy.data : null,
      shadow: parsedShadow.success ? parsedShadow.data : null,
    });
  }

  const legacy = parsedLegacy.data;
  const shadow = parsedShadow.data;
  const differences = new Set<SemanticDifferenceCode>();

  // 1. Compare observed milk rows
  if (legacy.observedMilkRows !== shadow.observedMilkRows) {
    differences.add("observed_row_count_mismatch");
  }

  // 2. Compare physical serving count when mutually known
  if (legacy.physicalServingCount.state === "known" && shadow.physicalServingCount.state === "known") {
    if (legacy.physicalServingCount.value !== shadow.physicalServingCount.value) {
      differences.add("physical_serving_count_mismatch");
    }
  }

  // 3. Compare confirmed accounting-unit count
  if (legacy.confirmedUnitCount !== shadow.confirmedUnitCount) {
    differences.add("confirmed_unit_count_mismatch");
  }

  // 4. Compare confirmed physical-serving count when mutually known
  if (
    legacy.confirmedPhysicalServingCount.state === "known" &&
    shadow.confirmedPhysicalServingCount.state === "known"
  ) {
    if (legacy.confirmedPhysicalServingCount.value !== shadow.confirmedPhysicalServingCount.value) {
      differences.add("confirmed_physical_serving_count_mismatch");
    }
  }

  // 4b. Compare supported physical-serving count when mutually known
  if (
    legacy.supportedPhysicalServingCount.state === "known" &&
    shadow.supportedPhysicalServingCount.state === "known"
  ) {
    if (legacy.supportedPhysicalServingCount.value !== shadow.supportedPhysicalServingCount.value) {
      differences.add("supported_physical_serving_count_mismatch");
    }
  }

  // 4c. Compare unresolved group count when mutually known
  if (
    legacy.unresolvedGroupCount.state === "known" &&
    shadow.unresolvedGroupCount.state === "known"
  ) {
    if (legacy.unresolvedGroupCount.value !== shadow.unresolvedGroupCount.value) {
      differences.add("unresolved_group_count_mismatch");
    }
  }

  // 5. Compare confirmed units (provenance binding, portion, unit, purpose/multiplicity, profile, nutrients)
  const legacyConfirmedUnits = confirmedAccountingUnits(legacy);
  const shadowConfirmedUnits = confirmedAccountingUnits(shadow);
  const pairedUnits = pairConfirmedUnits(legacyConfirmedUnits, shadowConfirmedUnits, differences);
  for (const [legacyUnit, shadowUnit] of pairedUnits) {
    compareUnitPair(legacyUnit, shadowUnit, differences);
  }

  // 6. Compare confirmed subtotals when mutually known
  if (legacy.confirmedSubtotal.state === "known" && shadow.confirmedSubtotal.state === "known") {
    collectNutrientDifferences(legacy.confirmedSubtotal.value, shadow.confirmedSubtotal.value, differences);
  }

  // 7. Compare full milk nutrition when mutually known
  if (legacy.fullMilkNutrition.state === "known" && shadow.fullMilkNutrition.state === "known") {
    collectNutrientDifferences(legacy.fullMilkNutrition.value, shadow.fullMilkNutrition.value, differences);
  }

  // 8. Compare meal coverage when mutually known
  if (legacy.coverage.state === "known" && shadow.coverage.state === "known") {
    if (legacy.coverage.value !== shadow.coverage.value) {
      differences.add("coverage_mismatch");
    }
  }

  // 9. Compare non-milk food preservation
  if (
    legacy.nonMilk.unitCount !== shadow.nonMilk.unitCount ||
    legacy.nonMilk.includedCount !== shadow.nonMilk.includedCount ||
    (legacy.nonMilk.subtotal.state === "known" &&
      shadow.nonMilk.subtotal.state === "known" &&
      (!rangeMatches(legacy.nonMilk.subtotal.value.kcal, shadow.nonMilk.subtotal.value.kcal) ||
        !rangeMatches(legacy.nonMilk.subtotal.value.protein, shadow.nonMilk.subtotal.value.protein) ||
        !rangeMatches(legacy.nonMilk.subtotal.value.carbs, shadow.nonMilk.subtotal.value.carbs) ||
        !rangeMatches(legacy.nonMilk.subtotal.value.fat, shadow.nonMilk.subtotal.value.fat)))
  ) {
    differences.add("non_milk_preservation_mismatch");
  }

  const uncomparable = collectUncomparableReasons(legacy, shadow);

  // Precedence Rule 3: Any demonstrable semantic difference in a mutually known
  // dimension yields `investigation_required / semantic_difference`.
  if (differences.size > 0) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId,
      outcome: {
        kind: "investigation_required",
        reason: "semantic_difference",
        differences: sortedUnique([...differences]),
        uncomparableReasons: uncomparable ? uncomparable.all : [],
      },
      legacy,
      shadow,
    });
  }

  // Precedence Rule 4: Any unknown binding, pending state, unknown portion/profile,
  // or unsupported reference yields `uncomparable_without_user_decision`.
  if (uncomparable) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId,
      outcome: {
        kind: "uncomparable_without_user_decision",
        reason: uncomparable.primary,
        uncomparableReasons: uncomparable.all,
      },
      legacy,
      shadow,
    });
  }

  // Precedence Rule 5: All required dimensions are known, bound, and equivalent.
  return validateShadowComparisonResult({
    comparatorVersion: SHADOW_COMPARATOR_VERSION,
    contractVersion: SERVING_CONTRACT_VERSION,
    engineVersion: SERVING_ENGINE_VERSION,
    grammarVersion: SERVING_GRAMMAR_VERSION,
    catalogVersion: SHADOW_CATALOG_VERSION,
    sceneId,
    outcome: {
      kind: "semantically_equivalent",
    },
    legacy,
    shadow,
  });
}

function isContractViolationError(error: unknown): boolean {
  return error instanceof ServingContractError || error instanceof z.ZodError;
}

export function compareMilkServingShadow(
  input: ShadowComparisonInput,
): ShadowComparisonResult {
  const rawSceneId = typeof input?.sceneId === "string" ? input.sceneId.trim() : "shadow-scene";
  const safeSceneId = rawSceneId.length > 0 && rawSceneId.length <= 200 ? rawSceneId : "invalid-scene";

  // Stage 1a: Validate raw FoodAnalysis input and caller option contracts
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input.sceneId !== undefined &&
      (typeof input.sceneId !== "string" ||
        input.sceneId.trim().length === 0 ||
        input.sceneId.length > 200))
  ) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId: safeSceneId,
      outcome: {
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      },
      legacy: null,
      shadow: null,
    });
  }

  const parsedAnalysis = foodAnalysisSchema.safeParse(input.analysis);
  if (!parsedAnalysis.success || parsedAnalysis.data.foods.length > MAX_OBSERVED_ROWS) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId: safeSceneId,
      outcome: {
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      },
      legacy: null,
      shadow: null,
    });
  }

  let validatedDecisions: readonly UserServingDecision[] | undefined;
  try {
    validatedDecisions = callerAuthorizedDecisions({ decisions: input.decisions });
    validateUserMilkTypeChoices(input.legacyUserMilkTypeChoices);
  } catch {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId: safeSceneId,
      outcome: {
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      },
      legacy: null,
      shadow: null,
    });
  }

  const analysis = cloneFoodAnalysis(parsedAnalysis.data);

  // Stage 1b: Project legacy side
  let legacyProjection: ShadowSideProjection;
  try {
    legacyProjection = projectLegacyMilkShadow(analysis, {
      sceneId: safeSceneId,
      userMilkTypeChoices: input.legacyUserMilkTypeChoices,
    });
  } catch (error) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId: safeSceneId,
      outcome: {
        kind: "investigation_required",
        reason: isContractViolationError(error) ? "invalid_contract" : "execution_failure",
        failureStage: "projection",
        differences: [],
        uncomparableReasons: [],
      },
      legacy: null,
      shadow: null,
    });
  }

  // Stage 1c: Run or validate new milk-serving reconciliation
  let reconciliation: ServingReconciliation;
  if (input.reconciliation !== undefined) {
    try {
      reconciliation = validateServingReconciliation(input.reconciliation);
      if (reconciliation.sceneId !== safeSceneId) {
        throw new ServingContractError("reconciliation sceneId mismatch");
      }
      confirmedPortionPlan(reconciliation);
      verifyAuthenticReconciliation(reconciliation, analysis, {
        sceneId: safeSceneId,
        decisions: validatedDecisions,
      });
    } catch (error) {
      return validateShadowComparisonResult({
        comparatorVersion: SHADOW_COMPARATOR_VERSION,
        contractVersion: SERVING_CONTRACT_VERSION,
        engineVersion: SERVING_ENGINE_VERSION,
        grammarVersion: SERVING_GRAMMAR_VERSION,
        catalogVersion: SHADOW_CATALOG_VERSION,
        sceneId: safeSceneId,
        outcome: {
          kind: "investigation_required",
          reason: isContractViolationError(error) ? "invalid_contract" : "execution_failure",
          failureStage: "output",
          differences: [],
          uncomparableReasons: [],
        },
        legacy: legacyProjection,
        shadow: null,
      });
    }
  } else {
    try {
      reconciliation = reconcileMilkServingScene({
        sceneId: safeSceneId,
        analysis: cloneFoodAnalysis(analysis),
        decisions: validatedDecisions ? [...validatedDecisions] : undefined,
      });
    } catch (error) {
      return validateShadowComparisonResult({
        comparatorVersion: SHADOW_COMPARATOR_VERSION,
        contractVersion: SERVING_CONTRACT_VERSION,
        engineVersion: SERVING_ENGINE_VERSION,
        grammarVersion: SERVING_GRAMMAR_VERSION,
        catalogVersion: SHADOW_CATALOG_VERSION,
        sceneId: safeSceneId,
        outcome: {
          kind: "investigation_required",
          reason: isContractViolationError(error) ? "invalid_contract" : "execution_failure",
          failureStage: "engine",
          differences: [],
          uncomparableReasons: [],
        },
        legacy: legacyProjection,
        shadow: null,
      });
    }
  }

  // Stage 1d: Project reconciled shadow side (includes strict validation + confirmedPortionPlan + authenticity check)
  let shadowProjection: ShadowSideProjection;
  try {
    shadowProjection = projectReconciledMilkShadow(reconciliation, analysis, {
      sceneId: safeSceneId,
      decisions: validatedDecisions,
    });
  } catch (error) {
    return validateShadowComparisonResult({
      comparatorVersion: SHADOW_COMPARATOR_VERSION,
      contractVersion: SERVING_CONTRACT_VERSION,
      engineVersion: SERVING_ENGINE_VERSION,
      grammarVersion: SERVING_GRAMMAR_VERSION,
      catalogVersion: SHADOW_CATALOG_VERSION,
      sceneId: safeSceneId,
      outcome: {
        kind: "investigation_required",
        reason: isContractViolationError(error) ? "invalid_contract" : "execution_failure",
        failureStage: input.reconciliation !== undefined ? "output" : "projection",
        differences: [],
        uncomparableReasons: [],
      },
      legacy: legacyProjection,
      shadow: null,
    });
  }

  // Stage 2: Semantic comparison
  return compareShadowProjections(legacyProjection, shadowProjection, {
    sceneId: safeSceneId,
  });
}
