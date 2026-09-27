// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PhotoRef } from "@/lib/meals/types";

const fixture = vi.hoisted(() => ({
  uid: "account-a",
  fetch: vi.fn(),
  createUrl: vi.fn(),
  revokeUrl: vi.fn(),
}));
vi.mock("@/lib/firebase/client", () => ({
  firebaseAuth: () => ({ currentUser: { uid: fixture.uid } }),
  authorizedFetch: fixture.fetch,
}));
import { PrivateMealPhoto } from "./private-meal-photo";

const photoRef: PhotoRef = {
  attachmentId: "461fe664-d9c7-4fc2-8ea3-c641954838c6",
  generation: "1837167347458867",
  contentType: "image/jpeg",
  width: 640,
  height: 480,
  byteSize: 3,
};
const props = { mealId: "d52f58f7-61f9-41f7-a5f3-e4fa4476ff73", photoRef, expectedUid: "account-a" };
function imageResponse() {
  return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), {
    headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  fixture.uid = "account-a";
  for (const mock of [fixture.fetch, fixture.createUrl, fixture.revokeUrl]) mock.mockReset();
  fixture.createUrl.mockReturnValue("blob:private-a");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: fixture.createUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: fixture.revokeUrl });
});
afterEach(() => cleanup());

it("loads an owner-scoped image without caching and revokes its URL when History closes", async () => {
  fixture.fetch.mockResolvedValue(imageResponse());
  const view = render(<PrivateMealPhoto {...props} />);
  expect(fixture.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  expect(screen.getByText("正在載入餐點附圖…")).toBeInTheDocument();
  expect(await screen.findByRole("img", { name: "餐點附圖" })).toHaveAttribute("src", "blob:private-a");
  expect(fixture.fetch).toHaveBeenCalledWith(`/api/meals/${props.mealId}/photo`,
    expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }), "account-a");
  view.unmount();
  expect(fixture.revokeUrl).toHaveBeenCalledWith("blob:private-a");
});

it("shows a retry after an API failure and accepts a later successful read", async () => {
  fixture.fetch.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(imageResponse());
  render(<PrivateMealPhoto {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  expect(await screen.findByRole("button", { name: "重試載入圖片" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重試載入圖片" }));
  expect(await screen.findByRole("img", { name: "餐點附圖" })).toBeInTheDocument();
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it("discards a late A response across A to B to A and never creates an old image URL", async () => {
  const old = deferred<Response>();
  fixture.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(imageResponse());
  const view = render(<PrivateMealPhoto key="a-first" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(1));
  fixture.uid = "account-b";
  view.rerender(<div>另一帳戶</div>);
  fixture.uid = "account-a";
  view.rerender(<PrivateMealPhoto key="a-second" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  expect(await screen.findByRole("img", { name: "餐點附圖" })).toBeInTheDocument();
  await act(async () => { old.resolve(imageResponse()); });
  expect(fixture.createUrl).toHaveBeenCalledTimes(1);
});

it("rejects an oversized response before creating an image URL", async () => {
  fixture.fetch.mockResolvedValue(new Response(null, {
    headers: { "Content-Type": "image/jpeg", "Content-Length": String(2 * 1024 * 1024 + 1) },
  }));
  render(<PrivateMealPhoto {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  expect(await screen.findByRole("button", { name: "重試載入圖片" })).toBeInTheDocument();
  expect(fixture.createUrl).not.toHaveBeenCalled();
});

it("does not refetch when a sync supplies the same attachment as a new object", async () => {
  fixture.fetch.mockResolvedValue(imageResponse());
  const view = render(<PrivateMealPhoto {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "查看餐點附圖" }));
  expect(await screen.findByRole("img", { name: "餐點附圖" })).toBeInTheDocument();
  view.rerender(<PrivateMealPhoto {...props} photoRef={{ ...photoRef }} />);
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(fixture.revokeUrl).not.toHaveBeenCalled();
});
