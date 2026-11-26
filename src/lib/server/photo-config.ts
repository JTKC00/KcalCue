import {
  isValidPhotoBucketName,
  MAX_PHOTO_JPEG_BYTES,
  type PhotoQuotaPolicy,
} from "@/lib/firebase/photo-assets";
import type { PhotoBucketIdentity } from "@/lib/firebase/photo-object-store";
import { HttpError } from "./auth";

const positiveIntPattern = /^[1-9][0-9]*$/;
const projectNumberPattern = /^[1-9][0-9]{0,31}$/;

function parsePositiveSafeInt(value: string | undefined): number | null {
  if (!value || !positiveIntPattern.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function readPhotoUploadPolicy(
  env: Record<string, string | undefined> = process.env,
): PhotoQuotaPolicy {
  if (env.KCALCUE_PHOTO_UPLOADS_ENABLED !== "true") {
    return {
      uploadsEnabled: false,
      bucketName: "",
      maxPendingPerUid: 0,
      maxReservedBytesPerUid: 0,
      maxReservedBytesProject: 0,
    };
  }
  const bucketName = env.KCALCUE_MEAL_PHOTO_BUCKET?.trim() ?? "";
  const maxPendingPerUid = parsePositiveSafeInt(env.KCALCUE_PHOTO_MAX_PENDING_PER_UID);
  const maxReservedBytesPerUid = parsePositiveSafeInt(env.KCALCUE_PHOTO_MAX_RESERVED_BYTES_PER_UID);
  const maxReservedBytesProject = parsePositiveSafeInt(env.KCALCUE_PHOTO_MAX_RESERVED_BYTES_PROJECT);
  if (!isValidPhotoBucketName(bucketName) ||
      maxPendingPerUid === null ||
      maxReservedBytesPerUid === null || maxReservedBytesPerUid < MAX_PHOTO_JPEG_BYTES ||
      maxReservedBytesProject === null || maxReservedBytesProject < MAX_PHOTO_JPEG_BYTES) {
    throw new HttpError(503, "photo_quota_not_configured");
  }
  return {
    uploadsEnabled: true,
    bucketName,
    maxPendingPerUid,
    maxReservedBytesPerUid,
    maxReservedBytesProject,
  };
}

export function readPhotoBucketIdentity(
  env: Record<string, string | undefined> = process.env,
): PhotoBucketIdentity | undefined {
  const bucketName = env.KCALCUE_MEAL_PHOTO_BUCKET?.trim() ?? "";
  const projectNumber = env.KCALCUE_MEAL_PHOTO_BUCKET_PROJECT_NUMBER?.trim() ?? "";
  if (!isValidPhotoBucketName(bucketName) || !projectNumberPattern.test(projectNumber)) {
    return undefined;
  }
  return { bucketName, projectNumber };
}

export function readPhotoMaintenanceConfig(
  env: Record<string, string | undefined> = process.env,
): { bucketName: string; absenceProof?: PhotoBucketIdentity; secret: string } {
  const bucketName = env.KCALCUE_MEAL_PHOTO_BUCKET?.trim() ?? "";
  const secret = env.KCALCUE_PHOTO_MAINTENANCE_SECRET?.trim() ?? "";
  if (!isValidPhotoBucketName(bucketName) || secret.length < 32 || /\s/.test(secret)) {
    throw new HttpError(503, "photo_maintenance_disabled");
  }
  return {
    bucketName,
    absenceProof: readPhotoBucketIdentity(env),
    secret,
  };
}

export function isPhotoUploadsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    return readPhotoUploadPolicy(env).uploadsEnabled === true;
  } catch {
    return false;
  }
}
