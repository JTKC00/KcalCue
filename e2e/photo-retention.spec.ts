import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";
import { createEditableFoodItems } from "../src/lib/domain/editable-meal";
import { foodAnalysisSchema, type FoodAnalysis } from "../src/lib/domain/food-analysis";

const userId = "11111111-1111-4111-8111-111111111111";

type StoredRecord = {
  id: string;
  version: number;
  mutationId: string;
  photoRef?: {
    attachmentId: string;
    generation: string;
    contentType: "image/jpeg";
    width: number;
    height: number;
    byteSize: number;
  } | null;
  [key: string]: unknown;
};

const sampleAnalysis: FoodAnalysis = foodAnalysisSchema.parse({
  analysisStatus: "success",
  foods: [{
    displayName: "白飯",
    normalizedName: "cooked white rice",
    identityLevel: "ingredient",
    portionMin: 150,
    portionMax: 200,
    unit: "g",
    recognitionConfidence: 0.94,
    portionConfidence: 0.67,
    uncertaintyReasons: ["相片無法確認白飯的實際重量。"],
    preparationMethod: "熟",
    visibleIngredients: ["白飯"],
  }],
  uncertaintyReasons: [],
  visibleEvidence: ["白飯"],
  estimatedInformation: ["估計份量"],
  unknownInformation: [],
});

function createPhotoBackend(options: { photoUploadsEnabled: boolean; jpegBytes: Uint8Array }) {
  const records = new Map<string, StoredRecord>();
  const stagedUploads = new Map<string, { mealId: string; generation: string }>();
  const uploadAttempts: Array<{ mealId: string; uploadId: string }> = [];
  const statusChecks: Array<{ mealId: string; uploadId: string }> = [];
  const mealSaves: Array<Record<string, unknown>> = [];
  const photoReads: string[] = [];
  const offline = new WeakSet<BrowserContext>();
  let nextUploadResponse: { status: number; code: string } | null = null;
  let stageOnNextFailedUpload = false;

  async function install(context: BrowserContext) {
    const token = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({
      sub: userId,
      user_id: userId,
      email: "tester@example.com",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      auth_time: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "demo-kcalcue",
      iss: "https://securetoken.google.com/demo-kcalcue",
      firebase: { sign_in_provider: "password" },
    })).toString("base64url")}.test`;

    await context.route("https://identitytoolkit.googleapis.com/**", async (route) => {
      if (offline.has(context)) return route.abort("internetdisconnected");
      const url = route.request().url();
      if (url.includes("sendOobCode")) return route.fulfill({ json: { email: "tester@example.com" } });
      if (url.includes("lookup")) {
        return route.fulfill({
          json: {
            users: [{
              localId: userId,
              email: "tester@example.com",
              emailVerified: true,
              providerUserInfo: [{ providerId: "password", email: "tester@example.com", federatedId: "tester@example.com" }],
              lastLoginAt: String(Date.now()),
              createdAt: String(Date.now()),
            }],
          },
        });
      }
      return route.fulfill({
        json: {
          localId: userId,
          email: "tester@example.com",
          idToken: token,
          refreshToken: "test-refresh",
          expiresIn: "3600",
          isNewUser: false,
        },
      });
    });

    await context.route("https://securetoken.googleapis.com/**", (route) =>
      offline.has(context)
        ? route.abort("internetdisconnected")
        : route.fulfill({
            json: {
              user_id: userId,
              id_token: token,
              refresh_token: "test-refresh",
              expires_in: "3600",
              token_type: "Bearer",
              project_id: "demo-kcalcue",
            },
          }),
    );

    await context.route("**/api/status", (route) =>
      offline.has(context)
        ? route.abort("internetdisconnected")
        : route.fulfill({
            json: { online: true, photoUploadsEnabled: options.photoUploadsEnabled },
          }),
    );

    await context.route("**/api/analyze", (route) =>
      offline.has(context)
        ? route.abort("internetdisconnected")
        : route.fulfill({ json: { mode: "live", analysis: sampleAnalysis } }),
    );

    await context.route("**/api/nutrition/resolve", (route) =>
      offline.has(context)
        ? route.abort("internetdisconnected")
        : route.fulfill({
            json: {
              provider: "kcalcue-reference",
              matches: createEditableFoodItems(sampleAnalysis.foods).map((item) => item.nutritionMatch),
            },
          }),
    );

    await context.route("**/api/meals**", async (route) => {
      if (offline.has(context)) return route.abort("internetdisconnected");
      const req = route.request();
      const url = new URL(req.url());

      if (url.pathname === "/api/meals/photo" && req.method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "image/jpeg",
          body: Buffer.from(options.jpegBytes),
        });
      }

      if (url.pathname === "/api/meals/photo/status" && req.method() === "POST") {
        const body = req.postDataJSON() as { mealId: string; uploadId: string };
        statusChecks.push({ mealId: body.mealId, uploadId: body.uploadId });
        const staged = stagedUploads.get(body.uploadId);
        return route.fulfill({
          json: { registryState: staged ? "staged" : "uploading" },
        });
      }

      const uploadMatch = /^\/api\/meals\/([^/]+)\/photo-uploads\/([^/]+)$/.exec(url.pathname);
      if (uploadMatch && req.method() === "POST") {
        const [, mealId, uploadId] = uploadMatch;
        uploadAttempts.push({ mealId, uploadId });
        if (nextUploadResponse) {
          const reply = nextUploadResponse;
          nextUploadResponse = null;
          if (stageOnNextFailedUpload) {
            stageOnNextFailedUpload = false;
            stagedUploads.set(uploadId, { mealId, generation: "9007199254740993" });
          }
          return route.fulfill({
            status: reply.status,
            json: { error: { code: reply.code } },
          });
        }
        const generation = "9007199254740993";
        stagedUploads.set(uploadId, { mealId, generation });
        return route.fulfill({
          json: {
            uploadId,
            state: "staged",
            photoRef: {
              attachmentId: uploadId,
              generation,
              contentType: "image/jpeg",
              width: 80,
              height: 60,
              byteSize: options.jpegBytes.byteLength,
            },
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        });
      }

      const photoReadMatch = /^\/api\/meals\/([^/]+)\/photo$/.exec(url.pathname);
      if (photoReadMatch && req.method() === "GET") {
        const meal = records.get(photoReadMatch[1]);
        if (!meal?.photoRef) {
          return route.fulfill({ status: 404, json: { error: { code: "photo_not_found" } } });
        }
        photoReads.push(photoReadMatch[1]);
        return route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
          body: Buffer.from(options.jpegBytes),
        });
      }

      if (req.method() === "GET") {
        return route.fulfill({ json: { records: [...records.values()] } });
      }

      if (req.method() === "POST") {
        const input = req.postDataJSON() as Record<string, unknown> & {
          id: string;
          version: number;
          mutationId: string;
          photoAction?: { kind: "attach"; uploadId: string } | { kind: "remove" };
        };
        mealSaves.push(input);
        const old = records.get(input.id);
        let photoRef = old?.photoRef ?? null;
        if (input.photoAction?.kind === "attach") {
          const staged = stagedUploads.get(input.photoAction.uploadId);
          if (!staged || staged.mealId !== input.id) {
            return route.fulfill({ status: 409, json: { error: { code: "photo_not_staged" } } });
          }
          photoRef = {
            attachmentId: input.photoAction.uploadId,
            generation: staged.generation,
            contentType: "image/jpeg",
            width: 80,
            height: 60,
            byteSize: options.jpegBytes.byteLength,
          };
        } else if (input.photoAction?.kind === "remove") {
          photoRef = null;
        }
        const saved: StoredRecord = {
          ...input,
          userId,
          version: input.version + 1,
          schemaVersion: 6,
          createdAt: old?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originalItems: old?.originalItems ?? input.items,
          photoRef,
        };
        records.set(input.id, saved);
        return route.fulfill({ json: { record: saved } });
      }
    });
  }

  return {
    records,
    uploadAttempts,
    statusChecks,
    mealSaves,
    photoReads,
    install,
    setOffline: async (context: BrowserContext, value: boolean) => {
      if (value) offline.add(context);
      else offline.delete(context);
      await context.setOffline(value);
    },
    failNextUpload: (status: number, code: string, stageBehindAck = false) => {
      nextUploadResponse = { status, code };
      stageOnNextFailedUpload = stageBehindAck;
    },
  };
}

async function login(page: Page) {
  await page.getByRole("button", { name: "帳戶與安裝", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("tester@example.com");
  await page.getByRole("button", { name: "寄出登入連結", exact: true }).click();
  await expect(page.getByText(/已寄出登入連結/)).toBeVisible();
  await page.goto("/?apiKey=test-firebase-key&oobCode=test-code&mode=signIn");
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();
  await expect.poll(() => page.url()).not.toContain("oobCode");
}

async function analyzeSyntheticPhoto(page: Page, jpeg: Uint8Array) {
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "meal.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(jpeg),
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
}

test("keeps photo retention disabled by default when flag is off", async ({ page, context }) => {
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "green" } })
    .jpeg().toBuffer();
  const backend = createPhotoBackend({ photoUploadsEnabled: false, jpegBytes: jpeg });
  await backend.install(context);
  await page.goto("/");
  await login(page);

  await page.getByRole("button", { name: "帳戶與安裝", exact: true }).click();
  await expect(page.getByText(/不會存入 Firebase Storage/)).toBeVisible();
  await page.getByRole("button", { name: "今日", exact: true }).click();

  await analyzeSyntheticPhoto(page, jpeg);
  await expect(page.getByRole("checkbox", { name: /儲存餐點縮圖供歷史查看/ })).toHaveCount(0);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();
  expect(backend.uploadAttempts).toHaveLength(0);
});

test("supports full opt-in attach, private History read on reload, and removal", async ({ page, context }) => {
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "green" } })
    .jpeg().toBuffer();
  const backend = createPhotoBackend({ photoUploadsEnabled: true, jpegBytes: jpeg });
  await backend.install(context);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await login(page);

  await analyzeSyntheticPhoto(page, jpeg);
  const optIn = page.getByRole("checkbox", { name: /儲存餐點縮圖供歷史查看/ });
  await expect(optIn).toBeVisible();
  await expect(optIn).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

  await optIn.check();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();

  expect(backend.uploadAttempts).toHaveLength(1);
  const uploadId = backend.uploadAttempts[0].uploadId;
  expect(backend.mealSaves[0]).toMatchObject({ photoAction: { kind: "attach", uploadId } });

  await page.reload();
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "歷史記錄", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看餐點附圖", exact: true }).click();
  const img = page.locator("figure.meal-photo img");
  await expect(img).toHaveAttribute("src", /^blob:/);
  expect(backend.photoReads).toHaveLength(1);

  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await page.getByRole("button", { name: "移除已保存圖片", exact: true }).click();
  await expect(page.getByText("儲存後將移除此餐附圖。")).toBeVisible();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();
  expect(backend.mealSaves.at(-1)).toMatchObject({ photoAction: { kind: "remove" } });

  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看餐點附圖", exact: true })).toHaveCount(0);
});

test("persists Blob offline across reload, recovers lost upload ACK by same uploadId, and supports save without photo", async ({ page, context }) => {
  const jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "green" } })
    .jpeg().toBuffer();
  const backend = createPhotoBackend({ photoUploadsEnabled: true, jpegBytes: jpeg });
  await backend.install(context);
  await page.goto("/");
  await login(page);

  await analyzeSyntheticPhoto(page, jpeg);
  await page.getByRole("checkbox", { name: /儲存餐點縮圖供歷史查看/ }).check();

  await backend.setOffline(context, true);
  await page.getByRole("button", { name: "離線儲存餐點", exact: true }).click();
  await expect(page.getByText("已保留本機；餐點及附圖待同步。")).toBeVisible();

  const storedBeforeReload = await page.evaluate(async () => {
    return await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open("kcalcue-sync");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("photoPayloads", "readonly");
        const countReq = tx.objectStore("photoPayloads").count();
        countReq.onsuccess = () => { db.close(); resolve(countReq.result); };
        countReq.onerror = () => reject(countReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  expect(storedBeforeReload).toBe(1);

  await page.reload();
  await expect(page.getByText(/1 項修改待同步/)).toBeVisible();

  // First upload response is lost (503) while server staged it; /api/meals/photo/status recovers it.
  backend.failNextUpload(503, "photo_storage_unavailable", true);
  await backend.setOffline(context, false);
  await expect.poll(() => backend.mealSaves.length).toBe(1);
  expect(backend.uploadAttempts).toHaveLength(1);
  expect(backend.statusChecks).toHaveLength(1);
  expect(backend.statusChecks[0].uploadId).toBe(backend.uploadAttempts[0].uploadId);
  expect(backend.mealSaves[0]).toMatchObject({
    photoAction: { kind: "attach", uploadId: backend.uploadAttempts[0].uploadId },
  });

  const storedAfterAck = await page.evaluate(async () => {
    return await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open("kcalcue-sync");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("photoPayloads", "readonly");
        const countReq = tx.objectStore("photoPayloads").count();
        countReq.onsuccess = () => { db.close(); resolve(countReq.result); };
        countReq.onerror = () => reject(countReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  expect(storedAfterAck).toBe(0);

  // Escape hatch: blocked photo upload allows saving meal without photo with a new mutationId.
  await analyzeSyntheticPhoto(page, jpeg);
  await page.getByRole("checkbox", { name: /儲存餐點縮圖供歷史查看/ }).check();
  backend.failNextUpload(413, "photo_output_too_large", false);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  const escapeBtn = page.getByRole("button", { name: "不附圖儲存餐點", exact: true });
  await expect(escapeBtn).toBeVisible();
  await escapeBtn.click();
  await expect.poll(() => backend.mealSaves.length).toBe(2);
  expect(backend.mealSaves[1]).not.toHaveProperty("photoAction");
});
