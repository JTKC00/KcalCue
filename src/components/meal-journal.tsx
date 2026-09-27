"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  firebaseAuth,
  onAuthStateChanged,
  signOut,
  hasEmailLink,
  cloudConfigured,
} from "@/lib/firebase/client";
import { Account } from "./firebase-account";
import { clearSyncState, visibleMeals, type PendingMeal } from "@/lib/meals/outbox";
import { localMeals, type LocalMeals } from "@/lib/meals/cache";
import { MealRepository, RepositoryError } from "@/lib/meals/repository";
import {
  dayNutrition,
  localDate,
  mealTypes,
  newDraft,
  type MealDraft,
  type MealRecord,
} from "@/lib/meals/types";
import { preparePhoto } from "@/lib/meals/photo";
import { unitCopy } from "@/content/zh-HK";
import { roundRange } from "@/lib/nutrition/calculation";
import { KcalCueApp } from "./kcalcue-app";
import { PwaControls } from "./pwa-controls";
import { CalorieCorrectionInput } from "./calorie-correction-input";
import { dayCalories, mealCalories, sameCalorieBasis } from "@/lib/meals/calories";

const repository = new MealRepository();
const messages: Record<string, string> = {
  login_required: "登入已過期，請重新登入。待同步修改仍保留，登入後自動重試。",
  conflict:
    "這餐已在另一個裝置修改或刪除。你的修改仍保留；可保留為新餐點草稿，或放棄待同步修改。",
  invalid_request: "請檢查食物名稱、份量及日期時間。每餐最多 12 項食物。",
  unsupported_schema: "這筆餐點的資料格式暫未支援，修改仍保留於本機。",
  photo_failed: "照片未能處理，可再試一次，或移除草稿圖片。",
  trial_access_required:
    "這個 Email 尚未獲得試用權限，修改保留於本機。請聯絡管理員開通後重試。",
  browser_unsupported:
    "此瀏覽器不支援安全的多分頁同步，請更新 Chrome、Safari 或 Firefox。",
  cloud_unavailable: "尚未設定 Firebase，目前只能保存本機草稿。",
};
function errorText(error: unknown) {
  return error instanceof RepositoryError
    ? (messages[error.code] ??
        "未能連接雲端，修改仍保留於本機，稍後會自動重試。")
    : "未能完成操作，請檢查網絡後再試。已保留的修改不會被清除。";
}
type JournalNotice = string | { kind: "pending-sync"; message: string };

function mealCalorieLabel(record: MealRecord) {
  const calories = mealCalories(record);
  if (calories.coverage === "insufficient") return "整餐卡路里未知；詳情可查看已知食物估算";
  if (!calories.range) return "卡路里未知";
  if (calories.source === "user") return `手動記錄：${calories.range.min} kcal`;
  const range = roundRange(calories.range, 5);
  return `${calories.coverage === "complete" ? "估算" : "已知部分"}：約 ${range.min}–${range.max} kcal`;
}

function OriginalAnalysisDetails({ record }: { record: MealRecord }) {
  if (record.mode !== "live") return null;
  const analysis = record.analysis;
  return (
    <details className="meal-original-analysis">
      <summary>{analysis ? "查看原始 AI 辨識" : "原始 AI 辨識未保存"}</summary>
      {analysis ? (
        <div>
          <p>拍照時的辨識結果，不會取代目前記錄。卡路里另按食物參考資料估算，或採用你的手動修正。</p>
          {analysis.foods.length ? (
            <ul>
              {analysis.foods.map((food, index) => (
                <li key={index}>
                  {food.displayName}：約 {food.portionMin}–{food.portionMax} {unitCopy[food.unit]}
                </li>
              ))}
            </ul>
          ) : (
            <p>當時未能可靠辨認相片中的食物。</p>
          )}
          {analysis.uncertaintyReasons.length > 0 && (
            <div>
              <strong>當時未能確認</strong>
              <ul>
                {analysis.uncertaintyReasons.map((reason, index) => <li key={index}>{reason}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <p>這筆舊紀錄沒有可核實的原始 AI 分析；目前記錄仍可查看及修正。</p>
      )}
    </details>
  );
}

export function MealJournal({
  initialProviderMode,
}: {
  initialProviderMode: "demo" | "live";
}) {
  const [tab, setTab] = useState("today");
  const [account, setAccount] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [userId, setUserId] = useState("guest");
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [records, setRecords] = useState<MealRecord[]>([]);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const [initialDraft, setInitialDraft] = useState<MealDraft | undefined>();
  const [editorKey, setEditorKey] = useState(0);
  const [manual, setManual] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<JournalNotice>("");
  const [syncNotice, setSyncNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<PendingMeal[]>([]);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const refreshRequested = useRef(false);
  const retryRequested = useRef(false);
  const accountGeneration = useRef(0);
  const pendingRef = useRef(0);
  const lastAttempt = useRef(0);
  useEffect(() => {
    pendingRef.current = pending.filter((job) => !job.error).length;
  }, [pending]);
  const current = useRef({ userId, draft, records, syncedAt });
  useEffect(() => {
    current.current = { userId, draft, records, syncedAt };
  }, [userId, draft, records, syncedAt]);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const cacheEnabled = useRef(true);
  const preparedFile = useRef<File | null>(null);
  const photoGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const busyRef = useRef(false);
  const allowUpdateReload = useRef(false);
  useEffect(() => {
    allowUpdateReload.current = false;
  }, [draft]);

  const refresh = useCallback(async function refreshMeals(retry = false) {
    const id = current.current.userId;
    const generation = ++refreshGeneration.current;
    const accountVersion = accountGeneration.current;
    if (id === "guest") return;
    retryRequested.current ||= retry;
    if (syncingRef.current || busyRef.current) {
      refreshRequested.current = true;
      return;
    }
    refreshRequested.current = false;
    const retryPending = retryRequested.current;
    retryRequested.current = false;
    const isCurrent = () =>
      current.current.userId === id &&
      accountGeneration.current === accountVersion &&
      refreshGeneration.current === generation &&
      !busyRef.current;
    lastAttempt.current = Date.now();
    syncingRef.current = true;
    setSyncing(true);
    try {
      if (navigator.onLine) {
        await repository.sync(id, retryPending);
        if (isCurrent()) {
          setOnline(true);
          setSyncNotice("");
        }
      }
    } catch (error) {
      if (isCurrent()) {
        setSyncNotice(errorText(error));
        if (error instanceof TypeError) setOnline(false);
      }
    } finally {
      try {
        // Records and pending count must describe the same durable snapshot.
        const state = await repository.state(id);
        if (isCurrent()) {
          setRecords(visibleMeals(state));
          setPending(state.jobs);
          setSyncedAt(state.syncedAt);
          setNotice((value) => {
            if (typeof value === "string") return value;
            return state.jobs.length === 0
              ? ""
              : { kind: "pending-sync", message: `已保留本機修改，尚有 ${state.jobs.length} 項待同步。` };
          });
        }
      } catch {
        if (isCurrent()) setSyncNotice("本機儲存不可用，請勿關閉頁面。");
      }
      syncingRef.current = false;
      setSyncing(false);
      if (refreshRequested.current && !busyRef.current) void refreshMeals();
    }
  }, []);

  useEffect(() => {
    let active = true;
    const accountEpoch = accountGeneration;
    const refreshEpoch = refreshGeneration;
    let loadGeneration = 0;
    let loading = false;
    async function load(id: string, address: string | null) {
      const generation = ++loadGeneration;
      const accountVersion = accountGeneration.current;
      const isCurrentLoad = () => active && generation === loadGeneration &&
        accountVersion === accountGeneration.current;
      loading = true;
      setReady(false);
      setSyncNotice("");
      setNotice("");
      refreshGeneration.current++;
      const oldId = current.current.userId;
      const guestDraft =
        oldId === "guest" && id !== "guest"
          ? (current.current.draft ??
            (await localMeals.read("guest").catch(() => ({ draft: null })))
              .draft)
          : null;
      if (oldId !== "guest" && oldId !== id) {
        cacheEnabled.current = false;
        await writes.current;
        // Account changes preserve unsynced work; explicit logout clears local data.
        if (localStorage.getItem("kcalcue-logout")?.split(":")[0] === oldId)
          await localMeals.clear(oldId);
      }
      const local = await localMeals.read(id).catch(() => {
        setNotice("本機儲存不可用，請勿在儲存到雲端前關閉頁面。");
        return {
          records: [],
          draft: null,
          syncedAt: null,
        } satisfies LocalMeals;
      });
      if (!isCurrentLoad()) return;
      if (guestDraft && !local.draft) {
        local.draft = guestDraft;
        await localMeals.write(id, local);
        await writes.current;
        await localMeals.clear("guest");
      }
      if (!isCurrentLoad()) return;
      const [visibleRecords, syncState] =
        id === "guest"
          ? [[], { jobs: [] }]
          : await Promise.all([repository.list(id), repository.state(id)]);
      // A later sign-in may finish while IndexedDB is reading the previous account.
      if (!isCurrentLoad()) return;
      loading = false;
      current.current = { userId: id, ...local, records: visibleRecords };
      cacheEnabled.current = true;
      setUserId(id);
      setEmail(address);
      setRecords(visibleRecords);
      setDraft(local.draft);
      setInitialDraft(local.draft ?? undefined);
      setEditorKey((key) => key + 1);
      setSyncedAt(local.syncedAt);
      setReady(true);
      setPending(syncState.jobs);
      void refresh();
    }
    const auth = firebaseAuth();
    const subscription = auth
      ? onAuthStateChanged(auth, (user) => {
          if (!active) return;
          // Invalidate old continuations immediately, before the next account's
          // IndexedDB load finishes (including an A -> B -> A transition).
          accountGeneration.current++;
          refreshGeneration.current++;
          if (!loading && user?.uid === current.current.userId) {
            setEmail(user.email);
            void refresh();
          } else void load(user?.uid ?? "guest", user?.email ?? null);
        })
      : undefined;
    if (!auth) void load("guest", null);
    // The callback URL is browser state unavailable during server rendering.
    if (hasEmailLink()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAccount(true);
      setReauth(true);
    }
    const connection = () => {
      lastAttempt.current = Date.now();
      setOnline(navigator.onLine);
      if (navigator.onLine) {
        void fetch("/api/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        })
          .then((response) => {
            if (active) setOnline(response.ok);
          })
          .catch(() => {
            if (active) setOnline(false);
          });
        void refresh();
      }
    };
    const foreground = () => {
      if (document.visibilityState === "visible") connection();
    };
    const signedOutElsewhere = (event: StorageEvent) => {
      if (
        event.key !== "kcalcue-logout" ||
        event.newValue?.split(":")[0] !== current.current.userId
      )
        return;
      const old = current.current.userId;
      accountGeneration.current++;
      cacheEnabled.current = false;
      refreshGeneration.current++;
      photoGeneration.current++;
      current.current = {
        userId: "guest",
        draft: null,
        records: [],
        syncedAt: null,
      };
      setReady(false);
      setEmail(null);
      setDraft(null);
      setInitialDraft(undefined);
      setRecords([]);
      setUserId("guest");
      setTab("today");
      loadGeneration++;
      void writes.current
        .then(() => localMeals.clear(old))
        .then(() => {
          if (active) setNotice("這個帳戶已在另一個分頁登出，本機資料已清除。");
        })
        .catch(() => {
          if (active)
            setNotice(
              "帳戶已登出，但本機資料清理失敗，請清除瀏覽器的網站資料。",
            );
        })
        .finally(() => {
          if (active) {
            cacheEnabled.current = true;
            setReady(true);
          }
        });
    };
    const navigate = () => {
      const next = ["today", "new", "history"].includes(location.hash.slice(1))
        ? location.hash.slice(1)
        : "today";
      if (next === "new") {
        setInitialDraft(current.current.draft ?? undefined);
        setEditorKey((key) => key + 1);
      }
      setTab(next);
    };
    const queued = () => {
      void refresh();
    };
    const syncTimer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastAttempt.current >=
          (pendingRef.current ? 5_000 : 30_000)
      )
        connection();
    }, 1_000);
    window.addEventListener("kcalcue-sync", queued);
    window.addEventListener("storage", queued);
    connection();
    navigate();
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    window.addEventListener("hashchange", navigate);
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("storage", signedOutElsewhere);
    return () => {
      active = false;
      accountEpoch.current++;
      refreshEpoch.current++;
      refreshRequested.current = false;
      retryRequested.current = false;
      subscription?.();
      clearInterval(syncTimer);
      window.removeEventListener("kcalcue-sync", queued);
      window.removeEventListener("storage", queued);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("storage", signedOutElsewhere);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [refresh]);

  useEffect(() => {
    if (!ready || !cacheEnabled.current) return;
    const state = { records, draft, syncedAt };
    writes.current = writes.current
      .catch(() => {})
      .then(() => localMeals.write(userId, state))
      .catch(() =>
        setNotice("本機空間不足或儲存不可用，草稿未能保留。請先儲存到雲端。"),
      );
  }, [ready, records, draft, syncedAt, userId]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (current.current.draft && !allowUpdateReload.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);

  function operationScope() {
    const id = current.current.userId;
    const generation = accountGeneration.current;
    return {
      id,
      isCurrent: () =>
        current.current.userId === id &&
        accountGeneration.current === generation,
    };
  }

  function go(next: string) {
    // State is updated here; hashchange is reserved for browser back/forward.
    window.history.pushState(null, "", `#${next}`);
    setTab(next);
    setAccount(false);
  }
  function openDraft(next: MealDraft, isManual = false) {
    photoGeneration.current++;
    preparedFile.current = null;
    setPreparing(false);
    setPhotoFailed(false);
    setDraft(next);
    setInitialDraft(next);
    setManual(isManual);
    setEditorKey((key) => key + 1);
    setConflict(false);
    go("new");
  }
  function start(isManual = false) {
    if (draft) {
      openDraft(draft, !draft.items.length && isManual);
      return;
    }
    openDraft(newDraft(), isManual);
  }
  const onDraftChange = useCallback(
    (change: Pick<MealDraft, "items" | "analysis" | "analysisProvenance" | "mode">) => {
      const previous = current.current.draft;
      if (previous && previous.calorieInput !== undefined &&
        (!sameCalorieBasis(previous.items, change.items) || previous.mode !== change.mode)) {
        setNotice("餐點內容已改，已恢復參考估算；請重新確認手動卡路里。");
      } else if (previous?.calorieCorrection &&
        (!sameCalorieBasis(previous.items, change.items) || previous.mode !== change.mode)) {
        setNotice("餐點內容已改，已恢復參考估算；請重新確認手動卡路里。");
      }
      setDraft((value) => {
        if (!value) return value;
        const changed = !sameCalorieBasis(value.items, change.items) || value.mode !== change.mode;
        return {
          ...value,
          ...change,
          calorieCorrection: changed ? null : value.calorieCorrection,
          calorieInput: changed ? undefined : value.calorieInput,
          originalItems: value.version === 0 && value.analysis !== change.analysis
            ? change.analysis ? change.items : []
            : value.originalItems.length
            ? value.originalItems
            : change.analysis ? change.items : [],
        };
      });
    },
    [],
  );
  const onPhotoSelected = useCallback(
    (file: File | null) => {
      const generation = ++photoGeneration.current;
      preparedFile.current = file;
      if (!file) {
        setDraft((value) =>
          value
            ? { ...value, photo: undefined, photoPath: null, removePhoto: true }
            : value,
        );
        setPreparing(false);
        setPhotoFailed(false);
        return;
      }
      const id = current.current.draft?.id;
      if (!id) return;
      setPreparing(true);
      setPhotoFailed(false);
      void preparePhoto(file, id, initialProviderMode === "live")
        .then((photo) => {
          if (generation === photoGeneration.current)
            setDraft((value) =>
              value?.id === id
                ? { ...value, photo, photoPath: null, removePhoto: false }
                : value,
            );
        })
        .catch(() => {
          if (generation === photoGeneration.current) {
            setPhotoFailed(true);
            setNotice(
              "照片壓縮未完成，原相只保留於本次頁面。可重試或移除草稿圖片。",
            );
          }
        })
        .finally(() => {
          if (generation === photoGeneration.current) setPreparing(false);
        });
    },
    [initialProviderMode],
  );

  async function save() {
    if (!draft || busyRef.current) return;
    const invalid = document.querySelector<HTMLInputElement>(
      ".journal-editor input:invalid",
    );
    if (invalid) {
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    if (draft.mode === "demo") {
      setNotice("示範結果不會加入正式記錄。");
      return;
    }
    if (!email) {
      setNotice("請先登入，然後回到草稿按儲存。");
      setAccount(true);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    const id = userId;
    const scope = operationScope();
    let next = draft;
    try {
      next = { ...next, photoPath: null, photo: undefined, calorieInput: undefined };
      const fingerprint = JSON.stringify({
        ...next,
        // Legacy omission and explicit unknown metadata are the same command.
        analysisProvenance: next.analysisProvenance ?? undefined,
        schemaVersion: undefined,
        createdAt: undefined,
        calorieInput: undefined,
        photo: undefined,
        pendingMutation: undefined,
      });
      const pendingMutation =
        next.pendingMutation?.fingerprint === fingerprint
          ? next.pendingMutation
          : { fingerprint, id: crypto.randomUUID() };
      next = { ...next, pendingMutation };
      setDraft({ ...draft, pendingMutation });
      const saved = await repository.save(next, pendingMutation.id, id);
      if (!scope.isCurrent()) return;
      setRecords((value) => [
        ...value.filter((record) => record.id !== saved.id),
        saved,
      ]);
      setDraft(null);
      setInitialDraft(undefined);
      setNotice({ kind: "pending-sync", message: "已儲存到本機，連線時會自動同步。圖片不會保存到雲端。" });
      go("today");
      await writes.current;
      if (!scope.isCurrent()) return;
      await localMeals.write(id, {
        records: await repository.list(id),
        draft: null,
        syncedAt: null,
      });
      preparedFile.current = null;
      photoGeneration.current++;
      void refresh();
    } catch (error) {
      if (!scope.isCurrent()) return;
      setNotice(errorText(error));
      if (error instanceof RepositoryError && error.code === "conflict")
        setConflict(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refresh();
    }
  }
  async function edit(record: MealRecord) {
    if (
      draft &&
      draft.id !== record.id &&
      !confirm("已有另一份草稿。放棄它並開啟這餐？")
    )
      return;
    openDraft({ ...record, photoPath: null });
  }
  async function discard() {
    if (!confirm("放棄這份草稿？已儲存的記錄不會改變。")) return;
    const scope = operationScope();
    photoGeneration.current++;
    preparedFile.current = null;
    setDraft(null);
    setInitialDraft(undefined);
    await writes.current;
    if (!scope.isCurrent()) return;
    await localMeals.write(userId, { records, draft: null, syncedAt });
    if (!scope.isCurrent()) return;
    go("today");
  }
  async function remove(record: MealRecord, ask = true) {
    if (ask && !confirm("刪除這餐？連線後會同步刪除。")) return;
    const scope = operationScope();
    await repository.delete(record);
    if (!scope.isCurrent()) return;
    setNotice({ kind: "pending-sync", message: "刪除已保留於本機，連線時自動同步。" });
    void refresh();
    setRecords((value) => value.filter((r) => r.id !== record.id));
    if (draft?.id === record.id) setDraft(null);
  }
  async function deleting(record: MealRecord) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    const scope = operationScope();
    try {
      await remove(record);
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refresh();
    }
  }
  async function clearAll() {
    if (
      busyRef.current ||
      !confirm(
        "刪除本機可見的全部餐點及草稿？連線後會自動同步刪除。其他裝置尚未同步的新增記錄不包含在內。",
      )
    )
      return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    const scope = operationScope();
    try {
      for (const record of await repository.list(scope.id)) {
        if (!scope.isCurrent()) return;
        await remove(record, false);
      }
      await writes.current;
      if (!scope.isCurrent()) return;
      await localMeals.clear(scope.id);
      if (!scope.isCurrent()) return;
      setDraft(null);
      setRecords([]);
      setNotice({ kind: "pending-sync", message: "刪除已保留於本機，連線時自動同步。" });
      void refresh();
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refresh();
    }
  }
  async function logout() {
    if (
      busyRef.current ||
      (draft &&
        !confirm("登出會清除這個帳戶的本機草稿、照片及快取。仍要登出？"))
    )
      return;
    const scope = operationScope();
    if ((await repository.state(userId)).jobs.length) {
      if (!scope.isCurrent()) return;
      setNotice("仍有待同步或衝突的修改。請先連線完成同步或處理衝突，再登出。");
      return;
    }
    if (!scope.isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    cacheEnabled.current = false;
    refreshGeneration.current++;
    photoGeneration.current++;
    try {
      await navigator.locks.request(`kcalcue-sync-${userId}`, () =>
        navigator.locks.request(`kcalcue-account-${userId}`, async () => {
          if (!scope.isCurrent()) throw new Error("account_changed");
          if ((await repository.state(userId)).jobs.length)
            throw new Error("pending_sync");
          await writes.current;
          if (!scope.isCurrent()) throw new Error("account_changed");
          await localMeals.clear(userId);
          await clearSyncState(userId);
          if (!scope.isCurrent()) throw new Error("account_changed");
          setDraft(null);
          setRecords([]);
          current.current = { ...current.current, draft: null, records: [] };
          localStorage.setItem("kcalcue-logout", `${userId}:${Date.now()}`);
          const auth = firebaseAuth();
          if (auth) await signOut(auth);
        }),
      );
      if (scope.isCurrent()) location.reload();
    } catch {
      cacheEnabled.current = true;
      if (scope.isCurrent()) setNotice("登出未完成，請連線後再試。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function latest() {
    const scope = operationScope();
    try {
      const next = (await repository.state(scope.id)).remote;
      if (!scope.isCurrent()) return;
      const record = next.find((r) => r.id === draft?.id);
      if (!record) {
        setNotice("這餐已被刪除。你可保留目前草稿，或放棄它。");
        return;
      }
      if (confirm("載入最新記錄會取代目前的未儲存修改，是否繼續？"))
        await edit(record);
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    }
  }

  async function resolvePending(job: PendingMeal, preserve: boolean) {
    if (busyRef.current) return;
    const scope = operationScope();
    if (job.record.userId !== scope.id) return;
    const last = [...pending].reverse().find((other) => other.record.id === job.record.id)!;
    if (preserve
      ? draft && !confirm("取代目前草稿並將這份修改保留為新餐點？")
      : !confirm("放棄這餐尚未同步的修改／刪除，使用雲端版本？")) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    try {
      const copy: MealDraft = {
        ...last.record,
        id: crypto.randomUUID(),
        version: 0,
        schemaVersion: undefined,
        createdAt: undefined,
        pendingMutation: undefined,
      };
      if (preserve) {
        // Drain older cache writes before preserving the recovery draft.
        await writes.current;
        if (!scope.isCurrent()) return;
        await localMeals.write(scope.id, { records, draft: copy, syncedAt });
        if (!scope.isCurrent()) return;
      }
      await repository.discardPending(job.record.id, scope.id);
      if (!scope.isCurrent()) return;
      if (preserve) openDraft(copy);
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refresh();
    }
  }
  const visible = records
    .filter(
      (r) =>
        r.mode !== "demo" &&
        (tab === "today"
          ? r.date === localDate()
          : !filter || r.date === filter),
    )
    .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
  const days = [...new Set(visible.map((record) => record.date))];
  const displayedNotice = syncNotice || (typeof notice === "string" ? notice : notice.message);

  return (
    <div className="journal-shell">
      <header className="journal-header">
        <a className="brand" href="#today">
          KcalCue
        </a>
        <button
          className="button button-ghost"
          disabled={busy}
          onClick={() => {
            setInitialDraft(draft ?? undefined);
            setEditorKey((key) => key + 1);
            setAccount((value) => !value);
          }}
        >
          帳戶與安裝
        </button>
      </header>
      <div className="journal-status" role="status">
        {online
          ? syncedAt
            ? `上次同步：${new Date(syncedAt).toLocaleString("zh-HK")}`
            : "連線中 · 尚未同步"
          : "離線中 · 可新增、修改及刪除，重連後自動同步"}
        {!cloudConfigured() && <span> · 雲端尚未設定，無法登入或同步</span>}
      </div>
      {displayedNotice && (
        <div className="journal-notice" role="status">
          <span>{displayedNotice}</span>
          <button aria-label="關閉訊息" onClick={() => { setNotice(""); setSyncNotice(""); }}>
            ×
          </button>
        </div>
      )}
      {!!pending.length && (
        <section className="journal-card">
          <p>
            {pending.length} 項修改待同步{syncing ? " · 同步中…" : ""}
          </p>
          <button
            className="button button-secondary"
            disabled={!online || syncing}
            onClick={() => void refresh(true)}
          >
            重試同步
          </button>
          {pending
            .filter(
              (job, index, jobs) =>
                job.error &&
                jobs.findIndex(
                  (other) => other.record.id === job.record.id && other.error,
                ) === index,
            )
            .map((job) => (
              <div key={job.id}>
                <p>
                  {job.record.items.map((item) => item.displayName).join("、")}
                  ：{messages[job.error!] ?? "同步未完成，修改仍保留於本機。"}
                </p>
                {job.kind === "save" && (
                  <button
                    className="button button-secondary"
                    disabled={busy || syncing}
                    onClick={() => void resolvePending(job, true)}
                  >
                    保留修改為新餐點草稿
                  </button>
                )}
                <button
                  className="button button-ghost"
                  disabled={busy || syncing}
                  onClick={() => void resolvePending(job, false)}
                >
                  放棄待同步修改
                </button>
              </div>
            ))}
        </section>
      )}
      <PwaControls
        visible={account}
        beforeUpdate={async () => {
          if (busyRef.current) throw new Error("Save in progress");
          await writes.current;
          if (current.current.draft)
            await localMeals.write(current.current.userId, {
              records: current.current.records,
              draft: current.current.draft,
              syncedAt: current.current.syncedAt,
            });
          allowUpdateReload.current = true;
        }}
      />
      {account ? (
        <main className="journal-main">
          <h1>帳戶與資料</h1>
          {email && !reauth ? (
            <section className="journal-card">
              <p>{email}</p>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => setReauth(true)}
              >
                重新登入
              </button>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => void logout()}
              >
                登出並清除本機資料
              </button>
              <button
                className="button button-ghost danger"
                disabled={busy}
                onClick={() => void clearAll()}
              >
                清除全部記錄
              </button>
            </section>
          ) : (
            <Account
              onDone={() => {
                setAccount(false);
                setReauth(false);
                setNotice("登入成功。草稿需要你確認後才會儲存。");
              }}
            />
          )}
          <section className="journal-card">
            <h2>照片與私隱</h2>
            <p>
              Live 分析會將相片傳送至 AI 服務。圖片只用於分析請求，不會存入
              Firebase
              Storage；雲端只保存餐點及營養分析結果。本機草稿可暫存壓縮圖片，儲存或放棄草稿後清除。AI
              分析需要連線。
            </p>
          </section>
        </main>
      ) : !ready ? (
        <main className="journal-main" aria-busy="true">
          正在讀取記錄…
        </main>
      ) : tab === "new" ? (
        <div className="journal-editor">
          {!draft ? (
            <main className="journal-main">
              <h1>記低新一餐</h1>
              <button className="button button-primary" onClick={() => start()}>
                拍照／上傳
              </button>
              <button
                className="button button-secondary"
                onClick={() => start(true)}
              >
                手動輸入
              </button>
            </main>
          ) : (
            <>
              <section className="journal-card meal-metadata">
                <h1>{draft.version ? "修正餐點" : "新餐點草稿"}</h1>
                <div className="metadata-grid">
                  <label>
                    日期
                    <input
                      required
                      disabled={busy}
                      type="date"
                      value={draft.date}
                      onChange={(e) =>
                        setDraft({ ...draft, date: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    時間
                    <input
                      required
                      disabled={busy}
                      type="time"
                      value={draft.time}
                      onChange={(e) =>
                        setDraft({ ...draft, time: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    餐次
                    <select
                      disabled={busy}
                      value={draft.mealType}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mealType: e.target.value as MealDraft["mealType"],
                        })
                      }
                    >
                      {Object.entries(mealTypes).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p>
                  按 {draft.timezone} 記錄 ·{" "}
                  {draft.mode === "demo"
                    ? "示範結果不加入每日統計"
                    : "確認後才加入每日記錄"}
                </p>
              </section>
              {draft.items.length > 0 && draft.mode !== "demo" && (
                <CalorieCorrectionInput
                  correction={draft.calorieCorrection}
                  input={draft.calorieInput}
                  disabled={busy}
                  onChange={(change) => setDraft((value) => value ? { ...value, ...change } : value)}
                />
              )}
              <fieldset className="editor-fields" disabled={busy}>
                <KcalCueApp
                  key={editorKey}
                  initialProviderMode={initialProviderMode}
                  initialDraft={initialDraft ?? draft}
                  calorieCorrection={draft.calorieCorrection}
                  manual={manual}
                  onDraftChange={onDraftChange}
                  onPhotoSelected={onPhotoSelected}
                  onExit={() => {
                    void discard();
                  }}
                />
              </fieldset>
              <section className="journal-card journal-actions">
                {preparing && <p role="status">正在準備壓縮照片…</p>}
                {photoFailed && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      if (preparedFile.current)
                        onPhotoSelected(preparedFile.current);
                    }}
                  >
                    重試照片處理
                  </button>
                )}
                {(draft.photo || draft.photoPath || photoFailed) && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      openDraft({
                        ...draft,
                        photo: undefined,
                        photoPath: null,
                      });
                      setNotice("已移除草稿圖片。");
                    }}
                  >
                    移除草稿圖片
                  </button>
                )}
                {!!draft.originalItems.length && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      if (confirm("還原到原始估算？目前修改會被取代。"))
                        openDraft({
                          ...draft,
                          items: structuredClone(draft.originalItems),
                          calorieCorrection: null,
                          calorieInput: undefined,
                        });
                    }}
                  >
                    還原原始估算
                  </button>
                )}
                {conflict && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => void latest()}
                  >
                    載入最新記錄
                  </button>
                )}
              </section>
              <div className="save-bar">
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void discard()}
                >
                  放棄修改
                </button>
                <button
                  className="button button-primary"
                  disabled={
                    busy || !draft.items.length || draft.mode === "demo"
                  }
                  onClick={() => void save()}
                >
                  {busy ? "儲存中…" : !online ? "離線儲存餐點" : "儲存餐點"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <main className="journal-main">
          <div className="journal-title">
            <div>
              <p className="eyebrow">一餐一餐，慢慢記低</p>
              <h1>{tab === "today" ? "今日飲食" : "歷史記錄"}</h1>
            </div>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => start()}
            >
              ＋ 新增餐點
            </button>
          </div>
          {draft && (
            <section className="journal-card draft-banner">
              <span>有一份未儲存草稿</span>
              <button
                className="button button-secondary"
                onClick={() => openDraft(draft)}
              >
                繼續草稿
              </button>
            </section>
          )}
          {tab === "history" && (
            <label className="date-filter">
              按日期查看
              <input
                type="date"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button
                className="button button-ghost"
                onClick={() => setFilter("")}
              >
                全部日期
              </button>
            </label>
          )}
          {tab === "today" && !visible.length && (
            <div className="day-summary journal-card" aria-label="今日摘要">
              <div><span>今日餐數</span><strong>0</strong><small>餐</small></div>
              <div><span>卡路里</span><strong>0</strong><small>kcal</small></div>
            </div>
          )}
          {!visible.length && (
            <section className="journal-card empty-journal">
              <h2>{tab === "today" ? "今日未有記錄" : "未有餐點記錄"}</h2>
              <p>
                拍張相，或者手動記低你的一餐。
                {!email && "登入後可以跨裝置同步。"}
              </p>
              <button
                className="button button-secondary"
                onClick={() => start(true)}
              >
                手動記一餐
              </button>
            </section>
          )}
          {days.map((date) => {
            const meals = visible.filter((r) => r.date === date);
            const nutrition = dayNutrition(meals);
            const calories = dayCalories(meals);
            const calorieRange = calories.range && (calories.referenceCount
              ? roundRange(calories.range, 5) : calories.range);
            return (
              <section className="journal-day" key={date}>
                <h2>{date}</h2>
                <div className="day-summary journal-card">
                  <div>
                    <span>{calorieRange && calories.partialCount + calories.unknownCount > 0 ? "已知部分卡路里" : "卡路里"}</span>
                    <strong>{calorieRange
                      ? calories.referenceCount ? `${calorieRange.min}–${calorieRange.max}` : calorieRange.min
                      : "未知"}</strong>
                    <small>kcal</small>
                  </div>
                  {Object.entries(nutrition.totals).filter(([key]) => key !== "calories").map(([key, range]) => {
                    const rounded = roundRange(range, 1);
                    return (
                      <div key={key}>
                        <span>
                          {
                            {
                              protein: "蛋白質",
                              carbs: "碳水",
                              fat: "脂肪",
                            }[key]
                          }
                        </span>
                        <strong>
                          {nutrition.includedCount
                            ? `${rounded.min}–${rounded.max}`
                            : "未知"}
                        </strong>
                        <small>g</small>
                      </div>
                    );
                  })}
                  {calories.manualCount > 0 && <p>含 {calories.manualCount} 餐手動卡路里記錄；營養素仍按食物參考估算。</p>}
                  {calories.partialCount + calories.unknownCount > 0 && <p>以上並非全日總數：{calories.partialCount + calories.unknownCount} 餐未完整計入，未知不代表零。</p>}
                  {nutrition.includedCount < nutrition.totalCount && (
                    <p>
                      營養素部分估算：只計入 {nutrition.includedCount}／
                      {nutrition.totalCount} 項食物，未計入項目不代表零營養。
                    </p>
                  )}
                </div>
                <div className="meal-list">
                  {meals.map((record) => (
                    <article className="journal-card meal-row" key={record.id}>
                      <div>
                        <p>
                          {record.time} · {mealTypes[record.mealType]}
                        </p>
                        {tab === "history" && <p className="meal-current-note">目前記錄</p>}
                        <h3>
                          {record.items
                            .map((item) => item.displayName)
                            .join("、")}
                        </h3>
                        <p className="meal-calories">{mealCalorieLabel(record)}</p>
                        {tab === "history" && <OriginalAnalysisDetails record={record} />}
                        <div className="journal-actions">
                          <button
                            className="button button-secondary"
                            disabled={busy}
                            onClick={() => void edit(record)}
                          >
                            查看／修正
                          </button>
                          <button
                            className="button button-ghost danger"
                            disabled={busy}
                            onClick={() => void deleting(record)}
                          >
                            刪除
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </main>
      )}
      <nav className="journal-nav" aria-label="主導覽">
        {[
          ["today", "今日"],
          ["new", "新增"],
          ["history", "歷史"],
        ].map(([key, label]) => (
          <button
            key={key}
            disabled={busy}
            aria-current={!account && tab === key ? "page" : undefined}
            onClick={() => {
              if (key === "new") start();
              else go(key);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
