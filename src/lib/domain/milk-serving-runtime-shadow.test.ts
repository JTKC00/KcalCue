import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foodAnalysisSchema, type FoodAnalysis } from "@/lib/domain/food-analysis";
import { MERGED_DUPLICATE_MILK_NOTICE } from "@/lib/domain/milk-dedupe";
import { preparePhotoMilkAnalysis } from "@/lib/domain/photo-milk-analysis";
import {
  SERVING_CONTRACT_VERSION,
  SERVING_ENGINE_VERSION,
  SERVING_GRAMMAR_VERSION,
  ServingContractError,
} from "@/lib/domain/milk-serving-contract";
import {
  PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
  publicShadowComparisonDiagnosticSchema,
  SHADOW_CATALOG_VERSION,
  SHADOW_COMPARATOR_VERSION,
  type PublicShadowComparisonDiagnostic,
} from "@/lib/domain/milk-serving-shadow-comparator";
import {
  evaluateRuntimeShadowEligibility,
  getRuntimeShadowMemoryCounters,
  MAX_RUNTIME_SHADOW_ENCODED_BYTES,
  QA_SERVING_SHADOW_ENV,
  QA_SHADOW_ALLOWED_EMAILS_ENV,
  qaServingShadowEnabled,
  resetRuntimeShadowMemoryCounters,
  RUNTIME_SHADOW_LOG_TAG,
  RUNTIME_SHADOW_SCENE_ID,
  runMilkServingRuntimeShadow,
} from "@/lib/domain/milk-serving-runtime-shadow";
import {
  analysis,
  milkRow,
  oatRow,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";
import {
  c3Run1SingleOatCartonAnalysis,
  m6CartonAndGlassAnalysis,
} from "@/lib/nutrition/m7-milk-dedupe.fixture";

function extractLoggedDiagnostics(
  spy: { mock: { calls: unknown[][] } },
): PublicShadowComparisonDiagnostic[] {
  return spy.mock.calls
    .filter((call: unknown[]) => call[0] === RUNTIME_SHADOW_LOG_TAG)
    .map((call: unknown[]) => call[1] as PublicShadowComparisonDiagnostic);
}

describe("milk-serving-runtime-shadow adapter (Gate C)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRuntimeShadowMemoryCounters();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetRuntimeShadowMemoryCounters();
  });

  describe("QA activation flag & principal eligibility", () => {
    it.each([
      undefined,
      "",
      "0",
      "false",
      "true",
      "yes",
      "on",
      "qa_shadow",
      "1 ",
      " 1",
      "2",
    ])("remains disabled when KCALCUE_QA_SERVING_SHADOW is %j", value => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
      if (value !== undefined) {
        env[QA_SERVING_SHADOW_ENV] = value;
      }

      expect(qaServingShadowEnabled(env)).toBe(false);
      expect(
        evaluateRuntimeShadowEligibility(
          { mode: "live", userId: "qa-user-1", userEmail: "qa@example.com" },
          env,
        ),
      ).toEqual({ eligible: false, reason: "disabled" });

      const result = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "qa-user-1",
        userEmail: "qa@example.com",
        env,
      });

      expect(result).toEqual({
        executed: false,
        skippedReason: "disabled",
        diagnostic: null,
        durationMs: 0,
      });
      expect(extractLoggedDiagnostics(consoleErrorSpy)).toHaveLength(0);
      expect(getRuntimeShadowMemoryCounters().attempted).toBe(0);
    });

    it("enables only when KCALCUE_QA_SERVING_SHADOW is exact '1', mode is 'live', and principal is authenticated", () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        [QA_SERVING_SHADOW_ENV]: "1",
      };

      expect(qaServingShadowEnabled(env)).toBe(true);
      expect(
        evaluateRuntimeShadowEligibility({ mode: "live", userId: "qa-user-1" }, env),
      ).toEqual({ eligible: true });

      expect(
        evaluateRuntimeShadowEligibility({ mode: "demo", userId: "qa-user-1" }, env),
      ).toEqual({ eligible: false, reason: "ineligible" });

      expect(
        evaluateRuntimeShadowEligibility({ mode: "live", userId: "" }, env),
      ).toEqual({ eligible: false, reason: "ineligible" });

      expect(
        evaluateRuntimeShadowEligibility({ mode: "live", userId: undefined }, env),
      ).toEqual({ eligible: false, reason: "ineligible" });
    });

    it("rejects non-QA authenticated users when KCALCUE_QA_SHADOW_ALLOWED_EMAILS is configured", () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        [QA_SERVING_SHADOW_ENV]: "1",
        [QA_SHADOW_ALLOWED_EMAILS_ENV]: "qa-lead@example.com, QA-Engineer@example.com",
      };

      const nonQaUser = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "trial-user-1",
        userEmail: "ordinary-trial@example.com",
        env,
      });
      expect(nonQaUser).toEqual({
        executed: false,
        skippedReason: "ineligible",
        diagnostic: null,
        durationMs: 0,
      });

      const missingEmailUser = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "trial-user-2",
        env,
      });
      expect(missingEmailUser).toEqual({
        executed: false,
        skippedReason: "ineligible",
        diagnostic: null,
        durationMs: 0,
      });

      const authorizedQaUser = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "qa-user-1",
        userEmail: "qa-engineer@example.com",
        env,
      });
      expect(authorizedQaUser.executed).toBe(true);
      expect(authorizedQaUser.diagnostic).not.toBeNull();
    });
  });

  describe("runtime behaviour scenarios", () => {
    const enabledEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      [QA_SERVING_SHADOW_ENV]: "1",
    };

    it("1. one oat-milk carton listed as two rows (C3-run1 unknown portion & explicit 250 ml oat/whole duplicate rows)", () => {
      // 1a: QA #126 C3-run1 (one oat carton returned as two rows, portion null)
      const c3Result = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(c3Result.executed).toBe(true);
      expect(c3Result.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(c3Result.diagnostic?.outcomeReason).toBe("unknown_portion");
      expect(c3Result.diagnostic?.counters).toEqual({
        observedMilkRows: 2,
        legacyConfirmedUnits: 0,
        shadowConfirmedUnits: 0,
        legacyPendingSlots: 1,
        shadowPendingSlots: 1,
        legacyUnresolvedGroups: null,
        shadowUnresolvedGroups: 1,
      });

      // 1b: Two 250 ml oat-milk rows (SH01 review thread 1 before user milk-type confirmation)
      const twoOatCartonRows = analysis([
        oatRow("一個燕麥奶紙盒（正面見藍色蓋）", 250),
        oatRow("燕麥奶紙盒（側面見營養標籤）", 250),
      ]);
      const oatResult = runMilkServingRuntimeShadow({
        rawAnalysis: twoOatCartonRows,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(oatResult.executed).toBe(true);
      expect(oatResult.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(oatResult.diagnostic?.outcomeReason).toBe("unknown_profile");
      expect(oatResult.diagnostic?.uncomparableReasons).toEqual(["pending_state", "unknown_profile"]);

      // 1c: Two 250 ml whole-milk rows of the same carton (SH01 before dismiss_group)
      const twoWholeCartonRows = analysis([
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);
      const wholeResult = runMilkServingRuntimeShadow({
        rawAnalysis: twoWholeCartonRows,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(wholeResult.executed).toBe(true);
      expect(wholeResult.diagnostic?.outcomeKind).not.toBe("semantically_equivalent");
      expect(wholeResult.diagnostic?.counters?.observedMilkRows).toBe(2);
      expect(wholeResult.diagnostic?.counters?.legacyConfirmedUnits).toBe(1);
      expect(wholeResult.diagnostic?.counters?.shadowConfirmedUnits).toBe(1);
      expect(wholeResult.diagnostic?.counters?.shadowUnresolvedGroups).toBe(1);
    });

    it("2. one carton plus a separate glass (oat carton + generic glass M6, and whole carton + whole glass)", () => {
      // 2a: M6 fixture (one oat-milk carton plus a separate glass of generic milk)
      const m6Result = runMilkServingRuntimeShadow({
        rawAnalysis: m6CartonAndGlassAnalysis,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(m6Result.executed).toBe(true);
      expect(m6Result.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(m6Result.diagnostic?.uncomparableReasons).toContain("unknown_profile");
      expect(m6Result.diagnostic?.counters?.observedMilkRows).toBe(2);

      // 2b: Clean carton + separate glass with resolved whole-milk profile -> semantically_equivalent
      const cleanCartonAndGlass = analysis([
        wholeRow("左邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("右邊獨立玻璃杯裝全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
      ]);
      const eqResult = runMilkServingRuntimeShadow({
        rawAnalysis: cleanCartonAndGlass,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(eqResult.executed).toBe(true);
      expect(eqResult.diagnostic?.outcomeKind).toBe("semantically_equivalent");
      expect(eqResult.diagnostic?.outcomeReason).toBe("equivalent");
      expect(eqResult.diagnostic?.counters).toEqual({
        observedMilkRows: 2,
        legacyConfirmedUnits: 2,
        shadowConfirmedUnits: 2,
        legacyPendingSlots: 0,
        shadowPendingSlots: 0,
        legacyUnresolvedGroups: 0,
        shadowUnresolvedGroups: 0,
      });
    });

    it("3. two genuinely independent cartons (oat-milk cartons & whole-milk cartons)", () => {
      // 3a: Two independent oat-milk cartons (pending plant-milk type confirmation at raw analysis stage)
      const twoOatCartons = analysis(
        [
          oatRow("左邊燕麥奶紙盒", 250, { preparationMethod: "紙盒" }),
          oatRow("右邊燕麥奶紙盒", 250, { preparationMethod: "紙盒" }),
        ],
        ["兩盒燕麥奶"],
      );
      const oatResult = runMilkServingRuntimeShadow({
        rawAnalysis: twoOatCartons,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(oatResult.executed).toBe(true);
      expect(oatResult.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(oatResult.diagnostic?.outcomeReason).toBe("unknown_profile");
      expect(oatResult.diagnostic?.counters?.observedMilkRows).toBe(2);
      expect(oatResult.diagnostic?.counters?.legacyPendingSlots).toBe(2);
      expect(oatResult.diagnostic?.counters?.shadowPendingSlots).toBe(2);

      // 3b: Two independent whole-milk cartons with Left/Right anchors -> semantically_equivalent
      const twoWholeCartons = analysis([
        wholeRow("左邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("右邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);
      const wholeResult = runMilkServingRuntimeShadow({
        rawAnalysis: twoWholeCartons,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(wholeResult.executed).toBe(true);
      expect(wholeResult.diagnostic?.outcomeKind).toBe("semantically_equivalent");
      expect(wholeResult.diagnostic?.counters).toEqual({
        observedMilkRows: 2,
        legacyConfirmedUnits: 2,
        shadowConfirmedUnits: 2,
        legacyPendingSlots: 0,
        shadowPendingSlots: 0,
        legacyUnresolvedGroups: 0,
        shadowUnresolvedGroups: 0,
      });
    });

    it("4. one real item listed as three rows by AI", () => {
      // 4a: Three rows with explicit same-serving cue ("同一盒全脂牛奶紙盒")
      const sameCartonThreeTimes = analysis([
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);

      const sameResult = runMilkServingRuntimeShadow({
        rawAnalysis: sameCartonThreeTimes,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });

      expect(sameResult.executed).toBe(true);
      expect(sameResult.diagnostic?.outcomeKind).not.toBe("semantically_equivalent");
      expect(sameResult.diagnostic?.counters?.observedMilkRows).toBe(3);
      expect(sameResult.diagnostic?.counters?.legacyConfirmedUnits).toBe(1);
      expect(sameResult.diagnostic?.counters?.shadowConfirmedUnits).toBe(1);
      expect(sameResult.diagnostic?.counters?.shadowUnresolvedGroups).toBe(1);

      // 4b: Three rows where one row carries package-capacity wording ("包裝全脂牛奶 250ml")
      const ambiguousThreeRows = analysis(
        [
          wholeRow("一盒全脂牛奶 250ml", 250, { preparationMethod: "紙盒" }),
          wholeRow("紙盒全脂牛奶 250ml", 250, { preparationMethod: "紙盒" }),
          wholeRow("包裝全脂牛奶 250ml", 250, { preparationMethod: "紙盒" }),
        ],
        ["相片只見一盒全脂牛奶 250ml"],
      );

      const ambiguousResult = runMilkServingRuntimeShadow({
        rawAnalysis: ambiguousThreeRows,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });

      expect(ambiguousResult.executed).toBe(true);
      expect(ambiguousResult.diagnostic?.outcomeKind).not.toBe("semantically_equivalent");
      expect(ambiguousResult.diagnostic?.counters?.observedMilkRows).toBe(3);
      expect(ambiguousResult.diagnostic?.counters?.legacyConfirmedUnits).toBe(1);
      expect(ambiguousResult.diagnostic?.counters?.shadowConfirmedUnits).toBe(0);
    });

    it("5. different milk families (whole + soy + oat P1-A, plus unsupported low-fat)", () => {
      const p1aScene = analysis([
        milkRow("左邊玻璃杯裝豆漿", 250, { preparationMethod: "玻璃杯" }),
        wholeRow("右邊玻璃杯裝全脂牛奶", 400),
        oatRow("燕麥奶紙盒", 250),
      ]);

      const p1aResult = runMilkServingRuntimeShadow({
        rawAnalysis: p1aScene,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(p1aResult.executed).toBe(true);
      expect(p1aResult.diagnostic?.outcomeKind).toBe("investigation_required");
      expect(p1aResult.diagnostic?.outcomeReason).toBe("semantic_difference");
      expect(p1aResult.diagnostic?.counters?.observedMilkRows).toBe(3);
      expect(p1aResult.diagnostic?.counters?.shadowConfirmedUnits).toBe(1);
      expect(p1aResult.diagnostic?.counters?.shadowPendingSlots).toBe(2);

      const unsupportedLowFat = analysis([
        milkRow("一盒低脂牛奶 250ml", 250, {
          displayName: "低脂牛奶",
          normalizedName: "low-fat milk",
          preparationMethod: "紙盒",
        }),
      ]);
      const unsupportedResult = runMilkServingRuntimeShadow({
        rawAnalysis: unsupportedLowFat,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(unsupportedResult.executed).toBe(true);
      expect(unsupportedResult.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(unsupportedResult.diagnostic?.outcomeReason).toBe("unsupported_reference");
    });

    it("6. evidence negation, questions, and uncertain descriptions", () => {
      const negatedAndQuestionedCount = analysis(
        [
          wholeRow("唔係兩盒全脂牛奶，只係一盒 250ml", 250, { preparationMethod: "紙盒" }),
          wholeRow("係咪兩盒全脂牛奶？未證實，can't see two cartons", 250, { preparationMethod: "紙盒" }),
        ],
        ["唔係兩盒全脂牛奶，只係一盒"],
        {
          uncertaintyReasons: ["係咪兩盒全脂牛奶？未證實"],
        },
      );

      const result = runMilkServingRuntimeShadow({
        rawAnalysis: negatedAndQuestionedCount,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });

      expect(result.executed).toBe(true);
      // Negation and questions must never authorize a second confirmed serving
      expect(result.diagnostic?.counters?.shadowConfirmedUnits).toBe(1);
      expect(result.diagnostic?.outcomeKind).not.toBe("semantically_equivalent");
    });

    it("7. unknown portion and unknown profile", () => {
      const unknownPortionScene = analysis([
        wholeRow("玻璃杯裝全脂牛奶", null),
      ]);
      const portionResult = runMilkServingRuntimeShadow({
        rawAnalysis: unknownPortionScene,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(portionResult.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(portionResult.diagnostic?.outcomeReason).toBe("unknown_portion");

      const unknownProfileScene = analysis([
        milkRow("玻璃杯裝牛奶", 250),
      ]);
      const profileResult = runMilkServingRuntimeShadow({
        rawAnalysis: unknownProfileScene,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(profileResult.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(profileResult.diagnostic?.outcomeReason).toBe("unknown_profile");
    });

    it("8. pending user decision and SH08 semantic difference (1L package vs 250ml consumed)", () => {
      // Pending user decision: single row with two conflicting personal portions in notes
      const conflictingPortionsSingleRow = analysis([
        wholeRow("飲了200ml，飲了400ml", null),
      ]);
      const pendingResult = runMilkServingRuntimeShadow({
        rawAnalysis: conflictingPortionsSingleRow,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(pendingResult.diagnostic?.outcomeKind).toBe("uncomparable_without_user_decision");
      expect(pendingResult.diagnostic?.outcomeReason).toBe("pending_state");
      expect(pendingResult.diagnostic?.uncomparableReasons).toContain("pending_state");

      // SH08 semantic difference: structured 1000ml vs consumed 250ml (1L package capacity)
      const sh08Scene = analysis([
        wholeRow("飲了250ml（包裝標示容量1L）", 1000, {
          preparationMethod: "紙盒",
        }),
      ]);
      const sh08Result = runMilkServingRuntimeShadow({
        rawAnalysis: sh08Scene,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(sh08Result.diagnostic?.outcomeKind).toBe("investigation_required");
      expect(sh08Result.diagnostic?.outcomeReason).toBe("semantic_difference");
      expect(sh08Result.diagnostic?.differences).toEqual(
        expect.arrayContaining([
          "portion_amount_mismatch",
          "kcal_mismatch",
          "protein_mismatch",
          "carbs_mismatch",
          "fat_mismatch",
        ]),
      );
    });

    it("9. isolates shadow engine throws, contract errors, and invalid/pre-deduped inputs", () => {
      // 9a: Comparator throws unexpected runtime error
      const thrownResult = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
        comparator: () => {
          throw new Error("SECRET_CANARY_ENGINE_CRASH_NOTE_999");
        },
      });
      expect(thrownResult.executed).toBe(true);
      expect(thrownResult.diagnostic).toEqual({
        diagnosticVersion: PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
        comparatorVersion: SHADOW_COMPARATOR_VERSION,
        contractVersion: SERVING_CONTRACT_VERSION,
        engineVersion: SERVING_ENGINE_VERSION,
        grammarVersion: SERVING_GRAMMAR_VERSION,
        catalogVersion: SHADOW_CATALOG_VERSION,
        outcomeKind: "investigation_required",
        outcomeReason: "execution_failure",
        failureStage: "engine",
        differences: [],
        uncomparableReasons: [],
        counters: null,
      });
      expect(JSON.stringify(thrownResult.diagnostic)).not.toContain("SECRET_CANARY_ENGINE_CRASH_NOTE_999");

      // 9b: Comparator throws ServingContractError
      const contractErrorResult = runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
        comparator: () => {
          throw new ServingContractError("forged slot ownership");
        },
      });
      expect(contractErrorResult.diagnostic?.outcomeKind).toBe("investigation_required");
      expect(contractErrorResult.diagnostic?.outcomeReason).toBe("invalid_contract");
      expect(contractErrorResult.diagnostic?.failureStage).toBe("engine");
      expect(contractErrorResult.diagnostic?.counters).toBeNull();

      // 9c: Invalid input (null / malformed / >12 foods / oversize bytes)
      for (const badInput of [
        null,
        "not-an-object",
        { analysisStatus: "success", foods: [] },
        {
          ...c3Run1SingleOatCartonAnalysis,
          foods: Array.from({ length: 13 }, () => c3Run1SingleOatCartonAnalysis.foods[0]),
        },
        {
          ...c3Run1SingleOatCartonAnalysis,
          oversizedPadding: "x".repeat(MAX_RUNTIME_SHADOW_ENCODED_BYTES + 1024),
        },
      ]) {
        const badResult = runMilkServingRuntimeShadow({
          rawAnalysis: badInput,
          mode: "live",
          userId: "qa-user",
          env: enabledEnv,
        });
        expect(badResult.executed).toBe(true);
        expect(badResult.diagnostic?.outcomeKind).toBe("investigation_required");
        expect(badResult.diagnostic?.outcomeReason).toBe("invalid_contract");
        expect(badResult.diagnostic?.failureStage).toBe("input");
        expect(badResult.diagnostic?.counters).toBeNull();
      }

      // 9d: Anti-double-deduplication guard: rejects FoodAnalysis that already went through preparePhotoMilkAnalysis
      const alreadyPrepared = preparePhotoMilkAnalysis(c3Run1SingleOatCartonAnalysis);
      expect(alreadyPrepared.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);

      const doubleDedupeAttempt = runMilkServingRuntimeShadow({
        rawAnalysis: alreadyPrepared,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });
      expect(doubleDedupeAttempt.executed).toBe(true);
      expect(doubleDedupeAttempt.diagnostic?.outcomeKind).toBe("investigation_required");
      expect(doubleDedupeAttempt.diagnostic?.outcomeReason).toBe("invalid_contract");
      expect(doubleDedupeAttempt.diagnostic?.failureStage).toBe("input");
      expect(doubleDedupeAttempt.diagnostic?.counters).toBeNull();
    });

    it("10. never mutates or freezes the caller's rawAnalysis object", () => {
      const callerRawAnalysis: FoodAnalysis = structuredClone(c3Run1SingleOatCartonAnalysis);
      const beforeSnapshot = structuredClone(callerRawAnalysis);

      const result = runMilkServingRuntimeShadow({
        rawAnalysis: callerRawAnalysis,
        mode: "live",
        userId: "qa-user",
        env: enabledEnv,
      });

      expect(result.executed).toBe(true);
      expect(callerRawAnalysis).toEqual(beforeSnapshot);
      expect(Object.isFrozen(callerRawAnalysis)).toBe(false);
      expect(Object.isFrozen(callerRawAnalysis.foods)).toBe(false);
      expect(Object.isFrozen(callerRawAnalysis.foods[0])).toBe(false);

      // Caller can still mutate or pass callerRawAnalysis to preparePhotoMilkAnalysis normally
      const prepared = preparePhotoMilkAnalysis(callerRawAnalysis);
      expect(foodAnalysisSchema.parse(prepared).foods).toHaveLength(1);
    });
  });

  describe("diagnostic privacy & redaction contract (Section 5)", () => {
    it("strips all canary strings (photo base64, food descriptions/notes, userId, email, token, fingerprint, evidence claims, journal content)", () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        [QA_SERVING_SHADOW_ENV]: "1",
        [QA_SHADOW_ALLOWED_EMAILS_ENV]: "canary-qa-user@secret-domain.example",
      };

      const canaries = {
        base64Photo: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        foodName: "CANARY_DISPLAY_NAME_OATLY_BARISTA",
        normalizedName: "canary oat milk private label",
        noteText: "CANARY_NOTE_PRIVATE_JOURNAL_ENTRY_DRANK_250ML_AT_HOME",
        prepText: "CANARY_PREP_CUSTOM_MUG",
        ingredientText: "CANARY_INGREDIENT_SECRET_RECIPE",
        uncertaintyText: "CANARY_UNCERTAINTY_PRIVATE_KITCHEN",
        evidenceText: "CANARY_EVIDENCE_CLAIM_BARCODE_987654321",
        estimatedText: "CANARY_ESTIMATED_INFO_TEXT",
        unknownText: "CANARY_UNKNOWN_INFO_TEXT",
        userId: "CANARY_UID_firebase_9988776655",
        userEmail: "canary-qa-user@secret-domain.example",
        bearerToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.CANARY_TOKEN_PAYLOAD",
        fingerprint: "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f",
      };

      const canaryAnalysis: FoodAnalysis = {
        analysisStatus: "success",
        foods: [
          {
            displayName: `${canaries.foodName} 燕麥奶`,
            normalizedName: "oat milk",
            identityLevel: "ingredient",
            portionMin: 250,
            portionMax: 250,
            unit: "ml",
            recognitionConfidence: 0.91,
            portionConfidence: 0.82,
            uncertaintyReasons: [canaries.uncertaintyText],
            preparationMethod: `${canaries.prepText} 紙盒`,
            visibleIngredients: [canaries.ingredientText],
            notes: `${canaries.noteText} 飲了250ml（包裝標示容量1L）`,
          },
        ],
        uncertaintyReasons: [canaries.uncertaintyText],
        visibleEvidence: [canaries.evidenceText, canaries.base64Photo, canaries.fingerprint],
        estimatedInformation: [canaries.estimatedText, canaries.bearerToken],
        unknownInformation: [canaries.unknownText],
      };

      const result = runMilkServingRuntimeShadow({
        rawAnalysis: canaryAnalysis,
        mode: "live",
        userId: canaries.userId,
        userEmail: canaries.userEmail,
        env,
      });

      expect(result.executed).toBe(true);
      expect(result.diagnostic).not.toBeNull();
      expect(() => publicShadowComparisonDiagnosticSchema.parse(result.diagnostic)).not.toThrow();

      const loggedDiagnostics = extractLoggedDiagnostics(consoleErrorSpy);
      expect(loggedDiagnostics).toHaveLength(1);

      const serializedDiagnostic = JSON.stringify(result.diagnostic);
      const serializedLogs = JSON.stringify(consoleErrorSpy.mock.calls);

      for (const secretValue of Object.values(canaries)) {
        expect(serializedDiagnostic).not.toContain(secretValue);
        expect(serializedLogs).not.toContain(secretValue);
      }

      for (const internalIdentifier of [
        RUNTIME_SHADOW_SCENE_ID,
        "sceneId",
        "rowId",
        "row-",
        "slotId",
        "slot-",
        "unitId",
        "unit-",
        "groupId",
        "group-",
        "claimId",
        "claim-",
        "sourceDigest",
        "semanticKey",
      ]) {
        expect(serializedDiagnostic).not.toContain(internalIdentifier);
        expect(serializedLogs).not.toContain(internalIdentifier);
      }
    });
  });

  describe("performance & bounded execution cost (Section 7)", () => {
    it("maintains bounded overhead when enabled and near-zero adapter overhead when disabled", () => {
      const iterations = 40;
      const disabledEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
      const enabledEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        [QA_SERVING_SHADOW_ENV]: "1",
      };

      // Warm up JIT before timing
      preparePhotoMilkAnalysis(c3Run1SingleOatCartonAnalysis);
      runMilkServingRuntimeShadow({
        rawAnalysis: c3Run1SingleOatCartonAnalysis,
        mode: "live",
        userId: "perf-user",
        env: enabledEnv,
      });

      const shadowOnlyDisabledStart = performance.now();
      for (let i = 0; i < iterations; i += 1) {
        const res = runMilkServingRuntimeShadow({
          rawAnalysis: c3Run1SingleOatCartonAnalysis,
          mode: "live",
          userId: "perf-user",
          env: disabledEnv,
        });
        expect(res.durationMs).toBe(0);
      }
      const avgShadowOnlyDisabledMs = (performance.now() - shadowOnlyDisabledStart) / iterations;

      const disabledStart = performance.now();
      for (let i = 0; i < iterations; i += 1) {
        preparePhotoMilkAnalysis(c3Run1SingleOatCartonAnalysis);
        runMilkServingRuntimeShadow({
          rawAnalysis: c3Run1SingleOatCartonAnalysis,
          mode: "live",
          userId: "perf-user",
          env: disabledEnv,
        });
      }
      const disabledTotalMs = performance.now() - disabledStart;

      const enabledStart = performance.now();
      for (let i = 0; i < iterations; i += 1) {
        preparePhotoMilkAnalysis(c3Run1SingleOatCartonAnalysis);
        runMilkServingRuntimeShadow({
          rawAnalysis: c3Run1SingleOatCartonAnalysis,
          mode: "live",
          userId: "perf-user",
          env: enabledEnv,
        });
      }
      const enabledTotalMs = performance.now() - enabledStart;

      const avgDisabledMs = disabledTotalMs / iterations;
      const avgEnabledMs = enabledTotalMs / iterations;

      expect(avgShadowOnlyDisabledMs).toBeLessThan(0.5);
      expect(avgDisabledMs).toBeLessThan(5);
      expect(avgEnabledMs).toBeLessThan(20);
    });
  });
});
