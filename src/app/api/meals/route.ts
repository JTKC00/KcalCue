import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { mealInputSchema, type MealRecord } from "@/lib/meals/types";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
import { resolveCalorieCorrection, sameCalorieBasis } from "@/lib/meals/calories";
import { resolveJournalNote } from "@/lib/meals/journal-note";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import {
  listMeals,
  listMealPage,
  previousMeal,
  commitMeal,
  assertWritableMealSchema,
} from "@/lib/firebase/meals";
import { accountPath } from "@/lib/firebase/admin";
import { createEditableFoodItems, hasKnownPortion } from "@/lib/domain/editable-meal";
import { canReuseNutritionMatchForNameEdit, needsServerCatalogCheck } from "@/lib/nutrition/client";
import { blocksUsdaLiveLookup, isCompositeIdentity, mealPlantMilkContext } from "@/lib/nutrition/canonical";
import {
  CATALOG_PROFILE_ID_PREFIX,
  emptyCatalogIndex,
  resolveFromCatalogIndex,
  type CatalogIndex,
} from "@/lib/nutrition/catalog-entry";
import { loadFirestoreNutritionCatalogIndex } from "@/lib/firebase/nutrition-catalog";
import { supportsUsdaPortionUnit, UsdaNutritionClient } from "@/lib/nutrition/usda";
import { getNutritionApiKey } from "@/lib/server/env";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
import { claimMealLookupAttempt, releaseMealLookupAttempt } from "@/lib/server/meal-lookup-attempt";
import { copy } from "@/content/zh-HK";
import {
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";

type FullReadMode = "legacy_revisioned" | "legacy_revisionless" | "paged_revisionless";

async function readFullMealList(db: Firestore, uid: string, mode: FullReadMode) {
  const startedAt = performance.now();
  let activeRecordCount: number | null = null;
  try {
    const records = await listMeals(db, uid);
    activeRecordCount = records.length;
    return records;
  } finally {
    // This measures the fallback scan without recording an account identifier,
    // revision, cursor, meal content, or raw error. Logging must never make a
    // successful read fail or cause a client retry of the full query.
    try {
      console.info("[kcalcue:meal-full-read]", {
        mode,
        querySucceeded: activeRecordCount !== null,
        activeRecordCount,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    } catch { /* Observability is best effort. */ }
  }
}

export async function GET(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    const params = new URL(request.url).searchParams;
    const paged = params.get("paged") === "1";
    const cursor = params.get("cursor");
    const expectedRevision = params.get("revision");
    if (paged && (
      (cursor !== null && !z.uuid().safeParse(cursor).success) ||
      (cursor !== null && (!expectedRevision || expectedRevision.length > 128)) ||
      (cursor === null && expectedRevision !== null)
    )) throw new HttpError(400, "invalid_request");
    const revision =
      (await db.doc(accountPath(user.id)).get()).data()?.revision ?? "empty";
    if (paged && cursor !== null && revision === "empty")
      throw new HttpError(409, "snapshot_changed");
    if (paged && cursor !== null && expectedRevision !== revision)
      throw new HttpError(409, "snapshot_changed");
    // An absent account revision cannot prove that the meal collection is empty
    // (for example after an import or metadata repair). Always read it in that case.
    if (cursor === null && revision !== "empty" && params.get("since") === revision)
      return Response.json(
        { revision },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (paged) {
      // Legacy imports can have meals without an account revision. Their
      // concurrent changes cannot be detected across page requests, so read
      // one complete Firestore query snapshot until metadata is established.
      const page = revision === "empty"
        ? { records: await readFullMealList(db, user.id, "paged_revisionless") }
        : await listMealPage(db, user.id, cursor ?? undefined);
      const afterRevision =
        (await db.doc(accountPath(user.id)).get()).data()?.revision ?? "empty";
      if (afterRevision !== revision) throw new HttpError(409, "snapshot_changed");
      return Response.json(
        { ...page, revision },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const records = await readFullMealList(
      db, user.id, revision === "empty" ? "legacy_revisionless" : "legacy_revisioned",
    );
    const afterRevision =
      (await db.doc(accountPath(user.id)).get()).data()?.revision ?? "empty";
    if (afterRevision !== revision) throw new HttpError(409, "snapshot_changed");
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
        error instanceof RequestBodyTooLargeError ? 413
          : error instanceof RequestBodyTimeoutError ? 408 : 400,
        error instanceof RequestBodyTimeoutError ? "network_timeout" : "invalid_request",
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
    if (previous?.mutationId === input.mutationId) {
      const committedNote = previous.journalNote ?? null;
      if (resolveJournalNote(input.journalNote, committedNote) !== committedNote)
        throw new HttpError(409, "conflict");
      return Response.json(
        { record: previous },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    assertWritableMealSchema(previous);
    if ((previous?.version ?? 0) !== input.version)
      throw new HttpError(409, "conflict");
    if (input.photoPath) throw new HttpError(400, "photos_not_stored");
    const { photoAction, journalNote, ...mealInput } = input;
    const local = new LocalNutritionProvider();
    const key = getNutritionApiKey();
    const usda = key ? new UsdaNutritionClient(key, async () =>
      (await reserveHourlyUsdaCall(db, user.id)).allowed, user.id) : null;
    const resolvedNote = resolveJournalNote(journalNote, previous?.journalNote);
    const analysisForNutrition = previous ? previous.analysis : input.analysis;
    const mealContext = mealPlantMilkContext({
      analysis: analysisForNutrition,
      mealNote: resolvedNote,
    });
    const previousContext = mealPlantMilkContext({
      analysis: previous?.analysis ?? null,
      mealNote: previous?.journalNote ?? null,
    });
    const noteChanged = resolvedNote !== (previous?.journalNote ?? null);
    const reusePreviousNutrition =
      journalNote !== undefined &&
      !!previous &&
      input.mode === previous.mode &&
      sameCalorieBasis(input.items, previous.items);
    const previousItems = new Map(previous?.items.map((item) => [item.id, item]) ?? []);
    const plantMilkGuardUnchanged = (item: typeof input.items[number]) =>
      blocksUsdaLiveLookup(item, mealContext) === blocksUsdaLiveLookup(item, previousContext);

    // Only load Firestore catalog shards when at least one item actually requires catalog lookup
    // (or when a journal-note edit may add/remove a brand cue for a catalog match).
    let catalogIndex: CatalogIndex = emptyCatalogIndex();
    const analysisNeedsCatalog =
      !previous?.originalItems &&
      Boolean(analysisForNutrition?.foods.some((food) => {
        if (!hasKnownPortion(food)) return false;
        const photoFood = { ...food, entrySource: "photo" as const };
        return needsServerCatalogCheck(photoFood, local.resolve(photoFood, mealContext), mealContext);
      }));
    const itemsNeedCatalog = input.items.some((item) => {
      if (!hasKnownPortion(item)) return false;
      const old = previousItems.get(item.id);
      const oldIsCatalog = Boolean(old?.nutritionMatch?.profile?.id.startsWith(CATALOG_PROFILE_ID_PREFIX));
      if (noteChanged && oldIsCatalog) return true;
      const canReuse =
        old &&
        plantMilkGuardUnchanged(item) &&
        !noteChanged &&
        (reusePreviousNutrition ||
          (hasKnownPortion(old) && canReuseNutritionMatchForNameEdit(old, item, old.nutritionMatch)));
      if (canReuse) return false;
      return needsServerCatalogCheck(item, local.resolve(item, mealContext), mealContext);
    });
    if (itemsNeedCatalog || analysisNeedsCatalog) {
      catalogIndex = await loadFirestoreNutritionCatalogIndex(db);
    }

    const resolveWithCatalog = (
      food: Parameters<typeof local.resolve>[0],
    ) => {
      const localMatch = local.resolve(food, mealContext);
      if (catalogIndex.entryCount > 0 && needsServerCatalogCheck(food, localMatch, mealContext)) {
        const catalogMatch = resolveFromCatalogIndex(food, catalogIndex, localMatch, mealContext);
        if (catalogMatch && (catalogMatch.includedInTotal || !localMatch.includedInTotal)) {
          return { match: catalogMatch, catalogHandled: true };
        }
      }
      return { match: localMatch, catalogHandled: false };
    };

    const catalogHandledIds = new Set<string>();
    const reusedItemIds = new Set<string>();
    const initialItems = input.items.map((item) => {
      if (!hasKnownPortion(item)) return { ...item, nutritionMatch: null };
      const old = previousItems.get(item.id);
      const baseReusable =
        old &&
        plantMilkGuardUnchanged(item) &&
        (reusePreviousNutrition ||
          (hasKnownPortion(old) && canReuseNutritionMatchForNameEdit(old, item, old.nutritionMatch)));

      if (baseReusable) {
        if (noteChanged) {
          const oldProfileId = old.nutritionMatch?.profile?.id ?? null;
          const oldIsCatalog = Boolean(oldProfileId?.startsWith(CATALOG_PROFILE_ID_PREFIX));
          const fresh = resolveWithCatalog(item);
          const freshProfileId = fresh.match.profile?.id ?? null;
          if ((oldIsCatalog && freshProfileId !== oldProfileId) || (fresh.catalogHandled && freshProfileId !== oldProfileId)) {
            if (fresh.catalogHandled) catalogHandledIds.add(item.id);
            return { ...item, nutritionMatch: fresh.match };
          }
        }
        reusedItemIds.add(item.id);
        return { ...item, nutritionMatch: old.nutritionMatch ?? null };
      }

      const resolved = resolveWithCatalog(item);
      if (resolved.catalogHandled) catalogHandledIds.add(item.id);
      return { ...item, nutritionMatch: resolved.match };
    });
    const isRemoteEligible = (
      food: Parameters<typeof local.resolve>[0],
      match: ReturnType<typeof local.resolve> | null,
      handledByCatalog: boolean,
    ) =>
      !handledByCatalog &&
      hasKnownPortion(food) &&
      match !== null &&
      !match.includedInTotal &&
      supportsUsdaPortionUnit(food.unit) &&
      !isCompositeIdentity(match.identity) &&
      !blocksUsdaLiveLookup(food, mealContext);
    const needsRemote = (item: typeof initialItems[number]) =>
      !reusedItemIds.has(item.id) &&
      hasKnownPortion(item) &&
      isRemoteEligible(item, item.nutritionMatch, catalogHandledIds.has(item.id));
    // All writes participate in this claim. Otherwise a changed local/manual
    // payload with the same mutation ID could race a Live lookup and commit
    // first, causing the eventual Live request to acknowledge the wrong body.
    const attempt = await claimMealLookupAttempt(db, {
      uid: user.id,
      mealId: input.id,
      mutationId: input.mutationId,
      expectedVersion: input.version,
      fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
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
      const resolveRemote = async (
        food: Parameters<typeof local.resolve>[0],
        match: ReturnType<typeof local.resolve>,
      ) => {
        if (!usda) return match;
        if (!allowRemote) {
          return {
            ...match,
            reasons: [copy.nutritionLookupFailed,
              ...match.reasons.filter((reason) => reason !== copy.nutritionLookupFailed)],
          };
        }
        try {
          const remote = await usda.resolve(food);
          return remote.includedInTotal ? remote : match;
        } catch {
          // An unavailable provider or exhausted budget cannot create a
          // trusted nutrition value. Save the meal with explicit uncertainty.
          return {
            ...match,
            reasons: [copy.nutritionLookupFailed,
              ...match.reasons.filter((reason) => reason !== copy.nutritionLookupFailed)],
          };
        }
      };

      const items = await Promise.all(initialItems.map(async (item) => {
        let match = item.nutritionMatch;
        if (needsRemote(item) && match && hasKnownPortion(item)) {
          match = await resolveRemote(item, match);
        }
        return { ...item, nutritionMatch: match };
      }));
      const analysis = previous ? previous.analysis : input.analysis;
      const originalItems = previous?.originalItems
        ? previous.originalItems
        : analysis
          ? await (async () => {
              const seeded = createEditableFoodItems(analysis.foods).map((item) => ({
                ...item,
                entrySource: "photo" as const,
              }));
              const resolvedOriginalMatches = await Promise.all(seeded.map(async (origItem) => {
                if (!hasKnownPortion(origItem)) return null;
                const matchingCurrent = items.find((current) =>
                  current.id === origItem.id &&
                  current.displayName === origItem.displayName &&
                  current.normalizedName === origItem.normalizedName &&
                  current.identityLevel === origItem.identityLevel &&
                  current.unit === origItem.unit &&
                  (current.preparationMethod ?? "") === (origItem.preparationMethod ?? "") &&
                  (current.notes ?? "") === (origItem.notes ?? "") &&
                  current.userMilkTypeChoice === origItem.userMilkTypeChoice &&
                  (origItem.unit !== "piece" ||
                    (current.portionMax !== null && (current.portionMax > 1) === (origItem.portionMax > 1))),
                );
                if (matchingCurrent?.nutritionMatch) return matchingCurrent.nutritionMatch;
                const resolved = resolveWithCatalog(origItem);
                if (isRemoteEligible(origItem, resolved.match, resolved.catalogHandled)) {
                  return resolveRemote(origItem, resolved.match);
                }
                return resolved.match;
              }));
              return seeded.map((item, idx) => ({
                ...item,
                nutritionMatch: resolvedOriginalMatches[idx] ?? null,
              }));
            })()
          : items;
      const record: Omit<MealRecord, "updatedAt"> = {
        ...mealInput,
        calorieCorrection: resolveCalorieCorrection(input.calorieCorrection, input.items, previous),
        journalNote: resolvedNote,
        items,
        analysis,
        analysisProvenance: previous
          ? previous.analysisProvenance ?? null
          : analysis ? readAnalysisProvenance(input.analysisProvenance, input.mode) : null,
        originalItems,
        userId: user.id,
        version: input.version + 1,
      };
      const saved = await commitMeal(db, user.id, record, input.version, photoAction);
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
