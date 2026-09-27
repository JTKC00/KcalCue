import { z } from "zod";

export const portionUnits = ["g", "ml", "piece", "bowl", "cup"] as const;
export type PortionUnit = (typeof portionUnits)[number];

export const foodIdentityLevels = ["dish", "ingredient"] as const;
export type FoodIdentityLevel = (typeof foodIdentityLevels)[number];

const confidenceSchema = z.number().min(0).max(1);
const shortTextSchema = z.string().trim().min(1).max(180);

const foodFields = {
  displayName: z.string().trim().min(1).max(80),
  normalizedName: z.string().trim().min(1).max(100),
  identityLevel: z.enum(foodIdentityLevels),
  unit: z.enum(portionUnits),
  recognitionConfidence: confidenceSchema,
  portionConfidence: confidenceSchema,
  uncertaintyReasons: z.array(shortTextSchema).max(8),
  preparationMethod: z.string().trim().min(1).max(120).optional(),
  visibleIngredients: z.array(shortTextSchema).max(12).optional(),
  notes: z.string().trim().min(1).max(240).optional(),
};
const positivePortionSchema = z.number().positive().max(5000);

// Numeric estimates remain the contract for reference nutrition providers.
export const foodEstimateSchema = z
  .object({
    ...foodFields,
    portionMin: positivePortionSchema,
    portionMax: positivePortionSchema,
  })
  .strip()
  .refine((food) => food.portionMax >= food.portionMin, {
    message: "portionMax must be greater than or equal to portionMin",
    path: ["portionMax"],
  });

// A model can recognize food in a shared platter or an unbounded close-up
// without evidence of the user's own serving. Keep that observation, but do
// not invent a numeric portion merely to satisfy the estimate contract.
export const observedFoodSchema = z
  .object({
    ...foodFields,
    portionMin: positivePortionSchema.nullable(),
    portionMax: positivePortionSchema.nullable(),
  })
  .strip()
  .refine((food) => (food.portionMin === null) === (food.portionMax === null), {
    message: "portionMin and portionMax must both be null or both be numbers",
    path: ["portionMax"],
  })
  .refine(
    (food) => food.portionMin === null || food.portionMax === null ||
      food.portionMax >= food.portionMin,
    {
      message: "portionMax must be greater than or equal to portionMin",
      path: ["portionMax"],
    },
  );

export const foodAnalysisSchema = z
  .object({
    analysisStatus: z.enum(["success", "unable_to_identify"]),
    foods: z.array(observedFoodSchema).max(12),
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
export type ObservedFood = z.infer<typeof observedFoodSchema>;
export type FoodAnalysis = z.infer<typeof foodAnalysisSchema>;

// OpenAI Structured Outputs requires additionalProperties=false on every object
// and every property to be required. Nullable properties preserve the domain's
// optional fields; the provider strips those nulls before Zod validation.
// Portion nulls are intentional observations and must survive normalization.
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
        properties: {
          displayName: { type: "string" },
          normalizedName: { type: "string" },
          identityLevel: {
            type: "string",
            enum: [...foodIdentityLevels],
          },
          portionMin: { type: ["number", "null"] },
          portionMax: { type: ["number", "null"] },
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
          preparationMethod: { type: ["string", "null"] },
          visibleIngredients: {
            type: ["array", "null"],
            items: { type: "string" },
          },
          notes: { type: ["string", "null"] },
        },
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
          "preparationMethod",
          "visibleIngredients",
          "notes",
        ],
        additionalProperties: false,
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
  additionalProperties: false,
} as const;

export function validateFoodAnalysis(value: unknown): FoodAnalysis {
  return foodAnalysisSchema.parse(value);
}
