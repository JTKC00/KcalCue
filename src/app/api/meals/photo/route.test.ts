import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: async () => ({
    db: {},
    user: { id: "11111111-1111-4111-8111-111111111111" },
  }),
}));
import { POST } from "./route";

describe("private photo preparation", () => {
  afterEach(() => { vi.restoreAllMocks(); });
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

  it.each([undefined, "8"])(
    "cancels oversized multipart before parsing with content-length %s",
    async (contentLength) => {
      const parse = vi.spyOn(Response.prototype, "formData");
      const cancel = vi.fn();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(pulls === 1 ? 1 : 11 * 1024 * 1024));
        },
        cancel,
      }, { highWaterMark: 0 });
      const headers = new Headers({ "content-type": "multipart/form-data; boundary=test" });
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      const response = await POST(new Request("http://localhost/api/meals/photo", {
        method: "POST", headers, body: stream, duplex: "half",
      } as RequestInit));

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: { code: "file_too_large" } });
      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBe(2);
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it("prepares a valid photo when multipart is exactly at the byte cap", async () => {
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    }).jpeg().toBuffer();
    const prefix = Buffer.concat([
      Buffer.from(`--test\r\nContent-Disposition: form-data; name="mealId"\r\n\r\n${crypto.randomUUID()}\r\n--test\r\nContent-Disposition: form-data; name="image"; filename="meal.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      source,
      Buffer.from('\r\n--test\r\nContent-Disposition: form-data; name="padding"; filename="padding.bin"\r\n\r\n'),
    ]);
    const suffix = Buffer.from("\r\n--test--\r\n");
    const bytes = Buffer.concat([
      prefix, Buffer.alloc(11 * 1024 * 1024 - prefix.length - suffix.length), suffix,
    ]);
    const response = await POST(new Request("http://localhost/api/meals/photo", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: bytes,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("returns a controlled error for malformed multipart", async () => {
    const response = await POST(new Request("http://localhost/api/meals/photo", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: "--test\r\nunfinished-private-input",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
  });

  it("returns a controlled error for an interrupted input stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("private transport details")); },
    });
    const response = await POST(new Request("http://localhost/api/meals/photo", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
  });
});
