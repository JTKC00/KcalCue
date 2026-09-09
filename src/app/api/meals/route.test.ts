import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { newDraft } from "@/lib/meals/types";

const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: auth,
}));
import { POST } from "./route";
import { DELETE } from "./[id]/route";
import { HttpError } from "@/lib/server/auth";

type Row = Record<string, unknown>;
function fakeDatabase() {
  const tables: Record<string, Row[]> = { meals: [], meal_photos: [] };
  function from(table: string) {
    let method = "select";
    let payload: Row = {};
    const filters: Array<(row: Row) => boolean> = [];
    function execute(single: boolean) {
      let selected = tables[table].filter((row) =>
        filters.every((filter) => filter(row)),
      );
      if (method === "insert") {
        if (tables[table].some((row) => row.id === payload.id))
          return { data: null, error: { code: "23505" } };
        selected = [{ deleted_at: null, ...payload }];
        tables[table].push(...selected);
      }
      if (method === "update")
        selected.forEach((row) => Object.assign(row, payload));
      if (method === "delete")
        tables[table] = tables[table].filter((row) => !selected.includes(row));
      return { data: single ? (selected[0] ?? null) : selected, error: null };
    }
    const query = {
      select: () => query,
      eq: (field: string, value: unknown) => {
        filters.push((row) => row[field] === value);
        return query;
      },
      is: (field: string, value: unknown) => {
        filters.push((row) => (row[field] ?? null) === value);
        return query;
      },
      insert: (row: Row) => {
        method = "insert";
        payload = row;
        return query;
      },
      update: (row: Row) => {
        method = "update";
        payload = row;
        return query;
      },
      delete: () => {
        method = "delete";
        return query;
      },
      maybeSingle: () => Promise.resolve(execute(true)),
      then: (resolve: (value: ReturnType<typeof execute>) => unknown) =>
        Promise.resolve(execute(false)).then(resolve),
    };
    return query;
  }
  return {
    from,
    tables,
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
}
function input() {
  return {
    ...newDraft(),
    mutationId: crypto.randomUUID(),
    items: createEditableFoodItems(demoFoodAnalysis.foods),
  };
}
function request(body: unknown) {
  return new Request("http://localhost/api/meals", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
describe("meal save API", () => {
  let db: ReturnType<typeof fakeDatabase>;
  beforeEach(() => {
    db = fakeDatabase();
    auth
      .mockReset()
      .mockResolvedValue({
        db,
        user: { id: "11111111-1111-4111-8111-111111111111" },
      });
  });
  it("recomputes nutrition server-side and returns the same record on a duplicate save", async () => {
    const body = input();
    const first = await POST(request(body));
    expect(first.status).toBe(200);
    const saved = (await first.json()).record;
    expect(saved.items[0].nutritionMatch.profile).toBeTruthy();
    expect(saved.version).toBe(1);
    const repeated = await POST(request(body));
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).record).toEqual(saved);
    expect(db.tables.meals).toHaveLength(1);
    expect(
      (db.tables.meals[0].totals as { includedCount: number }).includedCount,
    ).toBeGreaterThan(0);
  });
  it("preserves original analysis while applying explicit versioned corrections", async () => {
    const body = { ...input(), analysis: demoFoodAnalysis };
    const created = (await (await POST(request(body))).json()).record;
    const updated = await POST(
      request({
        ...created,
        mutationId: crypto.randomUUID(),
        analysis: null,
        items: created.items.map((item: Row) => ({
          ...item,
          portionMin: 200,
          portionMax: 300,
        })),
      }),
    );
    expect(updated.status).toBe(200);
    const record = (await updated.json()).record;
    expect(record.analysis).toEqual(demoFoodAnalysis);
    expect(record.originalItems).toEqual(created.originalItems);
    expect(record.items[0].portionMin).toBe(200);
    expect(record.version).toBe(2);
    const stale = await POST(
      request({ ...created, mutationId: crypto.randomUUID() }),
    );
    expect(stale.status).toBe(409);
  });
  it("rejects demo data, foreign photos and unauthenticated writes", async () => {
    expect((await POST(request({ ...input(), mode: "demo" }))).status).toBe(
      400,
    );
    expect(
      (
        await POST(
          request({ ...input(), photoPath: "another-account/photo.jpg" }),
        )
      ).status,
    ).toBe(400);
    auth.mockRejectedValueOnce(new HttpError(401, "login_required"));
    expect((await POST(request(input()))).status).toBe(401);
    expect(db.tables.meals).toHaveLength(0);
  });
  it("clears meal contents on deletion and rejects delayed attempts to save it again", async () => {
    const body = input();
    const created = (await (await POST(request(body))).json()).record;
    const deleted = await DELETE(
      new Request(`http://localhost/api/meals/${body.id}?version=1`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: body.id }) },
    );
    expect(deleted.status).toBe(200);
    expect((db.tables.meals[0].record as Row).items).toEqual([]);
    expect(
      (await POST(request({ ...created, mutationId: crypto.randomUUID() })))
        .status,
    ).toBe(409);
  });
});
