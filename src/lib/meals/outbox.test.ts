// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { foodEstimateSchema } from "@/lib/domain/food-analysis";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { CURRENT_MEAL_SCHEMA_VERSION, dayNutrition, newDraft } from "./types";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { MealRepository } from "./repository";
import { changeSyncState, clearSyncState } from "./outbox";
import { dayCalories } from "./calories";
import { provenance } from "@/test/provenance-fixture";

const fixture = vi.hoisted(() => ({ uid: "a", fetch: vi.fn() }));
vi.mock("@/lib/firebase/client", () => ({
  firebaseAuth: () => ({ currentUser: { uid: fixture.uid, metadata: {} } }),
  authorizedFetch: fixture.fetch,
}));
const repository = new MealRepository();
const draft = () => ({
  ...newDraft(),
  items: createEditableFoodItems(demoFoodAnalysis.foods),
});
beforeEach(async () => {
  fixture.uid = "a";
  fixture.fetch.mockReset();
  localStorage.clear();
  await clearSyncState("a");
  await clearSyncState("b");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  const tails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (key: string, run: () => Promise<unknown>) => {
        const pending = (tails.get(key) ?? Promise.resolve())
          .catch(() => {})
          .then(run);
        tails.set(key, pending);
        return pending;
      },
    },
  });
});
describe("durable offline meal outbox", () => {
  it("keeps reading and writing queued meals after an additive IDB schema upgrade", async () => {
    const mutationId = crypto.randomUUID();
    const queued = await repository.save(draft(), mutationId);
    const before = await changeSyncState("a", (state) => ({ ...state, revision: "prior" }));
    expect(before.jobs).toMatchObject([{ id: mutationId, expectedVersion: 0,
      record: { id: queued.id } }]);
    const currentVersion = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open("kcalcue-sync");
      request.onsuccess = () => {
        const version = request.result.version;
        request.result.close();
        resolve(version);
      };
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("kcalcue-sync", currentVersion + 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("photoPayloads"))
          request.result.createObjectStore("photoPayloads");
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    expect(await changeSyncState("a")).toEqual(before);
    expect((await changeSyncState("a", (state) => ({ ...state, revision: "after" }))).revision)
      .toBe("after");
    expect((await new MealRepository().state()).jobs).toEqual(before.jobs);
  });
  it("retains provenance and retry identity across offline reload and a lost ACK", async () => {
    const mutationId = crypto.randomUUID();
    const input = { ...draft(), mode: "live" as const, analysis: demoFoodAnalysis, analysisProvenance: provenance,
      calorieCorrection: { kcal: 723, source: "user" as const }, calorieInput: "723" };
    const saved = await repository.save(input, mutationId);
    expect((await new MealRepository().list())[0].analysisProvenance).toEqual(provenance);
    fixture.fetch.mockRejectedValueOnce(new TypeError("ACK lost"));
    await expect(repository.sync()).rejects.toThrow("ACK lost");
    const cloud = { ...saved, schemaVersion: 3, createdAt: "2026-09-26T20:00:00.000Z" };
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: cloud }))
      .mockResolvedValueOnce(Response.json({ records: [cloud] }));
    await new MealRepository().sync();
    expect(await repository.list()).toEqual([cloud]);
    const commands = fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.mutationId).toBe(mutationId);
      expect(command.version).toBe(0);
      expect(command.analysisProvenance).toEqual(provenance);
      expect(command.calorieCorrection).toEqual(input.calorieCorrection);
      expect(command).not.toHaveProperty("calorieInput");
      expect(command).not.toHaveProperty("createdAt");
    }
  });
  it.each([false, true])("does not replace the original analysis through an omitted/forged queued edit (confirmed=%s)", async (confirmed) => {
    const first = await repository.save({ ...draft(), mode: "live", analysis: demoFoodAnalysis, analysisProvenance: provenance }, crypto.randomUUID());
    const changedAnalysis = { ...demoFoodAnalysis, visibleEvidence: ["replacement"] };
    const edit = { ...first, version: 2, analysis: changedAnalysis, originalItems: [], analysisProvenance: undefined, time: "19:30" };
    const editId = crypto.randomUUID();
    await changeSyncState("a", (state) => ({ ...state, remote: confirmed ? [first] : [], jobs: [
      ...(confirmed ? [] : state.jobs), { id: editId, kind: "save", record: edit, expectedVersion: 1 },
    ] }));
    const visible = (await new MealRepository().list())[0];
    expect(visible.analysis).toEqual(first.analysis);
    expect(visible.originalItems).toEqual(first.originalItems);
    expect(visible.analysisProvenance).toEqual(provenance);
    expect(visible.time).toBe("19:30");
    expect((await repository.state()).jobs.at(-1)).toMatchObject({ id: editId, expectedVersion: 1, record: edit });
    await changeSyncState("a", (state) => ({ ...state, jobs: state.jobs.map((job) => job.id === editId
      ? { ...job, record: { ...job.record, analysisProvenance: { ...provenance, requestedModel: "replacement" } } } : job) }));
    expect((await repository.list())[0].analysisProvenance).toEqual(provenance);
  });
  it("reloads the corrected meal while the original Gemini analysis stays unchanged", async () => {
    const original = createEditableFoodItems([{
      ...demoFoodAnalysis.foods[1],
      displayName: "烤雞肉",
      normalizedName: "grilled chicken",
    }])[0];
    const corrected = {
      ...original,
      displayName: "三文魚",
      normalizedName: "三文魚",
      nutritionMatch: new LocalNutritionProvider().resolve({
        ...original,
        displayName: "三文魚",
        normalizedName: "三文魚",
        portionMin: original.portionMin ?? 140,
        portionMax: original.portionMax ?? 180,
      }),
    };
    const analysis = {
      ...demoFoodAnalysis,
      foods: [{ ...demoFoodAnalysis.foods[1], displayName: "烤雞肉", normalizedName: "grilled chicken" }],
    };
    const gemini = {
      ...provenance,
      provider: "gemini" as const,
      requestedModel: "gemini-3.8-flash",
      reportedModel: "gemini-3.8-flash",
    };
    await repository.save({
      ...draft(),
      mode: "live",
      analysis,
      analysisProvenance: gemini,
      items: [corrected],
      originalItems: [original],
    }, crypto.randomUUID());
    const reloaded = (await repository.list())[0];
    expect(reloaded.items[0].displayName).toBe("三文魚");
    expect(reloaded.items[0].nutritionMatch?.profile?.canonicalName).toBe("salmon");
    expect(reloaded.analysis?.foods[0].displayName).toBe("烤雞肉");
    expect(reloaded.originalItems[0].displayName).toBe("烤雞肉");
    expect(reloaded.analysisProvenance?.provider).toBe("gemini");
  });
  it("keeps a legacy cloud baseline unknown despite newly supplied pending metadata", async () => {
    const first = await repository.save({ ...draft(), mode: "live", analysis: demoFoodAnalysis }, crypto.randomUUID());
    const { analysisProvenance: _removed, ...legacy } = first;
    void _removed;
    await changeSyncState("a", () => ({ remote: [legacy], syncedAt: null,
      jobs: [{ id: first.mutationId, kind: "save", record: { ...first, analysisProvenance: provenance }, expectedVersion: 1 }] }));
    expect((await repository.list())[0].analysisProvenance).toBeNull();
    expect((await repository.list())[0].analysis).toEqual(first.analysis);
  });
  it("keeps a confirmed private photo visible during an offline edit without queueing its reference", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    const photoRef = {
      attachmentId: crypto.randomUUID(), generation: "1234567890123",
      contentType: "image/jpeg" as const, width: 1200, height: 900, byteSize: 100_000,
    };
    const confirmed = {
      ...first, schemaVersion: 4, createdAt: "2026-09-26T20:00:00.000Z", photoRef,
    };
    await changeSyncState("a", () => ({ remote: [confirmed], syncedAt: null, jobs: [] }));
    Object.defineProperty(navigator, "onLine", { value: false });

    const visible = await repository.save({ ...confirmed, time: "19:30" }, crypto.randomUUID());
    expect(visible.time).toBe("19:30");
    expect(visible.photoRef).toEqual(photoRef);
    expect((await new MealRepository().list())[0].photoRef).toEqual(photoRef);
    const queued = (await repository.state()).jobs[0].record;
    expect(queued).not.toHaveProperty("photoRef");
    expect(queued.schemaVersion).toBe(4);
  });
  it("never discards another account's pending meal after a delayed recovery", async () => {
    const input = draft();
    await repository.save(input, crypto.randomUUID());
    fixture.uid = "b";
    await repository.save(input, crypto.randomUUID());
    await expect(repository.discardPending(input.id, "a")).rejects.toMatchObject({
      code: "login_required",
    });
    expect((await repository.state("a")).jobs).toHaveLength(1);
    expect((await repository.state("b")).jobs).toHaveLength(1);
  });
  it("rechecks account ownership after waiting for the synchronization lock", async () => {
    const input = draft();
    await repository.save(input, crypto.randomUUID());
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = navigator.locks.request("kcalcue-sync-a", async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await started;
    const discard = repository.discardPending(input.id, "a");
    const rejected = expect(discard).rejects.toMatchObject({ code: "login_required" });
    fixture.uid = "b";
    release();
    await held;
    await rejected;
    expect((await repository.state("a")).jobs).toHaveLength(1);
  });
  it("blocks a stale tab from syncing or enqueueing after explicit logout", async () => {
    await repository.save(draft(), crypto.randomUUID());
    localStorage.setItem("kcalcue-logout", `a:${Date.now()}`);
    await expect(repository.sync("a")).rejects.toMatchObject({
      code: "login_required",
    });
    await expect(
      repository.save(draft(), crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "login_required" });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("saves offline, survives a repository restart, and never queues photo bytes", async () => {
    Object.defineProperty(navigator, "onLine", { value: false });
    const input = {
      ...draft(),
      photo: new Blob(["private image"]),
      photoPath: "old/photo.jpg",
    };
    const saved = await repository.save(input, crypto.randomUUID());
    expect(await new MealRepository().list()).toEqual([saved]);
    const state = await changeSyncState("a");
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0].record.photoPath).toBeNull();
    expect(state.jobs[0].record).not.toHaveProperty("photo");
    await repository.sync();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("preserves resolved nutrition and today totals through an offline save and portion edit", async () => {
    const input = draft();
    const match = new LocalNutritionProvider().resolve(foodEstimateSchema.parse(input.items[0]));
    expect(match.includedInTotal).toBe(true);
    input.items = [{
      ...input.items[0],
      displayName: "QA externally resolved grain",
      normalizedName: "qa-externally-resolved-grain",
      nutritionMatch: match,
    }];
    const saved = await repository.save(input, crypto.randomUUID());
    expect(saved.items[0].nutritionMatch).toEqual(match);
    const initial = dayNutrition([saved]);
    expect(initial.totals.calories.min).toBeGreaterThan(0);
    const edited = await repository.save({
      ...saved,
      items: saved.items.map((item) => ({
        ...item, portionMin: item.portionMin! * 2, portionMax: item.portionMax! * 2,
      })),
    }, crypto.randomUUID());
    const restored = await new MealRepository().list();
    expect(restored).toEqual([edited]);
    expect(dayNutrition(restored).totals.calories.min).toBe(initial.totals.calories.min * 2);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("keeps the same mutation after a lost response and overlays pending changes on remote data", async () => {
    const input = draft();
    const mutationId = crypto.randomUUID();
    const saved = await repository.save(input, mutationId);
    fixture.fetch.mockRejectedValueOnce(new TypeError("network lost"));
    await expect(repository.sync()).rejects.toThrow();
    expect((await repository.state()).jobs[0].id).toBe(mutationId);
    fixture.fetch
      .mockResolvedValueOnce(Response.json({ record: saved }))
      .mockResolvedValueOnce(Response.json({ records: [saved] }));
    await new MealRepository().sync();
    expect((await repository.state()).jobs).toHaveLength(0);
    expect(await repository.list()).toEqual([saved]);
    const requests = fixture.fetch.mock.calls.filter(
      (call) => call[1]?.method === "POST",
    );
    expect(requests.map((call) => JSON.parse(call[1].body).mutationId)).toEqual(
      [mutationId, mutationId],
    );
  });
  it("retains an in-progress meal attempt for automatic retry with the same mutation", async () => {
    const mutationId = crypto.randomUUID();
    const saved = await repository.save(draft(), mutationId);
    fixture.fetch.mockResolvedValueOnce(Response.json(
      { error: { code: "operation_in_progress" } }, { status: 503 },
    ));
    await expect(repository.sync()).rejects.toMatchObject({
      code: "operation_in_progress", status: 503,
    });
    expect((await repository.state()).jobs).toMatchObject([{ id: mutationId }]);
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: saved }))
      .mockResolvedValueOnce(Response.json({ records: [saved] }));
    await new MealRepository().sync();
    expect((await repository.state()).jobs).toHaveLength(0);
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body).mutationId)).toEqual([mutationId, mutationId]);
  });
  it("queues edits and deletion in order while a concurrent tab syncs", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    const second = await repository.save(
      { ...first, time: "13:00" },
      crypto.randomUUID(),
    );
    await repository.delete(second);
    expect(await repository.list()).toEqual([]);
    fixture.fetch.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? Response.json({
            record: {
              ...JSON.parse(init.body),
              version: JSON.parse(init.body).version + 1,
            },
          })
        : Response.json(
            init?.method === "DELETE" ? { ok: true } : { records: [] },
          ),
    );
    await Promise.all([repository.sync(), new MealRepository().sync()]);
    expect(
      fixture.fetch.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(2);
    expect(
      fixture.fetch.mock.calls.filter((call) => call[1]?.method === "DELETE"),
    ).toHaveLength(1);
    expect((await repository.state()).jobs).toHaveLength(0);
  });
  it("accepts an identical queued save retry without duplicating its job", async () => {
    Object.defineProperty(navigator, "onLine", { value: false });
    const input = draft();
    const mutationId = crypto.randomUUID();
    const first = await repository.save(input, mutationId);
    const retry = await new MealRepository().save(input, mutationId);
    expect(retry).toEqual(first);
    expect((await repository.state()).jobs).toHaveLength(1);
    expect((await repository.state()).jobs[0].id).toBe(mutationId);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("rejects a stale second-tab delete after an offline edit", async () => {
    Object.defineProperty(navigator, "onLine", { value: false });
    const secondTab = new MealRepository();
    const first = await repository.save(draft(), crypto.randomUUID());
    const edited = await repository.save({ ...first, time: "13:00" }, crypto.randomUUID());
    await expect(secondTab.delete(first)).rejects.toMatchObject({
      code: "conflict", status: 409,
    });
    expect((await repository.state()).jobs).toHaveLength(2);
    expect(await secondTab.list()).toEqual([edited]);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("rejects a stale second-tab save after an offline delete", async () => {
    Object.defineProperty(navigator, "onLine", { value: false });
    const secondTab = new MealRepository();
    const first = await repository.save(draft(), crypto.randomUUID());
    await repository.delete(first);
    await expect(secondTab.save({ ...first, time: "13:00" }, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    expect((await repository.state()).jobs.map((job) => job.kind)).toEqual(["save", "delete"]);
    expect(await secondTab.list()).toEqual([]);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("rejects an older save retry after deletion has been queued", async () => {
    const input = draft(), mutationId = crypto.randomUUID();
    const first = await repository.save(input, mutationId);
    await repository.delete(first);
    await expect(new MealRepository().save(input, mutationId)).rejects.toMatchObject({
      code: "conflict", status: 409,
    });
    expect((await repository.state()).jobs.map((job) => job.kind)).toEqual(["save", "delete"]);
    expect(await repository.list()).toEqual([]);
  });
  it("retains conflicts, blocks dependent edits and still syncs unrelated meals", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    await repository.save({ ...first, time: "15:00" }, crypto.randomUUID());
    const other = await repository.save(draft(), crypto.randomUUID());
    fixture.fetch
      .mockResolvedValueOnce(
        Response.json({ error: { code: "conflict" } }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ record: other }))
      .mockResolvedValueOnce(Response.json({ records: [other] }));
    await repository.sync();
    const state = await repository.state();
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs[0].error).toBe("conflict");
    expect(
      (await repository.list()).find((record) => record.id === first.id)?.time,
    ).toBe("15:00");
    await repository.discardPending(first.id);
    expect(await repository.list()).toEqual([other]);
  });
  it("never uploads an old account's jobs under a newly signed-in user", async () => {
    await repository.save(draft(), crypto.randomUUID());
    fixture.uid = "b";
    await repository.sync("a");
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(await repository.list()).toEqual([]);
    expect((await repository.state("a")).jobs).toHaveLength(1);
  });
  it("keeps new offline creation time unknown, even when a copied draft supplies metadata", async () => {
    const input = { ...draft(), schemaVersion: 1, createdAt: "2000-01-01T00:00:00.000Z" };
    const saved = await repository.save(input, crypto.randomUUID());
    expect(saved.createdAt).toBeUndefined();
    expect(saved.schemaVersion).toBeUndefined();
    expect((await new MealRepository().list())[0].createdAt).toBeUndefined();
    const existing = { ...saved, schemaVersion: 1, createdAt: "2026-01-02T03:04:05.000Z" };
    const edit = await repository.save({ ...existing, time: "18:30" }, crypto.randomUUID());
    expect(edit.createdAt).toBe(existing.createdAt);
    expect(edit.schemaVersion).toBe(1);
    expect((await new MealRepository().list())[0]).toEqual(edit);
  });
  it("preserves the first cloud creation time through an older queued edit and lost acknowledgement", async () => {
    const firstId = crypto.randomUUID(), editId = crypto.randomUUID();
    const first = await repository.save({ ...draft(), date: "2020-02-03" }, firstId);
    const edit = await repository.save({ ...first, time: "13:45" }, editId);
    const before = dayNutrition(await repository.list());
    const createdAt = "2026-09-26T14:00:00.000Z";
    const cloudFirst = { ...first, schemaVersion: 1, createdAt, updatedAt: createdAt };
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: cloudFirst }))
      .mockRejectedValueOnce(new TypeError("edit acknowledgement lost"));
    await expect(repository.sync()).rejects.toThrow("edit acknowledgement lost");
    const restarted = new MealRepository();
    const interrupted = await restarted.state();
    expect(interrupted.jobs).toHaveLength(1);
    expect(interrupted.jobs[0]).toMatchObject({ id: editId, expectedVersion: 1 });
    expect(interrupted.jobs[0].record.createdAt).toBeUndefined();
    expect((await restarted.list())[0]).toMatchObject({
      schemaVersion: 1, createdAt, version: 2, time: "13:45", date: "2020-02-03",
    });
    expect(dayNutrition(await restarted.list())).toEqual(before);
    const cloudEdit = { ...edit, schemaVersion: 1, createdAt, updatedAt: "2026-09-26T14:01:00.000Z" };
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: cloudEdit }))
      .mockResolvedValueOnce(Response.json({ records: [cloudEdit], revision: "next" }));
    await restarted.sync();
    expect((await restarted.state()).jobs).toEqual([]);
    expect(await restarted.list()).toEqual([cloudEdit]);
    const commands = fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body));
    expect(commands.map((body) => [body.mutationId, body.version])).toEqual([
      [firstId, 0], [editId, 1], [editId, 1],
    ]);
    for (const body of commands) {
      expect(body).not.toHaveProperty("createdAt");
      expect(body).not.toHaveProperty("schemaVersion");
    }
  });
  it("uses confirmed metadata over pending values and leaves a legacy creation date unknown", async () => {
    const saved = await repository.save(draft(), crypto.randomUUID());
    const pending = { ...saved, version: 2, createdAt: "2000-01-01T00:00:00.000Z", schemaVersion: 1 };
    await changeSyncState("a", () => ({
      remote: [saved], syncedAt: null,
      jobs: [{ id: pending.mutationId, kind: "save", record: pending, expectedVersion: 1 }],
    }));
    const legacy = (await repository.list())[0];
    expect(legacy.createdAt).toBeUndefined();
    expect(legacy.schemaVersion).toBeUndefined();
    await changeSyncState("a", (state) => ({
      ...state, remote: [{ ...saved, schemaVersion: 1, createdAt: null }],
    }));
    expect((await repository.list())[0]).toMatchObject({ version: 2, schemaVersion: 1, createdAt: null });
    expect((await repository.state()).jobs[0].record).toEqual(pending);
  });
  it("retains an unsupported-schema edit without automatically replaying it or downgrading remote metadata", async () => {
    const saved = await repository.save(draft(), crypto.randomUUID());
    const future = { ...saved, schemaVersion: CURRENT_MEAL_SCHEMA_VERSION + 1, createdAt: "2026-09-26T14:00:00.000Z" };
    fixture.fetch.mockResolvedValueOnce(Response.json({ error: { code: "unsupported_schema" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ records: [future], revision: "future" }))
      .mockResolvedValueOnce(Response.json({ revision: "future" }));
    await repository.sync();
    await new MealRepository().sync();
    expect((await repository.state()).jobs[0]).toMatchObject({ id: saved.mutationId, error: "unsupported_schema" });
    expect((await repository.list())[0]).toMatchObject({ schemaVersion: CURRENT_MEAL_SCHEMA_VERSION + 1, createdAt: future.createdAt });
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("keeps a rejected save blocked until one explicit retry replays its mutation", async () => {
    const mutationId = crypto.randomUUID();
    const saved = await repository.save(draft(), mutationId);
    fixture.fetch
      .mockResolvedValueOnce(Response.json({ error: { code: "invalid_request" } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ records: [], revision: "r1" }))
      .mockResolvedValueOnce(Response.json({ revision: "r1" }));
    await repository.sync();
    await repository.sync();
    expect((await repository.state()).jobs[0]).toMatchObject({ id: mutationId, error: "invalid_request" });
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    fixture.fetch
      .mockResolvedValueOnce(Response.json({ record: { ...saved, version: 1 } }))
      .mockResolvedValueOnce(Response.json({ records: [{ ...saved, version: 1 }], revision: "r2" }));
    await repository.sync("a", true);
    expect((await repository.state()).jobs).toHaveLength(0);
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body).mutationId)).toEqual([mutationId, mutationId]);
  });
  it("replays a conflicted command once when sync is explicitly retried", async () => {
    const mutationId = crypto.randomUUID();
    const saved = await repository.save(draft(), mutationId);
    fixture.fetch
      .mockResolvedValueOnce(Response.json({ error: { code: "conflict" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ records: [], revision: "r1" }))
      .mockResolvedValueOnce(Response.json({ record: saved }))
      .mockResolvedValueOnce(Response.json({ records: [saved], revision: "r2" }));
    await repository.sync();
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await repository.sync("a", true);
    expect((await repository.state()).jobs).toHaveLength(0);
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body).mutationId)).toEqual([mutationId, mutationId]);
  });
  it("reuses one blocked save for the same mutation and replaces it when the draft changes", async () => {
    const input = draft();
    const mutationId = crypto.randomUUID();
    await repository.save(input, mutationId);
    await changeSyncState("a", (state) => ({
      ...state,
      jobs: state.jobs.map((job) => ({ ...job, error: "invalid_request" })),
    }));
    await repository.save(input, mutationId);
    const reused = (await repository.state()).jobs;
    expect(reused).toHaveLength(1);
    expect(reused[0].id).toBe(mutationId);
    expect(reused[0].error).toBeUndefined();

    await changeSyncState("a", (state) => ({
      ...state,
      jobs: state.jobs.map((job) => ({ ...job, error: "invalid_request" })),
    }));
    const nextId = crypto.randomUUID();
    await repository.save({ ...input, time: "18:05" }, nextId);
    const jobs = (await repository.state()).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: nextId, expectedVersion: 0 });
    expect(jobs[0].error).toBeUndefined();
    expect(jobs[0].record.time).toBe("18:05");
  });
  it("still rejects a save when a delete for that meal is blocked", async () => {
    const input = draft();
    const saved = await repository.save(input, crypto.randomUUID());
    await repository.delete(saved);
    await changeSyncState("a", (state) => ({
      ...state,
      jobs: state.jobs.map((job) => job.kind === "delete" ? { ...job, error: "conflict" } : job),
    }));
    await expect(repository.save({ ...input, version: saved.version }, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    expect((await repository.state()).jobs.map((job) => job.kind)).toEqual(["save", "delete"]);
  });

  it("commits a paged cloud snapshot only after all pages share one revision", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    const second = { ...first, id: crypto.randomUUID(), mutationId: crypto.randomUUID() };
    await changeSyncState("a", (state) => ({ ...state, jobs: [], remote: [], revision: "old" }));
    fixture.fetch.mockResolvedValueOnce(Response.json({ records: [first], revision: "next", nextCursor: first.id }))
      .mockResolvedValueOnce(Response.json({ records: [second], revision: "next" }));

    await repository.sync();

    expect((await repository.state()).remote).toEqual([first, second]);
    expect((await repository.state()).revision).toBe("next");
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/meals?paged=1&since=old",
      `/api/meals?paged=1&cursor=${first.id}&revision=next`,
    ]);
  });

  it("restarts one changed page snapshot without replaying meal writes", async () => {
    const old = await repository.save(draft(), crypto.randomUUID());
    const next = { ...old, id: crypto.randomUUID(), mutationId: crypto.randomUUID() };
    await changeSyncState("a", (state) => ({ ...state, jobs: [], remote: [old], revision: "old" }));
    fixture.fetch.mockResolvedValueOnce(Response.json({ records: [next], revision: "first", nextCursor: next.id }))
      .mockResolvedValueOnce(Response.json({ error: { code: "snapshot_changed" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ records: [old, next], revision: "second" }));

    await repository.sync();

    expect((await repository.state()).remote).toEqual([old, next]);
    expect((await repository.state()).revision).toBe("second");
    expect(fixture.fetch.mock.calls).toHaveLength(3);
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("keeps the old cloud snapshot after a second changed page conflict", async () => {
    const old = await repository.save(draft(), crypto.randomUUID());
    const next = { ...old, id: crypto.randomUUID(), mutationId: crypto.randomUUID() };
    const previous = await changeSyncState("a", (state) => ({
      ...state, jobs: [], remote: [old], revision: "old", syncedAt: "2026-09-28T00:00:00.000Z",
    }));
    fixture.fetch.mockResolvedValueOnce(Response.json({ records: [next], revision: "new", nextCursor: next.id }))
      .mockResolvedValueOnce(Response.json({ error: { code: "snapshot_changed" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ records: [next], revision: "newer", nextCursor: next.id }))
      .mockResolvedValueOnce(Response.json({ error: { code: "snapshot_changed" } }, { status: 409 }));

    await expect(repository.sync()).rejects.toMatchObject({ code: "snapshot_changed", status: 409 });
    expect(await repository.state()).toEqual(previous);
    expect(fixture.fetch.mock.calls).toHaveLength(4);
  });

  it("does not commit partial pages after the signed-in account changes", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    const previous = await changeSyncState("a", (state) => ({ ...state, jobs: [], remote: [], revision: "old" }));
    fixture.fetch.mockImplementationOnce(async () => {
      fixture.uid = "b";
      return Response.json({ records: [first], revision: "next", nextCursor: first.id });
    });

    await repository.sync("a");

    expect(await repository.state("a")).toEqual(previous);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves manual calories offline through reload, lost acknowledgement and retry without leaking raw input", async () => {
    const mutationId = crypto.randomUUID();
    const before = { ...draft(), calorieCorrection: { kcal: 723, source: "user" as const }, calorieInput: "723" };
    const saved = await repository.save(before, mutationId);
    expect(saved).not.toHaveProperty("calorieInput");
    expect(dayCalories(await new MealRepository().list()).range).toEqual({ min: 723, max: 723 });
    expect(dayNutrition([saved])).toEqual(dayNutrition([{ ...saved, calorieCorrection: null }]));
    fixture.fetch.mockRejectedValueOnce(new TypeError("acknowledgement lost"));
    await expect(repository.sync()).rejects.toThrow();
    const cloud = { ...saved, schemaVersion: 2, createdAt: "2026-09-26T12:00:00.000Z" };
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: cloud }))
      .mockResolvedValueOnce(Response.json({ records: [cloud] }));
    await new MealRepository().sync();
    expect(await repository.list()).toEqual([cloud]);
    const commands = fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body));
    expect(commands.map((body) => body.mutationId)).toEqual([mutationId, mutationId]);
    for (const body of commands) {
      expect(body.calorieCorrection).toEqual({ kcal: 723, source: "user" });
      expect(body).not.toHaveProperty("calorieInput");
    }
    const cleared = await repository.save({ ...cloud, calorieCorrection: null }, crypto.randomUUID());
    expect(cleared.calorieCorrection).toBeNull();
    expect((await new MealRepository().list())[0].calorieCorrection).toBeNull();
    fixture.uid = "b";
    expect(await repository.list()).toEqual([]);
  });

  it("preserves a confirmed journal note under a legacy pending edit that omits the field", async () => {
    const saved = await repository.save(draft(), crypto.randomUUID());
    const confirmed = {
      ...saved,
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      photoRef: null,
      journalNote: "已確認備註",
      createdAt: "2026-10-07T01:00:00.000Z",
    };
    const mutationId = crypto.randomUUID();
    const { journalNote: _note, ...legacyPending } = {
      ...confirmed,
      mutationId,
      version: confirmed.version + 1,
      time: "18:00",
    };
    void _note;
    await changeSyncState("a", () => ({
      remote: [confirmed],
      syncedAt: null,
      jobs: [{ id: mutationId, kind: "save", record: legacyPending, expectedVersion: confirmed.version }],
    }));
    expect((await repository.list())[0].journalNote).toBe("已確認備註");
    expect((await repository.state()).jobs[0].record).not.toHaveProperty("journalNote");

    fixture.fetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(repository.sync()).rejects.toThrow();
    const command = JSON.parse(fixture.fetch.mock.calls[0][1].body);
    expect(command).not.toHaveProperty("journalNote");
  });

  it("lets an explicit pending null clear a confirmed journal note without rewriting the queued command", async () => {
    const saved = await repository.save(draft(), crypto.randomUUID());
    const confirmed = {
      ...saved,
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      photoRef: null,
      journalNote: "會被清除",
      createdAt: "2026-10-07T01:00:00.000Z",
    };
    const mutationId = crypto.randomUUID();
    const pending = {
      ...confirmed,
      mutationId,
      version: confirmed.version + 1,
      journalNote: null,
    };
    await changeSyncState("a", () => ({
      remote: [confirmed],
      syncedAt: null,
      jobs: [{ id: mutationId, kind: "save", record: pending, expectedVersion: confirmed.version }],
    }));
    expect((await repository.list())[0].journalNote).toBeNull();
    expect((await repository.state()).jobs[0].record.journalNote).toBeNull();
  });

  it("keeps a journal-note edit through offline restart, lost acknowledgement and retry", async () => {
    const mutationId = crypto.randomUUID();
    const saved = await repository.save({
      ...draft(),
      journalNote: "  第一行\r\n第二行  ",
    }, mutationId);
    expect(saved.journalNote).toBe("第一行\n第二行");
    expect((await repository.state()).jobs[0].record.journalNote).toBe("第一行\n第二行");

    fixture.fetch.mockRejectedValueOnce(new TypeError("acknowledgement lost"));
    await expect(repository.sync()).rejects.toThrow();
    const cloud = {
      ...saved,
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      photoRef: null,
      journalNote: saved.journalNote ?? null,
      createdAt: "2026-10-07T01:00:00.000Z",
    };
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: cloud }))
      .mockResolvedValueOnce(Response.json({ records: [cloud], revision: "journal-next" }));
    await new MealRepository().sync();
    expect(await repository.list()).toEqual([cloud]);
    const commands = fixture.fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body));
    expect(commands).toHaveLength(2);
    expect(commands.map((body) => body.mutationId)).toEqual([mutationId, mutationId]);
    expect(commands.every((body) => body.journalNote === "第一行\n第二行")).toBe(true);
  });

  it.each(["same", "changed", "clear"])("overlays legacy pending %s intent without rewriting its payload or mutation", async (mode) => {
    const saved = await repository.save({ ...draft(), calorieCorrection: { kcal: 650, source: "user" } }, crypto.randomUUID());
    const mutationId = crypto.randomUUID();
    const pending = { ...saved, version: 2, mutationId, time: "18:00",
      calorieCorrection: mode === "clear" ? null : undefined,
      calorieInput: "private stale draft text",
      items: saved.items.map((item) => ({ ...item, normalizedName: "async metadata",
        portionMin: mode === "changed" ? item.portionMin! + 0.1 : item.portionMin })),
    };
    await changeSyncState("a", () => ({ remote: [saved], syncedAt: null,
      jobs: [{ id: mutationId, kind: "save", record: pending, expectedVersion: 1 }] }));
    expect((await new MealRepository().list())[0].calorieCorrection).toEqual(mode === "same" ? saved.calorieCorrection : null);
    expect((await repository.state()).jobs[0].record).toEqual(pending);
    fixture.fetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(repository.sync()).rejects.toThrow();
    const command = JSON.parse(fixture.fetch.mock.calls[0][1].body);
    expect(command.mutationId).toBe(mutationId);
    expect(command).not.toHaveProperty("calorieInput");
    if (mode === "clear") expect(command.calorieCorrection).toBeNull();
    else expect(command).not.toHaveProperty("calorieCorrection");
  });

  it("carries legacy omission through the preceding pending correction, including explicit clears", async () => {
    const first = await repository.save({ ...draft(), calorieCorrection: { kcal: 700, source: "user" } }, crypto.randomUUID());
    const oldEdit = await repository.save({ ...first, calorieCorrection: undefined, time: "18:00" }, crypto.randomUUID());
    expect(oldEdit.calorieCorrection).toEqual(first.calorieCorrection);
    expect((await repository.state()).jobs[1].record.calorieCorrection).toBeUndefined();
    const clear = await repository.save({ ...oldEdit, calorieCorrection: null }, crypto.randomUUID());
    await repository.save({ ...clear, calorieCorrection: undefined, time: "19:00" }, crypto.randomUUID());
    expect((await repository.list())[0].calorieCorrection).toBeNull();
  });
});
