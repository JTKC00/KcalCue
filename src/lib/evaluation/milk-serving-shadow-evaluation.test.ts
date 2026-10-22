import { describe, expect, it } from "vitest";

import {
  compareMilkServingShadow,
  known,
  projectReconciledMilkShadow,
  PUBLIC_SHADOW_DIAGNOSTIC_VERSION,
  publicShadowComparisonDiagnosticSchema,
  SHADOW_CATALOG_VERSION,
  toPublicShadowComparisonDiagnostic,
  unknownValue,
  type ShadowComparisonResult,
  type ShadowSideProjection,
} from "@/lib/domain/milk-serving-shadow-comparator";
import { analysis } from "@/lib/domain/milk-serving.fixture";
import {
  buildGenericMilkWholeAuthorization,
  milkShadowEvaluationScenes,
  ORACLE_TWO_WHOLE_250_KCAL,
  ORACLE_WHOLE_1L_KCAL,
  ORACLE_WHOLE_250,
  ORACLE_WHOLE_600ML_KCAL,
  permutationInvarianceFoodOrders,
  unrelatedFoodInvarianceInputs,
} from "./milk-serving-shadow-evaluation.fixture";

function expectKnownNutrientsCloseTo(
  actual: ShadowSideProjection["fullMilkNutrition"],
  expected: { kcal: number; protein: number; carbs: number; fat: number },
  precision = 6,
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

function assertPublicDiagnosticRedacted(
  result: ShadowComparisonResult,
  probe: {
    sceneId: string;
    noteSubstring: string;
    evidenceSubstring?: string;
    nutrientSubstring?: string;
  },
): void {
  const diagnostic = toPublicShadowComparisonDiagnostic(result);
  expect(() => publicShadowComparisonDiagnosticSchema.parse(diagnostic)).not.toThrow();
  expect(diagnostic.diagnosticVersion).toBe(PUBLIC_SHADOW_DIAGNOSTIC_VERSION);
  expect(diagnostic.catalogVersion).toBe(SHADOW_CATALOG_VERSION);

  const serialized = JSON.stringify(diagnostic);
  const forbidden = [
    probe.sceneId,
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
    probe.noteSubstring,
    probe.evidenceSubstring,
    probe.nutrientSubstring,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const token of forbidden) {
    expect(serialized).not.toContain(token);
  }
}

function assertSceneOracle(
  sceneId: string,
  result: ShadowComparisonResult,
): string | null {
  switch (sceneId) {
    case "eval-whole-250-equivalent": {
      if (result.outcome.kind !== "semantically_equivalent") {
        return `expected semantically_equivalent, got ${result.outcome.kind}`;
      }
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, ORACLE_WHOLE_250);
      return null;
    }
    case "eval-sh01-dismiss-duplicate-carton": {
      if (result.outcome.kind !== "semantically_equivalent") {
        return `expected semantically_equivalent after dismiss, got ${result.outcome.kind}`;
      }
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, ORACLE_WHOLE_250);
      return null;
    }
    case "eval-sh08-1l-capacity-vs-250-consumed": {
      if (result.outcome.kind !== "investigation_required") {
        return `expected investigation_required, got ${result.outcome.kind}`;
      }
      if (result.outcome.reason !== "semantic_difference") {
        return `expected semantic_difference, got ${result.outcome.reason}`;
      }
      expect(result.legacy?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(result.legacy!.fullMilkNutrition, {
        kcal: ORACLE_WHOLE_1L_KCAL,
        protein: ORACLE_WHOLE_250.protein * 4,
        carbs: ORACLE_WHOLE_250.carbs * 4,
        fat: ORACLE_WHOLE_250.fat * 4,
      });
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, ORACLE_WHOLE_250);
      return null;
    }
    case "eval-sh09-aggregate-600ml-once": {
      if (result.outcome.kind !== "investigation_required") {
        return `expected investigation_required, got ${result.outcome.kind}`;
      }
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expect(result.shadow?.confirmedPhysicalServingCount).toEqual(known(3));
      expect(result.shadow?.units[0]?.portion).toEqual(
        known({
          purpose: "aggregate_consumed",
          amount: { min: 600, max: 600 },
          unit: "ml",
          multiplicity: 3,
        }),
      );
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, {
        kcal: ORACLE_WHOLE_600ML_KCAL,
        protein: (ORACLE_WHOLE_250.protein * 600) / 250,
        carbs: (ORACLE_WHOLE_250.carbs * 600) / 250,
        fat: (ORACLE_WHOLE_250.fat * 600) / 250,
      });
      return null;
    }
    case "eval-sh06-exclusive-250-400": {
      if (result.outcome.kind !== "investigation_required") {
        return `expected investigation_required, got ${result.outcome.kind}`;
      }
      expect(result.shadow?.confirmedUnitCount).toBe(0);
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
      expect(result.shadow?.fullMilkNutrition).toEqual(unknownValue("not_observed"));
      return null;
    }
    case "eval-sh05-evidenced-plus-ambiguous": {
      expect(result.outcome.kind).not.toBe("semantically_equivalent");
      expect(result.shadow?.supportedPhysicalServingCount).toEqual(known(2));
      expect(result.shadow?.confirmedUnitCount).toBe(2);
      expect(result.shadow?.unresolved).toBe(true);
      expect(result.shadow?.fullMilkNutrition).toEqual(unknownValue("not_observed"));
      expectKnownNutrientsCloseTo(result.shadow!.confirmedSubtotal, {
        kcal: ORACLE_TWO_WHOLE_250_KCAL,
        protein: ORACLE_WHOLE_250.protein * 2,
        carbs: ORACLE_WHOLE_250.carbs * 2,
        fat: ORACLE_WHOLE_250.fat * 2,
      });
      return null;
    }
    case "eval-forged-reconciliation-without-caller-decisions":
    case "eval-cross-scene-reconciliation-reject": {
      expect(result.outcome).toEqual({
        kind: "investigation_required",
        reason: "invalid_contract",
        failureStage: "output",
        differences: [],
        uncomparableReasons: [],
      });
      expect(result.shadow).toBeNull();
      return null;
    }
    case "eval-authorized-oat-after-confirmation": {
      if (result.outcome.kind !== "semantically_equivalent") {
        return `expected semantically_equivalent, got ${result.outcome.kind}`;
      }
      expect(result.shadow?.confirmedUnitCount).toBe(1);
      expectKnownNutrientsCloseTo(result.shadow!.fullMilkNutrition, {
        kcal: 116.0243653957,
        protein: 1.7016906925,
        carbs: 13.8455742706,
        fat: 6.0074838083,
      });
      return null;
    }
    default:
      return `no oracle registered for ${sceneId}`;
  }
}

describe("PR128 Phase 2B1 offline milk-serving Shadow evaluation gate", () => {
  it("runs named synthetic scenes with hand-written oracles and redacted public diagnostics", () => {
    const failures: string[] = [];
    let passed = 0;
    let diagnosticPass = 0;

    for (const scene of milkShadowEvaluationScenes) {
      const prefix = `${scene.id}: ${scene.description}`;
      const result = compareMilkServingShadow(scene.build());
      const oracleError = assertSceneOracle(scene.id, result);
      if (oracleError) {
        failures.push(`${prefix} — ${oracleError}`);
        continue;
      }

      try {
        assertPublicDiagnosticRedacted(result, scene.redactionProbe);
        diagnosticPass += 1;
      } catch (error) {
        failures.push(`${prefix} — public diagnostic redaction failed (${String(error)})`);
        continue;
      }

      passed += 1;
    }

    const report = [
      "KcalCue Milk-Serving Shadow Offline Evaluation",
      "",
      `Scenes: ${milkShadowEvaluationScenes.length}`,
      `PASS: ${passed}`,
      `FAIL: ${milkShadowEvaluationScenes.length - passed}`,
      `Public diagnostic redaction: ${diagnosticPass}/${milkShadowEvaluationScenes.length}`,
      ...(failures.length > 0 ? ["", "Failures:", ...failures.map((failure) => `- ${failure}`)] : []),
    ].join("\n");
    process.stdout.write(`${report}\n`);

    expect(failures, report).toEqual([]);
  });

  it("keeps shadow milk subtotal invariant when unrelated foods are added", () => {
    const { milkOnly, mixedMeal } = unrelatedFoodInvarianceInputs();
    const only = compareMilkServingShadow(milkOnly);
    const mixed = compareMilkServingShadow(mixedMeal);

    expect(mixed.outcome).toEqual({ kind: "semantically_equivalent" });
    expect(mixed.shadow?.fullMilkNutrition).toEqual(only.shadow?.fullMilkNutrition);
    expect(mixed.legacy?.fullMilkNutrition).toEqual(only.legacy?.fullMilkNutrition);
    expect(mixed.shadow?.nonMilk.unitCount).toBe(2);
    expect(mixed.legacy?.nonMilk).toEqual(mixed.shadow?.nonMilk);
  });

  it("is permutation-invariant for milk projection within a fixed multi-serving scene", () => {
    const permutationCase = permutationInvarianceFoodOrders();
    const baseline = compareMilkServingShadow({
      sceneId: permutationCase.sceneId,
      analysis: analysis(permutationCase.orders[0]!),
    });

    expect(permutationCase.orders).toHaveLength(24);
    expect(baseline.shadow?.confirmedUnitCount).toBe(2);
    expectKnownNutrientsCloseTo(baseline.shadow!.fullMilkNutrition, {
      kcal: ORACLE_WHOLE_250.kcal * 2.6,
      protein: ORACLE_WHOLE_250.protein * 2.6,
      carbs: ORACLE_WHOLE_250.carbs * 2.6,
      fat: ORACLE_WHOLE_250.fat * 2.6,
    }); // Two evidenced glasses: 250 + 400 ml = 650 ml, before permutations.
    for (const order of permutationCase.orders) {
      const current = compareMilkServingShadow({
        sceneId: permutationCase.sceneId,
        analysis: analysis(order),
      });
      expect(current.outcome).toEqual(baseline.outcome);
      expect(current.shadow?.fullMilkNutrition).toEqual(baseline.shadow?.fullMilkNutrition);
      expect(current.shadow?.confirmedUnitCount).toBe(baseline.shadow?.confirmedUnitCount);
    }
  });

  it("accepts explicit caller-authorized whole-milk projection when raw analysis and decisions align", () => {
    const { scene, reconciliation, authorizedDecisions, sceneId } =
      buildGenericMilkWholeAuthorization();
    const projected = projectReconciledMilkShadow(reconciliation, scene, {
      decisions: structuredClone(authorizedDecisions),
    });
    expect(projected.confirmedUnitCount).toBe(1);
    expectKnownNutrientsCloseTo(projected.fullMilkNutrition, ORACLE_WHOLE_250);

    const compared = compareMilkServingShadow({
      sceneId,
      analysis: scene,
      decisions: authorizedDecisions,
      legacyUserMilkTypeChoices: Object.fromEntries(
        reconciliation.rows.map((row) => [row.rowId, "whole" as const]),
      ),
    });
    expect(compared.outcome.kind).toBe("semantically_equivalent");
    expectKnownNutrientsCloseTo(compared.shadow!.fullMilkNutrition, ORACLE_WHOLE_250);
  });
});
