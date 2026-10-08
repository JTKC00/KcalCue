import { NextResponse } from "next/server";
import { authenticated, apiError } from "@/lib/server/auth";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { blocksUsdaLiveLookup, isCompositeIdentity, type MealPlantMilkContext } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { supportsUsdaPortionUnit, UsdaNutritionClient, UsdaNutritionError } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
import { acquirePublicBody } from "@/lib/server/public-body-admission";
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
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";
import { z } from "zod";

export const runtime = "nodejs";

const mealContextSchema = z.object({
  visibleEvidence: z.array(z.string().trim().min(1).max(180)).max(12).optional(),
  uncertaintyText: z.array(z.string().trim().min(1).max(180)).max(36).optional(),
  mealNote: z.string().max(2000).nullable().optional(),
}).strict();
const resolveFoodSchema = foodEstimateSchema.safeExtend({
  entrySource: z.enum(["photo", "manual"]).optional(),
});
const requestSchema = z.object({
  foods: z.array(resolveFoodSchema).max(12),
  mealContext: mealContextSchema.optional(),
});
const MAX_PARALLEL_USDA_LOOKUPS = 3;
const USDA_ENRICHMENT_DEADLINE_MS = 12_000;

export async function POST(request: Request) {
  const ip = clientIpFromHeaders(request.headers);
  if (!consumeRateLimit(`nutrition:${ip}`, NUTRITION_RATE_LIMIT).allowed) {
    const limited = rateLimitedJsonResponse();
    return NextResponse.json(limited.body, {
      status: limited.status,
      headers: limited.headers,
    });
  }

  const bodyAdmission = acquirePublicBody("nutrition");
  if (!bodyAdmission.release) {
    const limited = rateLimitedJsonResponse(bodyAdmission.retryAfterSeconds);
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
      { error: { code: error instanceof RequestBodyTimeoutError ? "network_timeout" : "invalid_request" } },
      { status: error instanceof RequestBodyTooLargeError ? 413
        : error instanceof RequestBodyTimeoutError ? 408 : 400 },
    );
  } finally {
    bodyAdmission.release();
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "invalid_request" } }, { status: 400 });
  }

  const local = new LocalNutritionProvider();
  const apiKey = getNutritionApiKey();
  const mealContext: MealPlantMilkContext | undefined = parsed.data.mealContext;
  const matches: NutritionMatch[] = parsed.data.foods.map((food) => local.resolve(food, mealContext));
  const warnings: Array<{ index: number; code: string }> = [];
  const startedAt = performance.now();

  try {
    const remoteIndexes = apiKey ? matches.flatMap((match, index) =>
      !match.includedInTotal &&
      supportsUsdaPortionUnit(parsed.data.foods[index].unit) &&
      !isCompositeIdentity(match.identity) &&
      !blocksUsdaLiveLookup(parsed.data.foods[index], mealContext) ? [index] : []) : [];
    if (apiKey && remoteIndexes.length > 0 && !request.signal.aborted) {
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(), USDA_ENRICHMENT_DEADLINE_MS);
      const signal = AbortSignal.any([request.signal, deadline.signal]);
      let stopAuthentication: () => void = () => {};
      const stopped = new Promise<null>((resolve) => {
        const stop = () => resolve(null);
        signal.addEventListener("abort", stop, { once: true });
        stopAuthentication = () => signal.removeEventListener("abort", stop);
      });
      const completed = new Set<number>();
      try {
        // Local reference/demo resolution remains public. A provider-backed
        // lookup requires the same verified trial account as Live analysis.
        let remoteAccount: Awaited<ReturnType<typeof authenticated>>;
        try {
          const account = await Promise.race([authenticated(request), stopped]);
          if (account === null) {
            for (const index of remoteIndexes) {
              warnings.push({ index, code: deadline.signal.aborted ? "timeout" : "canceled" });
            }
            return NextResponse.json({ matches, provider: "usda-fdc", warnings });
          }
          remoteAccount = account;
        } catch (error) {
          return apiError(error);
        }
        stopAuthentication();
        const usda = new UsdaNutritionClient(apiKey, async () =>
          (await reserveHourlyUsdaCall(remoteAccount.db, remoteAccount.user.id)).allowed,
        remoteAccount.user.id);
        let next = 0;
        const worker = async () => {
          while (next < remoteIndexes.length && !signal.aborted) {
            // Taking an index is synchronous; workers cannot claim it twice.
            const index = remoteIndexes[next++];
            try {
              const remote = await usda.resolve(parsed.data.foods[index], signal);
              if (remote.includedInTotal) matches[index] = remote;
            } catch (error) {
              warnings.push({
                index,
                code: deadline.signal.aborted ? "timeout" :
                  error instanceof UsdaNutritionError ? error.code : "unavailable",
              });
            } finally {
              completed.add(index);
            }
          }
        };
        await Promise.all(Array.from(
          { length: Math.min(MAX_PARALLEL_USDA_LOOKUPS, remoteIndexes.length) },
          () => worker(),
        ));
        if (deadline.signal.aborted) {
          for (const index of remoteIndexes) {
            if (!completed.has(index)) warnings.push({ index, code: "timeout" });
          }
        }
      } finally {
        clearTimeout(timeout);
        stopAuthentication();
      }
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
