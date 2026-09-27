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
import { UsdaNutritionClient } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
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
    const existing = await previousMeal(db, user.id, input.id);
    const previous = existing?.record;
    if (existing?.deleted) throw new HttpError(409, "conflict");
    if (previous?.mutationId === input.mutationId)
      return Response.json(
        { record: previous },
        { headers: { "Cache-Control": "no-store" } },
      );
    assertWritableMealSchema(previous);
    if ((previous?.version ?? 0) !== input.version)
      throw new HttpError(409, "conflict");
    if (input.photoPath) throw new HttpError(400, "photos_not_stored");
    const local = new LocalNutritionProvider();
    const key = getNutritionApiKey();
    const usda = key ? new UsdaNutritionClient(key) : null;
    const items = await Promise.all(
      input.items.map(async (item) => {
        const old = previous?.items.find((food) => food.id === item.id);
        let match =
          old &&
          canReuseNutritionMatchForNameEdit(old, item, old.nutritionMatch)
            ? old.nutritionMatch!
            : local.resolve(item);
        if (!match.includedInTotal && usda && input.mode === "live") {
          try {
            const remote = await usda.resolve(item);
            if (remote.includedInTotal) match = remote;
          } catch {
            /* Keep explicit unresolved coverage. */
          }
        }
        return { ...item, nutritionMatch: match };
      }),
    );
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
      ...input,
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
    const saved = await commitMeal(db, user.id, record, input.version);
    return Response.json(
      { record: saved },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
