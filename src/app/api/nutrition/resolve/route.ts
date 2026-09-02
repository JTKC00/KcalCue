import { NextResponse } from "next/server";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { isCompositeIdentity } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { UsdaNutritionClient, UsdaNutritionError } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import type { NutritionMatch } from "@/lib/nutrition/types";
import { elapsedMs, logSafeTiming } from "@/lib/server/timing";
import { z } from "zod";

export const runtime = "nodejs";

const requestSchema = z.object({
  foods: z.array(foodEstimateSchema).max(12),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400 });
  }

  const local = new LocalNutritionProvider();
  const apiKey = getNutritionApiKey();
  const usda = apiKey ? new UsdaNutritionClient(apiKey) : null;
  const matches: NutritionMatch[] = [];
  const warnings: Array<{ index: number; code: string }> = [];
  const startedAt = performance.now();

  try {
    for (const [index, food] of parsed.data.foods.entries()) {
      const localMatch = local.resolve(food);
      if (
        localMatch.includedInTotal ||
        !usda ||
        isCompositeIdentity(localMatch.identity)
      ) {
        matches.push(localMatch);
        continue;
      }

      try {
        const remote = await usda.resolve(food);
        matches.push(remote.includedInTotal ? remote : localMatch);
      } catch (error) {
        matches.push(localMatch);
        warnings.push({
          index,
          code: error instanceof UsdaNutritionError ? error.code : "unavailable",
        });
      }
    }

    const response = {
      matches,
      provider: usda ? "usda-fdc" : "kcalcue-reference",
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return NextResponse.json(response);
  } finally {
    logSafeTiming({
      operation: "nutrition-resolve",
      provider: usda ? "usda-fdc" : "kcalcue-reference",
      nutritionResolveMs: elapsedMs(startedAt),
      totalMs: elapsedMs(startedAt),
      resolvedCount: matches.length,
    });
  }
}
