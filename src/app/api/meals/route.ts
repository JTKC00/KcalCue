import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { mealInputSchema, type MealRecord } from "@/lib/meals/types";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { NutritionService } from "@/lib/nutrition/service";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { canReuseNutritionMatchForNameEdit } from "@/lib/nutrition/client";
import { UsdaNutritionClient } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";

export async function GET(request: Request) {
  try {
    const { db } = await authenticated(request);
    const records: MealRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db
        .from("meals")
        .select("record")
        .is("deleted_at", null)
        .order("id")
        .range(offset, offset + 499);
      if (error) throw new HttpError(503, "load_failed");
      records.push(...data.map((row) => row.record as MealRecord));
      if (data.length < 500) break;
    }
    return Response.json(
      { records },
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
    const { data: existing, error: readError } = await db
      .from("meals")
      .select("record,deleted_at")
      .eq("id", input.id)
      .maybeSingle();
    if (readError) throw new HttpError(503, "load_failed");
    const previous = existing?.record as MealRecord | undefined;
    if (existing?.deleted_at) throw new HttpError(409, "conflict");
    if (previous?.mutationId === input.mutationId)
      return Response.json({ record: previous });
    if ((previous?.version ?? 0) !== input.version)
      throw new HttpError(409, "conflict");
    if (
      input.photoPath &&
      !new RegExp(`^${user.id}/${input.id}/[a-f0-9-]+\\.jpg$`).test(
        input.photoPath,
      )
    )
      throw new HttpError(400, "invalid_photo");
    if (input.photoPath) {
      const { data } = await db
        .from("meal_photos")
        .select("path")
        .eq("path", input.photoPath)
        .eq("ready", true)
        .maybeSingle();
      if (!data) throw new HttpError(400, "invalid_photo");
    }
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
    const totals = new NutritionService(local).calculateMeal(items);
    const row = {
      id: record.id,
      user_id: user.id,
      version: record.version,
      record,
      totals: {
        ranges: totals.totals,
        includedCount: totals.includedCount,
        totalCount: totals.totalCount,
      },
      date: record.date,
    };
    const operation = previous
      ? db
          .from("meals")
          .update(row)
          .eq("id", input.id)
          .eq("version", input.version)
          .is("deleted_at", null)
      : db.from("meals").insert(row);
    const { data, error } = await operation.select("record").maybeSingle();
    if (error || !data) {
      const latest = await db
        .from("meals")
        .select("record,deleted_at")
        .eq("id", input.id)
        .maybeSingle();
      if (
        !latest.data?.deleted_at &&
        latest.data?.record?.mutationId === input.mutationId
      )
        return Response.json({ record: latest.data.record });
      throw new HttpError(
        error && error.code !== "23505" ? 503 : 409,
        error && error.code !== "23505" ? "save_failed" : "conflict",
      );
    }
    return Response.json(
      { record: data.record },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
