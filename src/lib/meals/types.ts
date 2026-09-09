import { z } from "zod";
import {
  foodAnalysisSchema,
  foodEstimateSchema,
  type FoodAnalysis,
} from "@/lib/domain/food-analysis";
import type { EditableFoodItem } from "@/lib/domain/editable-meal";
import { NutritionService } from "@/lib/nutrition/service";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";

export const mealTypes = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "小食",
} as const;
export interface MealDraft {
  id: string;
  date: string;
  time: string;
  timezone: string;
  mealType: keyof typeof mealTypes;
  mode: "live" | "manual" | "demo";
  analysis: FoodAnalysis | null;
  items: EditableFoodItem[];
  originalItems: EditableFoodItem[];
  version: number;
  photoPath: string | null;
  photo?: Blob;
  removePhoto?: boolean;
  pendingMutation?: { id: string; fingerprint: string };
}
export interface MealRecord extends Omit<MealDraft, "photo" | "removePhoto"> {
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
    items: [],
    originalItems: [],
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
  items: z
    .array(
      foodEstimateSchema.safeExtend({
        id: z.string().min(1).max(180),
        originalPortionMin: z.number().positive().max(5000),
        originalPortionMax: z.number().positive().max(5000),
      }),
    )
    .min(1)
    .max(12),
  photoPath: z.string().max(250).nullable(),
});
export function dayNutrition(records: MealRecord[]) {
  const service = new NutritionService(new LocalNutritionProvider());
  return service.calculateMeal(
    records.filter((r) => r.mode !== "demo").flatMap((r) => r.items),
  );
}
