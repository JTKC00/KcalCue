import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { MAX_PHOTO_INPUT_BYTES } from "@/lib/firebase/photo-assets";
import { ExactPhotoObjectStore } from "@/lib/firebase/photo-object-store";
import { uploadPrivateMealPhoto } from "@/lib/firebase/photo-upload";
import { readPhotoUploadPolicy } from "@/lib/server/photo-config";
import { encodeStoredPhoto } from "@/lib/server/stored-photo";
import {
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";
import { PHOTO_UPLOAD_RATE_LIMIT } from "@/lib/server/rate-limit";
import { createUserWorkAdmission } from "@/lib/server/live-analysis-admission";

export const runtime = "nodejs";

const acquirePhotoUpload = createUserWorkAdmission(PHOTO_UPLOAD_RATE_LIMIT);
const MAX_CONCURRENT_PHOTO_UPLOADS = 2;
let uploadingCount = 0;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; uploadId: string }> },
) {
  try {
    const { db, storage, user } = await authenticated(request);
    const policy = readPhotoUploadPolicy();
    if (!policy.uploadsEnabled) throw new HttpError(503, "photo_uploads_disabled");
    const { id, uploadId } = await context.params;
    if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(uploadId).success)
      throw new HttpError(400, "invalid_request");
    const credential = storage.app.options.credential;
    if (!credential) throw new HttpError(503, "photo_storage_unavailable");

    if (uploadingCount >= MAX_CONCURRENT_PHOTO_UPLOADS) {
      return Response.json({ error: { code: "rate_limited" } }, {
        status: 429, headers: { "Retry-After": "10", "Cache-Control": "private, no-store" },
      });
    }
    const release = acquirePhotoUpload(user.id);
    if (!release) {
      return Response.json({ error: { code: "rate_limited" } }, {
        status: 429, headers: { "Retry-After": "10", "Cache-Control": "private, no-store" },
      });
    }

    uploadingCount++;
    try {
      let data: FormData;
      try {
        const body = await readBoundedRequestBody(request, 11 * 1024 * 1024);
        data = await new Response(body, { headers: request.headers }).formData();
      } catch (error) {
        throw error instanceof RequestBodyTooLargeError
          ? new HttpError(413, "file_too_large")
          : error instanceof RequestBodyTimeoutError
            ? new HttpError(408, "network_timeout")
            : new HttpError(400, "invalid_request");
      }
      const file = data.get("image");
      if (!(file instanceof File) || !file.size)
        throw new HttpError(400, "invalid_request");
      if (file.size > MAX_PHOTO_INPUT_BYTES)
        throw new HttpError(413, "file_too_large");

      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await encodeStoredPhoto(bytes);
      const result = await uploadPrivateMealPhoto(
        db,
        new ExactPhotoObjectStore(credential),
        user.id,
        {
          mealId: id,
          uploadId,
          inputSha256: stored.inputSha256,
          inputBytes: bytes.byteLength,
        },
        stored,
        policy,
        request.signal,
      );

      return Response.json(
        {
          uploadId,
          state: result.asset.state,
          photoRef: result.photoRef,
          expiresAt: result.asset.expiresAt.toDate().toISOString(),
        },
        {
          headers: {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    } finally {
      uploadingCount--;
      release();
    }
  } catch (error) {
    return apiError(error);
  }
}
