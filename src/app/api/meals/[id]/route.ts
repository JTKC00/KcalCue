import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { z } from "zod";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { db, user } = await authenticated(request);
    const { id } = await context.params;
    const version = Number(new URL(request.url).searchParams.get("version"));
    if (
      !z.uuid().safeParse(id).success ||
      !Number.isInteger(version) ||
      version < 1
    )
      throw new HttpError(400, "invalid_request");
    const { data: row, error } = await db
      .from("meals")
      .select("version,deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new HttpError(503, "delete_failed");
    if (!row) return Response.json({ ok: true });
    if (row.version !== version) throw new HttpError(409, "conflict");
    if (!row.deleted_at) {
      const marked = await db
        .from("meals")
        .update({
          deleted_at: new Date().toISOString(),
          record: { id, userId: user.id, version, mode: "manual", items: [] },
          totals: {},
        })
        .eq("id", id)
        .eq("version", version)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (marked.error || !marked.data) throw new HttpError(409, "conflict");
    }
    // Tombstone remains until storage cleanup succeeds, so a retry cannot resurrect the meal.
    const photos = await db
      .from("meal_photos")
      .select("path")
      .eq("meal_id", id);
    if (photos.error) throw new HttpError(503, "cleanup_failed");
    if (photos.data.length) {
      const removed = await db.storage
        .from("meal-photos")
        .remove(photos.data.map((p) => p.path));
      if (removed.error) throw new HttpError(503, "cleanup_failed");
      const removedRows = await db
        .from("meal_photos")
        .delete()
        .eq("meal_id", id);
      if (removedRows.error) throw new HttpError(503, "cleanup_failed");
    }
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
