import { isPhotoUploadsEnabled } from "@/lib/server/photo-config";

export function GET() {
  return Response.json(
    { online: true, photoUploadsEnabled: isPhotoUploadsEnabled() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
