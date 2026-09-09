import { expect, test, type BrowserContext } from "@playwright/test";
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
  async function install(context: BrowserContext) {
    await context.route(
      "https://kcalcue-test.supabase.co/**",
      async (route) => {
        const user = {
          id: userId,
          aud: "authenticated",
          role: "authenticated",
          email: "tester@example.com",
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        };
        if (route.request().url().includes("/otp")) {
          await route.fulfill({ json: {} });
          return;
        }
        const token = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.test`;
        await route.fulfill({
          json: {
            access_token: token,
            refresh_token: "test-refresh",
            token_type: "bearer",
            expires_in: 3600,
            user,
          },
        });
      },
    );
    await context.route("**/api/meals**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === "/api/meals/photo" && req.method() === "POST") {
        await route.fulfill({
          status: 503,
          json: { error: { code: "photo_failed" } },
        });
        return;
      }
      if (url.pathname === "/api/meals/cleanup") {
        await route.fulfill({ json: { paths: [] } });
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
    failNextSave: () => {
      failSave = true;
    },
  };
}

test("manual draft survives navigation, login, retry and history correction", async ({
  page,
  context,
}) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await page.getByRole("button", { name: "手動記一餐", exact: true }).click();
  await page
    .getByRole("combobox", { name: "食物名稱", exact: true })
    .fill("白飯");
  await page
    .getByRole("spinbutton", { name: "最少份量", exact: true })
    .fill("");
  await page.getByRole("spinbutton", { name: "最多份量", exact: true }).click();
  await expect(
    page.getByText("請輸入 0.1 至 5000 的份量。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("spinbutton", { name: "最少份量", exact: true })
    .fill("120");
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await page.getByRole("button", { name: "繼續草稿", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "最少份量", exact: true }),
  ).toHaveValue("120");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("tester@example.com");
  await page.getByRole("button", { name: "寄出驗證碼", exact: true }).click();
  await page
    .getByRole("textbox", { name: "驗證碼", exact: true })
    .fill("123456");
  await page.getByRole("button", { name: "驗證並登入", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "食物名稱", exact: true }),
  ).toHaveValue("白飯");
  backend.failNextSave();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    page.getByText("未能連接雲端，草稿仍保留。請稍後再試。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日飲食", exact: true }),
  ).toBeVisible();
  expect(backend.saves[0].id).toBe(backend.saves[1].id);
  expect(backend.saves[0].mutationId).toBe(backend.saves[1].mutationId);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "查看／修正", exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "最多份量", exact: true })
    .fill("200");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日飲食", exact: true }),
  ).toBeVisible();
  expect([...backend.records.values()][0].version).toBe(2);
  await expect(page.locator(".day-summary")).toContainText("260");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "今日未有記錄", exact: true }),
  ).toBeVisible();
  expect(backend.records.size).toBe(0);
});

test("cross-device conflict preserves draft instead of silently overwriting", async ({
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
      await page
        .getByRole("button", { name: "帳戶與安裝", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Email", exact: true })
        .fill("tester@example.com");
      await page
        .getByRole("button", { name: "寄出驗證碼", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "驗證碼", exact: true })
        .fill("123456");
      await page
        .getByRole("button", { name: "驗證並登入", exact: true })
        .click();
      return page;
    }),
  );
  const [first, second] = pages;
  await first.getByRole("button", { name: "手動記一餐", exact: true }).click();
  await first
    .getByRole("combobox", { name: "食物名稱", exact: true })
    .fill("白飯");
  await first.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    first.getByRole("button", { name: "查看／修正", exact: true }),
  ).toBeVisible();
  await second.reload();
  for (const page of pages)
    await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await first
    .getByRole("spinbutton", { name: "最多份量", exact: true })
    .fill("200");
  await first.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    first.getByRole("heading", { name: "今日飲食", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("spinbutton", { name: "最多份量", exact: true })
    .fill("300");
  await second.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    second.getByRole("button", { name: "載入最新記錄", exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("spinbutton", { name: "最多份量", exact: true }),
  ).toHaveValue("300");
  expect([...backend.records.values()][0].version).toBe(2);
  await Promise.all(contexts.map((context) => context.close()));
});

test("PWA shell reopens offline and restores a locally saved draft", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByRole("button", { name: "手動記一餐", exact: true }).click();
  await page
    .getByRole("combobox", { name: "食物名稱", exact: true })
    .fill("白飯");
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "繼續草稿", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText(/離線中 · 可查看已下載記錄及保留草稿/),
  ).toBeVisible();
  await page.getByRole("button", { name: "繼續草稿", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "食物名稱", exact: true }),
  ).toHaveValue("白飯");
  await context.setOffline(false);
});

test("a photo upload failure allows explicit save without the photo", async ({
  page,
  context,
}) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
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
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("tester@example.com");
  await page.getByRole("button", { name: "寄出驗證碼", exact: true }).click();
  await page
    .getByRole("textbox", { name: "驗證碼", exact: true })
    .fill("123456");
  await page.getByRole("button", { name: "驗證並登入", exact: true }).click();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    page.getByText("照片未能上傳，可再試一次，或選擇不保存照片。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(backend.records.size).toBe(0);
  await page.getByRole("button", { name: "不保存照片", exact: true }).click();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "查看／修正", exact: true }),
  ).toBeVisible();
  expect([...backend.records.values()][0].photoPath).toBeNull();
});
