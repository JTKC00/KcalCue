import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import type { ServingReconciliation } from "@/lib/domain/milk-serving-contract";
import { reconcileMilkServingScene } from "@/lib/domain/milk-serving-reconciliation";
import {
  analysis,
  decisions,
  milkRow,
  oatRow,
  permutations,
  REFERENCE_250ML,
  sandwichRow,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";
import type { ShadowComparisonInput } from "@/lib/domain/milk-serving-shadow-comparator";

/** Hand-written oracle constants (Decimal-verified P1 review), never copied from engine output. */
export const ORACLE_WHOLE_250 = REFERENCE_250ML.whole!;
export const ORACLE_WHOLE_600ML_KCAL = (ORACLE_WHOLE_250.kcal * 600) / 250;
export const ORACLE_WHOLE_1L_KCAL = ORACLE_WHOLE_250.kcal * 4;
export const ORACLE_TWO_WHOLE_250_KCAL = ORACLE_WHOLE_250.kcal * 2;

export interface MilkShadowEvaluationScene {
  id: string;
  description: string;
  /** Secret values that must never appear in public diagnostics. */
  redactionProbe: {
    sceneId: string;
    noteSubstring: string;
    evidenceSubstring?: string;
    nutrientSubstring?: string;
  };
  build(): ShadowComparisonInput;
}

function nonMilkRiceRow() {
  return wholeRow("一碗白飯", 100, {
    displayName: "白飯",
    normalizedName: "white rice",
    unit: "g",
    identityLevel: "dish",
  });
}

function nonMilkChickenRow() {
  return milkRow("一件烤雞扒", 150, {
    displayName: "烤雞扒",
    normalizedName: "grilled chicken breast",
    unit: "g",
    identityLevel: "dish",
  });
}

export const milkShadowEvaluationScenes: readonly MilkShadowEvaluationScene[] = [
  {
    id: "eval-whole-250-equivalent",
    description: "Single explicit whole-milk 250 ml serving is semantically_equivalent",
    redactionProbe: {
      sceneId: "secret-eval-whole-250",
      noteSubstring: "機密備註全脂250",
      evidenceSubstring: "機密證據",
      nutrientSubstring: "157.075",
    },
    build() {
      return {
        sceneId: "secret-eval-whole-250",
        analysis: analysis(
          [wholeRow("機密備註全脂250玻璃杯", 250, { preparationMethod: "玻璃杯" })],
          ["機密證據"],
        ),
      };
    },
  },
  {
    id: "eval-sh01-dismiss-duplicate-carton",
    description: "Duplicate whole-carton observations become semantically_equivalent after dismiss_group",
    redactionProbe: {
      sceneId: "secret-eval-sh01-dismiss",
      noteSubstring: "同一盒全脂",
    },
    build() {
      const sceneId = "secret-eval-sh01-dismiss";
      const scene = analysis([
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("桌上同一盒全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ]);
      const base = reconcileMilkServingScene({ sceneId, analysis: scene });
      const dismissDecisions = decisions(base, [
        { kind: "dismiss_group", groupId: base.unresolved[0]!.groupId },
      ]);
      return { sceneId, analysis: scene, decisions: dismissDecisions };
    },
  },
  {
    id: "eval-sh08-1l-capacity-vs-250-consumed",
    description: "Equal unit count with 1 L packaging vs 250 ml consumed triggers investigation",
    redactionProbe: {
      sceneId: "secret-eval-sh08",
      noteSubstring: "飲了250ml",
    },
    build() {
      return {
        sceneId: "secret-eval-sh08",
        analysis: analysis([
          wholeRow("飲了250ml（包裝標示容量1L）", 1000, { preparationMethod: "紙盒" }),
        ]),
      };
    },
  },
  {
    id: "eval-sh09-aggregate-600ml-once",
    description: "Three cups aggregate 600 ml counted once for nutrition (not tripled)",
    redactionProbe: {
      sceneId: "secret-eval-sh09",
      noteSubstring: "三杯合共",
      nutrientSubstring: "376.98",
    },
    build() {
      return {
        sceneId: "secret-eval-sh09",
        analysis: analysis([wholeRow("三杯合共飲用了600ml", 600, { preparationMethod: undefined })]),
      };
    },
  },
  {
    id: "eval-sh06-exclusive-250-400",
    description: "Mutually exclusive 250 ml vs 400 ml on one cup: zero confirmed subtotal, unknown full milk nutrition",
    redactionProbe: {
      sceneId: "secret-eval-sh06",
      noteSubstring: "藍色圓點",
    },
    build() {
      return {
        sceneId: "secret-eval-sh06",
        analysis: analysis([
          wholeRow("桌上一隻藍色圓點玻璃杯裝全脂牛奶", 250),
          wholeRow("同一隻藍色圓點玻璃杯裝全脂牛奶", 400),
        ]),
      };
    },
  },
  {
    id: "eval-sh05-evidenced-plus-ambiguous",
    description: "Carton and glass stay confirmed while ambiguous white-drink row remains unresolved excess",
    redactionProbe: {
      sceneId: "secret-eval-sh05",
      noteSubstring: "白色飲品",
    },
    build() {
      return {
        sceneId: "secret-eval-sh05",
        analysis: analysis([
          wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
          wholeRow("獨立玻璃杯全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
          wholeRow("白色飲品", 250, { preparationMethod: undefined }),
        ]),
      };
    },
  },
  {
    id: "eval-forged-reconciliation-without-caller-decisions",
    description: "Supplied reconciliation with accepted decisions fails when caller omits authorization",
    redactionProbe: {
      sceneId: "secret-eval-forged-recon",
      noteSubstring: "玻璃杯裝牛奶",
    },
    build() {
      const sceneId = "secret-eval-forged-recon";
      const scene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
      const base = reconcileMilkServingScene({ sceneId, analysis: scene });
      const wholeConfirmation = decisions(base, [
        { kind: "set_type", targetId: base.supportedSlots[0]!.slotId, choice: "whole" },
      ]);
      const reconciliation = reconcileMilkServingScene({
        sceneId,
        analysis: scene,
        decisions: wholeConfirmation,
      });
      return { sceneId, analysis: scene, reconciliation };
    },
  },
  {
    id: "eval-cross-scene-reconciliation-reject",
    description: "Reconciliation bound to a different analysis digest is rejected at output stage",
    redactionProbe: {
      sceneId: "secret-eval-cross-scene",
      noteSubstring: "全脂牛奶紙盒",
    },
    build() {
      const rows = [
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
        wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }),
      ];
      const questioned = analysis(rows, ["三盒全脂牛奶嗎"]);
      const affirmative = analysis(rows, ["三盒全脂牛奶"]);
      const forged = reconcileMilkServingScene({
        sceneId: "secret-eval-cross-scene",
        analysis: affirmative,
      });
      return {
        sceneId: "secret-eval-cross-scene",
        analysis: questioned,
        reconciliation: forged,
      };
    },
  },
  {
    id: "eval-authorized-oat-after-confirmation",
    description: "Trusted analysis plus caller-authorized set_type and dismiss_group projects oat milk equivalently",
    redactionProbe: {
      sceneId: "secret-eval-authorized-oat",
      noteSubstring: "燕麥奶紙盒",
    },
    build() {
      const sceneId = "secret-eval-authorized-oat";
      const scene = analysis([
        oatRow("一個燕麥奶紙盒（正面見藍色蓋）", 250),
        oatRow("燕麥奶紙盒（側面見營養標籤）", 250),
      ]);
      const base = reconcileMilkServingScene({ sceneId, analysis: scene });
      const legacyChoices = Object.fromEntries(base.rows.map((row) => [row.rowId, "oat" as const]));
      const shadowDecisions = decisions(base, [
        { kind: "set_type", targetId: base.supportedSlots[0]!.slotId, choice: "oat" },
        { kind: "dismiss_group", groupId: base.unresolved[0]!.groupId },
      ]);
      return {
        sceneId,
        analysis: scene,
        decisions: shadowDecisions,
        legacyUserMilkTypeChoices: legacyChoices,
      };
    },
  },
];

export function permutationInvarianceFoodOrders(): ObservedFoodPermutationCase {
  const items = [
    wholeRow("左邊玻璃杯裝全脂牛奶", 250),
    wholeRow("右邊玻璃杯裝全脂牛奶", 400),
    nonMilkRiceRow(),
    sandwichRow,
  ];
  const orders = permutations(items) as ObservedFood[][];
  return {
    id: "eval-sh16-permutation-invariance",
    description: "Shadow milk projection invariant across all row permutations of a fixed scene",
    sceneId: "secret-eval-sh16-permute",
    orders,
  };
}

export interface ObservedFoodPermutationCase {
  id: string;
  description: string;
  sceneId: string;
  orders: ObservedFood[][];
}

export function unrelatedFoodInvarianceInputs(): {
  milkOnly: ShadowComparisonInput;
  mixedMeal: ShadowComparisonInput;
} {
  const milkAnalysis = analysis([
    wholeRow("桌上一杯全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
  ]);
  return {
    milkOnly: { sceneId: "secret-eval-sh18-milk-only", analysis: milkAnalysis },
    mixedMeal: {
      sceneId: "secret-eval-sh18-mixed",
      analysis: analysis([
        nonMilkRiceRow(),
        nonMilkChickenRow(),
        wholeRow("桌上一杯全脂牛奶", 250, { preparationMethod: "玻璃杯" }),
      ]),
    },
  };
}

export function buildGenericMilkWholeAuthorization(): {
  scene: FoodAnalysis;
  reconciliation: ServingReconciliation;
  authorizedDecisions: ReturnType<typeof decisions>;
  sceneId: string;
} {
  const sceneId = "secret-eval-t04-authorized-whole";
  const scene = analysis([milkRow("玻璃杯裝牛奶", 250)]);
  const base = reconcileMilkServingScene({ sceneId, analysis: scene });
  const authorizedDecisions = decisions(base, [
    { kind: "set_type", targetId: base.supportedSlots[0]!.slotId, choice: "whole" },
  ]);
  const reconciliation = reconcileMilkServingScene({
    sceneId,
    analysis: scene,
    decisions: authorizedDecisions,
  });
  return { scene, reconciliation, authorizedDecisions, sceneId };
}
