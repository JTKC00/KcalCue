import { z } from "zod";

export const portionUnits = ["g", "ml", "piece", "bowl", "cup"] as const;
export type PortionUnit = (typeof portionUnits)[number];

export const foodIdentityLevels = ["dish", "ingredient"] as const;
export type FoodIdentityLevel = (typeof foodIdentityLevels)[number];

const confidenceSchema = z.number().min(0).max(1);
const shortTextSchema = z.string().trim().min(1).max(180);

export const foodEstimateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    normalizedName: z.string().trim().min(1).max(100),
    identityLevel: z.enum(foodIdentityLevels),
    portionMin: z.number().positive().max(5000),
    portionMax: z.number().positive().max(5000),
    unit: z.enum(portionUnits),
    recognitionConfidence: confidenceSchema,
    portionConfidence: confidenceSchema,
    uncertaintyReasons: z.array(shortTextSchema).max(8),
    preparationMethod: z.string().trim().min(1).max(120).optional(),
    visibleIngredients: z.array(shortTextSchema).max(12).optional(),
    notes: z.string().trim().min(1).max(240).optional(),
  })
  .strip()
  .refine((food) => food.portionMax >= food.portionMin, {
    message: "portionMax must be greater than or equal to portionMin",
    path: ["portionMax"],
  });

export const foodAnalysisSchema = z
  .object({
    analysisStatus: z.enum(["success", "unable_to_identify"]),
    foods: z.array(foodEstimateSchema).max(12),
    uncertaintyReasons: z.array(shortTextSchema).max(12),
    visibleEvidence: z.array(shortTextSchema).max(12),
    estimatedInformation: z.array(shortTextSchema).max(12),
    unknownInformation: z.array(shortTextSchema).max(12),
  })
  .strip()
  .superRefine((analysis, context) => {
    if (analysis.analysisStatus === "success" && analysis.foods.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A successful analysis must include at least one food",
        path: ["foods"],
      });
    }

    if (
      analysis.analysisStatus === "unable_to_identify" &&
      analysis.foods.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An unable-to-identify result cannot include guessed foods",
        path: ["foods"],
      });
    }
  });

export type FoodEstimate = z.infer<typeof foodEstimateSchema>;
export type FoodAnalysis = z.infer<typeof foodAnalysisSchema>;

// Gemini 3.7 Flash generateContent rejects the constraint-heavy JSON Schema
// (additionalProperties/min/max/maxItems) with HTTP 400 INVALID_ARGUMENT.
// This schema only describes shape for generation. Zod remains authoritative.
export const foodAnalysisJsonSchema = {
  type: "object",
  required: [
    "analysisStatus",
    "foods",
    "uncertaintyReasons",
    "visibleEvidence",
    "estimatedInformation",
    "unknownInformation",
  ],
  properties: {
    analysisStatus: {
      type: "string",
      enum: ["success", "unable_to_identify"],
    },
    foods: {
      type: "array",
      items: {
        type: "object",
        required: [
          "displayName",
          "normalizedName",
          "identityLevel",
          "portionMin",
          "portionMax",
          "unit",
          "recognitionConfidence",
          "portionConfidence",
          "uncertaintyReasons",
        ],
        properties: {
          displayName: { type: "string" },
          normalizedName: { type: "string" },
          identityLevel: {
            type: "string",
            enum: [...foodIdentityLevels],
          },
          portionMin: { type: "number" },
          portionMax: { type: "number" },
          unit: {
            type: "string",
            enum: [...portionUnits],
          },
          recognitionConfidence: { type: "number" },
          portionConfidence: { type: "number" },
          uncertaintyReasons: {
            type: "array",
            items: { type: "string" },
          },
          preparationMethod: { type: "string" },
          visibleIngredients: {
            type: "array",
            items: { type: "string" },
          },
          notes: { type: "string" },
        },
      },
    },
    uncertaintyReasons: {
      type: "array",
      items: { type: "string" },
    },
    visibleEvidence: {
      type: "array",
      items: { type: "string" },
    },
    estimatedInformation: {
      type: "array",
      items: { type: "string" },
    },
    unknownInformation: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export function validateFoodAnalysis(value: unknown): FoodAnalysis {
  return foodAnalysisSchema.parse(value);
}
