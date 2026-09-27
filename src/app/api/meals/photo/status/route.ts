import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { MAX_PHOTO_INPUT_BYTES } from "@/lib/firebase/photo-assets";
import { readPhotoRegistryStatus } from "@/lib/firebase/photo-status";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/server/request-body";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  mealId: z.uuid(),
  uploadId: z.uuid(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inputBytes: z.number().int().min(1).max(MAX_PHOTO_INPUT_BYTES),
});

// POST carries the original-image fingerprint in a bounded body so URL logs
// cannot retain it. This route still performs a single read and no mutation.
export async function POST(request: Request) {
  try {
    const { db, user } = await authenticated(request);
    let json: unknown;
    try {
      const body = await readBoundedRequestBody(request, 512);
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (error) {
      throw new HttpError(
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        "invalid_request",
      );
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, "invalid_request");
    const registryState = await readPhotoRegistryStatus(db, user.id, parsed.data);
    return Response.json({ registryState }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
