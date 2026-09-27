import { createHash } from "node:crypto";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { mealInputSchema, type MealRecord } from "@/lib/meals/types";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
import { resolveCalorieCorrection } from "@/lib/meals/calories";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import {
  listMeals,
  previousMeal,
  commitMeal,
  assertWritableMealSchema,
} from "@/lib/firebase/meals";
import { accountPath } from "@/lib/firebase/admin";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { canReuseNutritionMatchForNameEdit } from "@/lib/nutrition/client";
import { isCompositeIdentity } from "@/lib/nutrition/canonical";
import { supportsUsdaPortionUnit, UsdaNutritionClient } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
import { claimMealLookupAttempt, releaseMealLookupAttempt } from "@/lib/server/meal-lookup-attempt";
import { copy } from "@/content/zh-HK";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";

export async function GET(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    const revision =
      (await db.doc(accountPath(user.id)).get()).data()?.revision ?? "empty";
    // An absent account revision cannot prove that the meal collection is empty
    // (for example after an import or metadata repair). Always read it in that case.
    if (revision !== "empty" && new URL(request.url).searchParams.get("since") === revision)
      return Response.json(
        { revision },
        { headers: { "Cache-Control": "no-store" } },
      );
    const records = await listMeals(db, user.id);
    return Response.json(
      { records, revision },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    let text: string;
    try {
      // UTF-8 needs at most three bytes per UTF-16 code unit; keep the existing
      // 150,000-character allowance, then enforce that limit after decoding.
      const bytes = await readBoundedRequestBody(request, 450_000);
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      throw new HttpError(
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        "invalid_request",
      );
    }
    if (text.length > 150_000) throw new HttpError(413, "invalid_request");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid_request");
    }
    const parsed = mealInputSchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, "invalid_request");
    const input = parsed.data;
    const inputFingerprint = createHash("sha256")
      .update(JSON.stringify(input)).digest("hex");
    const existing = await previousMeal(db, user.id, input.id);
    const previous = existing?.record;
    if (existing?.deleted) throw new HttpError(409, "conflict");
    if (previous?.mutationId === input.mutationId) {
      // Validate the replay against the durable fingerprint before returning
      // its old ACK; a changed meal or photo action must not appear saved.
      const replay = await claimMealLookupAttempt(db, {
        uid: user.id, mealId: input.id, mutationId: input.mutationId,
        expectedVersion: input.version, fingerprint: inputFingerprint,
      });
      if (replay.state !== "committed") throw new HttpError(409, "conflict");
      return Response.json(
        { record: replay.record },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    assertWritableMealSchema(previous);
    if ((previous?.version ?? 0) !== input.version)
      throw new HttpError(409, "conflict");
    if (input.photoPath) throw new HttpError(400, "photos_not_stored");
    const { photoAction, ...mealInput } = input;
    const local = new LocalNutritionProvider();
    const key = getNutritionApiKey();
    const usda = key ? new UsdaNutritionClient(key, async () =>
      (await reserveHourlyUsdaCall(db, user.id)).allowed, user.id) : null;
    const initialItems = input.items.map((item) => {
      const old = previous?.items.find((food) => food.id === item.id);
      const match =
        old &&
        canReuseNutritionMatchForNameEdit(old, item, old.nutritionMatch)
          ? old.nutritionMatch!
          : local.resolve(item);
      return { ...item, nutritionMatch: match };
    });
    const needsRemote = (item: typeof initialItems[number]) =>
      !item.nutritionMatch.includedInTotal &&
      supportsUsdaPortionUnit(item.unit) &&
      !isCompositeIdentity(item.nutritionMatch.identity);
    // All writes participate in this claim. Otherwise a changed local/manual
    // payload with the same mutation ID could race a Live lookup and commit
    // first, causing the eventual Live request to acknowledge the wrong body.
    const attempt = await claimMealLookupAttempt(db, {
      uid: user.id,
      mealId: input.id,
      mutationId: input.mutationId,
      expectedVersion: input.version,
      fingerprint: inputFingerprint,
    });
    if (attempt.state === "committed")
      return Response.json(
        { record: attempt.record },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (attempt.state === "busy")
      throw new HttpError(503, "operation_in_progress");
    const attemptToken = attempt.token;
    const allowRemote = attempt.state === "claimed";
    try {
      const items = await Promise.all(initialItems.map(async (item) => {
        let match = item.nutritionMatch;
        if (needsRemote(item) && usda && input.mode === "live" && allowRemote) {
          try {
            const remote = await usda.resolve(item);
            if (remote.includedInTotal) match = remote;
          } catch {
            // An unavailable provider or exhausted budget cannot create a
            // trusted nutrition value. Save the meal with explicit uncertainty.
            match = {
              ...match,
              reasons: [copy.nutritionLookupFailed,
                ...match.reasons.filter((reason) => reason !== copy.nutritionLookupFailed)],
            };
          }
        } else if (needsRemote(item) && usda && input.mode === "live" && !allowRemote) {
          match = {
            ...match,
            reasons: [copy.nutritionLookupFailed,
              ...match.reasons.filter((reason) => reason !== copy.nutritionLookupFailed)],
          };
        }
        return { ...item, nutritionMatch: match };
      }));
      const analysis = previous ? previous.analysis : input.analysis;
      const originalItems =
        previous?.originalItems ??
        (analysis
          ? createEditableFoodItems(
              analysis.foods,
              analysis.foods.map((food) => local.resolve(food)),
            )
          : items);
      const record: Omit<MealRecord, "updatedAt"> = {
        ...mealInput,
        calorieCorrection: resolveCalorieCorrection(input.calorieCorrection, input.items, previous),
        items,
        analysis,
        analysisProvenance: previous
          ? previous.analysisProvenance ?? null
          : analysis ? readAnalysisProvenance(input.analysisProvenance, input.mode) : null,
        originalItems,
        userId: user.id,
        version: input.version + 1,
      };
      const saved = await commitMeal(db, user.id, record, input.version, photoAction, inputFingerprint);
      return Response.json(
        { record: saved },
        { headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      // The meal write remains authoritative even when best-effort lease
      // cleanup is unavailable. A committed retry is acknowledged by ID.
      await releaseMealLookupAttempt(db, {
        uid: user.id, mealId: input.id, token: attemptToken,
      }).catch(() => {});
    }
  } catch (error) {
    return apiError(error);
  }
}
