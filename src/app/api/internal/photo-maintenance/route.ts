import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { adminServices } from "@/lib/firebase/admin";
import { ExactPhotoObjectStore } from "@/lib/firebase/photo-object-store";
import { runPhotoMaintenanceCycle } from "@/lib/firebase/photo-maintenance-runner";
import { apiError, HttpError } from "@/lib/server/auth";
import { readPhotoMaintenanceConfig } from "@/lib/server/photo-config";
import {
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";

export const runtime = "nodejs";

const bodySchema = z.strictObject({
  maxItems: z.number().int().min(1).max(10).optional(),
});

function sha256Digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorizedSecret(headerValue: string | null, expectedSecret: string): boolean {
  if (!headerValue || !headerValue.startsWith("Bearer ")) return false;
  const provided = headerValue.slice(7).trim();
  if (!provided) return false;
  return timingSafeEqual(sha256Digest(provided), sha256Digest(expectedSecret));
}

// Trusted background maintenance endpoint for Cloud Scheduler / Cloud Run Job.
// Fails closed unless KCALCUE_MEAL_PHOTO_BUCKET and a >=32-char
// KCALCUE_PHOTO_MAINTENANCE_SECRET are explicitly configured.
export async function POST(request: Request) {
  try {
    const config = readPhotoMaintenanceConfig();
    if (!authorizedSecret(request.headers.get("authorization"), config.secret)) {
      throw new HttpError(401, "unauthorized");
    }

    let maxItems: number | undefined;
    try {
      const raw = await readBoundedRequestBody(request, 256);
      if (raw.byteLength > 0) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
        if (text.length > 0) {
          const parsed = bodySchema.safeParse(JSON.parse(text));
          if (!parsed.success) throw new HttpError(400, "invalid_request");
          maxItems = parsed.data.maxItems;
        }
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw error instanceof RequestBodyTooLargeError
        ? new HttpError(413, "invalid_request")
        : error instanceof RequestBodyTimeoutError
          ? new HttpError(408, "network_timeout")
          : new HttpError(400, "invalid_request");
    }

    const { db, storage } = adminServices();
    const credential = storage.app.options.credential;
    if (!credential) throw new HttpError(503, "photo_storage_unavailable");

    const summary = await runPhotoMaintenanceCycle(
      db,
      new ExactPhotoObjectStore(credential),
      { maxItems, absenceProof: config.absenceProof },
    );
    return Response.json(summary, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
