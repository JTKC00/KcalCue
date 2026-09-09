import { authorizedFetch } from "@/lib/supabase/client";

export async function preparePhoto(
  file: File,
  mealId: string,
  allowServer = true,
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("encode"))),
          "image/jpeg",
          0.8,
        ),
      );
    } finally {
      bitmap.close();
    }
  } catch {
    if (!allowServer) throw new Error("local_preview_unavailable");
    const data = new FormData();
    data.set("image", file);
    data.set("mealId", mealId);
    const response = await authorizedFetch("/api/meals/photo?prepare=1", {
      method: "POST",
      body: data,
    });
    if (!response.ok) throw new Error("photo_failed");
    return response.blob();
  }
}
