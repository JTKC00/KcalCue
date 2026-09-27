import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";
import path from "node:path";

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

test("whole-meal user calories survive reload without inventing nutrition, and can be cleared", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await rice(page);
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("自訂測試餐");
  await page.getByRole("button", { name: "自行填寫本餐卡路里", exact: true }).click();
  const input = page.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）", exact: true });
  await input.fill("650");
  await expect(page.getByRole("heading", { name: "手動記錄：650 kcal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  expect([...backend.records.values()][0].calorieCorrection).toEqual({ kcal: 650, source: "user" });
  expect(backend.saves[0]).not.toHaveProperty("calorieInput");
  const total = page.locator(".day-summary > div").filter({ hasText: "卡路里" }).locator("strong");
  const todaySummary = page.locator('.day-summary[aria-label="今日摘要"]');
  await expect(todaySummary).toContainText("今日餐數1餐");
  await expect(total).toHaveText("650");
  await expect(page.locator(".meal-calories")).toHaveText("手動記錄：650 kcal");
  await expect(page.locator(".day-summary > div").filter({ hasText: "蛋白質" }).locator("strong")).toHaveText("未知");
  await page.reload();
  await expect(todaySummary).toContainText("今日餐數1餐");
  await expect(total).toHaveText("650");
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.locator(".meal-calories")).toHaveText("手動記錄：650 kcal");
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(input).toHaveValue("650");

  // An empty editor is invalid, not a user-confirmed zero or the old value.
  await input.fill("");
  const savesBefore = backend.saves.length;
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByRole("region", { name: "本餐卡路里修正" }).getByRole("alert")).toContainText("空白不代表零");
  expect(backend.saves).toHaveLength(savesBefore);
  await expect.poll(() => page.evaluate(async (uid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("kcalcue-private");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        const get = tx.objectStore("accounts").get(uid);
        tx.oncomplete = () => resolve(get.result?.draft?.calorieInput);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, userId)).toBe("");
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("region", { name: "本餐卡路里修正" }).getByRole("alert")).toContainText("空白不代表零");
  await input.fill("0");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => [...backend.records.values()][0].version).toBe(2);
  await expect(total).toHaveText("0");
  await expect(page.locator(".meal-calories")).toHaveText("手動記錄：0 kcal");
  await page.reload();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await page.getByRole("button", { name: "恢復參考估算", exact: true }).click();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => [...backend.records.values()][0].version).toBe(3);
  expect([...backend.records.values()][0].calorieCorrection).toBeNull();
  await page.reload();
  await expect(total).toHaveText("未知");
  await expect(page.locator(".meal-calories")).toHaveText("卡路里未知");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(0);
  await expect(page.getByRole("heading", { name: "今日未有記錄", exact: true })).toBeVisible();
  await expect(todaySummary).toContainText("今日餐數0餐");
});

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

test("a queued meal survives an additive IndexedDB schema upgrade and syncs", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const readJob = () => page.evaluate(async (uid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kcalcue-sync");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ id: string; mealId: string; expectedVersion: number } | null>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        const request = tx.objectStore("accounts").get(uid);
        tx.oncomplete = () => {
          const job = request.result?.jobs?.[0];
          resolve(job ? { id: job.id, mealId: job.record.id, expectedVersion: job.expectedVersion } : null);
        };
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, userId);
  await backend.setOffline(context, true);
  await rice(page);
  await page.getByRole("button", { name: "離線儲存餐點", exact: true }).click();
  await expect.poll(readJob).not.toBeNull();
  const pending = await readJob();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("kcalcue-sync", 2);
    request.onupgradeneeded = () => request.result.createObjectStore("photoPayloads");
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IDB upgrade blocked"));
  }));
  await page.reload();
  expect(await readJob()).toEqual(pending);
  await backend.setOffline(context, false);
  await expect.poll(() => backend.records.size).toBe(1);
  expect(backend.saves[0].mutationId).toBe(pending?.id);
  expect(backend.saves[0].id).toBe(pending?.mealId);
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

test("real photo preview with mocked analysis supports correction, reload, history, edit and delete", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let analyses = 0;
  let finishAnalysis!: () => void;
  const release = new Promise<void>((resolve) => { finishAnalysis = resolve; });
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    await release;
    await route.fulfill({ json: { mode: "live", analysis: {
      analysisStatus: "success",
      foods: [{
        displayName: "港式奶茶", normalizedName: "hong kong milk tea",
        identityLevel: "dish", portionMin: 200, portionMax: 300, unit: "ml",
        recognitionConfidence: 0.8, portionConfidence: 0.3,
        uncertaintyReasons: ["容量、糖量及奶比例未知，請按實際飲用份量修正。"],
      }],
      uncertaintyReasons: ["容量未知"], visibleEvidence: ["杯中的飲品"],
      estimatedInformation: ["飲用份量"], unknownInformation: ["糖量"],
    } } });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"));
  await expect(page.getByRole("img", { name: "已選擇的餐點相片預覽" })).toBeVisible();
  // The server is intentionally in demo mode; only this response is mocked live.
  // The photo remains local. This is not production real-image AI acceptance.
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析緊你嘅餐點…" })).toBeVisible();
  expect(analyses).toBe(1);
  finishAnalysis();
  await expect(page.getByText("AI 分析結果", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /約 .*kcal/ })).toBeVisible();
  await page.getByRole("spinbutton", { name: "最少份量", exact: true }).fill("150");
  await page.getByRole("spinbutton", { name: "最多份量", exact: true }).fill("180");
  // PortionInput commits on blur. selectOption changes a select without moving
  // keyboard focus, so explicitly finish the numeric edit before reading totals.
  await page.getByRole("spinbutton", { name: "最多份量", exact: true }).press("Tab");
  await page.getByRole("combobox", { name: "餐次", exact: true }).selectOption("breakfast");
  const firstRange = await page.locator("#result-title span").innerText();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  await expect(page.getByText(/項修改待同步/)).not.toBeVisible();
  await expect(page.locator(".journal-notice")).not.toBeVisible();
  expect(backend.saves).toHaveLength(1);
  const first = [...backend.records.values()][0];
  expect(first).toMatchObject({ mealType: "breakfast", mode: "live", photoPath: null, items: [{ portionMin: 150, portionMax: 180 }] });
  expect(first).not.toHaveProperty("photo");
  const todayCalories = page.locator(".day-summary > div").filter({ hasText: "卡路里" }).locator("strong");
  await expect(todayCalories).toHaveText(firstRange);
  await expect(page.getByRole("region", { name: "早餐" }).getByRole("heading", { name: "港式奶茶", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "午餐" })).toContainText("未有記錄");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "港式奶茶", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "早餐" }).getByRole("heading", { name: "港式奶茶", exact: true })).toBeVisible();
  await expect(todayCalories).toHaveText(firstRange);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "港式奶茶", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "最少份量", exact: true })).toHaveValue("150");
  await page.getByRole("spinbutton", { name: "最多份量", exact: true }).fill("220");
  await page.getByRole("spinbutton", { name: "最多份量", exact: true }).press("Tab");
  const editedRange = await page.locator("#result-title span").innerText();
  expect(editedRange).not.toBe(firstRange);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => [...backend.records.values()][0]?.version).toBe(2);
  expect([...backend.records.values()][0]).toMatchObject({ items: [{ portionMin: 150, portionMax: 220 }] });
  await expect(todayCalories).toHaveText(editedRange);
  expect(analyses).toBe(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(0);
  // Confirmed deletion must clear the local-pending acknowledgement before
  // reload; reloading alone would hide a stale in-memory notice.
  await expect(page.getByText(/項修改待同步/)).not.toBeVisible();
  await expect(page.locator(".journal-notice")).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "今日未有記錄", exact: true })).toBeVisible();
  await expect(todayCalories).toHaveText("0");
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("AI failure keeps the selected photo and a double tap starts one new analysis", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  let analyses = 0;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    if (analyses === 1) {
      await route.fulfill({ status: 503, json: { error: { code: "service_unavailable" } } });
      return;
    }
    await retryGate;
    await route.fulfill({ json: { mode: "live", analysis: {
      analysisStatus: "success",
      foods: [{ displayName: "白飯", normalizedName: "cooked white rice",
        identityLevel: "ingredient", portionMin: 100, portionMax: 150, unit: "g",
        recognitionConfidence: 0.8, portionConfidence: 0.5, uncertaintyReasons: [] }],
      uncertaintyReasons: [], visibleEvidence: ["白飯"],
      estimatedInformation: ["份量"], unknownInformation: [],
    } } });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(
    path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"),
  );
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI 服務暫時有問題" })).toBeVisible();
  await expect(page.getByRole("img", { name: "未能完成分析的餐點相片" })).toBeVisible();
  expect(analyses).toBe(1);
  expect(backend.saves).toHaveLength(0);
  const retry = page.getByRole("button", { name: "再試一次", exact: true });
  await retry.scrollIntoViewIfNeeded();
  const bounds = await retry.boundingBox();
  expect(bounds).not.toBeNull();
  // Mouse input sends two browser clicks even if React replaces the button
  // after the first click; this verifies the user-visible double-tap outcome.
  await page.mouse.dblclick(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await expect(page.getByRole("heading", { name: "分析緊你嘅餐點…" })).toBeVisible();
  await expect.poll(() => analyses).toBe(2);
  releaseRetry();
  await expect(page.getByText("AI 分析結果", { exact: true })).toBeVisible();
  expect(analyses).toBe(2);
  expect(backend.saves).toHaveLength(0);
});

test("refresh during an unfinished analysis restores the durable photo draft", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  let analyses = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    if (analyses === 1) {
      await firstGate;
      try { await route.fulfill({ status: 503, json: { error: { code: "service_unavailable" } } }); }
      catch { /* Navigation cancelled the old request. */ }
      return;
    }
    await route.fulfill({ json: { mode: "live", analysis: {
      analysisStatus: "unable_to_identify", foods: [], uncertaintyReasons: [],
      visibleEvidence: [], estimatedInformation: [], unknownInformation: ["食物"],
    } } });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(
    path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"),
  );
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析緊你嘅餐點…" })).toBeVisible();
  await expect.poll(() => analyses).toBe(1);
  await expect.poll(() => page.evaluate(async (uid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("kcalcue-private");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        const get = tx.objectStore("accounts").get(uid);
        tx.oncomplete = () => resolve(get.result?.draft?.photo?.size ?? 0);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, userId)).toBeGreaterThan(0);
  await page.reload();
  releaseFirst();
  await expect(page.getByRole("heading", { name: "新餐點草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "已選擇的餐點相片預覽" })).toBeVisible();
  await expect(page.getByText("AI 分析結果", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "無法可靠辨認" })).toBeVisible();
  expect(analyses).toBe(2);
  expect(backend.saves).toHaveLength(0);
});

test("entitlement denial retains a manual meal locally until an explicit sync retry", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  let entitled = false;
  await context.route("**/api/meals**", (route) => entitled
    ? route.fallback()
    : route.fulfill({ status: 403, json: { error: { code: "trial_access_required" } } }));
  let analyses = 0;
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    await route.fulfill({ status: 403, json: { error: { code: "trial_access_required" } } });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(
    path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"),
  );
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "尚未開通試用權限" })).toBeVisible();
  expect(analyses).toBe(1);
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("白飯");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
  await expect(page.getByText(/白飯：這個 Email 尚未獲得試用權限/)).toBeVisible();
  expect(backend.records.size).toBe(0);
  expect(backend.saves).toHaveLength(0);
  entitled = true;
  await page.reload();
  await expect(page.getByText(/1 項修改待同步/)).toBeVisible();
  expect(backend.records.size).toBe(0);
  await page.getByRole("button", { name: "重試同步", exact: true }).click();
  await expect.poll(() => backend.records.size, { timeout: 12_000 }).toBe(1);
  expect(backend.saves).toHaveLength(1);
  expect(backend.saves[0]).toMatchObject({ mode: "manual", photoPath: null });
  expect(analyses).toBe(1);
});

test("unreadable photo preparation can be retried or removed without blocking a manual meal", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.addInitScript(() => {
    const instrumented = window as Window & { __photoDecodeAttempts?: number };
    instrumented.__photoDecodeAttempts = 0;
    window.createImageBitmap = (async () => {
      instrumented.__photoDecodeAttempts = (instrumented.__photoDecodeAttempts ?? 0) + 1;
      throw new Error("synthetic decode failure");
    }) as typeof createImageBitmap;
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "unreadable.heic", mimeType: "image/heic", buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(page.getByRole("button", { name: "重試照片處理", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __photoDecodeAttempts?: number }).__photoDecodeAttempts)).toBe(1);
  await page.getByRole("button", { name: "重試照片處理", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __photoDecodeAttempts?: number }).__photoDecodeAttempts)).toBe(2);
  await expect(page.getByRole("button", { name: "重試照片處理", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "移除草稿圖片", exact: true }).click();
  await expect(page.getByRole("button", { name: "移除草稿圖片", exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "重試照片處理", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("白飯");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  expect(backend.saves).toHaveLength(1);
  expect(backend.saves[0]).toMatchObject({ mode: "manual", photoPath: null });
});

test("analysis timeout leaves the photo available for a later retry", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  let analyses = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    if (analyses === 1) {
      await firstGate;
      try { await route.fulfill({ status: 503, json: { error: { code: "service_unavailable" } } }); }
      catch { /* The timed-out request was cancelled. */ }
      return;
    }
    await route.fulfill({ json: { mode: "live", analysis: {
      analysisStatus: "unable_to_identify", foods: [], uncertaintyReasons: [],
      visibleEvidence: [], estimatedInformation: [], unknownInformation: ["食物"],
    } } });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "＋ 新增餐點", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(
    path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"),
  );
  await page.clock.install();
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析緊你嘅餐點…" })).toBeVisible();
  await expect.poll(() => analyses).toBe(1);
  await page.clock.fastForward(90_001);
  await expect(page.getByRole("heading", { name: "分析等候時間太長" })).toBeVisible();
  await expect(page.getByRole("img", { name: "未能完成分析的餐點相片" })).toBeVisible();
  releaseFirst();
  await page.getByRole("button", { name: "再試一次", exact: true }).click();
  await expect(page.getByRole("heading", { name: "無法可靠辨認" })).toBeVisible();
  expect(analyses).toBe(2);
  expect(backend.saves).toHaveLength(0);
});

test.describe("Today across local midnight", () => {
  test.use({ timezoneId: "Asia/Hong_Kong" });

  test("moves yesterday's offline meal out of Today without a reload", async ({ page, context }) => {
    const backend = cloud();
    await backend.install(context);
    await page.goto("/");
    await login(page);

    const nearMidnight = new Date();
    nearMidnight.setUTCHours(15, 59, 50, 0); // 23:59:50 in Hong Kong.
    if (nearMidnight.getTime() <= Date.now()) nearMidnight.setUTCDate(nearMidnight.getUTCDate() + 1);
    await page.clock.setFixedTime(nearMidnight);
    await backend.setOffline(context, true);
    await expect(page.getByText(/離線中/)).toBeVisible();
    await rice(page);
    await page.getByRole("button", { name: "自行填寫本餐卡路里", exact: true }).click();
    await page.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）", exact: true }).fill("650");
    await page.getByRole("button", { name: "離線儲存餐點", exact: true }).click();
    const todayCalories = page.locator(".day-summary > div").filter({ hasText: "卡路里" }).locator("strong");
    await expect(todayCalories).toHaveText("650");
    await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
    await expect(page.getByText("1 項修改待同步", { exact: true })).toBeVisible();

    await page.clock.setFixedTime(new Date(nearMidnight.getTime() + 20_000));
    await expect(page.getByRole("heading", { name: "今日未有記錄", exact: true })).toBeVisible();
    await expect(todayCalories).toHaveText("0");
    await expect(page.getByText(/之前的餐點可在歷史記錄查看/)).toBeVisible();
    await page.getByRole("button", { name: "歷史", exact: true }).click();
    await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
    await expect(page.locator(".meal-calories")).toHaveText("手動記錄：650 kcal");
    expect(backend.records.size).toBe(0);
  });
});
