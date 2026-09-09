import sharp from "sharp";
import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { detectSupportedImageMimeType } from "@/lib/providers/food-vision/types";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    if (Number(request.headers.get("content-length")) > 11 * 1024 * 1024)
      throw new HttpError(413, "file_too_large");
    const data = await request.formData();
    const id = z.uuid().safeParse(data.get("mealId"));
    const file = data.get("image");
    if (!id.success || !(file instanceof File) || !file.size)
      throw new HttpError(400, "invalid_request");
    if (file.size > 10 * 1024 * 1024)
      throw new HttpError(413, "file_too_large");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!detectSupportedImageMimeType(bytes))
      throw new HttpError(415, "invalid_file");
    let jpeg: Buffer;
    try {
      jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      throw new HttpError(422, "image_read_failed");
    }
    if (new URL(request.url).searchParams.get("prepare") === "1")
      return new Response(new Uint8Array(jpeg), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
      });
    const path = `${user.id}/${id.data}/${crypto.randomUUID()}.jpg`;
    const registered = await db
      .from("meal_photos")
      .insert({ path, user_id: user.id, meal_id: id.data, ready: false });
    if (registered.error) throw new HttpError(503, "photo_failed");
    const uploaded = await db.storage
      .from("meal-photos")
      .upload(path, jpeg, { contentType: "image/jpeg", upsert: false });
    if (uploaded.error) throw new HttpError(503, "photo_failed");
    const ready = await db
      .from("meal_photos")
      .update({ ready: true })
      .eq("path", path);
    if (ready.error) throw new HttpError(503, "photo_failed");
    return Response.json({ path });
  } catch (error) {
    return apiError(error);
  }
}
export async function GET(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    const path = new URL(request.url).searchParams.get("path") ?? "";
    if (!path.startsWith(`${user.id}/`) || path.includes(".."))
      throw new HttpError(404, "not_found");
    const { data, error } = await db.storage.from("meal-photos").download(path);
    if (error || !data) throw new HttpError(404, "not_found");
    return new Response(data, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    // Only unreferenced photos can be cleaned up. Call after a successful save or explicit draft discard.
    const path = new URL(request.url).searchParams.get("path");
    if (!path || !path.startsWith(`${user.id}/`))
      throw new HttpError(400, "invalid_photo");
    const rows = await db
      .from("meal_photos")
      .select("path,meal_id")
      .eq("user_id", user.id)
      .eq("path", path);
    if (rows.error) throw new HttpError(503, "cleanup_failed");
    for (const photo of rows.data) {
      const meal = await db
        .from("meals")
        .select("record,deleted_at")
        .eq("id", photo.meal_id)
        .maybeSingle();
      if (meal.error) throw new HttpError(503, "cleanup_failed");
      if (!meal.data?.deleted_at && meal.data?.record?.photoPath === photo.path)
        continue;
      const removed = await db.storage.from("meal-photos").remove([photo.path]);
      if (removed.error) throw new HttpError(503, "cleanup_failed");
      const deleted = await db
        .from("meal_photos")
        .delete()
        .eq("path", photo.path);
      if (deleted.error) throw new HttpError(503, "cleanup_failed");
    }
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
