import { z } from "zod";
import { foodAnalysisSchema, type FoodAnalysis } from "@/lib/domain/food-analysis";
import {
  MAX_OBSERVED_ROWS,
  SERVING_CONTRACT_VERSION,
  SERVING_ENGINE_VERSION,
  SERVING_GRAMMAR_VERSION,
  ServingContractError,
} from "@/lib/domain/milk-serving-contract";
import {
  compareMilkServingShadow,
  PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
  publicShadowComparisonDiagnosticSchema,
  SHADOW_CATALOG_VERSION,
  SHADOW_COMPARATOR_VERSION,
  toPublicShadowComparisonDiagnostic,
  type PublicShadowComparisonDiagnostic,
  type ShadowComparisonInput,
  type ShadowComparisonResult,
  type ShadowFailureStage,
} from "@/lib/domain/milk-serving-shadow-comparator";

/**
 * Runtime Shadow Adapter for the Physical Serving Decision Engine (PR #128, Gate C).
 *
 * Executes the Phase 2B1 Shadow Comparator against the raw provider FoodAnalysis
 * inside `/api/analyze` only when explicitly enabled in a controlled QA environment.
 *
 * Non-authority & isolation guarantees:
 * - Default disabled; only exact `KCALCUE_QA_SERVING_SHADOW="1"` enables execution.
 * - Requires live analysis mode and a verified authenticated principal.
 * - Operates on a detached deep-frozen clone of the raw provider FoodAnalysis
 *   (prior to `preparePhotoMilkAnalysis`) so deduplication is never applied twice
 *   and caller inputs are never mutated or frozen.
 * - Never alters `/api/analyze` responses, nutrition authority, quotas, or storage.
 * - Catches all internal errors and emits only schema-validated, redacted
 *   `PublicShadowComparisonDiagnostic` records.
 */

export const QA_SERVING_SHADOW_ENV = "KCALCUE_QA_SERVING_SHADOW" as const;
export const QA_SHADOW_ALLOWED_EMAILS_ENV = "KCALCUE_QA_SHADOW_ALLOWED_EMAILS" as const;
export const RUNTIME_SHADOW_SCENE_ID = "runtime-shadow-scene" as const;
export const MAX_RUNTIME_SHADOW_ENCODED_BYTES = 256 * 1024;
export const RUNTIME_SHADOW_LOG_TAG = "[kcalcue:milk-serving-shadow]" as const;

export interface RuntimeShadowEligibilityContext {
  mode?: string;
  userId?: unknown;
  userEmail?: unknown;
}

export type RuntimeShadowEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: "disabled" | "ineligible" };

export interface RuntimeShadowAdapterInput extends RuntimeShadowEligibilityContext {
  /**
   * Raw provider `FoodAnalysis` captured BEFORE `preparePhotoMilkAnalysis()`.
   */
  rawAnalysis: unknown;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional diagnostic callback invoked with the validated redacted diagnostic.
   */
  onDiagnostic?: (diagnostic: PublicShadowComparisonDiagnostic) => void;
  /**
   * Optional comparator seam for fault-injection testing.
   */
  comparator?: (input: ShadowComparisonInput) => ShadowComparisonResult;
}

export type RuntimeShadowExecutionResult =
  | {
    executed: false;
    skippedReason: "disabled" | "ineligible";
    diagnostic: null;
    durationMs: 0;
  }
  | {
    executed: true;
    skippedReason: null;
    diagnostic: PublicShadowComparisonDiagnostic;
    durationMs: number;
  };

export interface RuntimeShadowMemoryCounters {
  eligible: number;
  attempted: number;
  validated: number;
  comparable: number;
  equivalent: number;
  uncomparable: number;
  investigation: number;
  invalidContract: number;
  executionFailure: number;
}

const initialCounters: RuntimeShadowMemoryCounters = {
  eligible: 0,
  attempted: 0,
  validated: 0,
  comparable: 0,
  equivalent: 0,
  uncomparable: 0,
  investigation: 0,
  invalidContract: 0,
  executionFailure: 0,
};

let memoryCounters: RuntimeShadowMemoryCounters = { ...initialCounters };

export function getRuntimeShadowMemoryCounters(): RuntimeShadowMemoryCounters {
  return { ...memoryCounters };
}

export function resetRuntimeShadowMemoryCounters(): void {
  memoryCounters = { ...initialCounters };
}

/**
 * Exact `"1"` is required to enable runtime shadow comparison.
 * Any other value (`undefined`, `""`, `"0"`, `"true"`, `"yes"`, `"qa_shadow"`, whitespace)
 * leaves runtime shadow disabled.
 */
export function qaServingShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[QA_SERVING_SHADOW_ENV] === "1";
}

function parseAllowedQaEmails(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env[QA_SHADOW_ALLOWED_EMAILS_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const emails = raw
    .split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
  return emails.length > 0 ? emails : null;
}

export function isQaShadowPrincipalEligible(
  context: { userId?: unknown; userEmail?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof context.userId !== "string" || context.userId.trim().length === 0) {
    return false;
  }
  const qaAllowedEmails = parseAllowedQaEmails(env);
  if (qaAllowedEmails !== null) {
    if (typeof context.userEmail !== "string" || context.userEmail.trim().length === 0) {
      return false;
    }
    if (!qaAllowedEmails.includes(context.userEmail.trim().toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function evaluateRuntimeShadowEligibility(
  context: RuntimeShadowEligibilityContext,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeShadowEligibilityResult {
  if (!qaServingShadowEnabled(env)) {
    return { eligible: false, reason: "disabled" };
  }
  if (context.mode !== "live") {
    return { eligible: false, reason: "ineligible" };
  }
  if (!isQaShadowPrincipalEligible(context, env)) {
    return { eligible: false, reason: "ineligible" };
  }
  return { eligible: true };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return value;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function createDetachedFrozenAnalysis(analysis: FoodAnalysis): FoodAnalysis {
  const cloned: FoodAnalysis = {
    analysisStatus: analysis.analysisStatus,
    foods: analysis.foods.map(food => ({
      ...food,
      uncertaintyReasons: [...food.uncertaintyReasons],
      ...(food.visibleIngredients ? { visibleIngredients: [...food.visibleIngredients] } : {}),
    })),
    uncertaintyReasons: [...analysis.uncertaintyReasons],
    visibleEvidence: [...analysis.visibleEvidence],
    estimatedInformation: [...analysis.estimatedInformation],
    unknownInformation: [...analysis.unknownInformation],
  };
  return deepFreeze(cloned);
}

function hasPostDeduplicationMarkers(rawAnalysis: unknown): boolean {
  if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
    return false;
  }
  const foods = (rawAnalysis as { foods?: unknown }).foods;
  if (!Array.isArray(foods)) {
    return false;
  }
  return foods.some(
    food =>
      food !== null &&
      typeof food === "object" &&
      !Array.isArray(food) &&
      ((food as Record<string, unknown>).duplicateMilkNotice !== undefined ||
        (food as Record<string, unknown>).suspectedDuplicateMilk !== undefined),
  );
}

function buildFallbackFailureDiagnostic(
  outcomeReason: "invalid_contract" | "execution_failure",
  failureStage: ShadowFailureStage,
): PublicShadowComparisonDiagnostic {
  return publicShadowComparisonDiagnosticSchema.parse({
    diagnosticVersion: PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
    comparatorVersion: SHADOW_COMPARATOR_VERSION,
    contractVersion: SERVING_CONTRACT_VERSION,
    engineVersion: SERVING_ENGINE_VERSION,
    grammarVersion: SERVING_GRAMMAR_VERSION,
    catalogVersion: SHADOW_CATALOG_VERSION,
    outcomeKind: "investigation_required",
    outcomeReason,
    failureStage,
    differences: [],
    uncomparableReasons: [],
    counters: null,
  });
}

function recordDiagnosticCounters(diagnostic: PublicShadowComparisonDiagnostic): void {
  if (
    diagnostic.outcomeKind === "investigation_required" &&
    (diagnostic.outcomeReason === "invalid_contract" ||
      diagnostic.outcomeReason === "execution_failure")
  ) {
    memoryCounters.investigation += 1;
    if (diagnostic.outcomeReason === "invalid_contract") {
      memoryCounters.invalidContract += 1;
    } else {
      memoryCounters.executionFailure += 1;
    }
    return;
  }

  memoryCounters.validated += 1;
  if (diagnostic.outcomeKind === "semantically_equivalent") {
    memoryCounters.comparable += 1;
    memoryCounters.equivalent += 1;
    return;
  }
  if (diagnostic.outcomeKind === "uncomparable_without_user_decision") {
    memoryCounters.uncomparable += 1;
    return;
  }
  if (diagnostic.uncomparableReasons.length === 0) {
    memoryCounters.comparable += 1;
  }
  memoryCounters.investigation += 1;
}

/**
 * Validates and logs only the allowlisted `PublicShadowComparisonDiagnostic`.
 * Never logs raw food text, notes, evidence claims, user IDs, emails, tokens, or photos.
 */
export function logMilkServingShadowDiagnostic(
  diagnostic: PublicShadowComparisonDiagnostic,
): void {
  const validated = publicShadowComparisonDiagnosticSchema.parse(diagnostic);
  console.error(RUNTIME_SHADOW_LOG_TAG, validated);
}

export function runMilkServingRuntimeShadow(
  input: RuntimeShadowAdapterInput,
): RuntimeShadowExecutionResult {
  const env = input?.env ?? process.env;
  const eligibility = evaluateRuntimeShadowEligibility(
    {
      mode: input?.mode,
      userId: input?.userId,
      userEmail: input?.userEmail,
    },
    env,
  );

  if (!eligibility.eligible) {
    return {
      executed: false,
      skippedReason: eligibility.reason,
      diagnostic: null,
      durationMs: 0,
    };
  }

  const startedAt = performance.now();
  memoryCounters.eligible += 1;
  memoryCounters.attempted += 1;

  let diagnostic: PublicShadowComparisonDiagnostic;

  try {
    const rawAnalysis = input.rawAnalysis;
    if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
      diagnostic = buildFallbackFailureDiagnostic("invalid_contract", "input");
    } else {
      const encodedBytes = Buffer.byteLength(JSON.stringify(rawAnalysis), "utf8");
      const rawFoods = (rawAnalysis as { foods?: unknown }).foods;
      const exceedsFoodCap = Array.isArray(rawFoods) && rawFoods.length > MAX_OBSERVED_ROWS;

      if (
        encodedBytes > MAX_RUNTIME_SHADOW_ENCODED_BYTES ||
        exceedsFoodCap ||
        hasPostDeduplicationMarkers(rawAnalysis)
      ) {
        diagnostic = buildFallbackFailureDiagnostic("invalid_contract", "input");
      } else {
        const parsed = foodAnalysisSchema.safeParse(rawAnalysis);
        if (!parsed.success || parsed.data.foods.length > MAX_OBSERVED_ROWS) {
          diagnostic = buildFallbackFailureDiagnostic("invalid_contract", "input");
        } else {
          const detachedAnalysis = createDetachedFrozenAnalysis(parsed.data);
          const compare = input.comparator ?? compareMilkServingShadow;
          const comparisonResult = compare({
            sceneId: RUNTIME_SHADOW_SCENE_ID,
            analysis: detachedAnalysis,
          });
          diagnostic = toPublicShadowComparisonDiagnostic(comparisonResult);
        }
      }
    }
  } catch (error) {
    const isContractError =
      error instanceof ServingContractError || error instanceof z.ZodError;
    diagnostic = buildFallbackFailureDiagnostic(
      isContractError ? "invalid_contract" : "execution_failure",
      "engine",
    );
  }

  try {
    recordDiagnosticCounters(diagnostic);
    logMilkServingShadowDiagnostic(diagnostic);
    input.onDiagnostic?.(diagnostic);
  } catch {
    // Diagnostic sink failures are swallowed so they can never affect `/api/analyze`.
  }

  const durationMs = Math.max(0, performance.now() - startedAt);
  return {
    executed: true,
    skippedReason: null,
    diagnostic,
    durationMs,
  };
}
