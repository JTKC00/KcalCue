import { authenticated, apiError, HttpError } from "@/lib/server/auth";

export async function GET(request: Request) {
  try {
    const { db } = await authenticated(request);
    const paths: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const photos = await db
        .from("meal_photos")
        .select("path,meal_id")
        .order("path")
        .range(offset, offset + 499);
      if (photos.error) throw new HttpError(503, "cleanup_failed");
      for (const photo of photos.data) {
        const meal = await db
          .from("meals")
          .select("record,deleted_at")
          .eq("id", photo.meal_id)
          .maybeSingle();
        if (meal.error) throw new HttpError(503, "cleanup_failed");
        if (
          !meal.data ||
          meal.data.deleted_at ||
          meal.data.record.photoPath !== photo.path
        )
          paths.push(photo.path);
      }
      if (photos.data.length < 500) break;
    }
    return Response.json(
      { paths },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
