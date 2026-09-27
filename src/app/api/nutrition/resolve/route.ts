import { NextResponse } from "next/server";
import { authenticated, apiError } from "@/lib/server/auth";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { isCompositeIdentity } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { supportsUsdaPortionUnit, UsdaNutritionClient, UsdaNutritionError } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
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
const MAX_PARALLEL_USDA_LOOKUPS = 3;

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
  const matches: NutritionMatch[] = parsed.data.foods.map((food) => local.resolve(food));
  const warnings: Array<{ index: number; code: string }> = [];
  const startedAt = performance.now();

  try {
    const remoteIndexes = apiKey ? matches.flatMap((match, index) =>
      !match.includedInTotal &&
      supportsUsdaPortionUnit(parsed.data.foods[index].unit) &&
      !isCompositeIdentity(match.identity) ? [index] : []) : [];
    if (apiKey && remoteIndexes.length > 0 && !request.signal.aborted) {
      // Local reference/demo resolution remains public. A provider-backed
      // lookup requires the same verified trial account as Live analysis.
      let remoteAccount: Awaited<ReturnType<typeof authenticated>>;
      try {
        remoteAccount = await authenticated(request);
      } catch (error) {
        return apiError(error);
      }
      const usda = new UsdaNutritionClient(apiKey, async () =>
        (await reserveHourlyUsdaCall(remoteAccount.db, remoteAccount.user.id)).allowed,
      remoteAccount.user.id);
      let next = 0;
      const worker = async () => {
        while (next < remoteIndexes.length && !request.signal.aborted) {
          // Taking an index is synchronous; workers cannot claim it twice.
          const index = remoteIndexes[next++];
          try {
            const remote = await usda.resolve(parsed.data.foods[index]);
            if (remote.includedInTotal) matches[index] = remote;
          } catch (error) {
            warnings.push({
              index,
              code: error instanceof UsdaNutritionError ? error.code : "unavailable",
            });
          }
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(MAX_PARALLEL_USDA_LOOKUPS, remoteIndexes.length) },
        () => worker(),
      ));
    }

    warnings.sort((left, right) => left.index - right.index);
    const response = {
      matches,
      provider: apiKey ? "usda-fdc" : "kcalcue-reference",
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return NextResponse.json(response);
  } finally {
    logSafeTiming({
      operation: "nutrition-resolve",
      provider: apiKey ? "usda-fdc" : "kcalcue-reference",
      nutritionResolveMs: elapsedMs(startedAt),
      totalMs: elapsedMs(startedAt),
      resolvedCount: matches.length,
    });
  }
}
