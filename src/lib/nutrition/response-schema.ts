import { z } from "zod";
import { portionUnits } from "@/lib/domain/food-analysis";
import { NUTRITION_COVERAGE_REASONS } from "./coverage-reason";
import type { NutritionMatch } from "./types";

const category = z.enum([
  "rice", "noodles", "bread", "poultry", "beef", "pork", "seafood", "egg",
  "vegetable", "fruit", "tofu", "dairy", "sauce", "fried", "mixed", "unknown",
]);
const preparation = z.enum([
  "raw", "cooked", "steamed", "boiled", "pan_fried", "grilled", "stir_fried",
  "deep_fried", "sauced", "unknown",
]);
const nutrientRange = z.object({
  min: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
}).refine(range => range.max >= range.min);

// Validate the network boundary before these values reach calculation, editing
// or the persisted draft. A bad item must not discard other valid matches.
export const nutritionMatchResponseSchema: z.ZodType<NutritionMatch> = z.object({
  profile: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    canonicalName: z.string().min(1),
    category,
    preparations: z.array(preparation),
    aliases: z.array(z.string()),
    composite: z.boolean(),
    nutrientsPer100g: z.object({
      calories: nutrientRange,
      protein: nutrientRange,
      carbs: nutrientRange,
      fat: nutrientRange,
    }),
    gramsPerUnit: z.partialRecord(z.enum(portionUnits), z.number().finite().positive()),
    source: z.object({
      provider: z.enum(["kcalcue-reference", "usda-fdc", "demo"]),
      sourceId: z.string().optional(),
      sourceName: z.string(),
      retrievedAt: z.string().optional(),
      attribution: z.string(),
    }),
    dataNotice: z.string(),
    densityBasis: z.string(),
  }).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  matchType: z.enum([
    "exact_canonical", "strong_synonym", "category_preparation",
    "approximate_generic", "unresolved",
  ]),
  reasons: z.array(z.string()),
  identity: z.object({
    canonicalName: z.string(),
    category,
    preparation,
    qualifiers: z.array(z.string()),
  }),
  includedInTotal: z.boolean(),
  coverageReason: z.enum(NUTRITION_COVERAGE_REASONS).optional(),
}).refine(match => !match.includedInTotal || (match.profile !== null && match.confidence !== "low"));
