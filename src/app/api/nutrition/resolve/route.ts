import { NextResponse } from "next/server";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { UsdaNutritionClient, UsdaNutritionError } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import type { NutritionMatch } from "@/lib/nutrition/types";
import { z } from "zod";

export const runtime = "nodejs";

const requestSchema = z.object({
  foods: z.array(foodEstimateSchema).max(12),
});

const publicErrorStatus: Record<string, number> = {
  missing_key: 200,
  timeout: 504,
  rate_limited: 429,
  invalid_response: 502,
  unavailable: 503,
};

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

  for (const food of parsed.data.foods) {
    const localMatch = local.resolve(food);
    if (localMatch.includedInTotal || !usda) {
      matches.push(localMatch);
      continue;
    }

    try {
      const remote = await usda.resolve(food);
      matches.push(remote.includedInTotal ? remote : localMatch);
    } catch (error) {
      if (error instanceof UsdaNutritionError) {
        return NextResponse.json(
          { error: { code: error.code } },
          { status: publicErrorStatus[error.code] ?? 500 },
        );
      }
      return NextResponse.json({ error: { code: "unavailable" } }, { status: 503 });
    }
  }

  return NextResponse.json({
    matches,
    provider: usda ? "usda-fdc" : "kcalcue-reference",
  });
}
