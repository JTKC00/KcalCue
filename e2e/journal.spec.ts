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
  await page.reload();
  await expect(page.getByRole("heading", { name: "港式奶茶", exact: true })).toBeVisible();
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
  await expect(todayCalories).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
