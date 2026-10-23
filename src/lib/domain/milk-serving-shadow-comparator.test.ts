import { describe, expect, it } from "vitest";
import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import {
  canonicalJson,
  confirmedPortionPlan,
  ServingContractError,
  type ServingReconciliation,
} from "@/lib/domain/milk-serving-contract";
import { interpretServingEvidence } from "@/lib/domain/milk-serving-evidence";
import {
  reconcileMilkServingScene,
  reconcileServingEvidence,
} from "@/lib/domain/milk-serving-reconciliation";
import {
  analysis,
  decisions,
  dispositionOf,
  milkRow,
  nonMilkRow,
  oatRow,
  permutations,
  REFERENCE_250ML,
  rowIdByNotes,
  sandwichRow,
  slotForRow,
  soyRow,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";
import {
  compareMilkServingShadow,
  compareShadowProjections,
  known,
  projectLegacyMilkShadow,
  projectReconciledMilkShadow,
  PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
  publicShadowComparisonDiagnosticSchema,
  resolveCatalogReferenceByServingProfile,
  SHADOW_CATALOG_VERSION,
  toPublicShadowComparisonDiagnostic,
  unknownValue,
  validateShadowComparisonResult,
  type ReconciledShadowProjectionOptions,
  type ShadowNutrients,
  type ShadowSideProjection,
  type VerifiedCatalogReference,
} from "@/lib/domain/milk-serving-shadow-comparator";

function riceRow(): ObservedFood {
  return nonMilkRow("白飯", "white rice", "一碗白飯");
}

function chickenRow(extra: Partial<ObservedFood> = {}): ObservedFood {
  return milkRow("一件烤雞扒", 150, {
    displayName: "烤雞扒",
    normalizedName: "grilled chicken breast",
    unit: "g",
    identityLevel: "dish",
    ...extra,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function projectWithoutTrustedAnalysis(
  reconciliation: ServingReconciliation,
  options?: ReconciledShadowProjectionOptions,
) {
  return projectReconciledMilkShadow(
    reconciliation,
    undefined as unknown as FoodAnalysis,
    options,
  );
}

function expectKnownNutrientsCloseTo(
  actual: ShadowSideProjection["fullMilkNutrition"],
  expected: { kcal: number; protein: number; carbs: number; fat: number },
  precision = 6
): void {
  expect(actual.state).toBe("known");
  if (actual.state !== "known") return;
  expect(actual.value.kcal.min).toBeCloseTo(expected.kcal, precision);
  expect(actual.value.kcal.max).toBeCloseTo(expected.kcal, precision);
  expect(actual.value.protein.min).toBeCloseTo(expected.protein, precision);
  expect(actual.value.protein.max).toBeCloseTo(expected.protein, precision);
  expect(actual.value.carbs.min).toBeCloseTo(expected.carbs, precision);
  expect(actual.value.carbs.max).toBeCloseTo(expected.carbs, precision);
  expect(actual.value.fat.min).toBeCloseTo(expected.fat, precision);
  expect(actual.value.fat.max).toBeCloseTo(expected.fat, precision);
}

describe("Phase 2B1 offline synthetic Shadow comparator", () => {
  describe("Scenario 1 — One carton detected twice (SH01)", () => {
    it("keeps Shadow possible_excess unresolved until dismiss_group, then recognizes one whole-milk carton detected twice as semantically_equivalent", () => {
      const scene = analysis([
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);

      // Before dismiss_group: Phase 1 keeps an open possible_excess group on Shadow (partial coverage),
      // while Legacy silently merges the two rows into 1 complete serving.
      const beforeDismiss = compareMilkServingShadow({
        sceneId: "sh01-identical-whole-carton",
        analysis: scene,
      });
      expect(beforeDismiss.shadow?.supportedPhysicalServingCount).toEqual(
        known(1)
      );
      expect(beforeDismiss.shadow?.confirmedUnitCount).toBe(1);
      expect(beforeDismiss.shadow?.unresolved).toBe(true);
      expect(beforeDismiss.shadow?.unresolvedGroupCount).toEqual(known(1));
      expect(beforeDismiss.shadow?.coverage).toEqual(known("partial"));
      expect(beforeDismiss.shadow?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
      expectKnownNutrientsCloseTo(
        beforeDismiss.shadow!.confirmedSubtotal,
        REFERENCE_250ML.whole!
      );

      // Once the user dismisses the open possible_excess group, both sides are semantically_equivalent.
      const baseReconciliation = reconcileMilkServingScene({
        sceneId: "sh01-identical-whole-carton",
        analysis: scene,
      });
      const dismissDecisions = decisions(baseReconciliation, [
        {
          kind: "dismiss_group",
          groupId: baseReconciliation.unresolved[0]!.groupId,
        },
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh01-identical-whole-carton",
        analysis: scene,
        decisions: dismissDecisions,
      });

      expect(result.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(result.legacy?.physicalServingCount).toEqual(known(1));
      expect(result.shadow?.physicalServingCount).toEqual(known(1));
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expect(result.legacy?.confirmedPhysicalServingCount).toEqual(known(1));
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(1));
      expect(result.legacy?.coverage).toEqual(known("complete"));
      expect(result.shadow?.coverage).toEqual(known("complete"));
      expectKnownNutrientsCloseTo(
        result.legacy!.fullMilkNutrition,
        REFERENCE_250ML.whole!
      );
      expectKnownNutrientsCloseTo(
        result.shadow!.fullMilkNutrition,
        REFERENCE_250ML.whole!
      );
      expect(result.legacy?.units[0]?.binding).toEqual(
        result.shadow?.units[0]?.binding
      );
      if (result.shadow?.units[0]?.binding.state === "known") {
        expect(result.shadow.units[0].binding.value.relation).toBe(
          "same_serving_merge"
        );
        expect(
          result.shadow.units[0].binding.value.observationRowIds
        ).toHaveLength(2);
      }
    });

    it("recognizes one whole-milk carton with divergent front/side notes as semantically_equivalent once excess candidate is dismissed", () => {
      const scene = analysis([
        wholeRow("正面見到桌上同一盒全脂牛奶紙盒", 250, {
          preparationMethod: "紙盒",
        }),
        wholeRow("側面拍到桌上同一盒全脂牛奶紙盒", 250, {
          preparationMethod: "紙盒",
        }),
      ]);

      const baseReconciliation = reconcileMilkServingScene({
        sceneId: "sh01-front-side-whole-carton",
        analysis: scene,
      });
      const dismissDecisions = decisions(baseReconciliation, [
        {
          kind: "dismiss_group",
          groupId: baseReconciliation.unresolved[0]!.groupId,
        },
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh01-front-side-whole-carton",
        analysis: scene,
        decisions: dismissDecisions,
      });

      expect(result.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expect(result.legacy?.units[0]?.binding).toEqual(
        result.shadow?.units[0]?.binding
      );
    });

    it("handles SH01 review thread 1 (oat-milk carton with divergent packaging notes) before and after user type confirmation", () => {
      const scene = analysis([
        oatRow("一個燕麥奶紙盒（正面見藍色蓋）", 250),
        oatRow("燕麥奶紙盒（側面見營養標籤）", 250),
      ]);

      // Without explicit user milk-type confirmation, both Legacy and Shadow hold plant milk pending.
      const beforeUserDecision = compareMilkServingShadow({
        sceneId: "sh01-oat-unconfirmed",
        analysis: scene,
      });
      expect(beforeUserDecision.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unknown_profile",
        uncomparableReasons: ["pending_state", "unknown_profile"],
      });

      // Once user confirms oat-milk and dismisses the duplicate-angle excess candidate, both project 1 confirmed 250ml oat-milk serving.
      const baseReconciliation = reconcileMilkServingScene({
        sceneId: "sh01-oat-confirmed",
        analysis: scene,
      });
      const legacyChoices = Object.fromEntries(
        baseReconciliation.rows.map((row) => [row.rowId, "oat" as const])
      );
      const shadowDecisions = decisions(baseReconciliation, [
        {
          kind: "set_type",
          targetId: baseReconciliation.supportedSlots[0]!.slotId,
          choice: "oat",
        },
        {
          kind: "dismiss_group",
          groupId: baseReconciliation.unresolved[0]!.groupId,
        },
      ]);

      const afterUserDecision = compareMilkServingShadow({
        sceneId: "sh01-oat-confirmed",
        analysis: scene,
        decisions: shadowDecisions,
        legacyUserMilkTypeChoices: legacyChoices,
      });

      expect(afterUserDecision.outcome).toEqual({
        kind: "semantically_equivalent",
      });
      expectKnownNutrientsCloseTo(
        afterUserDecision.shadow!.fullMilkNutrition,
        REFERENCE_250ML.oat!
      );
      expectKnownNutrientsCloseTo(
        afterUserDecision.legacy!.fullMilkNutrition,
        REFERENCE_250ML.oat!
      );
    });
  });

  describe("Scenario 2 — Two genuinely distinct cartons (SH02)", () => {
    it("flags investigation_required / semantic_difference when Legacy collapses two distinct cartons (左方 vs 右方) into 1 confirmed serving", () => {
      const scene = analysis([
        wholeRow("左方全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("右方全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh02-two-distinct-cartons-divergent",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "physical_serving_count_mismatch",
            "confirmed_unit_count_mismatch",
            "confirmed_physical_serving_count_mismatch",
            "provenance_binding_mismatch",
            "kcal_mismatch",
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
          ])
        );
      }
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(2);
      expectKnownNutrientsCloseTo(
        result.legacy!.confirmedSubtotal,
        REFERENCE_250ML.whole!
      );
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, {
        kcal: REFERENCE_250ML.whole!.kcal * 2,
        protein: REFERENCE_250ML.whole!.protein * 2,
        carbs: REFERENCE_250ML.whole!.carbs * 2,
        fat: REFERENCE_250ML.whole!.fat * 2,
      });
    });

    it("recognizes two distinct cartons (左邊 vs 右邊) as semantically_equivalent when both Legacy and Shadow confirm both cartons", () => {
      const scene = analysis([
        wholeRow("左邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("右邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh02-two-distinct-cartons-equivalent",
        analysis: scene,
      });

      expect(result.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(result.legacy?.confirmedUnitCount).toBe(2);
      expect(result.shadow?.confirmedUnitCount).toBe(2);
    });
  });

  describe("Scenario 3 — Carton plus a separate glass (SH02 / SH04 / SH11)", () => {
    it("recognizes carton + separate glass from notes as 2 physical servings on Shadow vs 1 confirmed + 1 suspected duplicate on Legacy", () => {
      // Vessel kinds ("紙盒" vs "玻璃杯") are reported in notes with preparationMethod undefined.
      // Legacy rowOwnContainerKinds() ignores notes and marks the second row as suspectedDuplicateMilk,
      // while Shadow extracts own_vessel from each row's notes and confirms 2 separate servings.
      const scene = analysis([
        wholeRow("全脂牛奶紙盒", 250, {
          preparationMethod: undefined,
        }),
        wholeRow("獨立玻璃杯裝全脂牛奶", 250, {
          preparationMethod: undefined,
        }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh02-carton-plus-glass-divergent",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "confirmed_unit_count_mismatch",
            "confirmed_physical_serving_count_mismatch",
            "kcal_mismatch",
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
          ])
        );
      }
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(2);
    });

    it("recognizes clean carton + separate glass as semantically_equivalent when both Legacy and Shadow confirm both servings", () => {
      const scene = analysis([
        wholeRow("左邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("右邊獨立玻璃杯裝全脂牛奶", 250, {
          preparationMethod: "玻璃杯",
        }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh02-carton-plus-glass-clean",
        analysis: scene,
      });

      expect(result.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(result.legacy?.confirmedUnitCount).toBe(2);
      expect(result.shadow?.confirmedUnitCount).toBe(2);
    });

    it("handles SH04 / P1-B unrelated container holding a spoon without fabricating a second milk serving", () => {
      const front = wholeRow("前方透明玻璃杯內可見全脂牛奶", 250, {
        preparationMethod: "玻璃杯",
      });
      const spoon = wholeRow("後方另一個白色容器，內有湯匙", 250, {
        preparationMethod: undefined,
      });
      const scene = analysis([front, spoon]);

      const reconciled = reconcileMilkServingScene({
        sceneId: "sh04-spoon-container",
        analysis: scene,
      });
      expect(
        dispositionOf(reconciled, rowIdByNotes(reconciled, spoon.notes!))
          .disposition
      ).toBe("conflict");
      expect(reconciled.summary.supportedServingCount).toBe(1);

      const result = compareMilkServingShadow({
        sceneId: "sh04-spoon-container",
        analysis: scene,
      });
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(1));
    });

    it("handles SH11 review thread 2 ('not the same glass' on a carton does not create a second carton serving)", () => {
      const scene = analysis([
        wholeRow("紙盒全脂牛奶 not the same glass", 250, {
          preparationMethod: "紙盒",
        }),
        wholeRow("紙盒全脂牛奶", 250, { preparationMethod: "紙盒" }),
        wholeRow("獨立全脂牛奶玻璃杯", 250, { preparationMethod: "玻璃杯" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh11-not-the-same-glass-carton",
        analysis: scene,
      });

      // Shadow keeps 2 physical servings (1 carton + 1 glass = 314.15 kcal).
      expect(result.shadow?.supportedPhysicalServingCount).toEqual(known(2));
      expect(result.shadow?.confirmedUnitCount).toBe(2);
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: REFERENCE_250ML.whole!.kcal * 2,
        protein: REFERENCE_250ML.whole!.protein * 2,
        carbs: REFERENCE_250ML.whole!.carbs * 2,
        fat: REFERENCE_250ML.whole!.fat * 2,
      });
    });
  });

  describe("Scenario 4 — Three physical servings (SH03 / P1-A)", () => {
    it("detects 3 distinct whole-milk servings (左方玻璃杯 + 右方玻璃杯 + 紙盒) when Legacy collapses the two glasses", () => {
      const scene = analysis([
        wholeRow("左方玻璃杯裝全脂牛奶", 200, { preparationMethod: "玻璃杯" }),
        wholeRow("右方玻璃杯裝全脂牛奶", 200, { preparationMethod: "玻璃杯" }),
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "three-distinct-whole-servings",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "confirmed_unit_count_mismatch",
            "confirmed_physical_serving_count_mismatch",
            "kcal_mismatch",
          ])
        );
      }
      expect(result.legacy?.confirmedUnitCount).toBe(2);
      expect(result.shadow?.confirmedUnitCount).toBe(3);
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(3));
    });

    it("handles SH03 explicit affirmative count ('三盒全脂牛奶') with 3 cartons", () => {
      const scene = analysis(
        [
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        ],
        ["三盒全脂牛奶"]
      );

      const result = compareMilkServingShadow({
        sceneId: "sh03-three-cartons",
        analysis: scene,
      });

      expect(result.shadow?.physicalServingCount).toEqual(known(3));
      expect(result.shadow?.confirmedUnitCount).toBe(3);
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(3));
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, {
        kcal: REFERENCE_250ML.whole!.kcal * 3,
        protein: REFERENCE_250ML.whole!.protein * 3,
        carbs: REFERENCE_250ML.whole!.carbs * 3,
        fat: REFERENCE_250ML.whole!.fat * 3,
      });
    });

    it("evaluates P1-A (generic soy glass + whole glass + oat carton) before and after user milk-type confirmation", () => {
      const leftSoy = milkRow("左邊玻璃杯裝豆漿", 250, {
        preparationMethod: "玻璃杯",
      });
      const rightWhole = wholeRow("右邊玻璃杯裝全脂牛奶", 400);
      const cartonOat = oatRow("燕麥奶紙盒", 250);
      const scene = analysis([leftSoy, rightWhole, cartonOat]);

      // Before user type confirmation: Shadow has 1 confirmed whole-milk slot (400ml) + 2 pending plant-milk slots
      // and 0 unresolved groups, while Legacy flags the left soy glass as suspectedDuplicateMilk (unresolvedGroupCount = 1).
      const beforeDecision = compareMilkServingShadow({
        sceneId: "p1a-before-decision",
        analysis: scene,
      });
      expect(beforeDecision.outcome).toEqual({
        kind: "investigation_required",
        reason: "semantic_difference",
        differences: ["unresolved_group_count_mismatch"],
        uncomparableReasons: [
          "pending_state",
          "unknown_binding",
          "unknown_profile",
        ],
      });
      expect(beforeDecision.shadow?.supportedPhysicalServingCount).toEqual(
        known(3)
      );
      expect(beforeDecision.shadow?.confirmedUnitCount).toBe(1);

      // After user confirms soy, whole, and oat: Shadow confirms all 3 servings (452.08 kcal),
      // whereas Legacy marked the left generic-named soy glass as a suspected duplicate of the right whole glass!
      const baseReconciliation = reconcileMilkServingScene({
        sceneId: "p1a-after-decision",
        analysis: scene,
      });
      const shadowDecisions = decisions(baseReconciliation, [
        {
          kind: "set_type",
          targetId: slotForRow(baseReconciliation, leftSoy.notes!),
          choice: "soy",
        },
        {
          kind: "set_type",
          targetId: slotForRow(baseReconciliation, rightWhole.notes!),
          choice: "whole",
        },
        {
          kind: "set_type",
          targetId: slotForRow(baseReconciliation, cartonOat.notes!),
          choice: "oat",
        },
      ]);
      const legacyChoices = {
        [rowIdByNotes(baseReconciliation, leftSoy.notes!)]: "soy" as const,
        [rowIdByNotes(baseReconciliation, rightWhole.notes!)]: "whole" as const,
        [rowIdByNotes(baseReconciliation, cartonOat.notes!)]: "oat" as const,
      };

      const afterDecision = compareMilkServingShadow({
        sceneId: "p1a-after-decision",
        analysis: scene,
        decisions: shadowDecisions,
        legacyUserMilkTypeChoices: legacyChoices,
      });

      expect(afterDecision.outcome.kind).toBe("investigation_required");
      if (afterDecision.outcome.kind === "investigation_required") {
        expect(afterDecision.outcome.reason).toBe("semantic_difference");
        expect(afterDecision.outcome.differences).toEqual(
          expect.arrayContaining([
            "confirmed_unit_count_mismatch",
            "confirmed_physical_serving_count_mismatch",
            "kcal_mismatch",
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
          ])
        );
      }
      expect(afterDecision.legacy?.confirmedUnitCount).toBe(2);
      expect(afterDecision.shadow?.confirmedUnitCount).toBe(3);
      expectKnownNutrientsCloseTo(afterDecision.shadow!.fullMilkNutrition, {
        kcal:
          REFERENCE_250ML.soy!.kcal +
          (REFERENCE_250ML.whole!.kcal * 400) / 250 +
          REFERENCE_250ML.oat!.kcal,
        protein:
          REFERENCE_250ML.soy!.protein +
          (REFERENCE_250ML.whole!.protein * 400) / 250 +
          REFERENCE_250ML.oat!.protein,
        carbs:
          REFERENCE_250ML.soy!.carbs +
          (REFERENCE_250ML.whole!.carbs * 400) / 250 +
          REFERENCE_250ML.oat!.carbs,
        fat:
          REFERENCE_250ML.soy!.fat +
          (REFERENCE_250ML.whole!.fat * 400) / 250 +
          REFERENCE_250ML.oat!.fat,
      });
    });
  });

  describe("Scenario 5 — Three cups with 600ml aggregate consumed (SH09)", () => {
    it("projects aggregate_consumed 600ml ONCE (never multiplied by multiplicity 3) and flags semantic difference against Legacy", () => {
      const scene = analysis([
        wholeRow("三杯合共飲用了600ml", 600, { preparationMethod: undefined }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh09-aggregate-600ml",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "portion_purpose_mismatch",
            "provenance_binding_mismatch",
          ])
        );
      }
      expect(result.shadow?.physicalServingCount).toEqual(known(3));
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(3));
      expect(result.shadow?.units[0]?.portion).toEqual(
        known({
          purpose: "aggregate_consumed",
          amount: { min: 600, max: 600 },
          unit: "ml",
          multiplicity: 3,
        })
      );
      if (result.shadow?.units[0]?.binding.state === "known") {
        expect(result.shadow.units[0].binding.value.relation).toBe(
          "aggregate_population"
        );
      }
      // 600ml whole milk = 2.4 * 157.075 = 376.98 kcal (NOT 3 * 376.98 = 1130.94 kcal)
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, {
        kcal: (REFERENCE_250ML.whole!.kcal * 600) / 250,
        protein: (REFERENCE_250ML.whole!.protein * 600) / 250,
        carbs: (REFERENCE_250ML.whole!.carbs * 600) / 250,
        fat: (REFERENCE_250ML.whole!.fat * 600) / 250,
      });
    });
  });

  describe("Scenario 6 — 1L packaging versus 250ml consumed (SH08)", () => {
    it("flags investigation_required / semantic_difference when Legacy uses 1000ml carton capacity while Shadow uses 250ml personal consumed", () => {
      const scene = analysis([
        wholeRow("飲了250ml（包裝標示容量1L）", 1000, {
          preparationMethod: "紙盒",
        }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh08-packaging-1l-vs-250ml-consumed",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "portion_amount_mismatch",
            "kcal_mismatch",
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
          ])
        );
      }
      // Both sides have 1 confirmed unit and 1 physical serving, yet nutrition differs 4x!
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(result.legacy!.fullMilkNutrition, {
        kcal: REFERENCE_250ML.whole!.kcal * 4,
        protein: REFERENCE_250ML.whole!.protein * 4,
        carbs: REFERENCE_250ML.whole!.carbs * 4,
        fat: REFERENCE_250ML.whole!.fat * 4,
      });
      expectKnownNutrientsCloseTo(
        result.shadow!.fullMilkNutrition,
        REFERENCE_250ML.whole!
      );
    });
  });

  describe("Scenario 7 — Known versus unknown personal portion (SH10)", () => {
    it("returns uncomparable_without_user_decision / unknown_portion when both structured weight and notes omit portion, without coercing unknown to 0", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", null)]);

      const result = compareMilkServingShadow({
        sceneId: "sh10-unknown-portion",
        analysis: scene,
      });

      expect(result.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unknown_portion",
        uncomparableReasons: ["pending_state", "unknown_portion"],
      });
      expect(result.legacy?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
      expect(result.legacy?.units[0]?.portion).toEqual(
        unknownValue("not_observed")
      );
      expect(result.shadow?.units[0]?.portion).toEqual(
        unknownValue("not_observed")
      );
    });

    it("detects semantic_difference when personal portion is present only in notes ('飲了250ml') and structured weight is null", () => {
      const scene = analysis([wholeRow("飲了250ml", null)]);

      const result = compareMilkServingShadow({
        sceneId: "sh10-notes-portion-vs-null-structured",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "confirmed_unit_count_mismatch",
            "confirmed_physical_serving_count_mismatch",
            "kcal_mismatch",
          ])
        );
      }
      expect(result.legacy?.confirmedUnitCount).toBe(0);
      expect(result.legacy?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(
        result.shadow!.fullMilkNutrition,
        REFERENCE_250ML.whole!
      );
    });
  });

  describe("Scenario 8 — Pending milk-type confirmation (SH07)", () => {
    it("returns uncomparable_without_user_decision / unknown_profile for generic milk without user confirmation, and never defaults to whole-milk", () => {
      const scene = analysis([milkRow("玻璃杯裝牛奶", 250)]);

      const result = compareMilkServingShadow({
        sceneId: "sh07-generic-milk-pending",
        analysis: scene,
      });

      expect(result.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unknown_profile",
        uncomparableReasons: ["pending_state", "unknown_profile"],
      });
      expect(result.legacy?.confirmedUnitCount).toBe(0);
      expect(result.shadow?.confirmedUnitCount).toBe(0);
      expect(result.legacy?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
    });

    it("handles two generic milk glasses with spatial anchors (left/right) as uncomparable_without_user_decision / unknown_profile when both sides keep 2 pending units", () => {
      const scene = analysis([
        milkRow("左邊玻璃杯", 250, { preparationMethod: "玻璃杯" }),
        milkRow("右邊玻璃杯", 250, { preparationMethod: "玻璃杯" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh07-two-generic-milk-glasses",
        analysis: scene,
      });

      expect(result.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unknown_profile",
        uncomparableReasons: ["pending_state", "unknown_profile"],
      });
      expect(result.legacy?.physicalServingCount).toEqual(known(2));
      expect(result.shadow?.physicalServingCount).toEqual(known(2));
      expect(result.legacy?.confirmedUnitCount).toBe(0);
      expect(result.shadow?.confirmedUnitCount).toBe(0);
    });
  });

  describe("Scenario 9 — Mutually exclusive serving hypotheses (SH05 / SH06)", () => {
    it("returns uncomparable_without_user_decision / pending_state when a single row has two conflicting personal portions in notes", () => {
      const scene = analysis([wholeRow("飲了200ml，飲了400ml", null)]);

      const result = compareMilkServingShadow({
        sceneId: "exclusive-portions-single-row",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("uncomparable_without_user_decision");
      if (result.outcome.kind === "uncomparable_without_user_decision") {
        expect(result.outcome.reason).toBe("pending_state");
        expect(result.outcome.uncomparableReasons).toContain("pending_state");
      }
      expect(result.shadow?.hasExclusiveOrConflictHypothesis).toBe(true);
    });

    it("handles SH06 same blue-dot cup with conflicting 250ml vs 400ml personal portions as investigation_required / semantic_difference against Legacy", () => {
      const scene = analysis([
        wholeRow("桌上一隻藍色圓點玻璃杯裝全脂牛奶", 250),
        wholeRow("同一隻藍色圓點玻璃杯裝全脂牛奶", 400),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh06-conflicting-blue-dot-cup",
        analysis: scene,
      });

      // Legacy picks 400ml as confirmed while Shadow holds the slot pending due to conflicting portions.
      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
      }
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(0);
    });

    it("handles SH05 / P1-D unknown-vessel row compatible with both carton and glass without auto-confirming the 3rd row", () => {
      const scene = analysis([
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("獨立玻璃杯全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
        wholeRow("白色飲品", 250, { preparationMethod: undefined }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "sh05-competing-targets-unknown-row",
        analysis: scene,
      });

      // Shadow confirms the 2 anchored servings (carton + glass = 314.15 kcal) and keeps the 3rd row as possible_excess,
      // while Legacy groups the unknown row with one of the concrete containers.
      expect(result.shadow?.supportedPhysicalServingCount).toEqual(known(2));
      expect(result.shadow?.confirmedUnitCount).toBe(2);
      expect(result.shadow?.unresolved).toBe(true);
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: REFERENCE_250ML.whole!.kcal * 2,
        protein: REFERENCE_250ML.whole!.protein * 2,
        carbs: REFERENCE_250ML.whole!.carbs * 2,
        fat: REFERENCE_250ML.whole!.fat * 2,
      });
    });
  });

  describe("Scenario 10 — Unsupported nutrition profile or unit", () => {
    it("returns uncomparable_without_user_decision / unsupported_reference for low-fat milk without falling back to whole-milk", () => {
      const scene = analysis([
        milkRow("玻璃杯裝低脂牛奶", 250, {
          displayName: "低脂牛奶",
          normalizedName: "low fat milk",
          preparationMethod: "玻璃杯",
        }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "unsupported-low-fat-milk",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("uncomparable_without_user_decision");
      if (result.outcome.kind === "uncomparable_without_user_decision") {
        expect(result.outcome.reason).toBe("unsupported_reference");
        expect(result.outcome.uncomparableReasons).toContain(
          "unsupported_reference"
        );
      }
      expect(result.shadow?.units[0]?.profile).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.shadow?.units[0]?.nutrients).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference")
      );
    });

    it("returns uncomparable_without_user_decision / unsupported_reference for almond milk", () => {
      const scene = analysis([
        milkRow("杏仁奶紙盒", 250, {
          displayName: "杏仁奶",
          normalizedName: "almond milk",
          preparationMethod: "紙盒",
        }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "unsupported-almond-milk",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("uncomparable_without_user_decision");
      if (result.outcome.kind === "uncomparable_without_user_decision") {
        expect(result.outcome.reason).toBe("unsupported_reference");
      }
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference")
      );
    });

    it("marks a confirmed whole-milk serving with an unsupported unit conversion (unit: 'bowl') as unsupported_reference and never skips it in meal totals", () => {
      const scene = analysis([
        wholeRow("一碗全脂牛奶", 1, {
          unit: "bowl",
        }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "unsupported-unit-bowl",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("uncomparable_without_user_decision");
      if (result.outcome.kind === "uncomparable_without_user_decision") {
        expect(result.outcome.reason).toBe("unsupported_reference");
      }
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expect(result.legacy?.units[0]?.nutrients).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.shadow?.units[0]?.nutrients).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.legacy?.confirmedSubtotal).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.shadow?.confirmedSubtotal).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.legacy?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference")
      );
    });

    it("explicitly maps only whole, oat, and soy to VerifiedCatalogReference and marks low-fat as unsupported_reference", () => {
      expect(resolveCatalogReferenceByServingProfile("whole").state).toBe(
        "known"
      );
      expect(resolveCatalogReferenceByServingProfile("oat").state).toBe("known");
      expect(resolveCatalogReferenceByServingProfile("soy").state).toBe("known");
      expect(resolveCatalogReferenceByServingProfile("low-fat")).toEqual(
        unknownValue("unsupported_reference")
      );
    });
  });

  describe("Scenario 11 — Ambiguous provenance binding", () => {
    it("returns uncomparable_without_user_decision / unknown_binding when Legacy dedupe breaks an equal-specificity tie between distinct semanticKey rows by array order", () => {
      const scene = analysis([
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("白色飲品", 250, { preparationMethod: undefined }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "ambiguous-provenance-tie-break",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("uncomparable_without_user_decision");
      if (result.outcome.kind === "uncomparable_without_user_decision") {
        expect(result.outcome.reason).toBe("unknown_binding");
        expect(result.outcome.uncomparableReasons).toContain("unknown_binding");
      }
    });

    it("detects provenance_binding_mismatch when two projections have identical totals and counts but bind to different canonical rowIds", () => {
      const baseSide = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        { sceneId: "binding-mismatch-test" }
      );
      const baseUnit = baseSide.units[0]!;
      expect(baseUnit.binding.state).toBe("known");
      if (baseUnit.binding.state !== "known") return;

      const sideRow1: ShadowSideProjection = {
        ...baseSide,
        units: [
          {
            ...baseUnit,
            binding: known({
              relation: "single_observation",
              observationRowIds: ["row-01"],
              observationSemanticKeys:
                baseUnit.binding.value.observationSemanticKeys,
            }),
          },
        ],
      };
      const sideRow2: ShadowSideProjection = {
        ...baseSide,
        units: [
          {
            ...baseUnit,
            binding: known({
              relation: "single_observation",
              observationRowIds: ["row-02"],
              observationSemanticKeys:
                baseUnit.binding.value.observationSemanticKeys,
            }),
          },
        ],
      };

      const comparison = compareShadowProjections(sideRow1, sideRow2, {
        sceneId: "binding-mismatch-test",
      });
      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).toContain(
          "provenance_binding_mismatch"
        );
      }
    });
  });

  describe("Scenario 12 — Same serving counts but different kcal", () => {
    it("detects kcal_mismatch and portion_amount_mismatch when both sides have 1 confirmed whole-milk serving with different ml", () => {
      const side250 = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        { sceneId: "kcal-mismatch-scene" }
      );
      const side400 = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 400)]),
        { sceneId: "kcal-mismatch-scene" }
      );

      const comparison = compareShadowProjections(side250, side400, {
        sceneId: "kcal-mismatch-scene",
      });

      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).toEqual(
          expect.arrayContaining([
            "portion_amount_mismatch",
            "kcal_mismatch",
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
          ])
        );
      }
      expect(comparison.legacy?.confirmedUnitCount).toBe(1);
      expect(comparison.shadow?.confirmedUnitCount).toBe(1);
    });
  });

  describe("Scenario 13 — Same kcal but different macronutrients", () => {
    it("detects protein_mismatch, carbs_mismatch, and fat_mismatch even when kcal is identical (45g whole-milk = 27.45 kcal vs 61g oat-milk = 27.45 kcal)", () => {
      const wholeScene = analysis([wholeRow("全脂牛奶", 45, { unit: "g" })]);
      const oatScene = analysis([oatRow("燕麥奶", 61, { unit: "g" })]);
      const oatReconciled = reconcileMilkServingScene({
        sceneId: "same-kcal-diff-macros",
        analysis: oatScene,
      });

      const whole45g = projectLegacyMilkShadow(wholeScene, {
        sceneId: "same-kcal-diff-macros",
      });
      const oat61g = projectLegacyMilkShadow(oatScene, {
        sceneId: "same-kcal-diff-macros",
        userMilkTypeChoices: {
          [oatReconciled.rows[0]!.rowId]: "oat",
        },
      });

      // Verify both are exactly 27.45 kcal!
      expect(whole45g.fullMilkNutrition.state).toBe("known");
      expect(oat61g.fullMilkNutrition.state).toBe("known");
      if (
        whole45g.fullMilkNutrition.state === "known" &&
        oat61g.fullMilkNutrition.state === "known"
      ) {
        expect(whole45g.fullMilkNutrition.value.kcal.min).toBeCloseTo(27.45, 6);
        expect(oat61g.fullMilkNutrition.value.kcal.min).toBeCloseTo(27.45, 6);
      }

      const comparison = compareShadowProjections(whole45g, oat61g, {
        sceneId: "same-kcal-diff-macros",
      });

      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).not.toContain("kcal_mismatch");
        expect(comparison.outcome.differences).toEqual(
          expect.arrayContaining([
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
            "profile_mismatch",
          ])
        );
      }
    });

    it("detects a single-macro difference when kcal, volume, profile, and binding are all identical", () => {
      const base = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        { sceneId: "single-macro-diff" }
      );
      expect(base.fullMilkNutrition.state).toBe("known");
      if (base.fullMilkNutrition.state !== "known") return;

      const perturbedNutrients: ShadowNutrients = {
        ...base.fullMilkNutrition.value,
        protein: {
          min: base.fullMilkNutrition.value.protein.min + 0.5,
          max: base.fullMilkNutrition.value.protein.max + 0.5,
        },
      };

      const perturbedSide: ShadowSideProjection = {
        ...base,
        units: [
          {
            ...base.units[0]!,
            nutrients: known(perturbedNutrients),
          },
        ],
        confirmedSubtotal: known(perturbedNutrients),
        fullMilkNutrition: known(perturbedNutrients),
      };

      const comparison = compareShadowProjections(base, perturbedSide, {
        sceneId: "single-macro-diff",
      });
      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).toEqual(["protein_mismatch"]);
      }
    });
  });

  describe("Scenario 14 — Same totals but different profile/purpose", () => {
    it("detects portion_purpose_mismatch when kcal, macros, volume, and profile are identical (600ml personal vs 600ml aggregate_consumed)", () => {
      const base = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 600)]),
        { sceneId: "purpose-mismatch-only" }
      );
      const baseUnit = base.units[0]!;
      expect(baseUnit.portion.state).toBe("known");
      if (baseUnit.portion.state !== "known") return;

      const aggregateSide: ShadowSideProjection = {
        ...base,
        units: [
          {
            ...baseUnit,
            portion: known({
              ...baseUnit.portion.value,
              purpose: "aggregate_consumed",
              multiplicity: 1,
            }),
          },
        ],
      };

      const comparison = compareShadowProjections(base, aggregateSide, {
        sceneId: "purpose-mismatch-only",
      });
      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).toEqual([
          "portion_purpose_mismatch",
        ]);
      }
    });

    it("detects profile_mismatch when kcal, macros, volume, purpose, and bindings are identical", () => {
      const base = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        { sceneId: "profile-mismatch-only" }
      );
      const soyCatalogRef: VerifiedCatalogReference = {
        servingProfileId: "soy",
        catalogId: "unsweetened-soy-milk",
        catalogVersion: SHADOW_CATALOG_VERSION,
        sourceId: "175215",
        referenceAssumption: "usda_sr_legacy_unsweetened_soy_milk_reference",
      };
      const differentProfileSide: ShadowSideProjection = {
        ...base,
        units: [
          {
            ...base.units[0]!,
            profile: known(soyCatalogRef),
          },
        ],
      };

      const comparison = compareShadowProjections(base, differentProfileSide, {
        sceneId: "profile-mismatch-only",
      });
      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).toEqual(["profile_mismatch"]);
      }
    });
  });

  describe("Scenario 15 — Forged duplicate confirmed slot (SH12 / P1-A)", () => {
    it("rejects a forged duplicate confirmed unit reusing the same slotId before any nutrition projection", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const validReconciliation = reconcileMilkServingScene({
        sceneId: "sh12-forged-duplicate-slot",
        analysis: scene,
      });
      const originalUnit = validReconciliation.confirmed[0]!;
      const duplicatedUnit = {
        ...structuredClone(originalUnit),
        unitId: "unit-confirmed-duplicate",
      };

      const forgedReconciliation: ServingReconciliation = {
        ...structuredClone(validReconciliation),
        confirmed: [originalUnit, duplicatedUnit],
        summary: {
          ...validReconciliation.summary,
          confirmedServingCount: 2,
        },
      };

      expect(() =>
        projectReconciledMilkShadow(forgedReconciliation, scene)
      ).toThrow(ServingContractError);
      expect(() => confirmedPortionPlan(forgedReconciliation)).toThrow(
        /confirmed slot .* is consumed more than once/
      );

      const result = compareMilkServingShadow({
        sceneId: "sh12-forged-duplicate-slot",
        analysis: scene,
        reconciliation: forgedReconciliation,
      });

      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.shadow).toBeNull();
    });
  });

  describe("Scenario 16 — Invalid reconciliation schema and input bounds (SH13 / SH14 / SH15)", () => {
    it("fails closed at failureStage: 'input' with legacy: null and shadow: null when observed rows exceed MAX_OBSERVED_ROWS (12)", () => {
      const thirteenMilkRows = Array.from({ length: 13 }, (_, idx) =>
        wholeRow(`第${idx + 1}杯全脂牛奶`, 250)
      );
      const scene = analysis(thirteenMilkRows);

      const result = compareMilkServingShadow({
        sceneId: "sh13-over-max-rows",
        analysis: scene,
      });

      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.legacy).toBeNull();
      expect(result.shadow).toBeNull();
    });

    it("fails closed at failureStage: 'output' when a confirmed unit has a non-consumed portion purpose ('packaging') or corrupted summary", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const validReconciliation = reconcileMilkServingScene({
        sceneId: "sh14-corrupted-reconciliation",
        analysis: scene,
      });

      const packagingMutated = {
        ...structuredClone(validReconciliation),
        confirmed: validReconciliation.confirmed.map((unit) => ({
          ...unit,
          portion: {
            ...unit.portion,
            purpose: "packaging",
          },
        })),
      } as unknown as ServingReconciliation;

      const packagingResult = compareMilkServingShadow({
        sceneId: "sh14-corrupted-reconciliation",
        analysis: scene,
        reconciliation: packagingMutated,
      });
      expect(packagingResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(packagingResult.shadow).toBeNull();

      const summaryMutated: ServingReconciliation = {
        ...structuredClone(validReconciliation),
        summary: {
          ...validReconciliation.summary,
          confirmedServingCount: 99,
        },
      };

      const summaryResult = compareMilkServingShadow({
        sceneId: "sh14-corrupted-reconciliation",
        analysis: scene,
        reconciliation: summaryMutated,
      });
      expect(summaryResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(summaryResult.shadow).toBeNull();
    });

    it("fails closed at failureStage: 'output' when reconciliation belongs to a different rawAnalysis scene", () => {
      const sceneA = analysis([wholeRow("左邊全脂牛奶", 250)]);
      const sceneB = analysis([soyRow("右邊無糖豆漿", 300)]);
      const reconciliationB = reconcileMilkServingScene({
        sceneId: "sh15-cross-scene",
        analysis: sceneB,
      });

      const result = compareMilkServingShadow({
        sceneId: "sh15-cross-scene",
        analysis: sceneA,
        reconciliation: reconciliationB,
      });

      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.shadow).toBeNull();
    });
  });

  describe("Scenario 17 — Row permutation and stable attribution (SH16)", () => {
    it("produces identical Shadow projections and comparison outcomes across all 24 permutations of a 3-serving scene plus non-milk item", () => {
      const items = [
        wholeRow("左邊第一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("中間玻璃杯裝全脂牛奶", 200, { preparationMethod: "玻璃杯" }),
        wholeRow("右邊第二盒全脂牛奶紙盒", 300, { preparationMethod: "紙盒" }),
        sandwichRow,
      ];

      const allPermutations = permutations(items);
      expect(allPermutations).toHaveLength(24);

      const baseline = compareMilkServingShadow({
        sceneId: "sh16-permutation-invariance",
        analysis: analysis(allPermutations[0]!),
      });

      for (const perm of allPermutations) {
        const current = compareMilkServingShadow({
          sceneId: "sh16-permutation-invariance",
          analysis: analysis(perm),
        });
        expect(current.outcome).toEqual(baseline.outcome);
        expect(current.shadow?.physicalServingCount).toEqual(
          baseline.shadow?.physicalServingCount
        );
        expect(current.shadow?.confirmedUnitCount).toBe(
          baseline.shadow?.confirmedUnitCount
        );
        expect(current.shadow?.confirmedPhysicalServingCount).toEqual(
          baseline.shadow?.confirmedPhysicalServingCount
        );
        expect(current.shadow?.fullMilkNutrition).toEqual(
          baseline.shadow?.fullMilkNutrition
        );
        expect(
          current.shadow?.units.map((unit) =>
            unit.binding.state === "known"
              ? unit.binding.value.observationSemanticKeys
              : null
          )
        ).toEqual(
          baseline.shadow?.units.map((unit) =>
            unit.binding.state === "known"
              ? unit.binding.value.observationSemanticKeys
              : null
          )
        );
      }
    }, 15_000);
  });

  describe("Scenario 18 — Deterministic, repeatable comparison outcomes & non-milk preservation (SH17 / SH18)", () => {
    it("produces deeply identical comparison results across repeated invocations and never mutates deep-frozen inputs", () => {
      const frozenInput = deepFreeze(
        analysis([
          riceRow(),
          chickenRow(),
          wholeRow("左邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("右邊玻璃杯裝全脂牛奶", 200, {
            preparationMethod: "玻璃杯",
          }),
        ])
      );

      const first = compareMilkServingShadow({
        sceneId: "sh17-deterministic-frozen",
        analysis: frozenInput,
      });
      const second = compareMilkServingShadow({
        sceneId: "sh17-deterministic-frozen",
        analysis: frozenInput,
      });

      expect(second).toEqual(first);
      expect(() => validateShadowComparisonResult(first)).not.toThrow();
    });

    it("preserves non-milk items in mixed meals without letting non-milk nutrition hide or distort milk comparison", () => {
      const milkOnly = compareMilkServingShadow({
        sceneId: "sh18-milk-only",
        analysis: analysis([
          wholeRow("桌上一杯全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
        ]),
      });
      const mixedMeal = compareMilkServingShadow({
        sceneId: "sh18-mixed-meal",
        analysis: analysis([
          riceRow(),
          chickenRow(),
          wholeRow("桌上一杯全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
        ]),
      });

      expect(mixedMeal.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(mixedMeal.legacy?.fullMilkNutrition).toEqual(
        milkOnly.legacy?.fullMilkNutrition
      );
      expect(mixedMeal.shadow?.fullMilkNutrition).toEqual(
        milkOnly.shadow?.fullMilkNutrition
      );
      expect(mixedMeal.legacy?.nonMilk.unitCount).toBe(2);
      expect(mixedMeal.shadow?.nonMilk.unitCount).toBe(2);
      expect(mixedMeal.legacy?.nonMilk).toEqual(mixedMeal.shadow?.nonMilk);
    });

    it("returns semantically_equivalent with 0 milk servings for a meal with no milk items", () => {
      const nonMilkScene = analysis([riceRow(), chickenRow(), sandwichRow]);

      const result = compareMilkServingShadow({
        sceneId: "sh18-no-milk-meal",
        analysis: nonMilkScene,
      });

      expect(result.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(result.legacy?.physicalServingCount).toEqual(known(0));
      expect(result.shadow?.physicalServingCount).toEqual(known(0));
      expect(result.legacy?.confirmedUnitCount).toBe(0);
      expect(result.shadow?.confirmedUnitCount).toBe(0);
      expectKnownNutrientsCloseTo(result.legacy!.fullMilkNutrition, {
        kcal: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, {
        kcal: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
    });
  });

  describe("SH01–SH18 offline Shadow acceptance matrix extensions", () => {
    it("SH07 extension — anchored whole 400ml + Distinct whole 250ml/400ml preserve exact 408.395 kcal without displacement by unbound generic row", () => {
      const twoDistinctGlasses = analysis([
        wholeRow("左邊藍色圓點玻璃杯裝全脂牛奶", 250),
        wholeRow("右邊星形貼紙玻璃杯裝全脂牛奶", 400),
      ]);
      const pairResult = compareMilkServingShadow({
        sceneId: "sh07-distinct-250-400",
        analysis: twoDistinctGlasses,
      });
      expect(pairResult.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(pairResult.shadow?.confirmedUnitCount).toBe(2);
      expectKnownNutrientsCloseTo(pairResult.shadow!.fullMilkNutrition, {
        kcal: 408.395,
        protein: 21.424,
        carbs: 32.136,
        fat: 22.0935,
      });

      const withUnboundRow = analysis([
        wholeRow("左邊藍色圓點玻璃杯裝全脂牛奶", 250),
        wholeRow("右邊星形貼紙玻璃杯裝全脂牛奶", 400),
        milkRow("白色飲品", 300, { preparationMethod: undefined }),
      ]);
      const unboundResult = compareMilkServingShadow({
        sceneId: "sh07-distinct-with-unbound",
        analysis: withUnboundRow,
      });
      // Confirmed subtotal still equals 408.395 kcal while fullMilkNutrition is unknown due to possible_excess row.
      expect(unboundResult.shadow?.confirmedUnitCount).toBe(2);
      expectKnownNutrientsCloseTo(unboundResult.shadow!.confirmedSubtotal, {
        kcal: 408.395,
        protein: 21.424,
        carbs: 32.136,
        fat: 22.0935,
      });
      expect(unboundResult.shadow?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
    });

    it("SH09 extension — 1L stock carton poured 180ml into glass counts only the 180ml poured glass serving once confirmed", () => {
      const rows = [
        wholeRow("1L全脂牛奶紙盒，倒了180ml到玻璃杯", null, {
          preparationMethod: "紙盒",
        }),
        wholeRow("玻璃杯全脂牛奶", 180, { preparationMethod: "玻璃杯" }),
      ];
      const scene = analysis(rows);

      const result = compareMilkServingShadow({
        sceneId: "sh09-stock-1l-poured-180ml",
        analysis: scene,
      });

      expect(result.shadow?.supportedPhysicalServingCount).toEqual(known(1));
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(1));
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: (REFERENCE_250ML.whole!.kcal * 180) / 250,
        protein: (REFERENCE_250ML.whole!.protein * 180) / 250,
        carbs: (REFERENCE_250ML.whole!.carbs * 180) / 250,
        fat: (REFERENCE_250ML.whole!.fat * 180) / 250,
      });
    });

    it.each([
      "三盒全脂牛奶嗎",
      "係咪三盒全脂牛奶",
      "未證實有三盒全脂牛奶",
      "三盒全脂牛奶吗",
      "can't see three whole milk cartons",
      "「三盒優惠」",
    ])(
      "SH10 extension — questioned/negated/uncertain/quoted count (%s) never inflates confirmed serving count to 3",
      (phrase) => {
        const scene = analysis(
          [
            wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
            wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
            wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          ],
          [phrase]
        );

        const result = compareMilkServingShadow({
          sceneId: "sh10-polarity-guard",
          analysis: scene,
        });

        expect(result.shadow?.supportedPhysicalServingCount).toEqual(known(1));
        expect(result.shadow?.confirmedUnitCount).toBe(1);
        expectKnownNutrientsCloseTo(
          result.shadow!.confirmedSubtotal,
          REFERENCE_250ML.whole!
        );
      }
    );

    it("SH14 extension — exact accepted decision replay is idempotent while invalid sceneId fails closed at input stage", () => {
      const rows = [milkRow("前方", 250), milkRow("後方", 400)];
      const scene = analysis(rows);
      const base = reconcileMilkServingScene({
        sceneId: "sh14-decision-replay",
        analysis: scene,
      });
      const group = base.unresolved.find(
        (item) => item.kind === "exclusive_candidates"
      )!;
      const acceptedList = decisions(base, [
        {
          kind: "one_serving",
          groupId: group.groupId,
          portion: { min: 250, max: 250, unit: "ml" },
        },
        { kind: "set_type", targetId: group.slotIds[0]!, choice: "whole" },
      ]);

      const once = compareMilkServingShadow({
        sceneId: "sh14-decision-replay",
        analysis: scene,
        decisions: acceptedList,
      });
      const replayed = compareMilkServingShadow({
        sceneId: "sh14-decision-replay",
        analysis: scene,
        decisions: [acceptedList[0]!, acceptedList[0]!, acceptedList[1]!],
      });

      expect(replayed).toEqual(once);
      expect(once.shadow?.confirmedUnitCount).toBe(1);

      const invalidSceneResult = compareMilkServingShadow({
        sceneId: "   ",
        analysis: scene,
      });
      expect(invalidSceneResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      });
      expect(invalidSceneResult.legacy).toBeNull();
      expect(invalidSceneResult.shadow).toBeNull();
    });
  });

  describe("Phase 2B1 P1 reconciliation integrity & Shadow semantic corrections (F-01 through F-04)", () => {
    it("F-01.1 — rejects cross-scene reconciliation substitution ('三盒全脂牛奶嗎' analysis + '三盒全脂牛奶' reconciliation) as invalid_contract", () => {
      const rows = [
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ];
      const questionedScene = analysis(rows, ["三盒全脂牛奶嗎"]);
      const affirmativeScene = analysis(rows, ["三盒全脂牛奶"]);
      const forgedAffirmativeReconciliation = reconcileMilkServingScene({
        sceneId: "f01-cross-scene-polarity",
        analysis: affirmativeScene,
      });

      expect(() =>
        projectReconciledMilkShadow(
          forgedAffirmativeReconciliation,
          questionedScene
        )
      ).toThrow(ServingContractError);

      const result = compareMilkServingShadow({
        sceneId: "f01-cross-scene-polarity",
        analysis: questionedScene,
        reconciliation: forgedAffirmativeReconciliation,
      });

      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.shadow).toBeNull();
    });

    it("F-01.2 — rejects forged generic-milk-to-whole reconciliation as invalid_contract both with and without rawAnalysis", () => {
      const genericMilkScene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const authenticReconciliation = reconcileMilkServingScene({
        sceneId: "f01-forged-generic-to-whole",
        analysis: genericMilkScene,
      });
      const slot = authenticReconciliation.supportedSlots[0]!;
      expect(slot.portion.state).toBe("resolved");
      if (slot.portion.state !== "resolved") return;

      const forgedReconciliation: ServingReconciliation = {
        ...structuredClone(authenticReconciliation),
        supportedSlots: [
          {
            ...structuredClone(slot),
            status: "confirmed",
            profile: {
              state: "resolved",
              value: "whole",
              proofIds: [...slot.proofIds],
            },
            pendingReasons: [],
          },
        ],
        confirmed: [
          {
            unitId: "unit-forged-01",
            slotIds: [slot.slotId],
            profileId: "whole",
            portion: slot.portion.value,
            multiplicity: 1,
            confirmation: "evidence_admitted",
            proofIds: [...slot.proofIds],
          },
        ],
        summary: {
          ...authenticReconciliation.summary,
          confirmedServingCount: 1,
          pendingSlotCount: 0,
        },
      };

      expect(() =>
        projectReconciledMilkShadow(forgedReconciliation, genericMilkScene)
      ).toThrow(ServingContractError);
      expect(() => projectWithoutTrustedAnalysis(forgedReconciliation)).toThrow(
        ServingContractError
      );

      const result = compareMilkServingShadow({
        sceneId: "f01-forged-generic-to-whole",
        analysis: genericMilkScene,
        reconciliation: forgedReconciliation,
      });

      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.shadow).toBeNull();
    });

    it("F-01.3 — rejects forged acceptedDecisions in reconciliation when decisions are omitted or mismatched", () => {
      const genericMilkScene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const baseReconciliation = reconcileMilkServingScene({
        sceneId: "f01-unapproved-decisions",
        analysis: genericMilkScene,
      });
      const wholeConfirmation = decisions(baseReconciliation, [
        {
          kind: "set_type",
          targetId: baseReconciliation.supportedSlots[0]!.slotId,
          choice: "whole",
        },
      ]);
      const soyConfirmation = decisions(baseReconciliation, [
        {
          kind: "set_type",
          targetId: baseReconciliation.supportedSlots[0]!.slotId,
          choice: "soy",
        },
      ]);
      const reconciliationWithWholeDecision = reconcileMilkServingScene({
        sceneId: "f01-unapproved-decisions",
        analysis: genericMilkScene,
        decisions: wholeConfirmation,
      });

      // Caller omits decisions -> reconciliation containing acceptedDecisions must be rejected.
      const omittedResult = compareMilkServingShadow({
        sceneId: "f01-unapproved-decisions",
        analysis: genericMilkScene,
        reconciliation: reconciliationWithWholeDecision,
      });
      expect(omittedResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(omittedResult.shadow).toBeNull();

      // Caller supplies soy decision while reconciliation reflects whole decision -> rejected.
      const mismatchedResult = compareMilkServingShadow({
        sceneId: "f01-unapproved-decisions",
        analysis: genericMilkScene,
        decisions: soyConfirmation,
        reconciliation: reconciliationWithWholeDecision,
      });
      expect(mismatchedResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(mismatchedResult.shadow).toBeNull();

      // Direct projection without caller-authorized decisions must also throw.
      expect(() =>
        projectReconciledMilkShadow(
          reconciliationWithWholeDecision,
          genericMilkScene
        )
      ).toThrow(ServingContractError);
    });

    it("F-01.4 — rejects forged sourceDigest or semanticDecisionView mismatch as invalid_contract", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const authentic = reconcileMilkServingScene({
        sceneId: "f01-digest-view-tamper",
        analysis: scene,
      });

      const forgedDigest: ServingReconciliation = {
        ...structuredClone(authentic),
        sourceDigest: "sha256:00000000000000000000000000000000",
      };
      const digestResult = compareMilkServingShadow({
        sceneId: "f01-digest-view-tamper",
        analysis: scene,
        reconciliation: forgedDigest,
      });
      expect(digestResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(digestResult.shadow).toBeNull();

      const forgedSemanticView: ServingReconciliation = {
        ...structuredClone(authentic),
        rows: authentic.rows.map((row) => ({
          ...row,
          raw: {
            ...row.raw,
            notes: "forged notes in raw causing semanticDecisionView mismatch",
          },
        })),
      };
      const semanticViewResult = compareMilkServingShadow({
        sceneId: "f01-digest-view-tamper",
        analysis: scene,
        reconciliation: forgedSemanticView,
      });
      expect(semanticViewResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(semanticViewResult.shadow).toBeNull();
    });

    it("F-02 — two 300ml whole-milk carton views + one independent 200ml whole-milk glass never cross-pairs by array index or reports false portion_amount_mismatch", () => {
      const scene = analysis([
        wholeRow("全脂牛奶紙盒", 300, { preparationMethod: "紙盒" }),
        wholeRow("白色飲品", 300, { preparationMethod: "紙盒" }),
        wholeRow("獨立玻璃杯全脂牛奶", 200, { preparationMethod: "玻璃杯" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "f02-two-300ml-plus-independent-200ml",
        analysis: scene,
      });

      expect(result.outcome.kind).toBe("uncomparable_without_user_decision");
      if (result.outcome.kind === "uncomparable_without_user_decision") {
        expect(result.outcome.reason).toBe("unknown_binding");
        expect(result.outcome.uncomparableReasons).toContain("unknown_binding");
      }

      // Independent 200ml glass must retain its known single_observation binding on Legacy (not poisoned by the 300ml carton group).
      const legacyGlassUnit = result.legacy?.units.find(
        (u) => u.portion.state === "known" && u.portion.value.amount.min === 200
      );
      const shadowGlassUnit = result.shadow?.units.find(
        (u) => u.portion.state === "known" && u.portion.value.amount.min === 200
      );
      const legacyConfirmedCartonUnit = result.legacy?.units.find(
        (u) =>
          u.includedInConfirmedSubtotal &&
          u.portion.state === "known" &&
          u.portion.value.amount.min === 300
      );
      expect(legacyGlassUnit?.binding.state).toBe("known");
      expect(legacyGlassUnit?.binding).toEqual(shadowGlassUnit?.binding);
      if (legacyGlassUnit?.binding.state === "known") {
        expect(legacyGlassUnit.binding.value.relation).toBe(
          "single_observation"
        );
        expect(legacyGlassUnit.binding.value.observationRowIds).toHaveLength(1);
      }
      expect(legacyConfirmedCartonUnit?.binding).toEqual(
        unknownValue("unbound")
      );
    });

    it("F-03 — three 250ml whole-milk carton rows + visibleEvidence ['「三盒優惠」'] keeps open possible_excess unresolved and partial", () => {
      const scene = analysis(
        [
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        ],
        ["「三盒優惠」"]
      );

      const result = compareMilkServingShadow({
        sceneId: "f03-quoted-three-carton-promo",
        analysis: scene,
      });

      expect(result.shadow?.supportedPhysicalServingCount).toEqual(known(1));
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: 157.075,
        protein: 8.24,
        carbs: 12.36,
        fat: 8.4975,
      });
      expect(result.shadow?.unresolvedGroupCount).toEqual(known(1));
      expect(result.shadow?.unresolved).toBe(true);
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("not_observed")
      );
      expect(result.shadow?.coverage).toEqual(known("partial"));
      expect(result.outcome.kind).not.toBe("semantically_equivalent");
    });

    it("F-04A — detects supported_physical_serving_count_mismatch and unresolved_group_count_mismatch in compareShadowProjections", () => {
      const base = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        { sceneId: "f04a-count-mismatch" }
      );

      const perturbedSupportedSide: ShadowSideProjection = {
        ...base,
        supportedPhysicalServingCount: known(2),
      };
      const supportedComparison = compareShadowProjections(
        base,
        perturbedSupportedSide,
        { sceneId: "f04a-supported-count-mismatch" }
      );
      expect(supportedComparison.outcome.kind).toBe("investigation_required");
      if (supportedComparison.outcome.kind === "investigation_required") {
        expect(supportedComparison.outcome.reason).toBe("semantic_difference");
        expect(supportedComparison.outcome.differences).toContain(
          "supported_physical_serving_count_mismatch"
        );
      }

      const perturbedUnresolvedSide: ShadowSideProjection = {
        ...base,
        unresolvedGroupCount: known(1),
      };
      const unresolvedComparison = compareShadowProjections(
        base,
        perturbedUnresolvedSide,
        { sceneId: "f04a-unresolved-count-mismatch" }
      );
      expect(unresolvedComparison.outcome.kind).toBe("investigation_required");
      if (unresolvedComparison.outcome.kind === "investigation_required") {
        expect(unresolvedComparison.outcome.reason).toBe("semantic_difference");
        expect(unresolvedComparison.outcome.differences).toContain(
          "unresolved_group_count_mismatch"
        );
      }
    });

    it("F-04B — produces symmetric unsupported_reference reasons for blended milk ('燕麥豆漿', '燕麥混合豆漿') and unsupported unit + null portion ('bowl', null)", () => {
      for (const blendedLabel of ["燕麥豆漿", "燕麥混合豆漿"]) {
        const blendedScene = analysis([
          milkRow(`一杯${blendedLabel}`, 250, {
            displayName: blendedLabel,
            normalizedName: "oat soy milk blend",
            preparationMethod: "玻璃杯",
          }),
        ]);
        const blendedResult = compareMilkServingShadow({
          sceneId: `f04b-blended-${blendedLabel}`,
          analysis: blendedScene,
        });

        expect(blendedResult.outcome).toEqual({
          kind: "uncomparable_without_user_decision",
          reason: "unsupported_reference",
          uncomparableReasons: ["pending_state", "unsupported_reference"],
        });
        expect(blendedResult.legacy?.fullMilkNutrition).toEqual(
          unknownValue("unsupported_reference")
        );
        expect(blendedResult.shadow?.fullMilkNutrition).toEqual(
          unknownValue("unsupported_reference")
        );
      }

      const bowlNullScene = analysis([
        wholeRow("一碗全脂牛奶", null, {
          unit: "bowl",
        }),
      ]);
      const bowlNullResult = compareMilkServingShadow({
        sceneId: "f04b-bowl-null-portion",
        analysis: bowlNullScene,
      });

      expect(bowlNullResult.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unsupported_reference",
        uncomparableReasons: ["pending_state", "unsupported_reference"],
      });
      expect(bowlNullResult.legacy?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference")
      );
      expect(bowlNullResult.shadow?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference")
      );
    });

    it("F-04C — toPublicShadowComparisonDiagnostic(result) enforces a strict allowlisted schema with zero identifiers, notes, evidence, or nutrient values", () => {
      const equivalentResult = compareMilkServingShadow({
        sceneId: "secret-scene-id-001",
        analysis: analysis(
          [
            wholeRow("敏感備註：桌上全脂牛奶 250ml", 250, {
              preparationMethod: "紙盒",
            }),
          ],
          ["敏感證據文字"]
        ),
      });
      const diffResult = compareMilkServingShadow({
        sceneId: "secret-scene-id-002",
        analysis: analysis([
          wholeRow("左方全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("右方全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        ]),
      });
      const uncomparableResult = compareMilkServingShadow({
        sceneId: "secret-scene-id-003",
        analysis: analysis([milkRow("玻璃杯裝牛奶", 250)]),
      });
      const invalidResult = compareMilkServingShadow({
        sceneId: "   ",
        analysis: analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
      });

      for (const result of [
        equivalentResult,
        diffResult,
        uncomparableResult,
        invalidResult,
      ]) {
        const diagnostic = toPublicShadowComparisonDiagnostic(result);
        expect(() =>
          publicShadowComparisonDiagnosticSchema.parse(diagnostic)
        ).not.toThrow();
        expect(diagnostic.diagnosticVersion).toBe(
          PUBLIC_SHADOW_DIAGNOSTIC_VERSION
        );
        expect(diagnostic.catalogVersion).toBe(SHADOW_CATALOG_VERSION);

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain("secret-scene-id");
        expect(serialized).not.toContain("sceneId");
        expect(serialized).not.toContain("rowId");
        expect(serialized).not.toContain("row-");
        expect(serialized).not.toContain("slotId");
        expect(serialized).not.toContain("slot-");
        expect(serialized).not.toContain("unitId");
        expect(serialized).not.toContain("unit-");
        expect(serialized).not.toContain("groupId");
        expect(serialized).not.toContain("group-");
        expect(serialized).not.toContain("claimId");
        expect(serialized).not.toContain("claim-");
        expect(serialized).not.toContain("sourceDigest");
        expect(serialized).not.toContain("semanticKey");
        expect(serialized).not.toContain("敏感備註");
        expect(serialized).not.toContain("敏感證據");
        expect(serialized).not.toContain("157.075");
        expect(serialized).not.toContain("250");
      }
    });
  });

  describe("Phase 2B1 P1 trusted evidence and decision authorization", () => {
    function wholeDecisionAttack(sceneId: string) {
      const scene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const base = reconcileMilkServingScene({ sceneId, analysis: scene });
      const slotId = base.supportedSlots[0]!.slotId;
      const wholeDecisions = decisions(base, [
        { kind: "set_type", targetId: slotId, choice: "whole" },
      ]);
      const soyDecisions = decisions(base, [
        { kind: "set_type", targetId: slotId, choice: "soy" },
      ]);
      const reconciliation = reconcileMilkServingScene({
        sceneId,
        analysis: scene,
        decisions: wholeDecisions,
      });
      return { scene, wholeDecisions, soyDecisions, reconciliation };
    }

    it("T-01 — self-consistent whole-milk set_type reconciliation is rejected without rawAnalysis or caller decisions", () => {
      const { reconciliation } = wholeDecisionAttack("p1-t01-self-auth");
      expect(reconciliation.acceptedDecisions).toHaveLength(1);
      expect(reconciliation.acceptedDecisions[0]?.command).toEqual({
        kind: "set_type",
        targetId: reconciliation.supportedSlots[0]!.slotId,
        choice: "whole",
      });

      const frozen = deepFreeze(structuredClone(reconciliation));
      expect(() => projectWithoutTrustedAnalysis(frozen)).toThrow(ServingContractError);
    });

    it("T-02 — trusted rawAnalysis without caller decisions rejects a reconciliation that accepted set_type", () => {
      const { scene, reconciliation } = wholeDecisionAttack("p1-t02-analysis-only");
      expect(() => projectReconciledMilkShadow(reconciliation, scene)).toThrow(
        ServingContractError,
      );
    });

    it("T-03 — matching caller decisions without rawAnalysis cannot bind source evidence", () => {
      const { reconciliation, wholeDecisions } = wholeDecisionAttack(
        "p1-t03-decisions-without-source",
      );
      expect(() =>
        projectWithoutTrustedAnalysis(reconciliation, { decisions: wholeDecisions }),
      ).toThrow(ServingContractError);
      expect(() =>
        projectWithoutTrustedAnalysis(reconciliation, {
          decisions: reconciliation.acceptedDecisions,
        }),
      ).toThrow(ServingContractError);
    });

    it("T-04 — trusted rawAnalysis plus the same authorized decisions accepts whole-milk projection", () => {
      const { scene, reconciliation, wholeDecisions } = wholeDecisionAttack(
        "p1-t04-authorized-whole",
      );
      const projected = projectReconciledMilkShadow(reconciliation, scene, {
        decisions: structuredClone(wholeDecisions),
      });

      expect(projected.confirmedUnitCount).toBe(1);
      expect(projected.confirmedPhysicalServingCount).toEqual(known(1));
      expect(projected.units[0]?.profile.state).toBe("known");
      if (projected.units[0]?.profile.state === "known") {
        expect(projected.units[0].profile.value.servingProfileId).toBe("whole");
      }
      expectKnownNutrientsCloseTo(projected.confirmedSubtotal, REFERENCE_250ML.whole!);
      expectKnownNutrientsCloseTo(projected.fullMilkNutrition, REFERENCE_250ML.whole!);
      expect(confirmedPortionPlan(reconciliation)).toEqual([
        {
          profileId: "whole",
          min: 250,
          max: 250,
          unit: "ml",
          purpose: "personal",
          multiplicity: 1,
        },
      ]);
    });

    it("T-05 — an explicit empty decision list does not authorize acceptedDecisions from the payload", () => {
      const { scene, reconciliation } = wholeDecisionAttack("p1-t05-empty-decisions");
      expect(reconciliation.acceptedDecisions).toHaveLength(1);
      expect(() =>
        projectReconciledMilkShadow(reconciliation, scene, { decisions: [] }),
      ).toThrow(ServingContractError);
    });

    it("T-06 — caller authorization for soy milk rejects a reconciliation that confirmed whole milk", () => {
      const { scene, reconciliation, soyDecisions } = wholeDecisionAttack(
        "p1-t06-soy-versus-whole",
      );
      expect(reconciliation.confirmed[0]?.profileId).toBe("whole");
      expect(() =>
        projectReconciledMilkShadow(reconciliation, scene, { decisions: soyDecisions }),
      ).toThrow(ServingContractError);
    });

    it("T-07 — trusted rawAnalysis accepts a reconciliation that contains no user decisions", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const reconciliation = reconcileMilkServingScene({
        sceneId: "p1-t07-no-decisions",
        analysis: scene,
      });
      expect(reconciliation.acceptedDecisions).toEqual([]);

      const omitted = projectReconciledMilkShadow(reconciliation, scene);
      const empty = projectReconciledMilkShadow(reconciliation, scene, {
        decisions: [],
      });

      expect(empty).toEqual(omitted);
      expect(omitted.confirmedUnitCount).toBe(1);
      expect(omitted.confirmedSubtotal.state).toBe("known");
      expectKnownNutrientsCloseTo(omitted.confirmedSubtotal, REFERENCE_250ML.whole!);
      expectKnownNutrientsCloseTo(omitted.fullMilkNutrition, REFERENCE_250ML.whole!);
    });

    it("T-08 — changing visibleEvidence while preserving row identity and sceneId rejects the previous reconciliation", () => {
      const sceneId = "p1-t08-visible-evidence";
      const foods = [wholeRow("玻璃杯裝全脂牛奶", 250)];
      const original = analysis(foods, []);
      const tampered = analysis(foods, ["三盒全脂牛奶"]);
      const reconciliation = reconcileMilkServingScene({
        sceneId,
        analysis: original,
      });
      const recomputed = reconcileMilkServingScene({
        sceneId,
        analysis: tampered,
      });

      expect(reconciliation.sceneId).toBe(sceneId);
      expect(recomputed.sceneId).toBe(sceneId);
      expect(recomputed.rows.map((row) => row.rowId)).toEqual(
        reconciliation.rows.map((row) => row.rowId),
      );
      expect(recomputed.sourceDigest).not.toBe(reconciliation.sourceDigest);
      expect(() => projectReconciledMilkShadow(reconciliation, tampered)).toThrow(
        ServingContractError,
      );
    });

    it("T-09 — tampered sourceDigest, semantic content, or acceptedDecisions are rejected", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const authentic = reconcileMilkServingScene({
        sceneId: "p1-t09-tamper",
        analysis: scene,
      });

      const forgedDigest: ServingReconciliation = {
        ...structuredClone(authentic),
        sourceDigest: "sha256:00000000000000000000000000000000",
      };
      expect(() => projectReconciledMilkShadow(forgedDigest, scene)).toThrow(
        ServingContractError,
      );

      const forgedSemanticView: ServingReconciliation = {
        ...structuredClone(authentic),
        rows: authentic.rows.map((row) => ({
          ...row,
          raw: {
            ...row.raw,
            notes: "forged visible note that changes semanticDecisionView",
          },
        })),
      };
      expect(() => projectReconciledMilkShadow(forgedSemanticView, scene)).toThrow(
        ServingContractError,
      );

      const { scene: genericScene, reconciliation, wholeDecisions } =
        wholeDecisionAttack("p1-t09-decision-tamper");
      const forgedDecisions = structuredClone(reconciliation);
      const accepted = forgedDecisions.acceptedDecisions[0];
      expect(accepted?.command.kind).toBe("set_type");
      if (accepted?.command.kind === "set_type") accepted.command.choice = "soy";
      expect(() =>
        projectReconciledMilkShadow(forgedDecisions, genericScene, {
          decisions: wholeDecisions,
        }),
      ).toThrow(ServingContractError);
    });

    it("T-10 — a self-consistent reconciliation built from fabricated rows and claims is rejected without trusted source evidence", () => {
      const attackAnalysis = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const evidence = interpretServingEvidence({
        sceneId: "p1-t10-fabricated-evidence",
        analysis: attackAnalysis,
      });
      const base = reconcileServingEvidence({
        sceneId: evidence.sceneId,
        rows: evidence.rows,
        claims: evidence.claims,
      });
      const fabricatedDecisions = decisions(base, [
        {
          kind: "set_type",
          targetId: base.supportedSlots[0]!.slotId,
          choice: "whole",
        },
      ]);
      const forged = reconcileServingEvidence({
        sceneId: evidence.sceneId,
        rows: evidence.rows,
        claims: evidence.claims,
        decisions: fabricatedDecisions,
      });
      const replay = reconcileServingEvidence({
        sceneId: forged.sceneId,
        rows: forged.rows,
        claims: forged.claims,
        decisions: forged.acceptedDecisions,
      });

      expect(forged.acceptedDecisions).toHaveLength(1);
      expect(canonicalJson(replay)).toBe(canonicalJson(forged));
      expect(() => projectWithoutTrustedAnalysis(forged)).toThrow(ServingContractError);
      expect(() =>
        projectWithoutTrustedAnalysis(forged, { decisions: forged.acceptedDecisions }),
      ).toThrow(ServingContractError);
      expect(() =>
        projectReconciledMilkShadow(forged, analysis([soyRow("豆漿玻璃杯", 250)])),
      ).toThrow(ServingContractError);

      const unrelatedWhole = reconcileMilkServingScene({
        sceneId: "p1-t10-unrelated-whole",
        analysis: analysis([wholeRow("另一個場景的全脂牛奶", 250)]),
      });
      expect(unrelatedWhole.confirmed[0]?.profileId).toBe("whole");
      expect(() =>
        projectReconciledMilkShadow(
          unrelatedWhole,
          analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        ),
      ).toThrow(ServingContractError);
    });

    it("T-11 — compareMilkServingShadow maps an unauthorized supplied reconciliation to invalid_contract at output", () => {
      const { scene, reconciliation } = wholeDecisionAttack("p1-t11-compare-output");
      const result = compareMilkServingShadow({
        sceneId: "p1-t11-compare-output",
        analysis: scene,
        reconciliation,
      });

      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.outcome.kind).not.toBe("semantically_equivalent");
      expect(result.shadow).toBeNull();

      const diagnostic = toPublicShadowComparisonDiagnostic(result);
      expect(diagnostic.outcomeKind).toBe("investigation_required");
      expect(diagnostic.outcomeReason).toBe("invalid_contract");
      expect(diagnostic.failureStage).toBe("output");
      const serialized = JSON.stringify(diagnostic);
      expect(serialized).not.toContain("p1-t11-compare-output");
      expect(serialized).not.toContain("sourceDigest");
      expect(serialized).not.toContain("157.075");
    });

    it("T-12 — authorized decisions still project the confirmed whole-milk portion and nutrients", () => {
      const sceneId = "p1-t12-authorized-portion";
      const { scene, reconciliation, wholeDecisions } = wholeDecisionAttack(sceneId);
      const legacyUserMilkTypeChoices = Object.fromEntries(
        reconciliation.rows.map((row) => [row.rowId, "whole" as const]),
      );
      const projected = projectReconciledMilkShadow(reconciliation, scene, {
        decisions: wholeDecisions,
      });
      const compared = compareMilkServingShadow({
        sceneId,
        analysis: scene,
        decisions: wholeDecisions,
        reconciliation,
        legacyUserMilkTypeChoices,
      });

      expect(compared.outcome).toEqual({ kind: "semantically_equivalent" });
      expect(compared.shadow).not.toBeNull();
      expect(compared.shadow).toEqual(projected);
      expect(projected.confirmedUnitCount).toBe(1);
      expect(confirmedPortionPlan(reconciliation)).toEqual([
        {
          profileId: "whole",
          min: 250,
          max: 250,
          unit: "ml",
          purpose: "personal",
          multiplicity: 1,
        },
      ]);
      expectKnownNutrientsCloseTo(projected.confirmedSubtotal, REFERENCE_250ML.whole!);
      expectKnownNutrientsCloseTo(projected.fullMilkNutrition, REFERENCE_250ML.whole!);
      expectKnownNutrientsCloseTo(
        compared.shadow!.fullMilkNutrition,
        REFERENCE_250ML.whole!,
      );
      expectKnownNutrientsCloseTo(
        compared.legacy!.fullMilkNutrition,
        REFERENCE_250ML.whole!,
      );
    });
  });

  describe("Phase 2B1 Final Acceptance — Independent Adversarial Review (ADV-01 through ADV-18)", () => {
    it("ADV-1.1 — rejects reconciliation replay against another sceneId both via options.sceneId and compareMilkServingShadow", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const reconciliationA = reconcileMilkServingScene({
        sceneId: "adv-scene-alpha",
        analysis: scene,
      });

      expect(() =>
        projectReconciledMilkShadow(reconciliationA, scene, {
          sceneId: "adv-scene-beta",
        }),
      ).toThrow(ServingContractError);

      const compared = compareMilkServingShadow({
        sceneId: "adv-scene-beta",
        analysis: scene,
        reconciliation: reconciliationA,
      });
      expect(compared.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(compared.shadow).toBeNull();
    });

    it("ADV-1.2 & ADV-1.3 — rejects reconciliation replay when visibleEvidence or food contents change under the same sceneId", () => {
      const sceneId = "adv-same-scene-id";
      const baseScene = analysis([wholeRow("左邊全脂牛奶紙盒", 250)], []);
      const baseReconciliation = reconcileMilkServingScene({
        sceneId,
        analysis: baseScene,
      });

      // Changed visibleEvidence with identical food rows and sceneId
      const changedEvidenceScene = analysis(
        [wholeRow("左邊全脂牛奶紙盒", 250)],
        ["兩盒全脂牛奶"],
      );
      expect(() =>
        projectReconciledMilkShadow(baseReconciliation, changedEvidenceScene),
      ).toThrow(ServingContractError);

      // Changed food contents with identical sceneId
      const changedFoodScene = analysis([wholeRow("左邊全脂牛奶紙盒", 300)], []);
      expect(() =>
        projectReconciledMilkShadow(baseReconciliation, changedFoodScene),
      ).toThrow(ServingContractError);

      const comparedChangedFood = compareMilkServingShadow({
        sceneId,
        analysis: changedFoodScene,
        reconciliation: baseReconciliation,
      });
      expect(comparedChangedFood.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(comparedChangedFood.shadow).toBeNull();
    });

    it("ADV-1.4, ADV-1.5 & ADV-1.6 — rejects forged acceptedDecisions, tampered rejectedDecisions, and forged sourceDigest", () => {
      const sceneId = "adv-decisions-and-digest";
      const genericScene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const base = reconcileMilkServingScene({
        sceneId,
        analysis: genericScene,
      });
      const validWholeDecision = decisions(base, [
        {
          kind: "set_type",
          targetId: base.supportedSlots[0]!.slotId,
          choice: "whole",
        },
      ]);
      const staleDecision = [
        {
          ...validWholeDecision[0]!,
          sourceDigest: "sha256:ffffffffffffffffffffffffffffffff",
        },
      ];
      const reconciliationWithRejected = reconcileMilkServingScene({
        sceneId,
        analysis: genericScene,
        decisions: staleDecision,
      });
      expect(reconciliationWithRejected.rejectedDecisions).toHaveLength(1);

      // 1) Tamper rejectedDecisions by clearing the rejection array while caller passes staleDecision
      const wipedRejected: ServingReconciliation = {
        ...structuredClone(reconciliationWithRejected),
        rejectedDecisions: [],
      };
      expect(() =>
        projectReconciledMilkShadow(wipedRejected, genericScene, {
          decisions: staleDecision,
        }),
      ).toThrow(/rejectedDecisions do not match/);

      // 2) Tamper the rejection reason inside rejectedDecisions while keeping decisionId intact
      const mutatedRejectedReason: ServingReconciliation = {
        ...structuredClone(reconciliationWithRejected),
        rejectedDecisions: reconciliationWithRejected.rejectedDecisions.map(
          (entry) => ({
            ...entry,
            reason: "tampered_rejection_reason",
          }),
        ),
      };
      expect(() =>
        projectReconciledMilkShadow(mutatedRejectedReason, genericScene, {
          decisions: staleDecision,
        }),
      ).toThrow(/rejectedDecisions do not match/);

      const comparedTamperedRejected = compareMilkServingShadow({
        sceneId,
        analysis: genericScene,
        decisions: staleDecision,
        reconciliation: mutatedRejectedReason,
      });
      expect(comparedTamperedRejected.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(comparedTamperedRejected.shadow).toBeNull();

      // 3) Inject fabricated rejectedDecision when caller passed no decisions
      const injectedRejected: ServingReconciliation = {
        ...structuredClone(base),
        rejectedDecisions: reconciliationWithRejected.rejectedDecisions,
      };
      expect(() =>
        projectReconciledMilkShadow(injectedRejected, genericScene),
      ).toThrow(/rejectedDecisions do not match/);
    });

    it("ADV-1.7 — rejects unsupported reference substitution (low-fat milk or user_type_other cannot be substituted with whole milk)", () => {
      const sceneId = "adv-unsupported-substitution";
      const genericScene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const base = reconcileMilkServingScene({
        sceneId,
        analysis: genericScene,
      });
      const slotId = base.supportedSlots[0]!.slotId;

      const lowFatDecision = decisions(base, [
        { kind: "set_type", targetId: slotId, choice: "low-fat" },
      ]);
      const lowFatResult = compareMilkServingShadow({
        sceneId,
        analysis: genericScene,
        decisions: lowFatDecision,
        legacyUserMilkTypeChoices: {
          [base.rows[0]!.rowId]: "low-fat",
        },
      });
      expect(lowFatResult.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unsupported_reference",
        uncomparableReasons: ["pending_state", "unsupported_reference"],
      });
      expect(lowFatResult.legacy?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference"),
      );
      expect(lowFatResult.shadow?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference"),
      );

      const otherDecision = decisions(base, [
        { kind: "set_type", targetId: slotId, choice: "other" },
      ]);
      const otherResult = compareMilkServingShadow({
        sceneId,
        analysis: genericScene,
        decisions: otherDecision,
        legacyUserMilkTypeChoices: {
          [base.rows[0]!.rowId]: "other",
        },
      });
      expect(otherResult.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unsupported_reference",
        uncomparableReasons: ["pending_state", "unsupported_reference"],
      });
      expect(otherResult.legacy?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference"),
      );
      expect(otherResult.shadow?.fullMilkNutrition).toEqual(
        unknownValue("unsupported_reference"),
      );
    });

    it("ADV-1.8 — detects profile and macro mismatches for identical 250ml portion values across different milk types (whole vs soy vs oat)", () => {
      const sceneId = "adv-identical-portion-diff-milk";
      const genericScene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const base = reconcileMilkServingScene({
        sceneId,
        analysis: genericScene,
      });
      const slotId = base.supportedSlots[0]!.slotId;
      const rowId = base.rows[0]!.rowId;

      // Legacy user selects soy (250ml), Shadow user selects oat (250ml)
      const result = compareMilkServingShadow({
        sceneId,
        analysis: genericScene,
        decisions: decisions(base, [
          { kind: "set_type", targetId: slotId, choice: "oat" },
        ]),
        legacyUserMilkTypeChoices: {
          [rowId]: "soy",
        },
      });

      expect(result.outcome.kind).toBe("investigation_required");
      if (result.outcome.kind === "investigation_required") {
        expect(result.outcome.reason).toBe("semantic_difference");
        expect(result.outcome.differences).toEqual(
          expect.arrayContaining([
            "profile_mismatch",
            "kcal_mismatch",
            "protein_mismatch",
            "carbs_mismatch",
            "fat_mismatch",
          ]),
        );
        expect(result.outcome.differences).not.toContain(
          "portion_amount_mismatch",
        );
      }
    });

    it("ADV-1.9 (ADV-03) — refuses greedy index pairing when multiple candidate bindings share overlapping rows (1-to-many or many-to-1) and flags provenance_binding_mismatch", () => {
      const base = projectLegacyMilkShadow(
        analysis([
          wholeRow("左邊全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("右邊全脂牛奶玻璃杯", 250, { preparationMethod: "玻璃杯" }),
        ]),
        { sceneId: "adv-overlapping-bindings" },
      );
      expect(base.units).toHaveLength(2);
      const u0 = base.units[0]!;
      const u1 = base.units[1]!;
      expect(u0.binding.state).toBe("known");
      expect(u1.binding.state).toBe("known");
      if (u0.binding.state !== "known" || u1.binding.state !== "known") return;

      // Construct two projections where both sides have 2 units with identical 250ml whole milk
      // and identical 500ml subtotals, but overlapping chained row bindings:
      // Left: [row-01, row-02] and [row-02, row-03]
      // Right: [row-01, row-03] and [row-02, row-04]
      const leftSide: ShadowSideProjection = {
        ...base,
        units: [
          {
            ...u0,
            binding: known({
              relation: "same_serving_merge",
              observationRowIds: ["row-01", "row-02"],
              observationSemanticKeys: u0.binding.value.observationSemanticKeys,
            }),
          },
          {
            ...u1,
            binding: known({
              relation: "same_serving_merge",
              observationRowIds: ["row-02", "row-03"],
              observationSemanticKeys: u1.binding.value.observationSemanticKeys,
            }),
          },
        ],
      };
      const rightSide: ShadowSideProjection = {
        ...base,
        units: [
          {
            ...u0,
            binding: known({
              relation: "same_serving_merge",
              observationRowIds: ["row-01", "row-03"],
              observationSemanticKeys: u0.binding.value.observationSemanticKeys,
            }),
          },
          {
            ...u1,
            binding: known({
              relation: "same_serving_merge",
              observationRowIds: ["row-02", "row-04"],
              observationSemanticKeys: u1.binding.value.observationSemanticKeys,
            }),
          },
        ],
      };

      const comparison = compareShadowProjections(leftSide, rightSide, {
        sceneId: "adv-overlapping-bindings",
      });
      expect(comparison.outcome.kind).toBe("investigation_required");
      if (comparison.outcome.kind === "investigation_required") {
        expect(comparison.outcome.reason).toBe("semantic_difference");
        expect(comparison.outcome.differences).toEqual([
          "provenance_binding_mismatch",
        ]);
      }
    });

    it("ADV-1.10 — preserves confirmedSubtotal while keeping fullMilkNutrition unknown when unresolved groups coexist with confirmed units", () => {
      const scene = analysis([
        wholeRow("左邊藍色圓點玻璃杯裝全脂牛奶", 250, {
          preparationMethod: "玻璃杯",
        }),
        wholeRow("全脂牛奶紙盒", 300, { preparationMethod: "紙盒" }),
        wholeRow("全脂牛奶紙盒", 300, { preparationMethod: "紙盒" }),
      ]);

      const result = compareMilkServingShadow({
        sceneId: "adv-unresolved-with-confirmed-subtotal",
        analysis: scene,
      });

      // Shadow confirms 1 glass (250ml) + 1 carton (300ml) = 550ml confirmedSubtotal,
      // while the duplicate 300ml carton row remains in an open possible_excess group.
      expect(result.shadow?.confirmedUnitCount).toBe(2);
      expect(result.shadow?.unresolvedGroupCount).toEqual(known(1));
      expect(result.shadow?.unresolved).toBe(true);
      expect(result.shadow?.coverage).toEqual(known("partial"));
      expect(result.shadow?.fullMilkNutrition).toEqual(
        unknownValue("not_observed"),
      );
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: (REFERENCE_250ML.whole!.kcal * 550) / 250,
        protein: (REFERENCE_250ML.whole!.protein * 550) / 250,
        carbs: (REFERENCE_250ML.whole!.carbs * 550) / 250,
        fat: (REFERENCE_250ML.whole!.fat * 550) / 250,
      });
    });

    it("ADV-1.11, ADV-1.12 & ADV-1.13 (ADV-01) — rejects malformed decisions, invalid legacyUserMilkTypeChoices, and invalid direct projection inputs as contract errors", () => {
      const scene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const reconciliation = reconcileMilkServingScene({
        sceneId: "adv-malformed-inputs",
        analysis: scene,
      });

      // Non-array truthy decisions object on compareMilkServingShadow -> invalid_contract at input stage
      const nonArrayDecisionsResult = compareMilkServingShadow({
        sceneId: "adv-malformed-inputs",
        analysis: scene,
        decisions: { not: "an-array" } as unknown as readonly never[],
      });
      expect(nonArrayDecisionsResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      });
      expect(nonArrayDecisionsResult.legacy).toBeNull();
      expect(nonArrayDecisionsResult.shadow).toBeNull();

      // Array with malformed decision element on compareMilkServingShadow -> invalid_contract at input stage
      const malformedElementResult = compareMilkServingShadow({
        sceneId: "adv-malformed-inputs",
        analysis: scene,
        decisions: [{ decisionId: "bad" }] as unknown as readonly never[],
      });
      expect(malformedElementResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      });
      expect(malformedElementResult.legacy).toBeNull();
      expect(malformedElementResult.shadow).toBeNull();

      // Invalid legacyUserMilkTypeChoices value -> invalid_contract at input stage
      const invalidLegacyChoiceResult = compareMilkServingShadow({
        sceneId: "adv-malformed-inputs",
        analysis: scene,
        legacyUserMilkTypeChoices: {
          "row-01": "almond" as unknown as "whole",
        },
      });
      expect(invalidLegacyChoiceResult.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      });
      expect(invalidLegacyChoiceResult.legacy).toBeNull();
      expect(invalidLegacyChoiceResult.shadow).toBeNull();

      // Direct projectLegacyMilkShadow with null/invalid analysis or invalid options throws ServingContractError
      expect(() =>
        projectLegacyMilkShadow(null as unknown as FoodAnalysis),
      ).toThrow(ServingContractError);
      expect(() =>
        projectLegacyMilkShadow(scene, {
          userMilkTypeChoices: { "row-01": "almond" as unknown as "whole" },
        }),
      ).toThrow(ServingContractError);
      expect(() =>
        projectLegacyMilkShadow(scene, { sceneId: "   " }),
      ).toThrow(ServingContractError);

      // Direct projectReconciledMilkShadow with non-array or malformed decisions throws ServingContractError
      expect(() =>
        projectReconciledMilkShadow(reconciliation, scene, {
          decisions: { invalid: true } as unknown as readonly never[],
        }),
      ).toThrow(ServingContractError);
      expect(() =>
        projectReconciledMilkShadow(reconciliation, scene, {
          decisions: [{ bad: true }] as unknown as readonly never[],
        }),
      ).toThrow(ServingContractError);

      // Empty vs omitted decisions produce identical projections when no decisions were accepted
      const withOmitted = compareMilkServingShadow({
        sceneId: "adv-malformed-inputs",
        analysis: scene,
      });
      const withEmpty = compareMilkServingShadow({
        sceneId: "adv-malformed-inputs",
        analysis: scene,
        decisions: [],
      });
      expect(withEmpty).toEqual(withOmitted);
    });

    it("ADV-1.14 — rejects oversized observation arrays (> 12 rows) across direct projection and comparator entrypoints", () => {
      const oversizedScene = analysis(
        Array.from({ length: 13 }, (_, i) =>
          wholeRow(`第${i + 1}杯全脂牛奶`, 250),
        ),
      );
      const validScene = analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]);
      const validReconciliation = reconcileMilkServingScene({
        sceneId: "adv-oversized",
        analysis: validScene,
      });

      expect(() => projectLegacyMilkShadow(oversizedScene)).toThrow(
        ServingContractError,
      );
      expect(() =>
        projectReconciledMilkShadow(validReconciliation, oversizedScene),
      ).toThrow(ServingContractError);

      const compared = compareMilkServingShadow({
        sceneId: "adv-oversized",
        analysis: oversizedScene,
      });
      expect(compared.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "input",
        differences: [],
        uncomparableReasons: [],
      });
      expect(compared.legacy).toBeNull();
      expect(compared.shadow).toBeNull();
    });

    it("ADV-1.15 & ADV-1.16 (ADV-02) — prevents unknown bindings from being classified or validated as semantically_equivalent and rejects malformed diagnostic serialization", () => {
      const base = projectLegacyMilkShadow(
        analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
        { sceneId: "adv-unknown-binding-guard" },
      );
      const unboundSide: ShadowSideProjection = {
        ...base,
        units: base.units.map((unit) => ({
          ...unit,
          binding: unknownValue("unbound"),
        })),
      };

      // Even though all nutrients, portions, profiles, and counts match, unknown binding forces uncomparable_without_user_decision
      const comparison = compareShadowProjections(unboundSide, unboundSide, {
        sceneId: "adv-unknown-binding-guard",
      });
      expect(comparison.outcome).toEqual({
        kind: "uncomparable_without_user_decision",
        reason: "unknown_binding",
        uncomparableReasons: ["unknown_binding"],
      });

      // Forging a ShadowComparisonResult claiming semantically_equivalent with an unknown unit binding is rejected by validateShadowComparisonResult and toPublicShadowComparisonDiagnostic
      const forgedEquivalentWithUnbound = {
        ...comparison,
        outcome: { kind: "semantically_equivalent" as const },
      };
      expect(() =>
        validateShadowComparisonResult(forgedEquivalentWithUnbound),
      ).toThrow();
      expect(() =>
        toPublicShadowComparisonDiagnostic(forgedEquivalentWithUnbound),
      ).toThrow();

      // Forging a stage-input failure that leaks a non-null legacy projection is rejected
      const forgedInputFailureWithLeak = {
        ...comparison,
        outcome: {
          kind: "investigation_required" as const,
          reason: "invalid_contract" as const,
          failureStage: "input" as const,
          differences: [],
          uncomparableReasons: [],
        },
        legacy: base,
        shadow: null,
      };
      expect(() =>
        validateShadowComparisonResult(forgedInputFailureWithLeak),
      ).toThrow();
      expect(() =>
        toPublicShadowComparisonDiagnostic(forgedInputFailureWithLeak),
      ).toThrow();

      // Forging whitespace-only sceneId is rejected
      expect(() =>
        validateShadowComparisonResult({
          ...comparison,
          sceneId: "   ",
        }),
      ).toThrow();
    });

    it("ADV-1.17 & ADV-1.18 — preserves immutability on deep-frozen inputs/decisions/reconciliations and accurately tracks non-milk coverage interactions", () => {
      const knownRice = milkRow("一碗白飯", 200, {
        displayName: "白飯",
        normalizedName: "white rice",
        unit: "g",
        identityLevel: "ingredient",
      });
      const genericMilk = milkRow("玻璃杯裝牛奶", 250);
      const frozenScene = deepFreeze(
        analysis([knownRice, genericMilk], ["餐桌上有白飯與牛奶"]),
      );
      const baseReconciliation = reconcileMilkServingScene({
        sceneId: "adv-immutability-and-coverage",
        analysis: frozenScene,
      });
      const frozenDecisions = deepFreeze(
        decisions(baseReconciliation, [
          {
            kind: "set_type",
            targetId: baseReconciliation.supportedSlots[0]!.slotId,
            choice: "whole",
          },
        ]),
      );
      const frozenReconciliation = deepFreeze(
        reconcileMilkServingScene({
          sceneId: "adv-immutability-and-coverage",
          analysis: frozenScene,
          decisions: frozenDecisions,
        }),
      );
      const frozenLegacyChoices = deepFreeze({
        [baseReconciliation.rows.find((r) => r.subject.milkCandidate)!.rowId]:
          "whole" as const,
      });

      // Before decision: 1 confirmed non-milk item (white rice) + 1 pending milk item -> coverage is "insufficient" (1/2 = 0.5), NOT "complete" or "none"
      const pendingComparison = compareMilkServingShadow({
        sceneId: "adv-immutability-and-coverage",
        analysis: frozenScene,
      });
      expect(pendingComparison.legacy?.nonMilk.includedCount).toBe(1);
      expect(pendingComparison.shadow?.nonMilk.includedCount).toBe(1);
      expect(pendingComparison.legacy?.coverage).toEqual(known("insufficient"));
      expect(pendingComparison.shadow?.coverage).toEqual(known("insufficient"));
      expect(pendingComparison.legacy?.coverageDenominator).toEqual(known(2));
      expect(pendingComparison.shadow?.coverageDenominator).toEqual(known(2));

      // After decision with deep-frozen inputs: coverage becomes "complete" (2/2) and semantically_equivalent without mutating any input
      const confirmedComparison = compareMilkServingShadow({
        sceneId: "adv-immutability-and-coverage",
        analysis: frozenScene,
        decisions: frozenDecisions,
        reconciliation: frozenReconciliation,
        legacyUserMilkTypeChoices: frozenLegacyChoices,
      });
      expect(confirmedComparison.outcome).toEqual({
        kind: "semantically_equivalent",
      });
      expect(confirmedComparison.legacy?.coverage).toEqual(known("complete"));
      expect(confirmedComparison.shadow?.coverage).toEqual(known("complete"));
      expect(confirmedComparison.legacy?.coverageDenominator).toEqual(known(2));
      expect(confirmedComparison.shadow?.coverageDenominator).toEqual(known(2));
    });
  });
});
