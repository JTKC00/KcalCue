import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: async () => ({
    db: {},
    user: { id: "11111111-1111-4111-8111-111111111111" },
  }),
}));
import { POST } from "./route";

describe("private photo preparation", () => {
  it("normalizes orientation, caps dimensions and strips EXIF before persistence", async () => {
    const source = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "green" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const data = new FormData();
    data.set("mealId", crypto.randomUUID());
    data.set(
      "image",
      new Blob([new Uint8Array(source)], { type: "image/jpeg" }),
    );
    const response = await POST(
      new Request("http://localhost/api/meals/photo?prepare=1", {
        method: "POST",
        body: data,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const metadata = await sharp(
      Buffer.from(await response.arrayBuffer()),
    ).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(800);
    expect(metadata.height).toBe(1600);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });
  it("rejects a spoofed image container", async () => {
    const data = new FormData();
    data.set("mealId", crypto.randomUUID());
    data.set("image", new Blob(["not an image"], { type: "image/jpeg" }));
    expect(
      (
        await POST(
          new Request("http://localhost/api/meals/photo?prepare=1", {
            method: "POST",
            body: data,
          }),
        )
      ).status,
    ).toBe(415);
  });
});
