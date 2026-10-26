import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import type {
  ConfirmedPortionLine,
  DecisionCommand,
  ServingProfileId,
  ServingReconciliation,
  UserServingDecision,
} from "@/lib/domain/milk-serving-contract";

/**
 * Test-only fixtures for the Phase 1 serving engine.
 *
 * Reference vectors are fixed constants from the independent P1 review
 * (Decimal-verified against the baseline catalog), never derived from the
 * engine under test. A separate oracle test cross-checks them against the
 * existing catalog calculation for single hand-built items.
 */
export interface NutrientVector {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export const REFERENCE_250ML: Record<ServingProfileId, NutrientVector | null> = {
  whole: { kcal: 157.075, protein: 8.24, carbs: 12.36, fat: 8.4975 },
  oat: { kcal: 116.0243653957, protein: 1.7016906925, carbs: 13.8455742706, fat: 6.0074838083 },
  soy: { kcal: 84.7358275144, protein: 7.3437717179, carbs: 4.4678890871, fat: 4.1340812818 },
  "low-fat": null,
};

/** Linear in millilitres. Aggregate portions count once; multiplicity is not a multiplier. */
export function referenceTotals(plan: readonly ConfirmedPortionLine[]): { min: NutrientVector; max: NutrientVector } {
  const zero = (): NutrientVector => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const min = zero();
  const max = zero();
  for (const line of plan) {
    const vector = REFERENCE_250ML[line.profileId];
    if (!vector || line.unit !== "ml") throw new Error(`no reference vector for ${line.profileId}/${line.unit}`);
    for (const key of ["kcal", "protein", "carbs", "fat"] as const) {
      min[key] += (vector[key] * line.min) / 250;
      max[key] += (vector[key] * line.max) / 250;
    }
  }
  return { min, max };
}

let counter = 0;
export function nextSceneId(label: string): string {
  counter += 1;
  return `scene-${label}-${counter}`;
}

export function milkRow(notes: string | undefined, quantity: number | null = 250, extra: Partial<ObservedFood> = {}): ObservedFood {
  const row: ObservedFood = {
    displayName: "牛奶",
    normalizedName: "milk",
    identityLevel: "ingredient",
    portionMin: quantity,
    portionMax: quantity,
    unit: "ml",
    recognitionConfidence: 0.7,
    portionConfidence: 0.6,
    uncertaintyReasons: [],
    ...extra,
  };
  if (notes !== undefined) row.notes = notes;
  return row;
}

export function oatRow(notes = "燕麥奶紙盒", quantity: number | null = 250, extra: Partial<ObservedFood> = {}): ObservedFood {
  return milkRow(notes, quantity, { displayName: "燕麥奶", normalizedName: "oat milk", preparationMethod: "紙盒", ...extra });
}

export function wholeRow(notes = "獨立玻璃杯", quantity: number | null = 400, extra: Partial<ObservedFood> = {}): ObservedFood {
  return milkRow(notes, quantity, { displayName: "全脂牛奶", normalizedName: "whole milk", preparationMethod: "玻璃杯", ...extra });
}

export function soyRow(notes = "豆漿玻璃杯", quantity: number | null = 250, extra: Partial<ObservedFood> = {}): ObservedFood {
  return milkRow(notes, quantity, { displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "玻璃杯", ...extra });
}

export function nonMilkRow(displayName: string, normalizedName: string, notes?: string): ObservedFood {
  return milkRow(notes, 100, { displayName, normalizedName, unit: "g", identityLevel: "dish" });
}

export const sandwichRow = nonMilkRow("三明治", "sandwich", "包裝三明治，旁邊另一個容器，內有牛奶");

export function analysis(foods: ObservedFood[], visibleEvidence: string[] = [], extra: Partial<FoodAnalysis> = {}): FoodAnalysis {
  return {
    analysisStatus: "success",
    foods,
    visibleEvidence,
    uncertaintyReasons: [],
    estimatedInformation: [],
    unknownInformation: [],
    ...extra,
  };
}

export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map(rest => [item, ...rest]));
}

/** Row id for the unique row whose raw notes equal `notes` (content, not index). */
export function rowIdByNotes(result: ServingReconciliation, notes: string): string {
  const matches = result.rows.filter(row => row.raw.notes === notes);
  if (matches.length !== 1) throw new Error(`expected one row with notes ${notes}, got ${matches.length}`);
  return matches[0].rowId;
}

export function dispositionOf(result: ServingReconciliation, rowId: string) {
  const disposition = result.dispositions.find(item => item.rowId === rowId);
  if (!disposition) throw new Error(`no disposition for ${rowId}`);
  return disposition;
}

export function slotForRow(result: ServingReconciliation, notes: string): string {
  const disposition = dispositionOf(result, rowIdByNotes(result, notes));
  if (disposition.slotIds.length !== 1) {
    throw new Error(`row ${notes} is ${disposition.disposition} with ${disposition.slotIds.length} slots`);
  }
  return disposition.slotIds[0];
}

/** Sequential decisions bound to the current source digest. */
export function decisions(result: ServingReconciliation, commands: DecisionCommand[], prefix = "d"): UserServingDecision[] {
  return commands.map((command, index) => ({
    decisionId: `${prefix}-${index}`,
    sourceDigest: result.sourceDigest,
    expectedDecisionRevision: index,
    command,
  }));
}
