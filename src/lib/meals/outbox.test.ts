// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import "fake-indexeddb/auto";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { dayNutrition, newDraft } from "./types";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { MealRepository } from "./repository";
import { changeSyncState, clearSyncState, markPhotoUploadStaged, readPhotoPayload } from "./outbox";
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
  it("keeps a queued mutation immutable when save is retried or reused", async () => {
    const input = draft();
    const mutationId = crypto.randomUUID();
    const first = await repository.save(input, mutationId);
    const retry = await repository.save(input, mutationId);
    expect(retry).toEqual(first);
    expect((await repository.state()).jobs).toHaveLength(1);
    await expect(repository.save({ ...input, time: "19:30" }, mutationId))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(repository.save({ ...input, id: crypto.randomUUID() }, mutationId))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    expect((await repository.state()).jobs).toMatchObject([
      { id: mutationId, record: { id: input.id, time: input.time } },
    ]);
  });
  it("rejects a changed command under an already acknowledged mutation ID", async () => {
    const mutationId = crypto.randomUUID();
    const first = await repository.save(draft(), mutationId);
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: first }))
      .mockResolvedValueOnce(Response.json({ records: [first], revision: "server" }));
    await repository.sync();
    expect((await repository.state()).jobs).toHaveLength(0);
    await expect(repository.save({ ...first, time: "19:30" }, mutationId))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    expect((await repository.state()).jobs).toHaveLength(0);
    expect((await repository.list())[0].time).toBe(first.time);
  });
  it("holds a photo meal until staged, then clears its Blob only with the meal ACK", async () => {
    const photo = new NodeBlob(["private jpeg fixture"], { type: "image/jpeg" }) as Blob;
    const mutationId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const first = await repository.saveWithPhoto({ ...draft(), photo }, mutationId, uploadId);
    const other = await repository.save(draft(), crypto.randomUUID());
    expect(await (await readPhotoPayload("a", uploadId))?.text()).toBe("private jpeg fixture");
    expect((await repository.state()).jobs[0]).toMatchObject({
      id: mutationId, photoUpload: { uploadId, status: "pending" },
    });
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: other }))
      .mockResolvedValueOnce(Response.json({ records: [other], revision: "server" }));
    await repository.sync();
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST"))
      .toHaveLength(1);
    expect((await repository.state()).jobs[0].id).toBe(mutationId);
    expect(await readPhotoPayload("a", uploadId)).not.toBeNull();

    await markPhotoUploadStaged("a", uploadId);
    fixture.fetch.mockResolvedValueOnce(Response.json({ record: first }))
      .mockResolvedValueOnce(Response.json({ records: [first, other], revision: "server" }));
    await new MealRepository().sync();
    expect((await repository.state()).jobs).toHaveLength(0);
    expect(await readPhotoPayload("a", uploadId)).toBeNull();
    const command = fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body)).find((item) => item.mutationId === mutationId);
    expect(command).toMatchObject({
      mutationId, photoAction: { kind: "attach", uploadId },
    });
    expect(command).not.toHaveProperty("photo");
    expect(command).not.toHaveProperty("photoUpload");
    const laterUploadId = crypto.randomUUID();
    await expect(repository.saveWithPhoto({ ...first, time: "19:30", photo }, mutationId, laterUploadId))
      .rejects.toThrow();
    expect(await readPhotoPayload("a", laterUploadId)).toBeNull();
  });
  it("accepts an identical queued photo retry without duplicating its job or Blob", async () => {
    const photo = new NodeBlob(["private jpeg fixture"], { type: "image/jpeg" }) as Blob;
    const input = { ...draft(), photo };
    const mutationId = crypto.randomUUID(), uploadId = crypto.randomUUID();
    const first = await repository.saveWithPhoto(input, mutationId, uploadId);
    const retry = await new MealRepository().saveWithPhoto(input, mutationId, uploadId);
    expect(retry).toEqual(first);
    expect((await repository.state()).jobs).toHaveLength(1);
    expect(await (await readPhotoPayload("a", uploadId))?.text()).toBe("private jpeg fixture");
  });
  it("discards a photo job and Blob without affecting another account", async () => {
    const photo = new NodeBlob(["private jpeg fixture"], { type: "image/jpeg" }) as Blob;
    const meal = await repository.saveWithPhoto({ ...draft(), photo }, crypto.randomUUID(), crypto.randomUUID());
    const uploadId = (await repository.state()).jobs[0].photoUpload!.uploadId;
    fixture.uid = "b";
    const other = await repository.saveWithPhoto({ ...draft(), photo }, crypto.randomUUID(), crypto.randomUUID());
    const otherUploadId = (await repository.state("b")).jobs[0].photoUpload!.uploadId;
    fixture.uid = "a";
    await repository.discardPending(meal.id);
    expect(await readPhotoPayload("a", uploadId)).toBeNull();
    expect((await repository.state("a")).jobs).toHaveLength(0);
    expect((await repository.state("b")).jobs).toMatchObject([{ record: { id: other.id } }]);
    expect(await readPhotoPayload("b", otherUploadId)).not.toBeNull();
  });
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
      .mockResolvedValueOnce(Response.json({ records: [cloud], revision: "server" }));
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
    const match = new LocalNutritionProvider().resolve(input.items[0]);
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
        ...item, portionMin: item.portionMin * 2, portionMax: item.portionMax * 2,
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
      .mockResolvedValueOnce(Response.json({ records: [saved], revision: "server" }));
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
      .mockResolvedValueOnce(Response.json({ records: [saved], revision: "server" }));
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
            init?.method === "DELETE" ? { ok: true } : { records: [], revision: "server" },
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
  it("rejects a stale photo edit without persisting a new Blob", async () => {
    Object.defineProperty(navigator, "onLine", { value: false });
    const first = await repository.save(draft(), crypto.randomUUID());
    await repository.save({ ...first, time: "13:00" }, crypto.randomUUID());
    const uploadId = crypto.randomUUID();
    const photo = new NodeBlob(["private jpeg fixture"], { type: "image/jpeg" }) as Blob;
    await expect(new MealRepository().saveWithPhoto(
      { ...first, time: "14:00", photo }, crypto.randomUUID(), uploadId,
    )).rejects.toThrow("Stale photo meal version");
    expect(await readPhotoPayload("a", uploadId)).toBeNull();
    expect((await repository.state()).jobs).toHaveLength(2);
  });
  it("rejects a photo save after a queued delete without persisting its Blob", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    await repository.delete(first);
    const uploadId = crypto.randomUUID();
    const photo = new NodeBlob(["private jpeg fixture"], { type: "image/jpeg" }) as Blob;
    await expect(new MealRepository().saveWithPhoto(
      { ...first, photo }, crypto.randomUUID(), uploadId,
    )).rejects.toThrow("Meal already queued for deletion");
    expect(await readPhotoPayload("a", uploadId)).toBeNull();
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
      .mockResolvedValueOnce(Response.json({ records: [other], revision: "server" }));
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
    const future = { ...saved, schemaVersion: 5, createdAt: "2026-09-26T14:00:00.000Z" };
    fixture.fetch.mockResolvedValueOnce(Response.json({ error: { code: "unsupported_schema" } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ records: [future], revision: "future" }))
      .mockResolvedValueOnce(Response.json({ revision: "future" }));
    await repository.sync();
    await new MealRepository().sync();
    expect((await repository.state()).jobs[0]).toMatchObject({ id: saved.mutationId, error: "unsupported_schema" });
    expect((await repository.list())[0]).toMatchObject({ schemaVersion: 5, createdAt: future.createdAt });
    expect(fixture.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("does not advance the cloud cursor after an incomplete changed-revision response", async () => {
    const first = await repository.save(draft(), crypto.randomUUID());
    const second = { ...first, id: crypto.randomUUID(), mutationId: crypto.randomUUID() };
    const lastSyncedAt = "2026-09-26T12:00:00.000Z";
    await changeSyncState("a", (state) => ({
      ...state, remote: [first], jobs: [], revision: "r1", syncedAt: lastSyncedAt,
    }));
    fixture.fetch.mockResolvedValueOnce(Response.json({ revision: "r2" }))
      .mockResolvedValueOnce(Response.json({ records: [first, second], revision: "r2" }));

    await expect(repository.sync()).rejects.toMatchObject({
      code: "service_unavailable", status: 502,
    });
    expect(await repository.state()).toMatchObject({
      remote: [first], revision: "r1", syncedAt: lastSyncedAt,
    });
    await new MealRepository().sync();
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/meals?since=r1", "/api/meals?since=r1",
    ]);
    expect((await repository.state()).revision).toBe("r2");
    expect(await repository.list()).toEqual([first, second]);
  });
  it("rejects a meal list without a revision before marking the cloud confirmed", async () => {
    fixture.fetch.mockResolvedValueOnce(Response.json({ records: [] }));
    await expect(repository.sync()).rejects.toMatchObject({
      code: "service_unavailable", status: 502,
    });
    expect((await repository.state()).syncedAt).toBeNull();
    expect((await repository.state()).revision).toBeUndefined();
  });
  it("requires records when the cached revision is the empty sentinel", async () => {
    await changeSyncState("a", (state) => ({
      ...state, revision: "empty", syncedAt: "2026-09-26T12:00:00.000Z",
    }));
    fixture.fetch.mockResolvedValueOnce(Response.json({ revision: "empty" }));
    await expect(repository.sync()).rejects.toMatchObject({
      code: "service_unavailable", status: 502,
    });
    expect(fixture.fetch.mock.calls[0][0]).toBe("/api/meals?since=empty");
    expect((await repository.state()).syncedAt).toBe("2026-09-26T12:00:00.000Z");
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
      .mockResolvedValueOnce(Response.json({ records: [cloud], revision: "server" }));
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

  it.each(["same", "changed", "clear"])("overlays legacy pending %s intent without rewriting its payload or mutation", async (mode) => {
    const saved = await repository.save({ ...draft(), calorieCorrection: { kcal: 650, source: "user" } }, crypto.randomUUID());
    const mutationId = crypto.randomUUID();
    const pending = { ...saved, version: 2, mutationId, time: "18:00",
      calorieCorrection: mode === "clear" ? null : undefined,
      calorieInput: "private stale draft text",
      items: saved.items.map((item) => ({ ...item, normalizedName: "async metadata",
        portionMin: mode === "changed" ? item.portionMin + 0.1 : item.portionMin })),
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
