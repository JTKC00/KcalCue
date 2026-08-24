import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { canonicalizeFood, isCompositeIdentity } from "./canonical";
import { COMPOSITE_GENERIC_FALLBACK_REASON } from "./compatibility";
import type {
  NutrientRangePer100g,
  NutritionMatch,
  NutritionProfile,
} from "./types";
import { pointNutrient } from "./types";

const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const USDA_TIMEOUT_MS = 8_000;

interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
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

function nutrientValue(food: UsdaFood, names: string[], numbers: string[]): number | null {
  for (const nutrient of food.foodNutrients ?? []) {
    const name = nutrient.nutrientName?.toLowerCase() ?? "";
    const number = String(nutrient.nutrientNumber ?? nutrient.nutrientId ?? "");
    if (
      (names.some((candidate) => name.includes(candidate)) || numbers.includes(number)) &&
      typeof nutrient.value === "number" &&
      Number.isFinite(nutrient.value)
    ) {
      return nutrient.value;
    }
  }
  return null;
}

function toPointProfile(food: UsdaFood): NutritionProfile | null {
  if (!food.fdcId || !food.description) return null;
  const calories = nutrientValue(food, ["energy"], ["208", "1008"]);
  const protein = nutrientValue(food, ["protein"], ["203", "1003"]);
  const carbs = nutrientValue(food, ["carbohydrate"], ["205", "1005"]);
  const fat = nutrientValue(food, ["total lipid", "fat"], ["204", "1004"]);
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
    densityBasis: "FDC 回傳的單一 per-100g 值，因此 min = max。",
  };
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

    const query = [food.normalizedName, food.displayName].filter(Boolean).join(" ").trim();
    const cacheKey = query.toLocaleLowerCase("en");
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
        .map(toPointProfile)
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

      const match: NutritionMatch = {
        profile,
        confidence: "medium",
        matchType: "approximate_generic",
        reasons: ["已從 USDA FoodData Central 找到通用食物資料，烹調細節仍然未知。"],
        identity,
        includedInTotal: true,
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
