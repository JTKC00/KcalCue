// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft } from "./types";
import { MealRepository } from "./repository";
import { changeSyncState, clearSyncState } from "./outbox";

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
});
