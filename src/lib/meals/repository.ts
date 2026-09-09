import { authorizedFetch } from "@/lib/supabase/client";
import type { MealDraft, MealRecord } from "./types";

export class RepositoryError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
async function result(response: Response) {
  const body = await response.json();
  if (!response.ok)
    throw new RepositoryError(
      body.error?.code ?? "service_unavailable",
      response.status,
    );
  return body;
}
export class MealRepository {
  async list(): Promise<MealRecord[]> {
    return (
      await result(await authorizedFetch("/api/meals", { cache: "no-store" }))
    ).records;
  }
  async save(draft: MealDraft, mutationId: string): Promise<MealRecord> {
    return (
      await result(
        await authorizedFetch("/api/meals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, photo: undefined, mutationId }),
        }),
      )
    ).record;
  }
  async delete(record: MealRecord) {
    await result(
      await authorizedFetch(
        `/api/meals/${record.id}?version=${record.version}`,
        { method: "DELETE" },
      ),
    );
  }
  async upload(id: string, photo: Blob): Promise<string> {
    const data = new FormData();
    data.set("image", photo);
    data.set("mealId", id);
    return (
      await result(
        await authorizedFetch("/api/meals/photo", {
          method: "POST",
          body: data,
        }),
      )
    ).path;
  }
  async photo(path: string): Promise<Blob> {
    const response = await authorizedFetch(
      `/api/meals/photo?path=${encodeURIComponent(path)}`,
    );
    if (!response.ok) {
      await result(response);
    }
    return response.blob();
  }
}
