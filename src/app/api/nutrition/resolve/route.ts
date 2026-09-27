import { NextResponse } from "next/server";
import { authenticated, apiError } from "@/lib/server/auth";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { isCompositeIdentity } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { UsdaNutritionClient, UsdaNutritionError } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import {
  NUTRITION_RATE_LIMIT,
  clientIpFromHeaders,
  consumeRateLimit,
  rateLimitedJsonResponse,
} from "@/lib/server/rate-limit";
import type { NutritionMatch } from "@/lib/nutrition/types";
import { elapsedMs, logSafeTiming } from "@/lib/server/timing";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";
import { z } from "zod";

export const runtime = "nodejs";

const requestSchema = z.object({
  foods: z.array(foodEstimateSchema).max(12),
});

export async function POST(request: Request) {
  const ip = clientIpFromHeaders(request.headers);
  if (!consumeRateLimit(`nutrition:${ip}`, NUTRITION_RATE_LIMIT).allowed) {
    const limited = rateLimitedJsonResponse();
    return NextResponse.json(limited.body, {
      status: limited.status,
      headers: limited.headers,
    });
  }

  let body: unknown;
  try {
    const bytes = await readBoundedRequestBody(request, 150_000);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return NextResponse.json(
      { error: { code: "invalid_request" } },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
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
  let remoteAuthorized = false;

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

      // Local reference/demo resolution remains public. A provider-backed
      // lookup requires the same verified trial account as Live analysis.
      if (!remoteAuthorized) {
        try {
          await authenticated(request);
          remoteAuthorized = true;
        } catch (error) {
          return apiError(error);
        }
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
