import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { mealInputSchema, type MealRecord } from "@/lib/meals/types";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { listMeals, previousMeal, commitMeal } from "@/lib/firebase/meals";
import { accountPath } from "@/lib/firebase/admin";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { canReuseNutritionMatchForNameEdit } from "@/lib/nutrition/client";
import { UsdaNutritionClient } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";

export async function GET(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    const revision =
      (await db.doc(accountPath(user.id)).get()).data()?.revision ?? "empty";
    if (new URL(request.url).searchParams.get("since") === revision)
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
    const text = await request.text();
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
    const record: MealRecord = {
      ...input,
      items,
      analysis,
      originalItems,
      userId: user.id,
      version: input.version + 1,
      updatedAt: new Date().toISOString(),
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
