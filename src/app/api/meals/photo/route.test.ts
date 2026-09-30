import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRateLimitStore, PHOTO_PREPARATION_RATE_LIMIT } from "@/lib/server/rate-limit";
const account = vi.hoisted(() => ({ uid: "11111111-1111-4111-8111-111111111111" }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: async () => ({
    db: {},
    user: { id: account.uid },
  }),
}));
import { POST } from "./route";

describe("private photo preparation", () => {
  beforeEach(() => { clearRateLimitStore(); account.uid = crypto.randomUUID(); });
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

  it("identifies an over-40MP phone JPEG without trying to decode it", async () => {
    const source = await sharp({
      create: { width: 8064, height: 6048, channels: 3, background: "green" },
    }).jpeg({ quality: 70 }).toBuffer();
    expect(source.length).toBeLessThan(10 * 1024 * 1024);
    const data = new FormData();
    data.set("mealId", crypto.randomUUID());
    data.set("image", new Blob([new Uint8Array(source)], { type: "image/jpeg" }));

    const response = await POST(new Request("http://localhost/api/meals/photo?prepare=1", {
      method: "POST", body: data,
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "image_dimensions_too_large" } });
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

  it("uses the same white background as client preparation for transparent images", async () => {
    const source = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const data = new FormData();
    data.set("mealId", crypto.randomUUID());
    data.set("image", new Blob([new Uint8Array(source)], { type: "image/png" }));
    const response = await POST(new Request("http://localhost/api/meals/photo?prepare=1", {
      method: "POST",
      body: data,
    }));
    expect(response.status).toBe(200);
    const pixel = await sharp(Buffer.from(await response.arrayBuffer())).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([255, 255, 255]);
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

  it("limits repeated preparation requests by verified account before body parsing", async () => {
    const parse = vi.spyOn(Response.prototype, "formData");
    for (let index = 0; index < PHOTO_PREPARATION_RATE_LIMIT.limit; index++) {
      const response = await POST(new Request("http://localhost/api/meals/photo", {
        method: "POST", body: "invalid",
      }));
      expect(response.status).toBe(400);
    }
    const blocked = await POST(new Request("http://localhost/api/meals/photo", {
      method: "POST", body: "invalid",
    }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("10");
    expect(parse).toHaveBeenCalledTimes(PHOTO_PREPARATION_RATE_LIMIT.limit);
  });

  it("rejects a second preparation from the same account while the first body is still arriving", async () => {
    let finish!: () => void;
    const firstBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          finish = () => { controller.close(); resolve(); };
        });
      },
    }, { highWaterMark: 0 });
    const first = POST(new Request("http://localhost/api/meals/photo", {
      method: "POST", body: firstBody, duplex: "half",
      headers: { "content-type": "multipart/form-data; boundary=test" },
    } as RequestInit));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    const second = await POST(new Request("http://localhost/api/meals/photo", {
      method: "POST", body: "invalid",
    }));
    expect(second.status).toBe(429);
    finish();
    expect((await first).status).toBe(400);
  });

  it("bounds simultaneous preparation across separate verified accounts", async () => {
    const waiting: Array<() => void> = [];
    const start = async (uid: string) => {
      account.uid = uid;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            waiting.push(() => { controller.close(); resolve(); });
          });
        },
      }, { highWaterMark: 0 });
      const result = POST(new Request("http://localhost/api/meals/photo", {
        method: "POST", body, duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=test" },
      } as RequestInit));
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      return result;
    };
    const first = start(crypto.randomUUID());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    const second = start(crypto.randomUUID());
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    account.uid = crypto.randomUUID();
    const blocked = await POST(new Request("http://localhost/api/meals/photo", {
      method: "POST", body: "invalid",
    }));
    expect(blocked.status).toBe(429);
    waiting.forEach((finish) => finish());
    expect((await (await first)).status).toBe(400);
    expect((await (await second)).status).toBe(400);
  });
});
