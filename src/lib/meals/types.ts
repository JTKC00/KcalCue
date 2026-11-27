import { z } from "zod";
import {
  foodAnalysisSchema,
  observedFoodSchema,
  type FoodAnalysis,
} from "@/lib/domain/food-analysis";
import type { EditableFoodItem } from "@/lib/domain/editable-meal";
import { analysisProvenanceMetadataSchema, type AnalysisProvenance } from "@/lib/domain/analysis-provenance";
import { NutritionService } from "@/lib/nutrition/service";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { classifyMealCoverage, roundRange } from "@/lib/nutrition/calculation";
import { calorieCorrectionInputSchema, type MealCalorieCorrection } from "./calories";
import { journalNoteInputSchema } from "./journal-note";
export type { MealCalorieCorrection } from "./calories";

export const mealTypes = {
  breakfast: "早餐",
  lunch: "午餐",
  afternoon_tea: "下午茶",
  dinner: "晚餐",
  snack: "小食",
} as const;
// Version 5 permits an explicitly unknown personal portion. Version 6 adds
// the protected journal-note field. Older writers reject unknown versions so
// they cannot erase either distinction during rollback or stale-tab writes.
export const NULLABLE_PORTION_MEAL_SCHEMA_VERSION = 5;
export const CURRENT_MEAL_SCHEMA_VERSION = 6;
export const photoRefSchema = z.strictObject({
  attachmentId: z.uuid(),
  generation: z.string().regex(/^[1-9][0-9]{0,31}$/),
  contentType: z.literal("image/jpeg"),
  width: z.number().int().min(1).max(1600),
  height: z.number().int().min(1).max(1600),
  byteSize: z.number().int().min(1).max(2 * 1024 * 1024),
});
export type PhotoRef = z.infer<typeof photoRefSchema>;
export const photoActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("attach"), uploadId: z.uuid() }),
  z.strictObject({ kind: z.literal("remove") }),
]);
export type PhotoAction = z.infer<typeof photoActionSchema>;
export interface MealDraft {
  id: string;
  date: string;
  time: string;
  timezone: string;
  mealType: keyof typeof mealTypes;
  mode: "live" | "manual" | "demo";
  analysis: FoodAnalysis | null;
  analysisProvenance?: AnalysisProvenance | null;
  items: EditableFoodItem[];
  originalItems: EditableFoodItem[];
  calorieCorrection?: MealCalorieCorrection | null;
  journalNote?: string | null;
  calorieInput?: string;
  version: number;
  readonly schemaVersion?: number;
  readonly createdAt?: string | null;
  photoPath: string | null;
  readonly photoRef?: PhotoRef | null;
  photo?: Blob;
  savePhoto?: boolean;
  removePhoto?: boolean;
  pendingMutation?: { id: string; fingerprint: string; uploadId?: string };
}
export interface MealRecord extends Omit<MealDraft, "photo" | "savePhoto" | "removePhoto" | "calorieInput"> {
  userId: string;
  updatedAt: string;
  mutationId: string;
}
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function defaultMealType(date = new Date()): keyof typeof mealTypes {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 5 * 60 && minutes < 11 * 60) return "breakfast";
  if (minutes >= 11 * 60 && minutes < 15 * 60) return "lunch";
  if (minutes >= 15 * 60 && minutes < 17 * 60 + 30) return "afternoon_tea";
  if (minutes >= 17 * 60 + 30 && minutes < 22 * 60) return "dinner";
  return "snack";
}
export function newDraft(now = new Date()): MealDraft {
  return {
    id: crypto.randomUUID(),
    date: localDate(now),
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mealType: defaultMealType(now),
    mode: "manual",
    analysis: null,
    analysisProvenance: null,
    items: [],
    originalItems: [],
    calorieCorrection: null,
    version: 0,
    photoPath: null,
  };
}
export const mealInputSchema = z.object({
  id: z.uuid(),
  mutationId: z.uuid(),
  version: z.number().int().nonnegative(),
  date: z.iso.date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z
    .string()
    .max(80)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  mealType: z.enum(["breakfast", "lunch", "afternoon_tea", "dinner", "snack"]),
  mode: z.enum(["live", "manual"]),
  analysis: foodAnalysisSchema.nullable(),
  analysisProvenance: analysisProvenanceMetadataSchema.nullable().optional(),
  calorieCorrection: calorieCorrectionInputSchema.nullable().optional(),
  journalNote: journalNoteInputSchema.optional(),
  items: z
    .array(
      observedFoodSchema.safeExtend({
        id: z.string().min(1).max(180),
        originalPortionMin: z.number().positive().max(5000).nullable(),
        originalPortionMax: z.number().positive().max(5000).nullable(),
        entrySource: z.enum(["photo", "manual"]).optional(),
        userMilkTypeChoice: z.enum(["whole", "low-fat", "oat", "soy", "other"]).optional(),
        otherMilkNotice: z.string().trim().min(1).max(180).optional(),
      }).refine(item => (item.originalPortionMin === null) === (item.originalPortionMax === null), {
        message: "original portions must both be null or both be numbers",
        path: ["originalPortionMax"],
      }).refine(item => item.originalPortionMin === null || item.originalPortionMax === null ||
        item.originalPortionMax >= item.originalPortionMin, {
        message: "originalPortionMax must be greater than or equal to originalPortionMin",
        path: ["originalPortionMax"],
      }),
    )
    .min(1)
    .max(12),
  photoPath: z.string().max(250).nullable(),
  photoAction: photoActionSchema.optional(),
});
export function dayNutrition(records: MealRecord[]) {
  const service = new NutritionService(new LocalNutritionProvider());
  const perMeal = records
    .filter((r) => r.mode !== "demo")
    .map((r) => service.calculateMeal(r.items));
  const foods = perMeal.flatMap((meal) => meal.foods);
  const totals = {
    calories: { min: 0, max: 0 },
    protein: { min: 0, max: 0 },
    carbs: { min: 0, max: 0 },
    fat: { min: 0, max: 0 },
  };
  let includedCount = 0;
  let confirmedCount = 0;
  for (const meal of perMeal) {
    includedCount += meal.includedCount;
    confirmedCount += meal.foods.filter((item) => item.food.suspectedDuplicateMilk !== true).length;
    if (meal.includedCount === 0) continue;
    const calories = roundRange(meal.totals.calories, 5);
    const protein = roundRange(meal.totals.protein, 1);
    const carbs = roundRange(meal.totals.carbs, 1);
    const fat = roundRange(meal.totals.fat, 1);
    totals.calories.min += calories.min;
    totals.calories.max += calories.max;
    totals.protein.min += protein.min;
    totals.protein.max += protein.max;
    totals.carbs.min += carbs.min;
    totals.carbs.max += carbs.max;
    totals.fat.min += fat.min;
    totals.fat.max += fat.max;
  }
  const confirmedCoverage = classifyMealCoverage(includedCount, confirmedCount);
  const hasPendingDuplicate = confirmedCount < foods.length;
  return {
    foods,
    totals,
    midpointCalories: (totals.calories.min + totals.calories.max) / 2,
    coverage: hasPendingDuplicate && confirmedCoverage === "complete" ? "partial" : confirmedCoverage,
    includedCount,
    totalCount: foods.length,
  };
}
