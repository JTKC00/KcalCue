import { beforeEach, expect, it, vi } from "vitest";
import { MAX_PHOTO_JPEG_BYTES } from "@/lib/firebase/photo-assets";

const fixture = vi.hoisted(() => ({ toBuffer: vi.fn() }));
vi.mock("sharp", () => ({
  default: () => {
    const pipeline = {
      rotate: () => pipeline,
      resize: () => pipeline,
      flatten: () => pipeline,
      jpeg: () => pipeline,
      toBuffer: fixture.toBuffer,
    };
    return pipeline;
  },
}));
import { encodeStoredPhoto } from "./stored-photo";

beforeEach(() => fixture.toBuffer.mockReset());

it("rejects an encoded thumbnail above 2 MiB after one encode", async () => {
  fixture.toBuffer.mockResolvedValue({
    data: Buffer.alloc(MAX_PHOTO_JPEG_BYTES + 1, 0xff),
    info: { width: 1600, height: 1600 },
  });

  await expect(encodeStoredPhoto(new Uint8Array([0xff, 0xd8, 0xff]))).rejects.toMatchObject({
    status: 413,
    code: "photo_output_too_large",
  });
  expect(fixture.toBuffer).toHaveBeenCalledOnce();
});
