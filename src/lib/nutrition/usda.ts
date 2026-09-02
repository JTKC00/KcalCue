import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  canonicalizeFood,
  isCompositeIdentity,
  normalizeFoodName,
} from "./canonical";
import { COMPOSITE_GENERIC_FALLBACK_REASON } from "./compatibility";
import type {
  NutrientRangePer100g,
  NutritionMatch,
  NutritionProfile,
} from "./types";
import { pointNutrient } from "./types";

const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const USDA_TIMEOUT_MS = 8_000;
const USDA_DESCRIPTION_SIMILARITY_THRESHOLD = 0.8;

const USDA_NUTRIENT_SPECS = {
  calories: {
    numbers: ["208", "1008"],
    units: ["kcal", "kilocalorie", "kilocalories"],
  },
  protein: {
    numbers: ["203", "1003"],
    units: ["g", "gram", "grams"],
  },
  carbs: {
    numbers: ["205", "1005"],
    units: ["g", "gram", "grams"],
  },
  fat: {
    numbers: ["204", "1004"],
    units: ["g", "gram", "grams"],
  },
} as const;

type NutrientKind = keyof typeof USDA_NUTRIENT_SPECS;

interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string | number;
  nutrientName?: string;
  value?: number;
  unitName?: string;
}

interface UsdaFood {
  fdcId?: number;
  description?: string;
  dataType?: string;
  foodNutrients?: UsdaNutrient[];
}

interface UsdaSearchResponse {
  foods?: UsdaFood[];
}

const USDA_DESCRIPTION_FILLER_WORDS = new Set([
  "a",
  "added",
  "all",
  "and",
  "baked",
  "boiled",
  "chopped",
  "cooked",
  "diced",
  "dried",
  "dry",
  "eat",
  "fresh",
  "frozen",
  "fortified",
  "grilled",
  "heat",
  "in",
  "low",
  "fat",
  "flesh",
  "of",
  "pan",
  "peeled",
  "plain",
  "percent",
  "raw",
  "ready",
  "reduced",
  "roasted",
  "seared",
  "sliced",
  "steamed",
  "skin",
  "seed",
  "seeds",
  "the",
  "to",
  "uncooked",
  "unpeeled",
  "variety",
  "vitamin",
  "water",
  "with",
  "without",
  "whole",
  "milkfat",
]);

export type UsdaFailureCode =
  | "missing_key"
  | "timeout"
  | "rate_limited"
  | "invalid_response"
  | "unavailable";

export class UsdaNutritionError extends Error {
  constructor(
    public readonly code: UsdaFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UsdaNutritionError";
  }
}

function normalizedNutrientUnit(unitName: string | undefined): string {
  return unitName?.trim().toLocaleLowerCase("en").replace(/\s+/g, "") ?? "";
}

function nutrientNumber(nutrient: UsdaNutrient): string {
  return String(nutrient.nutrientNumber ?? nutrient.nutrientId ?? "").trim();
}

function hasExpectedUnit(nutrient: UsdaNutrient, kind: NutrientKind): boolean {
  const unit = normalizedNutrientUnit(nutrient.unitName);
  const units: readonly string[] = USDA_NUTRIENT_SPECS[kind].units;
  return units.includes(unit);
}

function hasExpectedName(nutrient: UsdaNutrient, kind: NutrientKind): boolean {
  const name = nutrient.nutrientName?.trim().toLocaleLowerCase("en") ?? "";

  switch (kind) {
    case "calories":
      return name.includes("energy") || name.includes("calorie");
    case "protein":
      return name === "protein" || name.startsWith("protein,");
    case "carbs":
      return name.includes("carbohydrate");
    case "fat":
      return name === "fat" || name.startsWith("total lipid");
  }
}

function hasFiniteValue(nutrient: UsdaNutrient): boolean {
  return (
    typeof nutrient.value === "number" &&
    Number.isFinite(nutrient.value) &&
    nutrient.value >= 0
  );
}

function nutrientValue(food: UsdaFood, kind: NutrientKind): number | null {
  const spec = USDA_NUTRIENT_SPECS[kind];
  const numbers: readonly string[] = spec.numbers;
  const nutrients = food.foodNutrients ?? [];
  const preferred = nutrients.find(
    (nutrient) =>
      numbers.includes(nutrientNumber(nutrient)) &&
      hasExpectedUnit(nutrient, kind) &&
      hasFiniteValue(nutrient),
  );
  if (preferred && typeof preferred.value === "number") return preferred.value;

  const named = nutrients.find(
    (nutrient) =>
      hasExpectedName(nutrient, kind) &&
      hasExpectedUnit(nutrient, kind) &&
      hasFiniteValue(nutrient),
  );
  return named && typeof named.value === "number" ? named.value : null;
}

function stemDescriptionToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function descriptionCoreTokens(value: string): Set<string> {
  return new Set(
    normalizeFoodName(value)
      .split(" ")
      .map(stemDescriptionToken)
      .filter((token) => /^[a-z0-9]+$/.test(token))
      .filter((token) => token.length > 1)
      .filter((token) => !/\d/.test(token))
      .filter((token) => !USDA_DESCRIPTION_FILLER_WORDS.has(token)),
  );
}

function descriptionSimilarity(food: FoodEstimate, description: string): number {
  const queryTokens = descriptionCoreTokens(
    [food.normalizedName, food.displayName].filter(Boolean).join(" "),
  );
  const descriptionTokens = descriptionCoreTokens(description);
  if (queryTokens.size === 0 || descriptionTokens.size === 0) return 0;

  const overlap = [...queryTokens].filter((token) => descriptionTokens.has(token)).length;
  if (overlap === 0) return 0;

  const recall = overlap / queryTokens.size;
  const precision = overlap / descriptionTokens.size;
  return (2 * precision * recall) / (precision + recall);
}

function toPointProfile(food: UsdaFood): NutritionProfile | null {
  if (!food.fdcId || !food.description) return null;
  const calories = nutrientValue(food, "calories");
  const protein = nutrientValue(food, "protein");
  const carbs = nutrientValue(food, "carbs");
  const fat = nutrientValue(food, "fat");
  if (calories === null || protein === null || carbs === null || fat === null) {
    return null;
  }

  const nutrientsPer100g: NutrientRangePer100g = {
    calories: pointNutrient(calories),
    protein: pointNutrient(protein),
    carbs: pointNutrient(carbs),
    fat: pointNutrient(fat),
  };

  return {
    id: `usda-${food.fdcId}`,
    displayName: food.description,
    canonicalName: "usda-generic",
    category: "unknown",
    preparations: ["cooked", "unknown"],
    aliases: [food.description],
    composite: false,
    nutrientsPer100g,
    gramsPerUnit: { g: 1 },
    source: {
      provider: "usda-fdc",
      sourceId: String(food.fdcId),
      sourceName: food.description,
      retrievedAt: new Date().toISOString(),
      attribution: "U.S. Department of Agriculture, FoodData Central（公有領域／CC0）。",
    },
    dataNotice: "USDA FoodData Central 即時查詢結果；單一公開值，烹調差異未必已包含。",
    densityBasis:
      "FDC 回傳的單一 per-100g 值，因此 min = max；只有 g 直接按 1 g 納入，未有可靠的 ml／piece／bowl／cup 換算不會納入。",
  };
}

function nutritionCacheKey(
  food: FoodEstimate,
  identity: ReturnType<typeof canonicalizeFood>,
): string {
  return [
    normalizeFoodName(food.normalizedName || food.displayName),
    identity.canonicalName,
    identity.category,
    identity.preparation,
    [...identity.qualifiers].sort().join(","),
    food.unit,
  ].join("|");
}

const queryCache = new Map<string, NutritionMatch>();

export function clearUsdaCache(): void {
  queryCache.clear();
}

export class UsdaNutritionClient {
  constructor(private readonly apiKey: string) {}

  async resolve(food: FoodEstimate): Promise<NutritionMatch> {
    const identity = canonicalizeFood(food);
    if (isCompositeIdentity(identity)) {
      return {
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: [COMPOSITE_GENERIC_FALLBACK_REASON],
        identity,
        includedInTotal: false,
      };
    }
    if (!this.apiKey.trim()) {
      throw new UsdaNutritionError("missing_key", "USDA API key is not configured.");
    }

    const query = [...new Set(
      [food.normalizedName, food.displayName]
        .map(normalizeFoodName)
        .filter(Boolean),
    )].join(" ");
    const cacheKey = nutritionCacheKey(food, identity);
    const cached = queryCache.get(cacheKey);
    if (cached) return { ...cached, identity };

    try {
      const url = new URL(USDA_SEARCH_URL);
      url.searchParams.set("api_key", this.apiKey);
      url.searchParams.set("query", query);
      url.searchParams.set("pageSize", "5");
      url.searchParams.set("dataType", "Foundation,SR Legacy,Survey (FNDDS)");

      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(USDA_TIMEOUT_MS),
      });

      if (response.status === 429) {
        throw new UsdaNutritionError("rate_limited", "USDA rate limit reached.");
      }
      if (!response.ok) {
        throw new UsdaNutritionError("unavailable", "USDA request failed.");
      }

      const payload = (await response.json()) as UsdaSearchResponse;
      const profile = (payload.foods ?? [])
        .map((candidate) => ({
          candidate,
          similarity: descriptionSimilarity(food, candidate.description ?? ""),
        }))
        .filter(({ similarity }) => similarity >= USDA_DESCRIPTION_SIMILARITY_THRESHOLD)
        .sort((left, right) => right.similarity - left.similarity)
        .map(({ candidate }) => toPointProfile(candidate))
        .find((item): item is NutritionProfile => item !== null);

      if (!profile) {
        const unresolved: NutritionMatch = {
          profile: null,
          confidence: "low",
          matchType: "unresolved",
          reasons: ["USDA 沒有足夠清楚的通用食物資料。"],
          identity,
          includedInTotal: false,
        };
        queryCache.set(cacheKey, unresolved);
        return unresolved;
      }

      const includedInTotal = typeof profile.gramsPerUnit[food.unit] === "number";
      const match: NutritionMatch = {
        profile,
        confidence: "medium",
        matchType: "approximate_generic",
        reasons: [
          "已從 USDA FoodData Central 找到通用食物資料，烹調細節仍然未知。",
          ...(includedInTotal
            ? []
            : [`USDA 未有 ${food.unit} 的可靠克重換算，因此不納入總數。`]),
        ],
        identity,
        includedInTotal,
      };
      queryCache.set(cacheKey, match);
      return match;
    } catch (error) {
      if (error instanceof UsdaNutritionError) throw error;
      if (
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new UsdaNutritionError("timeout", "USDA request timed out.", {
          cause: error,
        });
      }
      throw new UsdaNutritionError("invalid_response", "USDA returned unusable data.", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}
