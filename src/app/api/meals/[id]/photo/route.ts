import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { attachedPhotoForOwner, readPrivatePhoto } from "@/lib/firebase/photo-read";
import { ExactPhotoObjectStore } from "@/lib/firebase/photo-object-store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { db, storage, user } = await authenticated(request);
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, "photo_not_found");
    const { asset, ref } = await attachedPhotoForOwner(db, user.id, id);
    const credential = storage.app.options.credential;
    if (!credential) throw new HttpError(503, "photo_unavailable");
    const bytes = await readPrivatePhoto(
      new ExactPhotoObjectStore(credential), asset.bucketName, asset.objectKey, ref,
      asset.jpegSha256!, request.signal,
    );
    return new Response(bytes, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(bytes.byteLength),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
