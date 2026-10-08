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
import { draftTabId, prepareDraftTabId, localMeals, type LocalMeals, type SavedDraftSummary } from "@/lib/meals/cache";
import { MealRepository, RepositoryError } from "@/lib/meals/repository";
import {
  dayNutrition,
  localDate,
  mealTypes,
  newDraft,
  type MealDraft,
  type MealRecord,
} from "@/lib/meals/types";
import { PhotoPreparationError, preparePhoto } from "@/lib/meals/photo";
import { unitCopy } from "@/content/zh-HK";
import { foodAnalysisSchema } from "@/lib/domain/food-analysis";
import { roundRange } from "@/lib/nutrition/calculation";
import { KcalCueApp } from "./kcalcue-app";
import { PwaControls } from "./pwa-controls";
import { CalorieCorrectionInput } from "./calorie-correction-input";
import { PrivateMealPhoto } from "./private-meal-photo";
import { dayCalories, mealCalories, sameCalorieBasis } from "@/lib/meals/calories";
import { MAX_JOURNAL_NOTE_CODE_POINTS, journalNoteCodePoints, normalizeJournalNote } from "@/lib/meals/journal-note";
import { CameraIcon, FoodStampIcon, HistoryIcon, HomeIcon, JournalIcon, PlusIcon, UserIcon, type FoodStampKind } from "./icons";

const repository = new MealRepository();
const messages: Record<string, string> = {
  login_required: "登入已過期，請重新登入。待同步修改仍保留，登入後自動重試。",
  conflict:
    "這餐已在另一個裝置修改或刪除。你的修改仍保留；可保留為新餐點草稿，或放棄待同步修改。",
  snapshot_changed: "雲端餐點清單剛有更新，請再試同步；本機紀錄仍保留。",
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
type JournalNotice =
  | string
  | { kind: "pending-sync" | "blocked-save"; message: string };
function commandFingerprint(draft: MealDraft) {
  const next = { ...draft, photoPath: null, photo: undefined, calorieInput: undefined };
  return JSON.stringify({
    ...next,
    analysisProvenance: next.analysisProvenance ?? undefined,
    schemaVersion: undefined,
    createdAt: undefined,
    calorieInput: undefined,
    photo: undefined,
    pendingMutation: undefined,
  });
}
function blockedSaveText(code: string) {
  const detail = messages[code] ?? "同步未完成，修改仍保留於本機。";
  return `未能儲存到雲端。${detail} 草稿仍在，可重試儲存。`;
}
function pendingSyncNotice(count: number): JournalNotice {
  return { kind: "pending-sync", message: `已保留本機修改，尚有 ${count} 項待同步。` };
}
const oversizedPhotoNotice = "圖片像素超過 4000 萬，此瀏覽器未能壓縮。請選較低解像度的照片，或移除圖片後手動記錄。";
const retryablePhotoNotice = "照片壓縮未完成，原相只保留於本次頁面。可重試或移除草稿圖片。";
const photoRateLimitNotice = "照片處理稍忙，請約 10 秒後重試。原相只保留於本次頁面。";
function clearPhotoNotice(notice: JournalNotice): JournalNotice {
  return notice === oversizedPhotoNotice || notice === retryablePhotoNotice ||
    notice === photoRateLimitNotice ? "" : notice;
}

function mealCalorieLabel(record: MealRecord) {
  const calories = mealCalories(record);
  if (calories.coverage === "insufficient") return "整餐卡路里未知；詳情可查看已知食物估算";
  if (!calories.range) return "卡路里未知";
  if (calories.source === "user") return `手動記錄：${calories.range.min} kcal`;
  const range = roundRange(calories.range, 5);
  return `${calories.coverage === "complete" ? "估算" : "已知部分"}：約 ${range.min}–${range.max} kcal`;
}

const mealStamp: Record<MealRecord["mealType"], FoodStampKind> = {
  breakfast: "bowl",
  lunch: "salad",
  dinner: "soup",
  snack: "apple",
};

function FoodStampCluster({ variant = "today" }: { variant?: "today" | "new" | "empty" }) {
  const stamps: FoodStampKind[] = variant === "new"
    ? ["tomato", "rice", "milk", "carrot"]
    : variant === "empty"
      ? ["bread", "tea", "apple"]
      : ["apple", "bread", "carrot", "cup"];
  return (
    <div className={`food-stamp-cluster food-stamp-${variant}`} aria-hidden="true">
      {stamps.map((stamp, index) => (
        <span key={`${variant}-${index}`} className={`food-stamp food-stamp-${index + 1}`}>
          <FoodStampIcon kind={stamp} />
        </span>
      ))}
    </div>
  );
}

function journalDateLabel(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString("zh-HK", {
      month: "long",
      day: "numeric",
      weekday: "long",
    });
}

function OriginalAnalysisDetails({ record }: { record: MealRecord }) {
  if (record.mode !== "live") return null;
  // Cloud records predating schema validation can contain truthy, incomplete
  // analysis objects. Render only a complete original analysis as AI evidence.
  const parsed = foodAnalysisSchema.safeParse(record.analysis);
  const analysis = parsed.success ? parsed.data : null;
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
                  {food.displayName}：{food.portionMin === null || food.portionMax === null
                    ? "個人食用份量未知"
                    : `約 ${food.portionMin}–${food.portionMax} ${unitCopy[food.unit]}`}
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
  const [authEpoch, setAuthEpoch] = useState(0);
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [today, setToday] = useState(() => localDate());
  const [records, setRecords] = useState<MealRecord[]>([]);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<{ uid: string; items: SavedDraftSummary[] }>({
    uid: "guest", items: [],
  });
  const [initialDraft, setInitialDraft] = useState<MealDraft | undefined>();
  const [editorKey, setEditorKey] = useState(0);
  const [manual, setManual] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<JournalNotice>("");
  const [syncNotice, setSyncNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [photoFailure, setPhotoFailure] = useState<null | "retryable" | "too_large">(null);
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
  const queuedDraft = useRef<MealDraft | null>(null);
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
          const activeDraft = current.current.draft;
          const mutation = activeDraft?.pendingMutation;
          const ownedJob = mutation
            ? state.jobs.find((job) => job.id === mutation.id)
            : undefined;
          const acknowledged = !!activeDraft && !!mutation && !ownedJob &&
            state.remote.some((record) =>
              record.id === activeDraft.id && record.version > activeDraft.version) &&
            commandFingerprint(activeDraft) === mutation.fingerprint;
          if (acknowledged) {
            setDraft(null);
            setInitialDraft(undefined);
            window.history.pushState(null, "", "#today");
            setTab("today");
            setAccount(false);
          }
          setNotice((value) => {
            if (acknowledged)
              return state.jobs.length === 0 ? "" : pendingSyncNotice(state.jobs.length);
            if (ownedJob?.kind === "save" && ownedJob.error)
              return { kind: "blocked-save", message: blockedSaveText(ownedJob.error) };
            if (typeof value !== "object") return value;
            if (value.kind === "blocked-save") {
              const blocked = state.jobs.some((job) => job.kind === "save" && job.error);
              return blocked ? value : state.jobs.length === 0
                ? ""
                : pendingSyncNotice(state.jobs.length);
            }
            return state.jobs.length === 0 ? "" : pendingSyncNotice(state.jobs.length);
          });
          const saved = await localMeals.listDrafts(id).catch(() => null);
          if (isCurrent() && saved) setSavedDrafts({ uid: id, items: saved });
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
    function clearVolatilePhoto() {
      photoGeneration.current++;
      preparedFile.current = null;
      setPreparing(false);
      setPhotoFailure(null);
      setNotice(clearPhotoNotice);
    }
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
      const tabKey = await prepareDraftTabId();
      if (!isCurrentLoad()) return;
      const oldId = current.current.userId;
      const guestDraft =
        oldId === "guest" && id !== "guest"
          ? (current.current.draft ??
            (await localMeals.read("guest", tabKey).catch(() => ({ draft: null })))
              .draft)
          : null;
      if (oldId !== "guest" && oldId !== id) {
        cacheEnabled.current = false;
        await writes.current;
        // Account changes preserve unsynced work; explicit logout clears local data.
        if (localStorage.getItem("kcalcue-logout")?.split(":")[0] === oldId)
          await localMeals.clear(oldId);
      }
      const local = await localMeals.read(id, tabKey).catch(() => {
        setNotice("本機儲存不可用，請勿在儲存到雲端前關閉頁面。");
        return {
          records: [],
          draft: null,
          syncedAt: null,
        } satisfies LocalMeals;
      });
      if (!isCurrentLoad()) return;
      if (oldId === "guest" && id !== "guest" && local.draft) {
        // A signed-in account with its own draft does not adopt the guest
        // draft. Its retry control must not retain the guest's in-memory File.
        clearVolatilePhoto();
      }
      if (guestDraft && !local.draft) {
        local.draft = guestDraft;
        await localMeals.write(id, local, tabKey);
        await writes.current;
        await localMeals.clear("guest", tabKey);
      }
      if (!isCurrentLoad()) return;
      const syncState = id === "guest" ? null : await repository.state(id);
      const saved = await localMeals.listDrafts(id).catch(() => []);
      const visibleRecords = syncState ? visibleMeals(syncState) : [];
      // The durable outbox proves whether this account ever received a cloud
      // meal snapshot. The separate draft cache is not authority for that.
      const knownSyncedAt = syncState ? syncState.syncedAt ?? null : local.syncedAt ?? null;
      // A later sign-in may finish while IndexedDB is reading the previous account.
      if (!isCurrentLoad()) return;
      loading = false;
      queuedDraft.current = local.draft;
      current.current = { userId: id, ...local, records: visibleRecords, syncedAt: knownSyncedAt };
      cacheEnabled.current = true;
      setUserId(id);
      setEmail(address);
      setRecords(visibleRecords);
      setDraft(local.draft);
      setSavedDrafts({ uid: id, items: saved });
      setInitialDraft(local.draft ?? undefined);
      setEditorKey((key) => key + 1);
      setSyncedAt(knownSyncedAt);
      setReady(true);
      setPending(syncState?.jobs ?? []);
      void refresh();
    }
    const auth = firebaseAuth();
    const subscription = auth
      ? onAuthStateChanged(auth, (user) => {
          if (!active) return;
          const nextId = user?.uid ?? "guest";
          if (current.current.userId !== "guest" && nextId !== current.current.userId) {
            // An uncompressed File exists only in memory. It belongs to the
            // previous account even when the next account has a draft with
            // the same meal ID. Invalidate its async preparation immediately.
            clearVolatilePhoto();
          }
          // Invalidate old continuations immediately, before the next account's
          // IndexedDB load finishes (including an A -> B -> A transition).
          accountGeneration.current++;
          setAuthEpoch((epoch) => epoch + 1);
          refreshGeneration.current++;
          if (!loading && user?.uid === current.current.userId) {
            setEmail(user.email);
            void refresh();
          } else void load(nextId, user?.email ?? null);
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
      if (document.visibilityState === "visible") {
        setToday(localDate());
        connection();
      }
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
      clearVolatilePhoto();
      current.current = {
        userId: "guest",
        draft: null,
        records: [],
        syncedAt: null,
      };
      setReady(false);
      setEmail(null);
      setDraft(null);
      setSavedDrafts({ uid: "guest", items: [] });
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
      if (document.visibilityState === "visible") setToday(localDate());
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
    const state = { records, syncedAt };
    writes.current = writes.current
      .catch(() => {})
      .then(() => localMeals.writeSnapshot(userId, state))
      .catch(() =>
        setNotice("本機空間不足或儲存不可用，草稿未能保留。請先儲存到雲端。"),
      );
  }, [ready, records, syncedAt, userId]);
  useEffect(() => {
    if (!ready || !cacheEnabled.current || queuedDraft.current === draft) return;
    queuedDraft.current = draft;
    const state = { records, draft, syncedAt };
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        await localMeals.write(userId, state, draftTabId());
        const saved = await localMeals.listDrafts(userId);
        if (current.current.userId === userId)
          setSavedDrafts({ uid: userId, items: saved });
      })
      .catch(() =>
        setNotice("本機空間不足或儲存不可用，草稿未能保留。請先儲存到雲端。"),
      );
  }, [ready, draft, userId, records, syncedAt]);
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
    setPhotoFailure(null);
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
  async function recoverDraft(source: SavedDraftSummary) {
    if (draft && !confirm("開啟另一份草稿？目前草稿會另外保留，可稍後恢復。")) return;
    const scope = operationScope();
    try {
      await writes.current;
      if (!scope.isCurrent()) return;
      const recovered = await localMeals.restoreDraft(scope.id, draftTabId(), source.tabId);
      if (!scope.isCurrent()) return;
      queuedDraft.current = recovered;
      openDraft(recovered);
      const saved = await localMeals.listDrafts(scope.id);
      if (scope.isCurrent()) setSavedDrafts({ uid: scope.id, items: saved });
    } catch {
      if (scope.isCurrent()) setNotice("這份草稿暫時無法讀取，請重試。");
    }
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
        setPhotoFailure(null);
        setNotice(clearPhotoNotice);
        return;
      }
      const id = current.current.draft?.id;
      if (!id) return;
      setDraft((value) =>
        value?.id === id ? { ...value, photo: undefined, photoPath: null } : value,
      );
      setPreparing(true);
      setPhotoFailure(null);
      setNotice(clearPhotoNotice);
      void preparePhoto(file, id, initialProviderMode === "live")
        .then((photo) => {
          if (generation === photoGeneration.current)
            setDraft((value) =>
              value?.id === id
                ? { ...value, photo, photoPath: null, removePhoto: false }
                : value,
            );
        })
        .catch((error) => {
          if (generation === photoGeneration.current) {
            const tooLarge = error instanceof PhotoPreparationError &&
              error.code === "image_dimensions_too_large";
            const rateLimited = error instanceof PhotoPreparationError &&
              error.code === "photo_rate_limited";
            setPhotoFailure(tooLarge ? "too_large" : "retryable");
            setNotice(tooLarge ? oversizedPhotoNotice :
              rateLimited ? photoRateLimitNotice : retryablePhotoNotice);
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
    const noteLength = journalNoteCodePoints(normalizeJournalNote(draft.journalNote ?? "") ?? "");
    if (noteLength > MAX_JOURNAL_NOTE_CODE_POINTS) {
      setNotice("餐點備註最多 " + MAX_JOURNAL_NOTE_CODE_POINTS + " 個字元，請縮短後再儲存。");
      document.querySelector<HTMLTextAreaElement>("#meal-journal-note")?.focus();
      return;
    }
    const invalid = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      ".journal-editor input:invalid, .journal-editor textarea:invalid",
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
    const source = draft;
    try {
      const fingerprint = commandFingerprint(source);
      const pendingMutation =
        source.pendingMutation?.fingerprint === fingerprint
          ? source.pendingMutation
          : { fingerprint, id: crypto.randomUUID() };
      const retained = { ...source, pendingMutation };
      const command = { ...retained, photoPath: null, photo: undefined, calorieInput: undefined };
      setDraft(retained);
      await repository.save(command, pendingMutation.id, id);
      if (!scope.isCurrent()) return;
      if (navigator.onLine) {
        try {
          await repository.sync(id);
        } catch (error) {
          if (scope.isCurrent()) {
            setSyncNotice(errorText(error));
            if (error instanceof TypeError) setOnline(false);
          }
        }
      }
      if (!scope.isCurrent()) return;
      const state = await repository.state(id);
      if (!scope.isCurrent()) return;
      const job = state.jobs.find((pending) => pending.id === pendingMutation.id);
      const proved = !job && state.remote.some((record) =>
        record.id === source.id && record.version > source.version);
      setRecords(visibleMeals(state));
      setPending(state.jobs);
      setSyncedAt(state.syncedAt);
      if (job?.error) {
        setNotice({ kind: "blocked-save", message: blockedSaveText(job.error) });
        await writes.current;
        if (!scope.isCurrent()) return;
        await localMeals.write(id, {
          records: visibleMeals(state),
          draft: retained,
          syncedAt: state.syncedAt,
        }, draftTabId());
        return;
      }
      if (!job && !proved) {
        setNotice("未能確認雲端已保存這餐。草稿仍保留，請再試。");
        return;
      }
      setDraft(null);
      setInitialDraft(undefined);
      setNotice(proved
        ? ""
        : { kind: "pending-sync", message: "已儲存到本機，連線時會自動同步。圖片不會保存到雲端。" });
      go("today");
      await writes.current;
      if (!scope.isCurrent()) return;
      await localMeals.write(id, {
        records: await repository.list(id),
        draft: null,
        syncedAt: null,
      }, draftTabId());
      preparedFile.current = null;
      photoGeneration.current++;
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
    await localMeals.write(userId, { records, draft: null, syncedAt }, draftTabId());
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
        "刪除本機可見的全部餐點及此分頁草稿？連線後會自動同步刪除。其他裝置尚未同步的新增記錄不包含在內。",
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
      // Another tab can have a separate unsaved draft for this account.
      // Clear this tab's copy without silently deleting that other work.
      await localMeals.write(scope.id, {
        records: [], draft: null, syncedAt: null,
      }, draftTabId());
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
        await localMeals.write(scope.id, { records, draft: copy, syncedAt }, draftTabId());
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
          ? r.date === today
          : !filter || r.date === filter),
    )
    .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
  const days = [...new Set(visible.map((record) => record.date))];
  const cloudRecordsUnknown = userId !== "guest" && !syncedAt;
  const blockedSaveNotice = typeof notice === "object" && notice.kind === "blocked-save"
    ? notice.message
    : "";
  const displayedNotice = blockedSaveNotice
    || syncNotice
    || (typeof notice === "string" ? notice : notice.message);
  const visibleSavedDrafts = ready && savedDrafts.uid === userId
    ? savedDrafts.items : [];
  const ownDraftRevision = visibleSavedDrafts.find((saved) =>
    ready && typeof window !== "undefined" && saved.tabId === draftTabId())?.revision;
  const otherDrafts = [...new Map(visibleSavedDrafts
    .filter((saved) => saved.revision !== ownDraftRevision)
    .map((saved) => [saved.revision, saved])).values()];
  const journalNoteLength = draft
    ? journalNoteCodePoints(normalizeJournalNote(draft.journalNote ?? "") ?? "")
    : 0;
  const journalNoteTooLong = journalNoteLength > MAX_JOURNAL_NOTE_CODE_POINTS;
  const todayLabel = journalDateLabel(today);
  const syncTone = !online
    ? "is-offline"
    : ready && syncedAt
      ? "is-synced"
      : "is-syncing";

  return (
    <div className="journal-shell">
      <header className="journal-header">
        <a className="journal-brand" href="#today" aria-label="KcalCue 今日">
          <span className="journal-brand-mark" aria-hidden="true" />
          <span>
            <strong>KcalCue</strong>
            <small>每日飲食小記</small>
          </span>
        </a>
        <button
          className="button button-ghost journal-account-button"
          aria-label="帳戶與安裝"
          disabled={busy}
          onClick={() => {
            setInitialDraft(draft ?? undefined);
            setEditorKey((key) => key + 1);
            setAccount((value) => !value);
          }}
        >
          <UserIcon />
          <span>帳戶</span>
        </button>
      </header>
      <div className={`journal-status ${syncTone}`} role="status">
        <span className="journal-status-dot" aria-hidden="true" />
        <span>
          {online
            ? ready && syncedAt
              ? `已同步 · ${new Date(syncedAt).toLocaleString("zh-HK")}`
              : "連線中 · 尚未同步"
            : "離線中 · 修改會保留，重連後自動同步"}
          {!cloudConfigured() && <span> · 雲端尚未設定</span>}
        </span>
      </div>
      {displayedNotice && (
        <div className="journal-notice" role={blockedSaveNotice ? "alert" : "status"}>
          <span>{displayedNotice}</span>
          {blockedSaveNotice && (
            <button
              className="button button-secondary"
              type="button"
              disabled={!online || syncing || busy}
              onClick={() => void refresh(true)}
            >
              重試儲存
            </button>
          )}
          <button aria-label="關閉訊息" onClick={() => { setNotice(""); setSyncNotice(""); }}>
            ×
          </button>
        </div>
      )}
      {ready && otherDrafts.length > 0 && (
        <section className="journal-card" aria-label="其他未儲存草稿">
          <p>此裝置另有 {otherDrafts.length} 份未儲存草稿。</p>
          {otherDrafts.map((saved) => (
            <div key={saved.revision}>
              <span>{saved.label} · {saved.date} · {new Date(saved.updatedAt).toLocaleString("zh-HK")}</span>{" "}
              <button className="button button-secondary" onClick={() => void recoverDraft(saved)}>
                恢復草稿
              </button>
            </div>
          ))}
        </section>
      )}
      {ready && pending.length > 0 && (
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
        visible={account && ready}
        beforeUpdate={async () => {
          if (busyRef.current) throw new Error("Save in progress");
          const scope = operationScope();
          await writes.current;
          if (!scope.isCurrent()) throw new Error("Account changed during update");
          const active = current.current;
          if (active.draft) {
            // Background cache writes report errors in the UI and settle the
            // queue. A PWA reload must confirm this draft is durable itself.
            await localMeals.write(active.userId, active, draftTabId());
          }
          if (!scope.isCurrent() || current.current.draft !== active.draft)
            throw new Error("Draft changed during update");
          allowUpdateReload.current = true;
        }}
      />
      {account ? (
        <main className="journal-main">
          <h1>帳戶與資料</h1>
          {!ready && <p role="status">正在讀取記錄…</p>}
          {ready && email && !reauth ? (
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
              key={authEpoch}
              suppressStoredEmail={!ready}
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
          <section className="journal-card journal-loading-card">
            <span className="journal-loading-mark" aria-hidden="true"><JournalIcon /></span>
            <div>
              <p className="eyebrow">準備你嘅日誌</p>
              <h1>正在讀取記錄…</h1>
              <p>餐點同草稿會喺準備好之後出現。</p>
            </div>
          </section>
        </main>
      ) : tab === "new" ? (
        <div className="journal-editor">
          {!draft ? (
            <main className="journal-main journal-new-start">
              <section className="journal-card journal-start-hero">
                <FoodStampCluster variant="new" />
                <div className="journal-start-copy">
                  <p className="eyebrow">今日想記低啲咩？</p>
                  <h1>記低新一餐</h1>
                  <p>
                    唔一定要影相。直接記低食物同份量就得；想快啲開始，亦可以用 AI 相片幫你起草。
                  </p>
                </div>
              </section>
              <div className="journal-entry-grid" aria-label="新增餐點方式">
                <button
                  className="journal-entry-card is-primary"
                  aria-label="手動記一餐"
                  onClick={() => start(true)}
                >
                  <span className="journal-entry-icon"><JournalIcon /></span>
                  <span>
                    <strong>手動記一餐</strong>
                    <small>最直接 · 唔需要相片</small>
                  </span>
                </button>
                <button
                  className="journal-entry-card"
                  aria-label="用相片 AI 辨識"
                  onClick={() => start()}
                >
                  <span className="journal-entry-icon"><CameraIcon /></span>
                  <span>
                    <strong>用相片 AI 辨識</strong>
                    <small>先起草，再由你逐項確認</small>
                  </span>
                </button>
              </div>
            </main>
          ) : (
            <>
              <section className="journal-card meal-metadata editor-card">
                <div className="editor-heading">
                  <div>
                    <p className="eyebrow">{draft.version ? "編輯日誌" : "新增日誌"}</p>
                    <h1>{draft.version ? "修正餐點" : "新餐點草稿"}</h1>
                    <p>先記低時間同餐次；食物、份量同營養可以逐項調整。</p>
                  </div>
                  <span className={`editor-mode-chip ${draft.mode === "live" ? "is-ai" : "is-manual"}`}>
                    {draft.mode === "live" ? "AI 起草" : "手動記錄"}
                  </span>
                </div>
                <div className="editor-section-label">
                  <span>時間與餐次</span>
                  <small>按 {draft.timezone} 記錄</small>
                </div>
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
                <p className="editor-card-footnote">
                  {draft.mode === "demo"
                    ? "示範結果不加入每日統計"
                    : "確認後先會加入每日記錄"}
                </p>
              </section>
              <section className="journal-card journal-note-card">
                <div className="journal-note-card-heading">
                  <span className="journal-note-icon" aria-hidden="true"><JournalIcon /></span>
                  <div>
                    <p className="eyebrow">留低少少背景</p>
                    <h2>餐點備註 <small>選填</small></h2>
                  </div>
                </div>
                <div className="journal-note-field">
                  <label className="sr-only" htmlFor="meal-journal-note">餐點備註（選填）</label>
                  <textarea
                    id="meal-journal-note"
                    disabled={busy}
                    rows={4}
                    value={draft.journalNote ?? ""}
                    aria-label="餐點備註（選填）"
                    aria-invalid={journalNoteTooLong || undefined}
                    aria-describedby="meal-journal-note-help meal-journal-note-count"
                    onChange={(e) =>
                      setDraft((value) =>
                        value ? { ...value, journalNote: e.target.value } : value,
                      )
                    }
                    placeholder="例如：同朋友食午餐、雞皮冇食、醬汁另上"
                  />
                  <span className="journal-note-meta">
                    <span id="meal-journal-note-help">
                      備註只作記錄；要改營養數值，請另外修改食物或份量。
                    </span>
                    <span
                      id="meal-journal-note-count"
                      className={journalNoteTooLong ? "is-error" : undefined}
                    >
                      {journalNoteLength}/{MAX_JOURNAL_NOTE_CODE_POINTS}
                    </span>
                  </span>
                  {journalNoteTooLong && (
                    <span className="journal-note-error" role="alert">
                      已超出 {MAX_JOURNAL_NOTE_CODE_POINTS} 個字元，請縮短後再儲存。
                    </span>
                  )}
                </div>
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
                  onNewMeal={() => {
                    if (busyRef.current ||
                        !confirm("放棄這份草稿並開啟另一餐？已儲存的記錄不會改變。"))
                      return;
                    openDraft(newDraft(), true);
                  }}
                />
              </fieldset>
              <section className="journal-card journal-actions">
                {preparing && <p role="status">正在準備壓縮照片…</p>}
                {photoFailure === "retryable" && (
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
                {(draft.photo || draft.photoPath || photoFailure) && (
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
                {draft.mode === "live" ? (
                  <p className="save-review-note" id="save-review-note" role="note">
                    AI 可能認錯或漏掉食物、估錯份量；共用餐點只記自己吃喝的部分，請逐項核對後再儲存。
                  </p>
                ) : null}
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void discard()}
                >
                  放棄修改
                </button>
                <button
                  className="button button-primary"
                  aria-describedby={draft.mode === "live" ? "save-review-note" : undefined}
                  disabled={
                    busy || !draft.items.length || draft.mode === "demo" || journalNoteTooLong
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
        <main className={`journal-main journal-main-${tab}`}>
          <section className={`journal-title journal-hero-card ${tab === "history" ? "is-history" : ""}`}>
            {tab === "today" && <FoodStampCluster variant="today" />}
            <div className="journal-heading-copy">
              <p className="eyebrow">{tab === "today" ? "一餐一餐，慢慢記低" : "翻返你記低過嘅每一餐"}</p>
              <h1>{tab === "today" ? "今日飲食" : "歷史記錄"}</h1>
              <p className="journal-date-line">
                {tab === "today" ? todayLabel : "按日回顧、查看備註，同埋修正已保存嘅餐點。"}
              </p>
            </div>
            <div className="journal-title-actions">
              <button
                className="button button-primary journal-quick-action is-primary"
                aria-label="＋ 手動記餐"
                disabled={busy}
                onClick={() => start(true)}
              >
                <span className="journal-quick-icon"><PlusIcon /></span>
                <span><strong>手動記餐</strong><small>最快記低</small></span>
              </button>
              <button
                className="button button-secondary journal-quick-action"
                aria-label="AI 相片辨識"
                disabled={busy}
                onClick={() => start()}
              >
                <span className="journal-quick-icon"><CameraIcon /></span>
                <span><strong>AI 相片辨識</strong><small>相片起草</small></span>
              </button>
            </div>
          </section>
          {draft && (
            <section className="journal-card draft-banner">
              <span className="draft-banner-icon" aria-hidden="true"><JournalIcon /></span>
              <div>
                <strong>有一份未儲存草稿</strong>
                <small>你可以返去繼續，唔使由頭再記。</small>
              </div>
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
          {cloudRecordsUnknown && !!visible.length && (
            <p className="journal-card" role="status">
              雲端記錄尚未確認；以下只顯示本機已知餐點。
            </p>
          )}
          {tab === "today" && !visible.length && !cloudRecordsUnknown && (
            <div className="day-summary journal-card today-summary is-empty" role="region" aria-label="今日摘要">
              <div><span>今日餐數</span><strong>0</strong><small>餐</small></div>
              <div><span>卡路里</span><strong>未記錄</strong><small>未知不代表零</small></div>
            </div>
          )}
          {!visible.length && (
            <section className="journal-card empty-journal">
              <FoodStampCluster variant="empty" />
              <div className="empty-journal-copy">
                <p className="eyebrow">{cloudRecordsUnknown ? "仲未讀完雲端" : "今日由第一餐開始"}</p>
                <h2>{cloudRecordsUnknown
                  ? tab === "today" ? "尚未確認今日記錄" : "尚未確認歷史記錄"
                  : tab === "today" ? "今日未有記錄" : "未有餐點記錄"}</h2>
                <p>
                  {cloudRecordsUnknown
                    ? "尚未成功讀取雲端餐點，不能確認是否沒有記錄。可先記低一餐，連線後再同步。"
                    : <>
                      {tab === "today" &&
                        records.some((record) => record.mode !== "demo" && record.date < today) &&
                        "之前的餐點可在歷史記錄查看。"}
                      手動記低食物同份量，或者用相片 AI 幫你起草。
                      {!email && "登入後可以跨裝置同步。"}
                    </>}
                </p>
              </div>
              <div className="journal-entry-actions">
                <button
                  className="button button-primary"
                  aria-label="手動記一餐"
                  onClick={() => start(true)}
                >
                  <JournalIcon />
                  手動記一餐
                </button>
                <button
                  className="button button-secondary"
                  aria-label="用相片 AI 辨識"
                  onClick={() => start()}
                >
                  <CameraIcon />
                  用相片 AI 辨識
                </button>
              </div>
            </section>
          )}
          {days.map((date) => {
            const meals = visible.filter((r) => r.date === date);
            const nutrition = dayNutrition(meals);
            const calories = dayCalories(meals);
            const calorieRange = calories.range && (calories.referenceCount
              ? roundRange(calories.range, 5) : calories.range);
            const groups = tab === "today"
              ? Object.entries(mealTypes).map(([mealType, label]) => ({
                key: mealType,
                label,
                records: meals.filter((record) => record.mealType === mealType),
              }))
              : [{ key: "history", label: null, records: meals }];
            const MealNameHeading = tab === "today" ? "h4" : "h3";
            return (
              <section className="journal-day" key={date}>
                <div className="journal-day-heading">
                  <h2>{journalDateLabel(date)}</h2>
                  <span>{date}</span>
                </div>
                <div className={`day-summary journal-card ${tab === "today" ? "today-summary" : "history-summary"}`} role="region" aria-label={tab === "today" ? "今日摘要" : `${date} 摘要`}>
                  <div><span>{tab === "today" ? "今日餐數" : "餐數"}</span><strong>{calories.mealCount}</strong><small>餐</small></div>
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
                {groups.map((group) => (
                  <section className="meal-group" key={group.key} aria-label={group.label ?? undefined}>
                    {group.label && <h3 className="meal-group-title">{group.label}</h3>}
                    {group.records.length === 0 && <p className="meal-group-empty">未有記錄</p>}
                    <div className="meal-list">
                      {group.records.map((record) => (
                        <article className="journal-card meal-row" key={record.id}>
                          <span className="meal-stamp" aria-hidden="true">
                            <FoodStampIcon kind={mealStamp[record.mealType]} />
                          </span>
                          <div className="meal-row-content">
                            <div className="meal-meta-line">
                              <p>{record.time} · {mealTypes[record.mealType]}</p>
                              {tab === "history" && <span className="meal-current-note">已保存</span>}
                            </div>
                            <MealNameHeading>
                              {record.items
                                .map((item) => item.displayName)
                                .join("、")}
                            </MealNameHeading>
                            {!!record.journalNote?.trim() && (
                              <div className="meal-journal-note">
                                <strong>備註</strong>
                                <span>{record.journalNote}</span>
                              </div>
                            )}
                            <p className="meal-calories">{mealCalorieLabel(record)}</p>
                            {tab === "history" && userId !== "guest" && record.photoRef && (
                              <PrivateMealPhoto
                                key={`${userId}:${authEpoch}:${record.id}:${record.photoRef.attachmentId}:${record.photoRef.generation}`}
                                mealId={record.id}
                                photoRef={record.photoRef}
                                expectedUid={userId}
                              />
                            )}
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
                ))}
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
            className={key === "new" ? "journal-nav-add" : undefined}
            aria-label={label}
            disabled={busy}
            aria-current={!account && tab === key ? "page" : undefined}
            onClick={() => {
              if (key === "new") start(true);
              else go(key);
            }}
          >
            <span className="journal-nav-icon" aria-hidden="true">
              {key === "today" ? <HomeIcon /> : key === "new" ? <PlusIcon /> : <HistoryIcon />}
            </span>
            <span className="journal-nav-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
