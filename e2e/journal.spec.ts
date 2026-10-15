import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import sharp from "sharp";
import path from "node:path";

import { foodAnalysisSchema, type FoodAnalysis, type ObservedFood } from "../src/lib/domain/food-analysis";
import { productionGlassMilkUnknownAnalysis } from "../src/lib/nutrition/photo-milk-prod-qa.fixture";
import { c3Run1SingleOatCartonAnalysis, c4TwoMilkContainersAnalysis, m6CartonAndGlassAnalysis } from "../src/lib/nutrition/m7-milk-dedupe.fixture";
import { preparePhotoMilkAnalysis } from "../src/lib/domain/photo-milk-analysis";
import { qaSuspectedMilkAnalysis } from "../src/lib/domain/qa-suspected-milk";
import { createEditableFoodItems } from "../src/lib/domain/editable-meal";
import { roundRange } from "../src/lib/nutrition/calculation";
import { LocalNutritionProvider } from "../src/lib/nutrition/local-provider";
import { NutritionService } from "../src/lib/nutrition/service";

const userId = "11111111-1111-4111-8111-111111111111";
type TestRecord = {
  id: string;
  version: number;
  mutationId: string;
  [key: string]: unknown;
};
function cloud() {
  const records = new Map<string, TestRecord>();
  const tombstones = new Map<string, { version: number; mutationId: string }>();
  const saves: TestRecord[] = [];
  let failSave = false;
  let blockSave = false;
  let failAfterCommittedSave = false;
  let committedSaveAckGate: Promise<void> | null = null;
  let releaseCommittedSaveAck: (() => void) | null = null;
  let failMealRead = false;
  let mealPageSize: number | null = null;
  const mealReadUrls: string[] = [];
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
        mealReadUrls.push(req.url());
        if (failMealRead) {
          await route.fulfill({
            status: 503,
            json: { error: { code: "service_unavailable" } },
          });
          return;
        }
        if (mealPageSize && url.searchParams.get("paged") === "1") {
          const sorted = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
          const cursor = url.searchParams.get("cursor");
          const start = cursor ? sorted.findIndex((record) => record.id === cursor) + 1 : 0;
          const page = sorted.slice(start, start + mealPageSize);
          const nextCursor = page.length === mealPageSize ? page.at(-1)?.id : undefined;
          await route.fulfill({ json: {
            records: page, revision: "paged-test-revision",
            ...(nextCursor ? { nextCursor } : {}),
          } });
          return;
        }
        await route.fulfill({ json: { records: [...records.values()] } });
        return;
      }
      if (req.method() === "DELETE") {
        const id = url.pathname.split("/").at(-1)!;
        const version = Number(url.searchParams.get("version"));
        const mutationId = url.searchParams.get("mutationId")!;
        const previous = records.get(id);
        const tombstone = tombstones.get(id);
        if (tombstone) {
          if (tombstone.mutationId !== mutationId && tombstone.version !== version + 1)
            return route.fulfill({ status: 409, json: { error: { code: "conflict" } } });
        } else if ((previous?.version ?? 0) !== version) {
          return route.fulfill({ status: 409, json: { error: { code: "conflict" } } });
        } else {
          records.delete(id);
          tombstones.set(id, { version: version + 1, mutationId });
        }
        await route.fulfill({ json: { ok: true } });
        return;
      }
      const input = req.postDataJSON() as TestRecord;
      saves.push(input);
      if (blockSave) {
        await route.fulfill({
          status: 400,
          json: { error: { code: "invalid_request" } },
        });
        return;
      }
      if (failSave) {
        failSave = false;
        await route.fulfill({
          status: 503,
          json: { error: { code: "save_failed" } },
        });
        return;
      }
      const old = records.get(input.id);
      if (tombstones.has(input.id)) {
        await route.fulfill({ status: 409, json: { error: { code: "conflict" } } });
        return;
      }
      if (old?.mutationId === input.mutationId) {
        if (committedSaveAckGate) await committedSaveAckGate;
        await route.fulfill({ json: { record: old } });
        return;
      }
      if ((old?.version ?? 0) !== input.version) {
        await route.fulfill({ status: 409, json: { error: { code: "conflict" } } });
        return;
      }
      const record = {
        ...input,
        userId,
        version: input.version + 1,
        updatedAt: new Date().toISOString(),
        originalItems: old?.originalItems ?? input.items,
      };
      records.set(input.id, record);
      if (failAfterCommittedSave) {
        failAfterCommittedSave = false;
        committedSaveAckGate = new Promise<void>((resolve) => {
          releaseCommittedSaveAck = resolve;
        });
        await route.fulfill({ status: 503, json: { error: { code: "save_failed" } } });
        return;
      }
      await route.fulfill({ json: { record } });
    });
  }
  return {
    records,
    saves,
    mealReadUrls,
    install,
    setMealPageSize: (size: number) => { mealPageSize = size; },
    setOffline: async (context: BrowserContext, value: boolean) => {
      if (value) offline.add(context);
      else offline.delete(context);
      await context.setOffline(value);
    },
    failNextSave: () => {
      failSave = true;
    },
    blockSaves: (value: boolean) => {
      blockSave = value;
    },
    failAfterNextCommittedSave: () => { failAfterCommittedSave = true; },
    allowCommittedSaveAck: () => {
      releaseCommittedSaveAck?.();
      releaseCommittedSaveAck = null;
      committedSaveAckGate = null;
    },
    failMealReads: (value: boolean) => { failMealRead = value; },
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

test("車仔麵 asks for a narrower range and a meal note can mark hot milk as plant milk", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "手動記一餐", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("車仔麵");
  await expect(page.getByRole("status").filter({ hasText: "2.5 倍" })).toBeVisible();
  await expect(page.getByRole("article").getByText("約 45–185 kcal", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新增食物", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).nth(1).fill("熱牛奶");
  const hotMilk = page.getByRole("article").filter({ has: page.getByRole("combobox", { name: "食物名稱" }) }).nth(1);
  await expect(hotMilk.getByText("約 60–95 kcal", { exact: true })).toBeVisible();
  await page.locator("#meal-journal-note").fill("這杯是燕麥奶");
  await expect(hotMilk.getByText(/不配對乳製奶/)).toBeVisible();
  await expect(hotMilk.getByText("約 60–95 kcal", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "2.5 倍" })).toBeVisible();
});

test("journal visual refresh keeps mobile and desktop hierarchy usable", async ({ browser, page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();
  await expect(page.locator(".journal-hero-card")).toBeVisible();
  await expect(page.locator(".food-stamp-cluster").first()).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "＋ 手動記餐", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "AI 相片辨識", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增", exact: true })).toHaveClass(/journal-nav-add/);
  await expect(page.locator(".food-stamp svg").first()).toHaveCSS("width", "26px");
  await expect(page.locator(".food-stamp svg").first()).toHaveCSS("height", "26px");
  await expect(page.getByText("未記錄", { exact: true })).toBeVisible();
  await expect(page.getByText("未知不代表零", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const wide = await desktop.newPage();
    await wide.goto("/");
    await expect(wide.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();
    await expect(wide.locator(".journal-title-actions")).toBeVisible();
    await expect(wide.locator(".food-stamp svg").first()).toHaveCSS("width", "30px");
    await expect(wide.locator(".food-stamp svg").first()).toHaveCSS("height", "30px");
    expect(await wide.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  } finally {
    await desktop.close();
  }
});

test("mobile journal-first manual note saves, reloads and stays plain text without AI", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  let analyses = 0;
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    await route.fulfill({ status: 500, json: { error: { code: "unexpected_ai_call" } } });
  });

  await page.goto("/");
  await login(page);

  const manual = page.getByRole("button", { name: "＋ 手動記餐", exact: true });
  const photo = page.getByRole("button", { name: "AI 相片辨識", exact: true });
  await expect(manual).toBeVisible();
  await expect(photo).toBeVisible();
  await manual.click();

  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("白飯");
  const note = page.getByRole("textbox", { name: "餐點備註（選填）", exact: true });
  await note.fill("  <b>雞皮冇食</b>\n醬汁另上 🧸  ");
  await expect(page.getByText("18/500", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();

  await expect.poll(() => backend.records.size).toBe(1);
  expect(analyses).toBe(0);
  expect(backend.saves).toHaveLength(1);
  expect(backend.saves[0].journalNote).toBe("<b>雞皮冇食</b>\n醬汁另上 🧸");

  const todayNote = page.locator(".meal-journal-note");
  await expect(todayNote).toContainText("<b>雞皮冇食</b>");
  await expect(todayNote).toContainText("醬汁另上 🧸");
  await expect(todayNote.locator("b")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
  await expect(page.locator(".meal-journal-note")).toContainText("醬汁另上 🧸");

  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.locator(".meal-journal-note")).toContainText("<b>雞皮冇食</b>");
  await expect(page.locator(".meal-journal-note b")).toHaveCount(0);
  expect(analyses).toBe(0);
});

test("a fresh mobile session assembles every paged meal before showing Today and History", async ({ browser, page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await rice(page);
  await page.getByRole("button", { name: "自行填寫本餐卡路里", exact: true }).click();
  await page.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）", exact: true }).fill("650");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const first = [...backend.records.values()][0];
  const secondId = crypto.randomUUID();
  backend.records.set(secondId, {
    ...first, id: secondId, mutationId: crypto.randomUUID(), mealType: "lunch",
    calorieCorrection: { kcal: 500, source: "user" },
    items: (first.items as Array<Record<string, unknown>>).map((item) => ({ ...item, id: crypto.randomUUID(), displayName: "第二餐" })),
  });
  backend.setMealPageSize(1);

  const fresh = await browser.newContext({ viewport: { width: 375, height: 812 } });
  try {
    await backend.install(fresh);
    const restored = await fresh.newPage();
    await restored.goto("/");
    await login(restored);
    await expect(restored.locator('.day-summary[aria-label="今日摘要"]')).toContainText("今日餐數2餐");
    await expect(restored.locator(".day-summary > div").filter({ hasText: "卡路里" }).locator("strong")).toHaveText("1150");
    await restored.getByRole("button", { name: "歷史", exact: true }).click();
    await expect(restored.locator(".meal-row")).toHaveCount(2);
    expect(backend.mealReadUrls.some((url) => new URL(url).searchParams.has("cursor"))).toBe(true);
    expect(await restored.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  } finally {
    await fresh.close();
  }
});

test("failed first cloud read stays unknown until an empty meal list is confirmed", async ({ page, context }) => {
  const backend = cloud();
  backend.failMealReads(true);
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await expect(page.getByRole("heading", { name: "尚未確認今日記錄" })).toBeVisible();
  await expect(page.getByRole("region", { name: "今日摘要" })).toHaveCount(0);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "尚未確認歷史記錄" })).toBeVisible();
  backend.failMealReads(false);
  await page.reload();
  await page.getByRole("button", { name: "今日", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日未有記錄" })).toBeVisible();
  await expect(page.getByRole("region", { name: "今日摘要" }))
    .toContainText("今日餐數0餐");
});

test("a second tab's background refresh cannot erase an unsaved draft", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  const other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "帳戶與安裝", exact: true }).click();
  await expect(other.getByText("tester@example.com", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "今日", exact: true }).click();

  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("白飯");
  const cached = () => page.evaluate(async (uid) => {
    const tabId = sessionStorage.getItem("kcalcue-draft-tab");
    if (!tabId) throw new Error("Missing draft tab ID");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("kcalcue-private");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<{ draft: unknown; syncedAt: string | null }>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        const store = tx.objectStore("accounts");
        const request = store.get(uid);
        const draft = store.get(["draft", uid, tabId]);
        tx.oncomplete = () => resolve({
          draft: draft.result?.draft ?? null,
          syncedAt: request.result?.syncedAt ?? null,
        });
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, userId);
  await expect.poll(async () => (await cached()).draft).not.toBeNull();
  const previousSync = (await cached()).syncedAt;
  await page.waitForTimeout(20);
  await other.evaluate(() => window.dispatchEvent(new Event("kcalcue-sync")));
  await expect.poll(async () => (await cached()).syncedAt).not.toBe(previousSync);
  expect((await cached()).draft).not.toBeNull();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: "新餐點草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await expect(reopened.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  expect(backend.saves).toHaveLength(0);
  await reopened.close();
  await other.close();
});

test("a popup with cloned session storage gets its own draft identity", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("白飯");
  const originalId = await page.evaluate(() => sessionStorage.getItem("kcalcue-draft-tab"));
  expect(originalId).toBeTruthy();

  const opened = page.waitForEvent("popup");
  await page.evaluate(() => window.open("/", "_blank"));
  const popup = await opened;
  await popup.getByRole("button", { name: "帳戶與安裝", exact: true }).click();
  await expect(popup.getByText("tester@example.com", { exact: true })).toBeVisible();
  const popupId = await popup.evaluate(() => sessionStorage.getItem("kcalcue-draft-tab"));
  expect(popupId).toBeTruthy();
  expect(popupId).not.toBe(originalId);

  await popup.getByRole("button", { name: "今日", exact: true }).click();
  await popup.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await expect(popup.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  await popup.getByRole("combobox", { name: "食物名稱", exact: true }).fill("香蕉");
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole("heading", { name: "新餐點草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  expect(backend.saves).toHaveLength(0);
  await popup.close();
});

test("a stale tab cannot replace the latest draft and its fork stays recoverable", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  const firstName = page.getByRole("combobox", { name: "食物名稱", exact: true });
  await firstName.fill("白飯");
  const legacyName = () => page.evaluate(async (uid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("kcalcue-private");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        const request = tx.objectStore("accounts").get(uid);
        tx.oncomplete = () => resolve(request.result?.draft?.items?.[0]?.displayName ?? null);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, userId);
  await expect.poll(legacyName).toBe("白飯");
  const stale = await context.newPage();
  await stale.goto("/");
  await stale.getByRole("button", { name: "帳戶與安裝", exact: true }).click();
  await expect(stale.getByText("tester@example.com", { exact: true })).toBeVisible();
  await stale.getByRole("button", { name: "今日", exact: true }).click();
  await firstName.fill("香蕉");
  await expect.poll(legacyName).toBe("香蕉");
  await stale.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await expect(stale.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  const recovered = await context.newPage();
  await recovered.goto("/");
  await expect(recovered.getByRole("region", { name: "其他未儲存草稿" })).toContainText("白飯");
  await recovered.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await expect(recovered.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("香蕉");
  recovered.once("dialog", (dialog) => dialog.accept());
  await recovered.getByRole("region", { name: "其他未儲存草稿" })
    .getByRole("button", { name: "恢復草稿" }).first().click();
  await expect(recovered.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  const afterRecovery = await context.newPage();
  await afterRecovery.goto("/");
  await afterRecovery.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await expect(afterRecovery.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("白飯");
  expect(backend.saves).toHaveLength(0);
  await afterRecovery.close();
  await recovered.close();
  await stale.close();
});

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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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
  // Reload can still be applying the saved meal. Acknowledging that draft
  // returns the shell to Today in the same render that clears the banner.
  // Opening History before that render lands never mounts this heading.
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("有一份未儲存草稿")).toHaveCount(0);
  await expect(page.getByText(/項修改待同步/)).toHaveCount(0);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "歷史記錄", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "香蕉", exact: true })).toBeVisible();
  await expect(page.locator(".meal-stamp svg").first()).toHaveCSS("width", "20px");
  await expect(page.locator(".meal-stamp svg").first()).toHaveCSS("height", "20px");
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("香蕉");
  await expect(estimate).toHaveText(correctedEstimate!);
  await expect(page.getByRole("spinbutton", { name: "最少份量", exact: true })).toHaveValue("100");
  await expect(page.getByRole("spinbutton", { name: "最多份量", exact: true })).toHaveValue("150");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("another meal from History starts a fresh draft without changing the saved meal", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await rice(page);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const original = [...backend.records.values()][0];

  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.getByRole("heading", { name: "修正餐點", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "記另一餐", exact: true }).click();
  await expect(page.getByRole("heading", { name: "修正餐點", exact: true })).toBeVisible();
  expect(backend.records.size).toBe(1);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "記另一餐", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新餐點草稿", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("香蕉");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(2);
  expect(backend.records.get(original.id)).toEqual(original);
  await page.reload();
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "香蕉", exact: true })).toBeVisible();
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
  await expect.poll(() => backend.records.size, { timeout: 12_000 }).toBe(1);
  await expect(page.getByText(/項修改待同步/)).not.toBeVisible();
  expect(backend.saves).toHaveLength(2);
  expect(backend.saves[0].mutationId).toBe(backend.saves[1].mutationId);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("a blocked cloud save keeps the draft, shows an error, and retries the same mutation", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await rice(page);
  backend.blockSaves(true);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "未能儲存到雲端" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("請檢查食物名稱、份量及日期時間");
  await expect(page.getByRole("heading", { name: "新餐點草稿", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "儲存餐點", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重試儲存", exact: true })).toBeEnabled();
  await expect(page.getByText("已儲存到本機，連線時會自動同步。")).not.toBeVisible();
  await expect(page.getByText(/尚有 \d+ 項待同步/)).not.toBeVisible();
  await expect.poll(() => backend.saves.length).toBe(1);
  expect(backend.records.size).toBe(0);

  backend.blockSaves(false);
  await page.getByRole("button", { name: "重試儲存", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  await expect.poll(() => backend.saves.length).toBe(2);
  expect(backend.saves[0].mutationId).toBe(backend.saves[1].mutationId);
  await expect(page.getByRole("heading", { name: "今日飲食", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
  await expect(alert).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
  expect(backend.records.size).toBe(1);
  expect(backend.saves).toHaveLength(2);
});

test("a committed save with a lost response replays one mutation after reload", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.goto("/");
  await login(page);
  await rice(page);
  await page.getByRole("button", { name: "自行填寫本餐卡路里", exact: true }).click();
  await page.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）", exact: true }).fill("650");
  backend.failAfterNextCommittedSave();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  await expect(page.getByText(/1 項修改待同步/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/1 項修改待同步/)).toBeVisible();

  await expect.poll(() => backend.saves.length).toBeGreaterThanOrEqual(2);
  backend.allowCommittedSaveAck();
  await expect(page.getByText(/項修改待同步/)).not.toBeVisible();
  expect(backend.saves.length).toBeGreaterThanOrEqual(2);
  expect(new Set(backend.saves.map((save) => save.mutationId)).size).toBe(1);
  expect(backend.records.size).toBe(1);
  const summary = page.locator('.day-summary[aria-label="今日摘要"]');
  await expect(summary).toContainText("今日餐數1餐");
  await expect(page.locator(".day-summary > div").filter({ hasText: "卡路里" }).locator("strong"))
    .toHaveText("650");
  await expect(page.locator(".meal-row")).toHaveCount(1);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.locator(".meal-row")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".meal-row")).toHaveCount(1);
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

test("a stale offline delete cannot erase another device's newer meal", async ({ browser }) => {
  const backend = cloud();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(async (context) => {
    await backend.install(context);
    const page = await context.newPage();
    await page.goto("/");
    await login(page);
    return page;
  }));
  const [first, second] = pages;
  await rice(first);
  await first.getByRole("button", { name: "自行填寫本餐卡路里", exact: true }).click();
  await first.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）", exact: true }).fill("650");
  await first.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => [...backend.records.values()][0]?.version).toBe(1);
  await second.reload();
  await first.evaluate(async () => { await navigator.serviceWorker.ready; });
  await backend.setOffline(contexts[0], true);
  first.once("dialog", (dialog) => dialog.accept());
  await first.getByRole("button", { name: "刪除", exact: true }).click();
  await expect(first.getByRole("heading", { name: "今日未有記錄", exact: true })).toBeVisible();

  await second.getByRole("button", { name: "查看／修正", exact: true }).click();
  await second.getByRole("spinbutton", { name: "手動卡路里（整餐 kcal）", exact: true }).fill("700");
  await second.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => [...backend.records.values()][0]?.version).toBe(2);
  await backend.setOffline(contexts[0], false);
  await expect(first.getByRole("button", { name: "放棄待同步修改", exact: true })).toBeVisible();
  expect([...backend.records.values()][0].calorieCorrection).toEqual({ kcal: 700, source: "user" });
  first.once("dialog", (dialog) => dialog.accept());
  await first.getByRole("button", { name: "放棄待同步修改", exact: true }).click();
  await expect(first.locator(".meal-calories")).toHaveText("手動記錄：700 kcal");
  await first.reload();
  await expect(first.locator(".meal-row")).toHaveCount(1);
  await expect(first.locator(".meal-calories")).toHaveText("手動記錄：700 kcal");
  await first.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(first.locator(".meal-row")).toHaveCount(1);
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
  await expect(page.getByText(/離線中 · 修改會保留，重連後自動同步/)).toBeVisible();
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
    const probe = indexedDB.open("kcalcue-sync");
    probe.onerror = () => reject(probe.error ?? new Error("IDB probe failed"));
    probe.onsuccess = () => {
      const version = probe.result.version;
      probe.result.close();
      const request = indexedDB.open("kcalcue-sync", version + 1);
      const timer = window.setTimeout(() => {
        reject(new Error("IDB upgrade timed out while another connection stayed open"));
      }, 10_000);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("photoPayloads"))
          request.result.createObjectStore("photoPayloads");
      };
      request.onsuccess = () => {
        window.clearTimeout(timer);
        request.result.close();
        resolve();
      };
      request.onerror = () => {
        window.clearTimeout(timer);
        reject(request.error ?? new Error("IDB upgrade failed"));
      };
      // The journal opens kcalcue-sync per transaction and closes it when the
      // transaction finishes. A transient block is that in-flight connection,
      // not a lost queued meal. Rejecting here raced the closer.
    };
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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
  const reviewNote = page.getByRole("note");
  await expect(reviewNote).toContainText("AI 可能認錯或漏掉食物、估錯份量");
  expect(await reviewNote.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && rect.width <= innerWidth;
  })).toBe(true);
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
  await expect(page.getByRole("note")).toContainText("共用餐點只記自己吃喝的部分，請逐項核對");
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
  await expect(todayCalories).toHaveText("未記錄");
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("mobile real-photo flow preserves an unknown serving through save and reload", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let nutritionRequests = 0;
  await page.route("**/api/nutrition/resolve", route => {
    nutritionRequests++;
    return route.fulfill({ json: { matches: [] } });
  });
  await page.route("**/api/analyze", route => route.fulfill({ json: { mode: "live", analysis: {
    analysisStatus: "success",
    foods: [{ displayName: "港式奶茶", normalizedName: "hong kong milk tea", identityLevel: "dish",
      portionMin: null, portionMax: null, unit: "ml",
      recognitionConfidence: 0.8, portionConfidence: 0.1,
      uncertaintyReasons: ["共用飲品的個人飲用份量未知。"] }],
    uncertaintyReasons: [], visibleEvidence: ["杯中的飲品"], estimatedInformation: [],
    unknownInformation: ["個人飲用份量"],
  } } }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"));
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "暫未能計算" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "最少份量", exact: true })).toBeEmpty();
  await expect(page.getByText(/請核對食物名稱；現有資料不足以判斷你吃了多少/)).toBeVisible();
  await expect(page.getByText("AI 辨認：請核對")).toBeVisible();
  expect(nutritionRequests).toBe(0);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  expect([...backend.records.values()][0].items).toMatchObject([{ portionMin: null, portionMax: null }]);
  await expect(page.locator(".day-summary")).toContainText("未知");
  await page.reload();
  await expect(page.getByRole("heading", { name: "港式奶茶", exact: true })).toBeVisible();
  await expect(page.locator(".day-summary")).toContainText("未知");
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "最少份量", exact: true })).toBeEmpty();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("a slow nutrition lookup keeps the completed AI result editable without another AI call", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let analyses = 0;
  let nutritionRequests = 0;
  let finishNutrition!: () => void;
  const nutritionGate = new Promise<void>((resolve) => { finishNutrition = resolve; });
  await page.route("**/api/analyze", async (route) => {
    analyses++;
    await route.fulfill({ json: { mode: "live", analysis: {
      analysisStatus: "success",
      foods: [{ displayName: "帶子", normalizedName: "scallops",
        identityLevel: "ingredient", portionMin: 100, portionMax: 150, unit: "g",
        recognitionConfidence: 0.8, portionConfidence: 0.5, uncertaintyReasons: [] }],
      uncertaintyReasons: [], visibleEvidence: ["碟上的食物"],
      estimatedInformation: ["份量"], unknownInformation: [],
    } } });
  });
  await page.route("**/api/nutrition/resolve", async (route) => {
    nutritionRequests++;
    await nutritionGate;
    await route.fulfill({ json: { matches: [] } });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(
    path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"),
  );
  await page.getByRole("button", { name: "開始分析", exact: true }).click();

  await expect(page.getByText("AI 分析結果", { exact: true })).toBeVisible();
  await expect(page.getByText(/正在補查營養參考/)).toBeVisible();
  await expect.poll(() => nutritionRequests).toBe(1);
  await page.getByRole("combobox", { name: "食物名稱" }).fill("banana");
  await expect(page.getByRole("combobox", { name: "食物名稱" })).toHaveValue("banana");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  expect([...backend.records.values()][0]).toMatchObject({ items: [{ displayName: "banana" }] });
  finishNutrition();
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "banana", exact: true })).toBeVisible();
  expect(analyses).toBe(1);
  expect(errors).toEqual([]);
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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

test("rejecting a replacement cannot restore an earlier photo after its preparation finishes", async ({ page, context }, testInfo) => {
  const backend = cloud();
  await backend.install(context);
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      return encode.call(this, (blob) => {
        callback(blob);
        window.setTimeout(() => {
          (window as Window & { __photoEncodeSettled?: boolean }).__photoEncodeSettled = true;
        }, 0);
      }, type, quality);
    };
    window.createImageBitmap = (source: ImageBitmapSource, options?: ImageBitmapOptions) =>
      new Promise<ImageBitmap>((resolve, reject) => {
        (window as Window & { __releasePhotoDecode?: () => void }).__releasePhotoDecode = () => {
          void decode(source, options).then((bitmap) => {
            (window as Window & { __photoDecodeFinished?: boolean }).__photoDecodeFinished = true;
            resolve(bitmap);
          }, reject);
        };
      });
  });
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const input = page.locator('input[type="file"]').nth(1);
  await input.setInputFiles(path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"));
  await expect.poll(() => page.evaluate(() =>
    !!(window as Window & { __releasePhotoDecode?: () => void }).__releasePhotoDecode,
  )).toBe(true);
  await input.setInputFiles({
    name: "oversized.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("img", { name: "已選擇的餐點相片預覽" })).toHaveCount(0);
  await page.evaluate(() =>
    (window as Window & { __releasePhotoDecode?: () => void }).__releasePhotoDecode?.(),
  );
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __photoDecodeFinished?: boolean }).__photoDecodeFinished === true,
  )).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __photoEncodeSettled?: boolean }).__photoEncodeSettled === true,
  )).toBe(true);
  const persistedPhotoSize = await page.evaluate(async (uid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("kcalcue-private");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        let size = 0;
        const cursor = tx.objectStore("accounts").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const key = row.key;
          const owned = key === uid || (Array.isArray(key) && key[0] === "draft" && key[1] === uid);
          if (owned) size = Math.max(size, row.value?.draft?.photo?.size ?? 0);
          row.continue();
        };
        tx.oncomplete = () => resolve(size);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, userId);
  expect(persistedPhotoSize).toBe(0);
  await page.reload();
  await expect(page.getByRole("img", { name: "已選擇的餐點相片預覽" })).toHaveCount(0);
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  await page.locator('input[type="file"]').nth(1).setInputFiles(
    path.join(testInfo.project.testDir, "fixtures/hk-milk-tea.jpg"),
  );
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "尚未開通試用權限" })).toBeVisible();
  expect(analyses).toBe(1);
  await page.getByRole("button", { name: "手動加入食物", exact: true }).click();
  await page.getByRole("combobox", { name: "食物名稱", exact: true }).fill("白飯");
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "未能儲存到雲端" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "新餐點草稿", exact: true })).toBeVisible();
  await expect(page.getByText(/白飯：這個 Email 尚未獲得試用權限/)).toBeVisible();
  await expect(page.getByText("已儲存到本機，連線時會自動同步。")).not.toBeVisible();
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
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
    await expect(todayCalories).toHaveText("未記錄");
    await expect(page.getByText(/之前的餐點可在歷史記錄查看/)).toBeVisible();
    await page.getByRole("button", { name: "歷史", exact: true }).click();
    await expect(page.getByRole("heading", { name: "白飯", exact: true })).toBeVisible();
    await expect(page.locator(".meal-calories")).toHaveText("手動記錄：650 kcal");
    expect(backend.records.size).toBe(0);
  });
});

test("a recognised protein salad photo shows a kcal range instead of an empty total", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: {
      mode: "live",
      analysis: {
        analysisStatus: "success",
        foods: [{
          displayName: "燒烤蛋白質雜菜沙律碗",
          normalizedName: "grilled protein mixed vegetable salad bowl",
          identityLevel: "dish",
          portionMin: 450,
          portionMax: 700,
          unit: "g",
          recognitionConfidence: 0.9,
          portionConfidence: 0.7,
          uncertaintyReasons: ["醬汁和肉量未能確定。"],
          preparationMethod: "燒烤",
          visibleIngredients: ["grilled chicken", "mixed vegetables"],
        }],
        uncertaintyReasons: ["醬汁和肉量未能確定。"],
        visibleEvidence: ["一碗雜菜和烤肉"],
        estimatedInformation: ["份量約 450–700 克"],
        unknownInformation: ["醬汁分量"],
      },
    },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "green" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "salad-bowl.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "約 270–1120 kcal", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "暫未能計算", exact: true })).toHaveCount(0);
  await expect(page.getByText("未有足夠資料", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("燒烤蛋白質雜菜沙律碗");
});

test("a duplicated generic milk carton stays one item until a dairy choice", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  let nutritionLookups = 0;
  await page.route("**/api/nutrition/resolve", async (route) => {
    nutritionLookups += 1;
    await route.fulfill({ status: 500, json: { error: { code: "unexpected_nutrition" } } });
  });
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: {
      mode: "live",
      analysis: {
        analysisStatus: "success",
        foods: [
          {
            displayName: "牛奶",
            normalizedName: "milk",
            identityLevel: "ingredient",
            portionMin: null,
            portionMax: null,
            unit: "ml",
            recognitionConfidence: 0.7,
            portionConfidence: 0.2,
            uncertaintyReasons: ["未能讀到紙盒上的種類。"],
            preparationMethod: "紙盒飲品",
          },
          {
            displayName: "牛奶",
            normalizedName: "milk",
            identityLevel: "ingredient",
            portionMin: null,
            portionMax: null,
            unit: "ml",
            recognitionConfidence: 0.66,
            portionConfidence: 0.2,
            uncertaintyReasons: ["同一紙盒被分成兩項。"],
            preparationMethod: "紙盒飲品",
          },
        ],
        uncertaintyReasons: ["紙盒飲品的種類未能確認。"],
        visibleEvidence: ["一盒飲品。"],
        estimatedInformation: [],
        unknownInformation: ["紙盒上的品牌與種類未能讀到。"],
      },
    },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "oat-carton.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();

  await expect(page.getByRole("heading", { name: "暫未能計算", exact: true })).toBeVisible();
  await expect(page.locator(".food-card").getByText("已合併重複嘅牛奶項目，如果係兩杯可以再加返", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "全脂牛奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "低脂牛奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "燕麥奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "豆漿", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "其他", exact: true })).toBeVisible();

  const minimum = page.getByRole("spinbutton", { name: "最少份量", exact: true });
  const maximum = page.getByRole("spinbutton", { name: "最多份量", exact: true });
  await minimum.fill("250");
  await minimum.press("Tab");
  await expect(page.getByText("相片只辨識到牛奶，未能分辨全脂、低脂或植物奶。請先選擇種類，因此暫不計算。")).toBeVisible();
  await expect(page.getByText("155–160")).toHaveCount(0);
  await expect(maximum).toHaveValue("250");
  expect(nutritionLookups).toBe(0);

  await page.getByRole("button", { name: "全脂牛奶", exact: true }).click();
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "燕麥奶", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("全脂牛奶");

  await maximum.fill("300");
  await maximum.press("Tab");
  await expect(maximum).toHaveValue("300");
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toHaveCount(0);
  await expect(page.locator(".food-card").getByText("已合併重複嘅牛奶項目，如果係兩杯可以再加返", { exact: true })).toBeVisible();
  expect(nutritionLookups).toBe(0);
  expect(backend.records.size).toBe(0);
});

test("a dish-classified glass of milk always offers a type choice and counts 全脂 at 250 ml", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/nutrition/resolve", (route) => route.fulfill({
    status: 500,
    json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: {
      mode: "live",
      analysis: {
        analysisStatus: "success",
        foods: [{
          displayName: "冷牛奶",
          normalizedName: "whole milk",
          identityLevel: "dish",
          portionMin: null,
          portionMax: null,
          unit: "ml",
          recognitionConfidence: 0.71,
          portionConfidence: 0.48,
          uncertaintyReasons: ["外觀是白色飲品，未能從杯子判斷脂肪含量。"],
          preparationMethod: "冷飲",
          visibleIngredients: ["牛奶"],
          notes: "透明玻璃杯",
        }],
        uncertaintyReasons: ["只有一隻玻璃杯。"],
        visibleEvidence: ["一隻透明玻璃杯", "白色液體"],
        estimatedInformation: ["份量大約 250 ml。"],
        unknownInformation: ["沒有包裝，看不到全脂或低脂字樣。"],
      },
    },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "milk-glass.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();

  await expect(page.getByRole("button", { name: "全脂牛奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "低脂牛奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "燕麥奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "其他", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "最少份量", exact: true }).fill("250");
  await page.getByRole("spinbutton", { name: "最少份量", exact: true }).press("Tab");
  await expect(page.getByText("155–160")).toHaveCount(0);

  await page.getByRole("button", { name: "全脂牛奶", exact: true }).click();
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "燕麥奶", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0];
  const item = (saved.items as Array<{ displayName: string; identityLevel: string; userMilkTypeChoice?: string; nutritionMatch?: { includedInTotal?: boolean; profile?: { id?: string } } }>)[0];
  expect(item.displayName).toBe("全脂牛奶");
  expect(item.identityLevel).toBe("ingredient");
  expect(item.userMilkTypeChoice).toBe("whole");
  expect(item.nutritionMatch?.includedInTotal).toBe(true);
  expect(item.nutritionMatch?.profile?.id).toBe("whole-milk");
});

test("an oat carton split into name variants becomes one item with a merge notice", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: {
      mode: "live",
      analysis: {
        analysisStatus: "success",
        foods: [
          {
            displayName: "燕麥飲品",
            normalizedName: "oat beverage",
            identityLevel: "dish",
            portionMin: 1000,
            portionMax: 1000,
            unit: "ml",
            recognitionConfidence: 0.7,
            portionConfidence: 0.4,
            uncertaintyReasons: ["紙盒容量不一定是飲用份量。"],
            preparationMethod: "盒裝",
            notes: "紙盒標示 1 公升",
            visibleIngredients: ["燕麥"],
          },
          {
            displayName: "燕麥奶",
            normalizedName: "oat milk",
            identityLevel: "ingredient",
            portionMin: 250,
            portionMax: 250,
            unit: "ml",
            recognitionConfidence: 0.8,
            portionConfidence: 0.6,
            uncertaintyReasons: ["同一紙盒的飲用份量。"],
            preparationMethod: "紙盒飲品",
            notes: "紙盒正面",
            visibleIngredients: ["燕麥奶"],
          },
        ],
        uncertaintyReasons: ["一盒飲品被拆成兩項。"],
        visibleEvidence: ["一盒燕麥飲品", "紙盒"],
        estimatedInformation: [],
        unknownInformation: [],
      },
    },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "beige" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "oat-carton.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();

  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "食物名稱", exact: true })).toHaveValue("燕麥奶");
  await expect(page.locator(".food-card").getByText("已合併重複嘅牛奶項目，如果係兩杯可以再加返", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增食物", exact: true })).toBeVisible();
  expect(backend.records.size).toBe(0);
});

test("choosing 其他 hides the milk buttons and stays uncomputed", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: {
      mode: "live",
      analysis: {
        analysisStatus: "success",
        foods: [{
          displayName: "牛奶",
          normalizedName: "milk",
          identityLevel: "ingredient",
          portionMin: 250,
          portionMax: 250,
          unit: "ml",
          recognitionConfidence: 0.7,
          portionConfidence: 0.5,
          uncertaintyReasons: ["未能讀到種類。"],
        }],
        uncertaintyReasons: [],
        visibleEvidence: ["一杯白色飲品"],
        estimatedInformation: [],
        unknownInformation: [],
      },
    },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "milk.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.getByRole("button", { name: "其他", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "其他", exact: true }).click();
  await expect(page.getByRole("button", { name: "全脂牛奶", exact: true })).toHaveCount(0);
  await expect(page.locator(".food-card").getByText("已標為其他。沒有對應營養資料，因此不計算。")).toBeVisible();
  await expect(page.getByText("155–160")).toHaveCount(0);
  expect(backend.records.size).toBe(0);
});

test("a production glass that might be milk or plant milk still offers 全脂 and counts 250 ml", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/nutrition/resolve", (route) => route.fulfill({
    status: 500,
    json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: { mode: "live", analysis: productionGlassMilkUnknownAnalysis },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "milkglass.jpg", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();

  await expect(page.getByRole("button", { name: "全脂牛奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "低脂牛奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "燕麥奶", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "其他", exact: true })).toBeVisible();
  await expect(page.getByText("名稱像牛奶、鮮奶或低脂奶，但餐點備註、相片證據、不確定說明、項目備註或可見食材指向燕麥奶、豆漿或杏仁奶，因此不配對乳製奶，也不交給 USDA。")).toHaveCount(0);
  await expect(page.getByText("155–160")).toHaveCount(0);

  const maximum = page.getByRole("spinbutton", { name: "最多份量", exact: true });
  await maximum.fill("250");
  await maximum.press("Tab");
  await expect(maximum).toHaveValue("250");
  await expect(page.getByRole("button", { name: "全脂牛奶", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "全脂牛奶", exact: true }).click();
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "燕麥奶", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0];
  const item = (saved.items as Array<{
    displayName: string;
    identityLevel: string;
    userMilkTypeChoice?: string;
    portionMin: number;
    portionMax: number;
    nutritionMatch?: { includedInTotal?: boolean; profile?: { id?: string }; coverageReason?: string };
  }>)[0];
  expect(item.displayName).toBe("全脂牛奶");
  expect(item.identityLevel).toBe("ingredient");
  expect(item.userMilkTypeChoice).toBe("whole");
  expect(item.portionMin).toBe(250);
  expect(item.portionMax).toBe(250);
  expect(item.nutritionMatch?.includedInTotal).toBe(true);
  expect(item.nutritionMatch?.profile?.id).toBe("whole-milk");
  expect(item.nutritionMatch?.coverageReason).not.toBe("UNKNOWN_DISH");
});

test("choosing 全脂牛奶 counts when the photo could not tell whole milk from low-fat", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/nutrition/resolve", (route) => route.fulfill({
    status: 500,
    json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.route("**/api/analyze", (route) => route.fulfill({
    json: {
      mode: "live",
      analysis: {
        analysisStatus: "success",
        foods: [{
          displayName: "牛奶",
          normalizedName: "milk",
          identityLevel: "ingredient",
          portionMin: null,
          portionMax: null,
          unit: "ml",
          recognitionConfidence: 0.7,
          portionConfidence: 0.2,
          uncertaintyReasons: ["未能分辨全脂或低脂"],
          preparationMethod: "紙盒飲品",
        }],
        uncertaintyReasons: ["紙盒飲品的種類未能確認。"],
        visibleEvidence: ["一盒飲品。"],
        estimatedInformation: [],
        unknownInformation: ["紙盒上的品牌與種類未能讀到。"],
      },
    },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "ambiguous-milk.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();

  await expect(page.getByRole("button", { name: "全脂牛奶", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "最少份量", exact: true }).fill("250");
  await page.getByRole("spinbutton", { name: "最少份量", exact: true }).press("Tab");
  await expect(page.getByText("低脂或脫脂奶在本地目錄沒有對應的 USDA 減脂奶資料，因此暫不計算。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "全脂牛奶", exact: true }).click();
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toBeVisible();
  await expect(page.getByText("未能分辨全脂或低脂")).toHaveCount(0);
  await expect(page.getByText("低脂或脫脂奶在本地目錄沒有對應的 USDA 減脂奶資料，因此暫不計算。")).toHaveCount(0);
  expect(backend.records.size).toBe(0);
});

async function expectFieldsInsideCard(page: Page) {
  const card = page.locator(".meal-metadata");
  const date = page.getByLabel("日期", { exact: true });
  const time = page.getByLabel("時間", { exact: true });
  const mealType = page.getByRole("combobox", { name: "餐次", exact: true });
  await expect(date).toBeVisible();
  await expect(time).toBeVisible();
  await expect(mealType).toBeVisible();
  const cardBox = await card.boundingBox();
  const dateBox = await date.boundingBox();
  const timeBox = await time.boundingBox();
  const mealBox = await mealType.boundingBox();
  expect(cardBox && dateBox && timeBox && mealBox).toBeTruthy();
  for (const box of [dateBox!, timeBox!, mealBox!]) {
    expect(box.x).toBeGreaterThanOrEqual(cardBox!.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
  }
  const dateFit = await date.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dateFit.scrollWidth).toBeLessThanOrEqual(dateFit.clientWidth + 1);
  if (dateFit.innerWidth <= 374) expect(dateFit.clientWidth).toBeGreaterThan(240);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("edit meal time and meal type stay inside the card at 360 and 375px", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const backend = cloud();
  await backend.install(context);
  try {
    await page.goto("/");
    await login(page);
    await rice(page);
    await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
    await expect.poll(() => backend.records.size).toBe(1);
    await page.getByRole("button", { name: "歷史", exact: true }).click();
    await page.getByRole("button", { name: "查看／修正", exact: true }).click();
    await expect(page.getByRole("heading", { name: "修正餐點", exact: true })).toBeVisible();
    await page.getByLabel("時間", { exact: true }).fill("10:25");
    await expectFieldsInsideCard(page);
    await page.screenshot({
      path: testInfo.outputPath("edit-meal-375.png"),
      fullPage: true,
    });
    await page.locator(".metadata-grid").screenshot({
      path: testInfo.outputPath("edit-meal-375-metadata.png"),
    });

    await page.setViewportSize({ width: 360, height: 800 });
    await expectFieldsInsideCard(page);
    await page.screenshot({
      path: testInfo.outputPath("edit-meal-360.png"),
      fullPage: true,
    });
    await page.locator(".metadata-grid").screenshot({
      path: testInfo.outputPath("edit-meal-360-metadata.png"),
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => page.locator(".metadata-grid").evaluate((element) => {
      const columns = getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).map(Number.parseFloat);
      return columns.length === 3 && Math.max(...columns) - Math.min(...columns) < 1;
    })).toBe(true);
    await expectFieldsInsideCard(page);
  } finally {
    await context.close();
  }
});

for (const width of [360, 375]) {
  for (const choice of [
    { id: "oat", label: "燕麥奶", profileId: "oat-milk", range: "115–120" },
    { id: "soy", label: "豆漿", profileId: "unsweetened-soy-milk", range: "80–85" },
  ]) {
    test(`QA124 ${choice.id} 250 ml counts and survives a saved edit at ${width}px`, async ({ page, context }, testInfo) => {
      await page.setViewportSize({ width, height: 812 });
      const backend = cloud();
      await backend.install(context);
      await page.route("**/api/nutrition/resolve", route => route.fulfill({ status: 500, json: { error: { code: "unexpected_nutrition" } } }));
      await page.route("**/api/analyze", route => route.fulfill({ json: {
        mode: "live", analysis: productionGlassMilkUnknownAnalysis,
      } }));
      await page.goto("/");
      await login(page);
      await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
      const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } }).png().toBuffer();
      await page.locator('input[type="file"]').nth(1).setInputFiles({ name: "milk.png", mimeType: "image/png", buffer: png });
      await page.getByRole("button", { name: "開始分析", exact: true }).click();
      for (const label of ["全脂牛奶", "低脂牛奶", "燕麥奶", "豆漿", "其他"]) {
        await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const maximum = page.getByRole("spinbutton", { name: "最多份量", exact: true });
      await maximum.fill("250");
      await maximum.press("Tab");
      await page.getByRole("button", { name: choice.label, exact: true }).click();
      await expect(page.getByRole("heading", { name: `約 ${choice.range} kcal`, exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`QA124-${choice.id}-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
      await expect.poll(() => backend.records.size).toBe(1);
      const readItem = () => ([...backend.records.values()][0].items as Array<{
        userMilkTypeChoice?: string;
        nutritionMatch?: { includedInTotal?: boolean; profile?: { id?: string } };
      }>)[0];
      expect(readItem().userMilkTypeChoice).toBe(choice.id);
      expect(readItem().nutritionMatch?.includedInTotal).toBe(true);
      expect(readItem().nutritionMatch?.profile?.id).toBe(choice.profileId);
      await page.getByRole("button", { name: "歷史", exact: true }).click();
      await page.getByRole("button", { name: "查看／修正", exact: true }).click();
      await expect(page.getByRole("heading", { name: `約 ${choice.range} kcal`, exact: true })).toBeVisible();
      await page.getByLabel("時間", { exact: true }).fill("10:25");
      await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
      await expect.poll(() => backend.saves.length).toBe(2);
      expect(readItem().userMilkTypeChoice).toBe(choice.id);
      expect(readItem().nutritionMatch?.includedInTotal).toBe(true);
      expect(readItem().nutritionMatch?.profile?.id).toBe(choice.profileId);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test("QA124 server milk notices survive client parsing and render beside the split action", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  const plantNotice = "包裝顯示植物奶，請核對種類及份量。";
  const duplicateNotice = "已合併重複嘅牛奶項目，如果係兩杯可以再加返";
  await page.route("**/api/analyze", route => route.fulfill({ json: {
    mode: "live", analysis: {
      ...productionGlassMilkUnknownAnalysis,
      uncertaintyReasons: ["飲用份量不是整盒。"],
      visibleEvidence: ["紙盒寫有燕麥奶。"],
      unknownInformation: [],
      foods: [{
        ...productionGlassMilkUnknownAnalysis.foods[0],
        displayName: "燕麥奶",
        normalizedName: "oat milk",
        notes: "紙盒標示為燕麥奶。",
        uncertaintyReasons: ["飲用份量不是整盒。"],
        otherMilkNotice: plantNotice,
        duplicateMilkNotice: duplicateNotice,
      }],
    },
  } }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({ name: "carton.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.locator(".food-card").getByText(plantNotice, { exact: true })).toBeVisible();
  await expect(page.locator(".food-card").getByText(duplicateNotice, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增食物", exact: true })).toBeVisible();
});

test("M7 C3-run1 one oat carton described twice merges and does not double kcal", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/analyze", route => route.fulfill({
    json: { mode: "live", analysis: c3Run1SingleOatCartonAnalysis },
  }));
  await page.route("**/api/nutrition/resolve", route => route.fulfill({
    status: 500,
    json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({ name: "oat.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(1);
  await expect(page.getByText("已合併重複嘅牛奶項目，如果係兩杯可以再加返", { exact: true })).toBeVisible();
  await expect(page.getByText("包裝顯示植物奶，請核對種類及份量。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "暫未能計算", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
});

test("M7 C4 two described milk containers stay two rows without a plant-packaging notice", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/analyze", route => route.fulfill({
    json: { mode: "live", analysis: c4TwoMilkContainersAnalysis },
  }));
  await page.route("**/api/nutrition/resolve", route => route.fulfill({
    status: 500,
    json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({ name: "oatmilk.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expect(page.getByText("已合併重複嘅牛奶項目，如果係兩杯可以再加返", { exact: true })).toHaveCount(0);
  await expect(page.getByText("可能係同一份飲品重複列出", { exact: false })).toHaveCount(0);
  await expect(page.getByText("包裝顯示植物奶，請核對種類及份量。", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "暫未能計算", exact: true })).toBeVisible();
});

async function openSuspectedMilkFixture(page: Page, context: BrowserContext) {
  const backend = cloud();
  await backend.install(context);
  await page.route("**/api/analyze", route => route.fulfill({
    json: { mode: "live", analysis: qaSuspectedMilkAnalysis, analysisProvenance: null },
  }));
  await page.route("**/api/nutrition/resolve", route => route.fulfill({
    status: 500,
    json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({ name: "oat.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "已確認項目合計：約 155–160 kcal", exact: true })).toBeVisible();
  await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
  await expect(page.getByText(/營養參考只包括 1 \/ 2 項/)).toBeVisible();
  await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toBeVisible();
  return backend;
}

test("suspected oat row can be counted as a separate serving, saved, and read back", async ({ page, context }) => {
  const backend = await openSuspectedMilkFixture(page, context);
  await page.getByRole("button", { name: "係另一份，計入", exact: true }).click();
  await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toHaveCount(0);
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "約 310–315 kcal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = () => [...backend.records.values()][0].items as Array<{ suspectedDuplicateMilk?: boolean }>;
  expect(saved()).toHaveLength(2);
  expect(saved().every(item => item.suspectedDuplicateMilk == null)).toBe(true);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "約 310–315 kcal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
  expect(backend.mealReadUrls.length).toBeGreaterThan(0);
});

test("suspected oat row can be removed as a duplicate, saved, and read back", async ({ page, context }) => {
  const backend = await openSuspectedMilkFixture(page, context);
  await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0].items as unknown[];
  expect(saved).toHaveLength(1);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "約 155–160 kcal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toHaveCount(0);
  expect(backend.mealReadUrls.length).toBeGreaterThan(0);
});


// This exercises the real server-side milk grouping on a 3-row photo response,
// not a hand-crafted suspectedDuplicateMilk flag. Cloud is synthetic E2E.
for (const decision of ["remove", "confirm"] as const) {
  test(`P1 one oat carton duplicated beside a real milk glass: ${decision} persists after History readback`,
  async ({ page, context }) => {
    const backend = cloud();
    await backend.install(context);
    const carton = m6CartonAndGlassAnalysis.foods[0];
    const glass = m6CartonAndGlassAnalysis.foods[1];
    const modelAnalysis = {
      ...m6CartonAndGlassAnalysis,
      foods: [carton, { ...carton, notes: "相片中同一紙盒燕麥奶" },
        { ...glass, displayName: "全脂牛奶", normalizedName: "whole milk" }],
      visibleEvidence: ["一盒燕麥奶", "旁邊另外一個玻璃杯盛全脂牛奶"],
    };
    const serverAnalysis = preparePhotoMilkAnalysis(modelAnalysis);
    expect(serverAnalysis.foods).toHaveLength(3);
    expect(serverAnalysis.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(1);
    await page.route("**/api/analyze", route => route.fulfill({
      json: { mode: "live", analysis: serverAnalysis, analysisProvenance: null },
    }));
    await page.route("**/api/nutrition/resolve", route => route.fulfill({
      status: 500, json: { error: { code: "unexpected_nutrition" } },
    }));
    await page.goto("/");
    await login(page);
    await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
    const png = await sharp({
      create: { width: 80, height: 60, channels: 3, background: "white" },
    }).png().toBuffer();
    await page.locator('input[type="file"]').nth(1).setInputFiles({
      name: "oat-and-glass.png", mimeType: "image/png", buffer: png,
    });
    await page.getByRole("button", { name: "開始分析", exact: true }).click();
    await expect(page.locator(".food-card")).toHaveCount(3);
    await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
    await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toBeVisible();
    if (decision === "remove") {
      await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(2);
    } else {
      await page.getByRole("button", { name: "係另一份，計入", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(3);
    }
    await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toHaveCount(0);
    await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
    await expect.poll(() => backend.records.size).toBe(1);
    const saved = [...backend.records.values()][0].items as Array<{
      normalizedName: string; suspectedDuplicateMilk?: true;
    }>;
    expect(saved.length).toBe(decision === "remove" ? 2 : 3);
    expect(saved.every(item => item.suspectedDuplicateMilk == null)).toBe(true);
    expect(saved.some(item => item.normalizedName === "whole milk")).toBe(true);
    await page.getByRole("button", { name: "歷史", exact: true }).click();
    await page.getByRole("button", { name: "查看／修正", exact: true }).click();
    await expect(page.locator(".food-card")).toHaveCount(decision === "remove" ? 2 : 3);
    await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
    expect(backend.mealReadUrls.length).toBeGreaterThan(0);
  });
}


// Cardinality safety: a model's repeated food rows are not proof of extra
// physical cartons. These are synthetic-account browser + History tests.
for (const scenario of [
  { physical: 2, reported: 3, decision: "remove", evidence: "兩盒燕麥奶" },
  { physical: 2, reported: 3, decision: "confirm", evidence: "兩盒燕麥奶" },
  { physical: 3, reported: 3, decision: "none", evidence: "三盒燕麥奶" },
] as const) {
  test(`P1 cardinality: ${scenario.physical} real / ${scenario.reported} AI oat cartons, ${scenario.decision}, cloud History`,
    async ({ page, context }) => {
      const backend = cloud();
      await backend.install(context);
      const carton = m6CartonAndGlassAnalysis.foods[0];
      const glass = {
        ...m6CartonAndGlassAnalysis.foods[1],
        displayName: "全脂牛奶", normalizedName: "whole milk",
      };
      const model = {
        ...m6CartonAndGlassAnalysis,
        foods: [...Array.from({ length: scenario.reported }, () => ({ ...carton })), glass],
        visibleEvidence: [scenario.evidence, "獨立玻璃杯盛全脂牛奶"],
      };
      const serverAnalysis = preparePhotoMilkAnalysis(model);
      const pending = scenario.reported - scenario.physical;
      expect(serverAnalysis.foods).toHaveLength(scenario.reported + 1);
      expect(serverAnalysis.foods.filter(row => row.suspectedDuplicateMilk)).toHaveLength(pending);
      expect(serverAnalysis.foods.filter(row => row.normalizedName === "whole milk" && row.suspectedDuplicateMilk)).toHaveLength(0);
      await page.route("**/api/analyze", route => route.fulfill({
        json: { mode: "live", analysis: serverAnalysis, analysisProvenance: null },
      }));
      await page.route("**/api/nutrition/resolve", route => route.fulfill({
        status: 500, json: { error: { code: "unexpected_nutrition" } },
      }));
      await page.goto("/");
      await login(page);
      await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
      const png = await sharp({
        create: { width: 80, height: 60, channels: 3, background: "white" },
      }).png().toBuffer();
      await page.locator('input[type="file"]').nth(1).setInputFiles({
        name: "multiple-cartons.png", mimeType: "image/png", buffer: png,
      });
      await page.getByRole("button", { name: "開始分析", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(scenario.reported + 1);
      if (pending > 0) {
        await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
        if (scenario.decision === "remove") {
          await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "係另一份，計入", exact: true }).click();
        }
        await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toHaveCount(0);
      } else {
        await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toHaveCount(0);
      }
      const expected = scenario.decision === "remove" ? scenario.physical + 1 : scenario.reported + 1;
      await expect(page.locator(".food-card")).toHaveCount(expected);
      await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
      await expect.poll(() => backend.records.size).toBe(1);
      const saved = [...backend.records.values()][0].items as Array<{
        normalizedName: string; suspectedDuplicateMilk?: true;
      }>;
      expect(saved).toHaveLength(expected);
      expect(saved.filter(x => x.normalizedName === "oat milk")).toHaveLength(expected - 1);
      expect(saved.every(x => !x.suspectedDuplicateMilk)).toBe(true);
      expect(saved.some(x => x.normalizedName === "whole milk")).toBe(true);
      await page.getByRole("button", { name: "歷史", exact: true }).click();
      await page.getByRole("button", { name: "查看／修正", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(expected);
      expect(backend.mealReadUrls.length).toBeGreaterThan(0);
    });
}


// Count evidence is only safe when it explicitly affirms the same milk family.
// Two rows that are not supported stay pending through the real UI flow and
// can be resolved separately before synthetic cloud save and History readback.
for (const scenario of [
  { name: "other soy cartons omitted from food rows", evidence: "一盒燕麥奶，旁邊另外兩盒豆漿及一杯全脂牛奶", decision: "remove" },
  { name: "questioned three oat cartons", evidence: "三盒燕麥奶？", decision: "confirm" },
] as const) {
  test(`P1 evidence admission: ${scenario.name}, ${scenario.decision}, cloud History`,
    async ({ page, context }) => {
      const backend = cloud();
      await backend.install(context);
      const oat = m6CartonAndGlassAnalysis.foods[0];
      const dairy = {
        ...m6CartonAndGlassAnalysis.foods[1],
        displayName: "全脂牛奶", normalizedName: "whole milk",
      };
      const model = {
        ...m6CartonAndGlassAnalysis,
        foods: [{ ...oat }, { ...oat }, { ...oat }, dairy],
        visibleEvidence: [scenario.evidence],
      };
      const preparedAnalysis = preparePhotoMilkAnalysis(model);
      expect(preparedAnalysis.foods).toHaveLength(4);
      expect(preparedAnalysis.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(2);
      expect(preparedAnalysis.foods.find(x => x.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
      await page.route("**/api/analyze", route => route.fulfill({
        json: { mode: "live", analysis: preparedAnalysis, analysisProvenance: null },
      }));
      await page.route("**/api/nutrition/resolve", route => route.fulfill({
        status: 500, json: { error: { code: "unexpected_nutrition" } },
      }));
      await page.goto("/");
      await login(page);
      await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
      const png = await sharp({
        create: { width: 80, height: 60, channels: 3, background: "white" },
      }).png().toBuffer();
      await page.locator('input[type="file"]').nth(1).setInputFiles({
        name: "cardinality-evidence.png", mimeType: "image/png", buffer: png,
      });
      await page.getByRole("button", { name: "開始分析", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(4);
      await expect(page.getByText(/有 2 項飲品可能重複，尚待你確認/)).toBeVisible();
      for (let i = 0; i < 2; i++) {
        const action = scenario.decision === "remove" ? "係重複，移除" : "係另一份，計入";
        await page.getByRole("button", { name: action, exact: true }).first().click();
      }
      await expect(page.getByText(/可能重複，尚待你確認/)).toHaveCount(0);
      const expected = scenario.decision === "remove" ? 2 : 4;
      await expect(page.locator(".food-card")).toHaveCount(expected);
      await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
      await expect.poll(() => backend.records.size).toBe(1);
      const saved = [...backend.records.values()][0].items as Array<{
        normalizedName: string; suspectedDuplicateMilk?: true;
      }>;
      expect(saved).toHaveLength(expected);
      expect(saved.filter(x => x.normalizedName === "oat milk")).toHaveLength(expected - 1);
      expect(saved.some(x => x.normalizedName === "whole milk")).toBe(true);
      expect(saved.every(x => !x.suspectedDuplicateMilk)).toBe(true);
      await page.getByRole("button", { name: "歷史", exact: true }).click();
      await page.getByRole("button", { name: "查看／修正", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(expected);
      expect(backend.mealReadUrls.length).toBeGreaterThan(0);
    });
}


// Separate cups / unidentified cartons / spatial directions in oat-row notes
// must not make a duplicate oat carton count automatically. All three flows
// exercise UI decisions and synthetic cloud History, never a live user.
for (const scenario of [
  {
    name: "another glass does not count an extra oat carton",
    note: "燕麥奶紙盒，旁邊另一杯",
    decision: "remove",
    pending: 1,
  },
  {
    name: "other glass positions cannot authorize second oat carton",
    note: "燕麥奶紙盒；前方玻璃杯，後方另一杯",
    decision: "confirm",
    pending: 1,
  },
  {
    name: "explicit second oat carton is a real distinct serving",
    note: "紙盒燕麥奶，另一盒燕麥奶",
    decision: "none",
    pending: 0,
  },
] as const) {
  test(`P1 non-numeric vessel scope: ${scenario.name}, ${scenario.decision}, save + History`,
    async ({ page, context }) => {
      const backend = cloud();
      await backend.install(context);
      const oatCarton = { ...m6CartonAndGlassAnalysis.foods[0], notes: scenario.note };
      const glass = {
        ...m6CartonAndGlassAnalysis.foods[1],
        displayName: "全脂牛奶", normalizedName: "whole milk",
      };
      const vision = {
        ...m6CartonAndGlassAnalysis,
        foods: [oatCarton, { ...oatCarton }, glass],
        visibleEvidence: [],
      };
      const preparedAnalysis = preparePhotoMilkAnalysis(vision);
      expect(preparedAnalysis.foods).toHaveLength(3);
      expect(preparedAnalysis.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(scenario.pending);
      expect(preparedAnalysis.foods.find(x => x.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
      await page.route("**/api/analyze", route => route.fulfill({
        json: { mode: "live", analysis: preparedAnalysis, analysisProvenance: null },
      }));
      await page.route("**/api/nutrition/resolve", route => route.fulfill({
        status: 500, json: { error: { code: "unexpected_nutrition" } },
      }));
      await page.goto("/");
      await login(page);
      await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
      const png = await sharp({
        create: { width: 80, height: 60, channels: 3, background: "white" },
      }).png().toBuffer();
      await page.locator('input[type="file"]').nth(1).setInputFiles({
        name: "non-numeric-vessels.png", mimeType: "image/png", buffer: png,
      });
      await page.getByRole("button", { name: "開始分析", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(3);
      if (scenario.pending) {
        await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
        await page.getByRole("button", {
          name: scenario.decision === "remove" ? "係重複，移除" : "係另一份，計入",
          exact: true,
        }).click();
        await expect(page.getByText(/可能重複，尚待你確認/)).toHaveCount(0);
      } else {
        await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
      }
      const expected = scenario.decision === "remove" ? 2 : 3;
      await expect(page.locator(".food-card")).toHaveCount(expected);
      await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
      await expect.poll(() => backend.records.size).toBe(1);
      const saved = [...backend.records.values()][0].items as Array<{
        normalizedName: string; suspectedDuplicateMilk?: true;
      }>;
      expect(saved).toHaveLength(expected);
      expect(saved.filter(x => x.normalizedName === "oat milk")).toHaveLength(expected - 1);
      expect(saved.every(x => !x.suspectedDuplicateMilk)).toBe(true);
      expect(saved.some(x => x.normalizedName === "whole milk")).toBe(true);
      await page.getByRole("button", { name: "歷史", exact: true }).click();
      await page.getByRole("button", { name: "查看／修正", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(expected);
      expect(backend.mealReadUrls.length).toBeGreaterThan(0);
    });
}

test("P1 two-row differing oat notes stay pending, remove duplicate, save + History", async ({ page, context }) => {
  const backend = cloud();
  await backend.install(context);
  const left = {
    ...m6CartonAndGlassAnalysis.foods[0],
    notes: "燕麥奶紙盒，旁邊另一杯",
  };
  const right = {
    ...m6CartonAndGlassAnalysis.foods[0],
    notes: "燕麥奶紙盒，旁邊玻璃杯",
  };
  const glass = {
    ...m6CartonAndGlassAnalysis.foods[1],
    displayName: "全脂牛奶",
    normalizedName: "whole milk",
  };
  const preparedAnalysis = preparePhotoMilkAnalysis({
    ...m6CartonAndGlassAnalysis,
    foods: [left, right, glass],
    visibleEvidence: [],
  });
  expect(preparedAnalysis.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
  await page.route("**/api/analyze", route => route.fulfill({
    json: { mode: "live", analysis: preparedAnalysis, analysisProvenance: null },
  }));
  await page.route("**/api/nutrition/resolve", route => route.fulfill({
    status: 500, json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "two-row-diff-notes.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(3);
  await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
  await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
  await expect(page.getByText(/可能重複，尚待你確認/)).toHaveCount(0);
  await expect(page.locator(".food-card")).toHaveCount(2);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0].items as Array<{
    normalizedName: string; suspectedDuplicateMilk?: true;
  }>;
  expect(saved).toHaveLength(2);
  expect(saved.filter(x => x.normalizedName === "oat milk")).toHaveLength(1);
  expect(saved.some(x => x.normalizedName === "whole milk")).toBe(true);
  expect(saved.every(x => !x.suspectedDuplicateMilk)).toBe(true);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  expect(backend.mealReadUrls.length).toBeGreaterThan(0);
});

function syntheticOat(note: string): ObservedFood {
  return {
    displayName: "燕麥奶",
    normalizedName: "oat milk",
    identityLevel: "ingredient",
    portionMin: 250,
    portionMax: 250,
    unit: "ml",
    recognitionConfidence: 0.74,
    portionConfidence: 0.58,
    uncertaintyReasons: [],
    notes: note,
  };
}

function syntheticWholeGlass(): ObservedFood {
  return {
    displayName: "全脂牛奶",
    normalizedName: "whole milk",
    identityLevel: "ingredient",
    portionMin: 250,
    portionMax: 250,
    unit: "ml",
    recognitionConfidence: 0.7,
    portionConfidence: 0.5,
    uncertaintyReasons: [],
    notes: "玻璃杯全脂牛奶",
  };
}

function visibleNutrition(foods: ObservedFood[]) {
  const meal = new NutritionService(new LocalNutritionProvider()).calculateMeal(
    createEditableFoodItems(foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      ...(item.normalizedName === "oat milk" ? { userMilkTypeChoice: "oat" as const } : {}),
      ...(item.normalizedName === "whole milk" ? { userMilkTypeChoice: "whole" as const } : {}),
    })),
  );
  const calories = roundRange(meal.totals.calories, 5);
  const macro = (range: { min: number; max: number }) => {
    const rounded = roundRange(range, 1);
    return `${rounded.min}–${rounded.max}g`;
  };
  return {
    pendingHeading: `已確認項目合計：約 ${calories.min}–${calories.max} kcal`,
    heading: `約 ${calories.min}–${calories.max} kcal`,
    protein: macro(meal.totals.protein),
    carbs: macro(meal.totals.carbs),
    fat: macro(meal.totals.fat),
    included: meal.includedCount,
    total: meal.totalCount,
    coverage: meal.coverage,
  };
}

async function chooseOat(page: Page, pendingOnly: boolean) {
  const cards = page.locator(".food-card");
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const pending = await card.getByRole("button", { name: "係重複，移除", exact: true }).count();
    if (pendingOnly ? pending === 0 : pending > 0) continue;
    const choice = card.getByRole("button", { name: "燕麥奶", exact: true });
    if (await choice.count() > 0) await choice.click();
  }
}

async function expectMealNutrition(page: Page, foods: ObservedFood[], pending: boolean) {
  const expected = visibleNutrition(foods);
  await expect(page.getByRole("heading", {
    name: pending ? expected.pendingHeading : expected.heading,
    exact: true,
  })).toBeVisible();
  await expect(page.locator(".macro-protein strong")).toHaveText(expected.protein);
  await expect(page.locator(".macro-carbs strong")).toHaveText(expected.carbs);
  await expect(page.locator(".macro-fat strong")).toHaveText(expected.fat);
  if (pending) {
    await expect(page.getByText(
      `營養參考只包括 ${expected.included} / ${expected.total} 項有可靠營養資料的食物。`,
    )).toBeVisible();
  }
  return expected;
}

async function openSyntheticMilk(
  page: Page,
  context: BrowserContext,
  foods: ObservedFood[],
  visibleEvidence: string[] = [],
) {
  const backend = cloud();
  await backend.install(context);
  const preparedAnalysis = preparePhotoMilkAnalysis(foodAnalysisSchema.parse({
    analysisStatus: "success",
    foods,
    uncertaintyReasons: [],
    visibleEvidence,
    estimatedInformation: [],
    unknownInformation: [],
  } satisfies FoodAnalysis));
  await page.route("**/api/analyze", route => route.fulfill({
    json: { mode: "live", analysis: preparedAnalysis, analysisProvenance: null },
  }));
  await page.route("**/api/nutrition/resolve", route => route.fulfill({
    status: 500, json: { error: { code: "unexpected_nutrition" } },
  }));
  await page.goto("/");
  await login(page);
  await page.getByRole("button", { name: "AI 相片辨識", exact: true }).click();
  const png = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "white" },
  }).png().toBuffer();
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "synthetic-milk.png", mimeType: "image/png", buffer: png,
  });
  await page.getByRole("button", { name: "開始分析", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(preparedAnalysis.foods.length);
  return { backend, preparedAnalysis };
}

for (const decision of ["remove", "confirm"] as const) {
  test(`P1 spatial glass notes keep one oat carton pending: ${decision}, save + History`, async ({ page, context }) => {
    const { backend, preparedAnalysis } = await openSyntheticMilk(page, context, [
      syntheticOat("燕麥奶紙盒，前方玻璃杯"),
      syntheticOat("燕麥奶紙盒，後方玻璃杯"),
    ]);
    expect(preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(1);
    await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
    await chooseOat(page, false);
    await expectMealNutrition(page, preparedAnalysis.foods, true);
    if (decision === "remove") {
      await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
      await expect(page.locator(".food-card")).toHaveCount(1);
    } else {
      await page.getByRole("button", { name: "係另一份，計入", exact: true }).click();
      await chooseOat(page, false);
      await expect(page.locator(".food-card")).toHaveCount(2);
    }
    await expect(page.getByText(/可能重複，尚待你確認/)).toHaveCount(0);
    const kept = decision === "remove"
      ? preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk !== true)
      : preparedAnalysis.foods.map(food => {
        const next = { ...food };
        delete next.suspectedDuplicateMilk;
        return next;
      });
    await expectMealNutrition(page, kept, false);
    await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
    await expect.poll(() => backend.records.size).toBe(1);
    const saved = [...backend.records.values()][0].items as Array<{
      displayName: string;
      normalizedName: string;
      suspectedDuplicateMilk?: boolean;
      userMilkTypeChoice?: string;
    }>;
    expect(saved).toHaveLength(decision === "remove" ? 1 : 2);
    expect(saved.every(item => item.displayName === "燕麥奶")).toBe(true);
    expect(saved.every(item => item.normalizedName === "oat-milk")).toBe(true);
    expect(saved.every(item => item.suspectedDuplicateMilk == null)).toBe(true);
    expect(saved.every(item => item.userMilkTypeChoice === "oat")).toBe(true);
    await page.getByRole("button", { name: "歷史", exact: true }).click();
    await page.getByRole("button", { name: "查看／修正", exact: true }).click();
    await expect(page.locator(".food-card")).toHaveCount(saved.length);
    await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toHaveCount(0);
    await expectMealNutrition(page, kept, false);
    expect(backend.mealReadUrls.length).toBeGreaterThan(0);
  });
}

test("P1 mixed-vessel oat note keeps the dairy glass and one pending oat through History", async ({ page, context }) => {
  const { backend, preparedAnalysis } = await openSyntheticMilk(page, context, [
    syntheticOat("紙盒燕麥奶 not the same glass"),
    syntheticOat("燕麥奶紙盒"),
    syntheticWholeGlass(),
  ]);
  expect(preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(1);
  expect(preparedAnalysis.foods.find(food => food.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
  await expect(page.getByText(/有 1 項飲品可能重複，尚待你確認/)).toBeVisible();
  await chooseOat(page, false);
  await expectMealNutrition(page, preparedAnalysis.foods, true);
  await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  const kept = preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk !== true);
  await expectMealNutrition(page, kept, false);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0].items as Array<{
    normalizedName: string;
    suspectedDuplicateMilk?: boolean;
  }>;
  expect(saved.map(item => item.normalizedName).sort()).toEqual(["oat-milk", "whole milk"]);
  expect(saved.every(item => item.suspectedDuplicateMilk == null)).toBe(true);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expectMealNutrition(page, kept, false);
  expect(backend.mealReadUrls.length).toBeGreaterThan(0);
});

test("P1 negated oat quantity stays pending until the duplicate rows are removed", async ({ page, context }) => {
  const { backend, preparedAnalysis } = await openSyntheticMilk(page, context, [
    syntheticOat("燕麥奶紙盒。唔係三盒燕麥奶，只係一盒"),
    syntheticOat("燕麥奶紙盒"),
    syntheticOat("燕麥奶紙盒"),
    syntheticWholeGlass(),
  ]);
  expect(preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(2);
  expect(preparedAnalysis.foods.find(food => food.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
  await expect(page.getByText(/有 2 項飲品可能重複，尚待你確認/)).toBeVisible();
  await chooseOat(page, false);
  await expectMealNutrition(page, preparedAnalysis.foods, true);
  await page.getByRole("button", { name: "係重複，移除", exact: true }).first().click();
  await page.getByRole("button", { name: "係重複，移除", exact: true }).click();
  await expect(page.getByText(/可能重複，尚待你確認/)).toHaveCount(0);
  await expect(page.locator(".food-card")).toHaveCount(2);
  const kept = preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk !== true);
  await expectMealNutrition(page, kept, false);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0].items as Array<{
    normalizedName: string;
    suspectedDuplicateMilk?: boolean;
  }>;
  expect(saved.map(item => item.normalizedName).sort()).toEqual(["oat-milk", "whole milk"]);
  expect(saved.every(item => item.suspectedDuplicateMilk == null)).toBe(true);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expectMealNutrition(page, kept, false);
  expect(backend.mealReadUrls.length).toBeGreaterThan(0);
});

test("P1 two explicitly positioned oat cartons count with no pending confirmation", async ({ page, context }) => {
  const { backend, preparedAnalysis } = await openSyntheticMilk(page, context, [
    syntheticOat("左邊燕麥奶紙盒"),
    syntheticOat("右邊燕麥奶紙盒"),
  ]);
  expect(preparedAnalysis.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(0);
  await expect(page.getByRole("button", { name: "係重複，移除", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "係另一份，計入", exact: true })).toHaveCount(0);
  await chooseOat(page, false);
  await expectMealNutrition(page, preparedAnalysis.foods, false);
  await page.getByRole("button", { name: "儲存餐點", exact: true }).click();
  await expect.poll(() => backend.records.size).toBe(1);
  const saved = [...backend.records.values()][0].items as Array<{
    normalizedName: string;
    suspectedDuplicateMilk?: boolean;
    userMilkTypeChoice?: string;
  }>;
  expect(saved).toHaveLength(2);
  expect(saved.every(item => item.normalizedName === "oat-milk" && item.userMilkTypeChoice === "oat")).toBe(true);
  expect(saved.every(item => item.suspectedDuplicateMilk == null)).toBe(true);
  await page.getByRole("button", { name: "歷史", exact: true }).click();
  await page.getByRole("button", { name: "查看／修正", exact: true }).click();
  await expect(page.locator(".food-card")).toHaveCount(2);
  await expectMealNutrition(page, preparedAnalysis.foods, false);
  expect(backend.mealReadUrls.length).toBeGreaterThan(0);
});
