import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";

const userId = "11111111-1111-4111-8111-111111111111";
type TestRecord = {
  id: string;
  version: number;
  mutationId: string;
  [key: string]: unknown;
};
function cloud() {
  const records = new Map<string, TestRecord>();
  const saves: TestRecord[] = [];
  let failSave = false;
  const offline = new WeakSet<BrowserContext>();
  async function install(context: BrowserContext) {
    const token = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId, user_id: userId, email: "tester@example.com", email_verified: true, iat: Math.floor(Date.now() / 1000), auth_time: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, aud: "demo-kcalcue", iss: "https://securetoken.google.com/demo-kcalcue", firebase: { sign_in_provider: "password" } })).toString("base64url")}.test`;
    await context.route(
      "https://identitytoolkit.googleapis.com/**",
      async (route) => {
        if (offline.has(context)) return route.abort("internetdisconnected");
        const url = route.request().url();
        if (url.includes("sendOobCode"))
          return route.fulfill({ json: { email: "tester@example.com" } });
        if (url.includes("lookup"))
          return route.fulfill({
            json: {
              users: [
                {
                  localId: userId,
                  email: "tester@example.com",
                  emailVerified: true,
                  providerUserInfo: [
                    {
                      providerId: "password",
                      email: "tester@example.com",
                      federatedId: "tester@example.com",
                    },
                  ],
                  lastLoginAt: String(Date.now()),
                  createdAt: String(Date.now()),
                },
              ],
            },
          });
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
      },
    );
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
    await context.route("**/api/meals**", async (route) => {
      if (offline.has(context)) return route.abort("internetdisconnected");
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === "/api/meals/photo" && req.method() === "POST") {
        await route.fulfill({
          status: 503,
          json: { error: { code: "photo_failed" } },
        });
        return;
      }
      if (req.method() === "GET") {
        await route.fulfill({ json: { records: [...records.values()] } });
        return;
      }
      if (req.method() === "DELETE") {
        records.delete(url.pathname.split("/").at(-1)!);
        await route.fulfill({ json: { ok: true } });
        return;
      }
      const input = req.postDataJSON() as TestRecord;
      saves.push(input);
      if (failSave) {
        failSave = false;
        await route.fulfill({
          status: 503,
          json: { error: { code: "save_failed" } },
        });
        return;
      }
      const old = records.get(input.id);
      if (
        old &&
        old.version !== input.version &&
        old.mutationId !== input.mutationId
      ) {
        await route.fulfill({
          status: 409,
          json: { error: { code: "conflict" } },
        });
        return;
      }
      const record = {
        ...input,
        userId,
        version:
          old?.mutationId === input.mutationId
            ? old.version
            : input.version + 1,
        updatedAt: new Date().toISOString(),
        originalItems: old?.originalItems ?? input.items,
      };
      records.set(input.id, record);
      await route.fulfill({ json: { record } });
    });
  }
  return {
    records,
    saves,
    install,
    setOffline: async (context: BrowserContext, value: boolean) => {
      if (value) offline.add(context);
      else offline.delete(context);
      await context.setOffline(value);
    },
    failNextSave: () => {
      failSave = true;
    },
  };
}

async function login(page: Page) {
  await page.getByRole("button", { name: "帳戶與安裝", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "使用 Google 登入", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("tester@example.com");
  await page.getByRole("button", { name: "寄出登入連結", exact: true }).click();
  await expect(page.getByText(/已寄出登入連結/)).toBeVisible();
  await page.goto("/?apiKey=test-firebase-key&oobCode=test-code&mode=signIn");
  await expect(
    page.getByRole("heading", { name: "今日飲食", exact: true }),
  ).toBeVisible();
  await expect.poll(() => page.url()).not.toContain("oobCode");
}
async function rice(page: Page) {
  await page.getByRole("button", { name: "手動記一餐", exact: true }).click();
  await page
    .getByRole("combobox", { name: "食物名稱", exact: true })
    .fill("白飯");
}

test("correcting an AI dish to banana survives cloud save, reload and history editing", async ({
  page,
  context,
}) => {
  const backend = cloud();
  await backend.install(context);
  const originalAnalysis = {
    analysisStatus: "success",
    foods: [{
      displayName: "混合沙律",
      normalizedName: "mixed salad",
      identityLevel: "dish",
      portionMin: 100,
      portionMax: 150,
      unit: "g",
      recognitionConfidence: 0.5,
      portionConfidence: 0.5,
      uncertaintyReasons: ["請確認份量。"],
      preparationMethod: "grilled",
      visibleIngredients: ["rice", "chicken"],
      notes: "原始 AI 食材推測。",
    }],
    uncertaintyReasons: [],
    visibleEvidence: ["合成測試餐點"],
    estimatedInformation: ["估計份量"],
    unknownInformation: [],
  };
  // Synthetic Live response only: the E2E server has no provider credentials.
  await context.route("**/api/analyze", (route) => route.fulfill({
    json: { mode: "live", analysis: originalAnalysis },
  }));
  await context.route("**/api/nutrition/resolve", (route) => route.fulfill({
    json: {
      provider: "kcalcue-reference",
      matches: [{
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: ["找到相近的基礎食材資料，但不足以代表整道菜，因此未納入總數。"],
        identity: {
          canonicalName: "mixed-dish",
          category: "mixed",
          preparation: "grilled",
          qualifiers: ["composite"],
        },
        includedInTotal: false,
      }],
    },
  }));

  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "yellow" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "synthetic-meal.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "暫未能計算", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("混合沙律");

  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("香蕉");
  const estimate = page.getByRole("heading", { name: /約 .*kcal/ });
  await expect(estimate).toBeVisible();
  const correctedEstimate = await estimate.textContent();
  await expect(page.getByRole("spinbutton", { name: "最少份量", exact: true })).toHaveValue("100");
  await expect(page.getByRole("spinbutton", { name: "最多份量", exact: true })).toHaveValue("150");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  await expect(page.getByText(/項修改待同步/)).not.toBeVisible();

  expect(backend.saves).toHaveLength(1);
  const saved = backend.saves[0];
  expect(saved.analysis).toEqual(originalAnalysis);
  expect(saved.items).toEqual([expect.objectContaining({
    displayName: "香蕉",
    normalizedName: "banana",
    identityLevel: "ingredient",
    portionMin: 100,
    portionMax: 150,
    unit: "g",
  })]);
  const [corrected] = saved.items as Array<Record<string, unknown>>;
  expect(corrected).not.toHaveProperty("preparationMethod");
  expect(corrected).not.toHaveProperty("visibleIngredients");
  expect(corrected).not.toHaveProperty("notes");

  const readback = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/meals" && response.request().method() === "GET",
  );
  await page.reload();
  expect((await (await readback).json()).records[0]).toMatchObject({
    id: saved.id, version: 1, analysis: originalAnalysis, items: saved.items,
  });
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "歷史記錄", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "香蕉", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("香蕉");
  await expect(estimate).toHaveText(correctedEstimate!);
  await expect(page.getByRole("spinbutton", { name: "最少份量", exact: true })).toHaveValue("100");
  await expect(page.getByRole("spinbutton", { name: "最多份量", exact: true })).toHaveValue("150");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("Email link login restores a guest draft and automatically retries a failed save", async ({
  page,
  context,
}) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await rice(page);
  await page
    .getByRole("spinbutton", { name: "最少份量", exact: true })
    .fill("120");
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await login(page);
  await page.getByRole("button", { name: "繼續草稿", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "最少份量", exact: true }),
  ).toHaveValue("120");
  backend.failNextSave();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByText(/1 項修改待同步/)).toBeVisible();
  await expect.poll(() => backend.records.size, { timeout: 12_000 }).toBe(1);
  await expect(page.getByText(/1 項修改待同步/)).not.toBeVisible();
  expect(backend.saves[0].mutationId).toBe(backend.saves[1].mutationId);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("offline creation, edit and deletion survive reload and synchronize on reconnection", async ({
  page,
  context,
}) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await backend.setOffline(context, true);
  await rice(page);
  await page.getByRole("button", { name: "離線儲存餐點", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看／修正", exact: true }),
  ).toBeVisible();
  expect(backend.records.size).toBe(0);
  await page.reload();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "最多份量", exact: true })
    .fill("200");
  await page.getByRole("button", { name: "離線儲存餐點", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日飲食", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText(/2 項修改待同步/)).toBeVisible();
  await backend.setOffline(context, false);
  await expect
    .poll(() => [...backend.records.values()][0]?.version, { timeout: 12_000 })
    .toBe(2);
  await expect(page.getByText(/項修改待同步/)).not.toBeVisible();
  await backend.setOffline(context, true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日未有記錄", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "今日未有記錄", exact: true }),
  ).toBeVisible();
  expect(backend.records.size).toBe(1);
  await backend.setOffline(context, false);
  await expect.poll(() => backend.records.size, { timeout: 12_000 }).toBe(0);
});

test("cross-device conflict preserves the offline edit for recovery", async ({
  browser,
}) => {
  const backend = cloud();
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(),
  ]);
  const pages = await Promise.all(
    contexts.map(async (context) => {
      await backend.install(context);
      const page = await context.newPage();
      await page.goto("/");
      await login(page);
      return page;
    }),
  );
  const [first, second] = pages;
  await rice(first);
  await first.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  await second.reload();
  for (const page of pages)
    await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await backend.setOffline(contexts[1], true);
  await second
    .getByRole("spinbutton", { name: "最多份量", exact: true })
    .fill("300");
  await second
    .getByRole("button", { name: "離線儲存餐點", exact: true })
    .click();
  await first
    .getByRole("spinbutton", { name: "最多份量", exact: true })
    .fill("200");
  await first.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect
    .poll(() => [...backend.records.values()][0]?.version, { timeout: 12_000 })
    .toBe(2);
  await backend.setOffline(contexts[1], false);
  await expect(
    second.getByRole("button", { name: "保留修改為新餐點草稿", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "保留修改為新餐點草稿", exact: true })
    .click();
  await expect(
    second.getByRole("spinbutton", { name: "最多份量", exact: true }),
  ).toHaveValue("300");
  expect([...backend.records.values()][0].version).toBe(2);
  await Promise.all(contexts.map((context) => context.close()));
});

test("PWA shell restores a guest draft offline", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await rice(page);
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/離線中 · 可新增、修改及刪除/)).toBeVisible();
  await page.getByRole("button", { name: "繼續草稿", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "食物名稱", exact: true }),
  ).toHaveValue("白飯");
});

test("saving a meal never uploads or persists its source image", async ({
  page,
  context,
}) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/meals/photo") ||
      request.url().includes("firebasestorage")
    )
      uploads.push(request.url());
  });
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: "meal.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  await page
    .getByRole("combobox", { name: "食物名稱", exact: true })
    .fill("白飯");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  expect(uploads).toEqual([]);
  const saved = [...backend.records.values()][0];
  expect(saved.photoPath).toBeNull();
  expect(saved).not.toHaveProperty("photo");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "繼續草稿", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "移除草稿圖片", exact: true }),
  ).not.toBeVisible();
});
