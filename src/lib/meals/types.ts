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
import { calorieCorrectionInputSchema, type MealCalorieCorrection } from "./calories";
export type { MealCalorieCorrection } from "./calories";

export const mealTypes = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "小食",
} as const;
// Version 5 permits an explicitly unknown personal portion. Older writers
// reject this version, preventing them from erasing that distinction.
export const CURRENT_MEAL_SCHEMA_VERSION = 5;
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
  calorieInput?: string;
  version: number;
  readonly schemaVersion?: number;
  readonly createdAt?: string | null;
  photoPath: string | null;
  readonly photoRef?: PhotoRef | null;
  photo?: Blob;
  removePhoto?: boolean;
  pendingMutation?: { id: string; fingerprint: string };
}
export interface MealRecord extends Omit<MealDraft, "photo" | "removePhoto" | "calorieInput"> {
  userId: string;
  updatedAt: string;
  mutationId: string;
}
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function newDraft(): MealDraft {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    date: localDate(now),
    time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    mealType: "snack",
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
  mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  mode: z.enum(["live", "manual"]),
  analysis: foodAnalysisSchema.nullable(),
  analysisProvenance: analysisProvenanceMetadataSchema.nullable().optional(),
  calorieCorrection: calorieCorrectionInputSchema.nullable().optional(),
  items: z
    .array(
      observedFoodSchema.safeExtend({
        id: z.string().min(1).max(180),
        originalPortionMin: z.number().positive().max(5000).nullable(),
        originalPortionMax: z.number().positive().max(5000).nullable(),
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
  return service.calculateMeal(
    records.filter((r) => r.mode !== "demo").flatMap((r) => r.items),
  );
}
