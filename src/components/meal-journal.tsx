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
import { clearOrphanedPhotoOutbox, clearSyncState, visibleMeals, type PendingMeal } from "@/lib/meals/outbox";
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
import { copy as zhCopy, unitCopy } from "@/content/zh-HK";
import { foodAnalysisSchema } from "@/lib/domain/food-analysis";
import { assignEntrySource } from "@/lib/domain/editable-meal";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
import { roundRange } from "@/lib/nutrition/calculation";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { NutritionService } from "@/lib/nutrition/service";
import { KcalCueApp } from "./kcalcue-app";
import { PwaControls } from "./pwa-controls";
import { CalorieCorrectionInput } from "./calorie-correction-input";
import { PrivateMealPhoto } from "./private-meal-photo";
import { dayCalories, mealCalories, sameCalorieBasis, type MealCalorieSummary } from "@/lib/meals/calories";
import { MAX_JOURNAL_NOTE_CODE_POINTS, journalNoteCodePoints, normalizeJournalNote } from "@/lib/meals/journal-note";
import { CameraIcon, CloseIcon, HistoryIcon, HomeIcon, JournalIcon, PlusIcon, UserIcon } from "./icons";
import { RangeRail } from "./range-rail";
import { ConfirmDialog, type ConfirmRequest } from "./confirm-dialog";

const repository = new MealRepository();
const messages: Record<string, string> = {
  login_required: "登入已過期，請重新登入。待同步修改仍保留，登入後自動重試。",
  conflict:
    "這餐已在另一個裝置修改或刪除。你的修改仍保留；可保留為新餐點草稿，或放棄待同步修改。",
  snapshot_changed: "雲端餐點清單剛有更新，請再試同步；本機紀錄仍保留。",
  invalid_request: "請檢查食物名稱、份量及日期時間。每餐最多 12 項食物。",
  unsupported_schema: "這筆餐點的資料格式暫未支援，修改仍保留於本機。",
  photo_failed: "照片未能處理，可再試一次，或移除草稿圖片。",
  photo_uploads_disabled: "私人照片保存功能目前未啟用，可不附圖儲存餐點。",
  photo_quota_not_configured: "私人照片保存尚未設定上限，可不附圖儲存餐點。",
  photo_quota_exceeded: "照片保存空間暫達上限，可稍後重試或不附圖儲存餐點。",
  photo_output_too_large: "壓縮後照片仍超過 2 MiB 上限，請更換圖片或不附圖儲存餐點。",
  photo_not_staged: "此附圖的暫存期限已過，可重新上傳附圖或不附圖儲存餐點。",
  photo_upload_expired: "此草稿圖片的上傳期限已過，請重新選取圖片或不附圖儲存餐點。",
  photo_upload_conflict: "圖片上傳識別衝突，請移除草稿圖片重新選取，或不附圖儲存餐點。",
  photo_object_conflict: "雲端圖片檢查不一致，請重新選取圖片或不附圖儲存餐點。",
  photo_payload_missing: "本機暫存圖片已遺失，請重新選取圖片或不附圖儲存餐點。",
  photo_storage_unavailable: "照片儲存暫時不可用，修改及圖片仍保留於本機，稍後自動重試。",
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
  | { kind: "pending-sync" | "blocked-save" | "pending-logout"; message: string };
function commandFingerprint(draft: MealDraft) {
  const next = {
    ...draft,
    photoPath: null,
    photo: undefined,
    calorieInput: undefined,
    savePhoto: Boolean(draft.savePhoto),
    removePhoto: Boolean(draft.removePhoto),
    photoSignature: draft.photo ? `${draft.photo.size}:${draft.photo.type}` : null,
  };
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
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
function stripDerivedItemFields(item: MealDraft["items"][number]) {
  const rest = { ...item };
  delete rest.nutritionMatch;
  return rest;
}
function persistedMealFingerprint(meal: MealDraft): string {
  const analysis = meal.analysis ?? null;
  const items = assignEntrySource(meal.items, analysis).map(stripDerivedItemFields);
  const originalItems = (
    meal.originalItems?.length
      ? meal.originalItems
      : analysis
        ? assignEntrySource(meal.items, analysis)
        : []
  ).map(stripDerivedItemFields);
  return stableJson({
    id: meal.id,
    version: meal.version,
    mode: meal.mode,
    date: meal.date,
    time: meal.time,
    timezone: meal.timezone,
    mealType: meal.mealType,
    analysis,
    analysisProvenance: analysis
      ? readAnalysisProvenance(meal.analysisProvenance, meal.mode)
      : null,
    calorieCorrection: meal.calorieCorrection ?? null,
    journalNote: normalizeJournalNote(meal.journalNote ?? ""),
    items,
    originalItems,
  });
}
function isUntouchedSavedMeal(
  candidate: MealDraft | null,
  baseline: string | null,
): boolean {
  if (!candidate || candidate.version === 0 || !baseline) return false;
  if (
    candidate.photo ||
    candidate.savePhoto ||
    candidate.removePhoto ||
    candidate.pendingMutation ||
    candidate.calorieInput !== undefined
  ) {
    return false;
  }
  return persistedMealFingerprint(candidate) === baseline;
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
async function clearOrphanedPhotoOutboxLocked(uid: string) {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    await navigator.locks.request(`kcalcue-sync-${uid}`, () =>
      navigator.locks.request(`kcalcue-account-${uid}`, () =>
        clearOrphanedPhotoOutbox(uid),
      ),
    );
    return;
  }
  await clearOrphanedPhotoOutbox(uid);
}

function mealCalorieLabel(calories: MealCalorieSummary) {
  if (calories.coverage === "insufficient") return "整餐卡路里未知；詳情可查看已知食物估算";
  if (!calories.range) return "卡路里未知";
  if (calories.source === "user") return `手動記錄：${calories.range.min} kcal`;
  const range = roundRange(calories.range, 5);
  return `${calories.coverage === "complete" ? "估算" : "已知部分"}：約 ${range.min}–${range.max} kcal`;
}

interface MealPlacard {
  name: string;
  state: "known" | "unknown" | "plain";
  kcal: string | null;
}

interface MealView {
  placards: MealPlacard[];
  calorieLabel: string;
  calorieKnown: boolean;
}

let placardService: NutritionService | null = null;
const mealViewCache = new WeakMap<MealRecord, MealView>();

function mealView(record: MealRecord): MealView {
  const cached = mealViewCache.get(record);
  if (cached) return cached;
  const calories = mealCalories(record);
  // A whole-meal user kcal replaces the reference estimate; per-item reference
  // ranges beside it would read as a competing total, so those placards show names only.
  const userTotal = calories.source === "user";
  placardService ??= new NutritionService(new LocalNutritionProvider());
  const foods = userTotal ? [] : placardService.calculateMeal(record.items).foods;
  const placards = record.items.map((item, index): MealPlacard => {
    const food = foods[index];
    const range = food?.includedInTotal && food.ranges ? roundRange(food.ranges.calories, 5) : null;
    return {
      name: item.displayName.trim() || zhCopy.emptyName,
      state: userTotal ? "plain" : range ? "known" : "unknown",
      kcal: range ? `約 ${range.min}–${range.max} kcal` : null,
    };
  });
  const view = { placards, calorieLabel: mealCalorieLabel(calories), calorieKnown: Boolean(calories.range) };
  mealViewCache.set(record, view);
  return view;
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
  initialPhotoUploadsEnabled = false,
}: {
  initialProviderMode: "demo" | "live";
  initialPhotoUploadsEnabled?: boolean;
}) {
  const [photoUploadsEnabled, setPhotoUploadsEnabled] = useState(initialPhotoUploadsEnabled);
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
  const [nutritionPending, setNutritionPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [photoFailure, setPhotoFailure] = useState<null | "retryable" | "too_large">(null);
  const [conflict, setConflict] = useState(false);
  const [savedDraftBaseline, setSavedDraftBaseline] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmResolver = useRef<((accepted: boolean) => void) | null>(null);
  const finishConfirm = useCallback((accepted: boolean) => {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setConfirmRequest(null);
    resolve?.(accepted);
  }, []);
  const askConfirm = useCallback((request: ConfirmRequest): Promise<boolean> => {
    confirmResolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve;
      setConfirmRequest(request);
    });
  }, []);
  const [pending, setPending] = useState<PendingMeal[]>([]);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const refreshRequested = useRef(false);
  const retryRequested = useRef(false);
  const accountGeneration = useRef(0);
  const pendingRef = useRef(0);
  const syncErrorRef = useRef(false);
  const lastAttempt = useRef(0);
  const statusProbeGeneration = useRef(0);
  const statusProbeController = useRef<AbortController | null>(null);
  const cancelStatusProbe = useCallback(() => {
    statusProbeGeneration.current++;
    statusProbeController.current?.abort();
    statusProbeController.current = null;
  }, []);
  useEffect(() => {
    pendingRef.current = pending.filter((job) => !job.error).length;
  }, [pending]);
  useEffect(() => {
    syncErrorRef.current = Boolean(syncNotice);
  }, [syncNotice]);
  const current = useRef({ userId, draft, records, syncedAt, savedDraftBaseline });
  useEffect(() => {
    current.current = { userId, draft, records, syncedAt, savedDraftBaseline };
  }, [userId, draft, records, syncedAt, savedDraftBaseline]);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const queuedDraft = useRef<MealDraft | null>(null);
  const cacheEnabled = useRef(true);
  const preparedFile = useRef<File | null>(null);
  const preparingRef = useRef(false);
  const photoGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const busyRef = useRef(false);
  const allowUpdateReload = useRef(false);
  useEffect(() => {
    allowUpdateReload.current = false;
  }, [draft]);

  const refresh = useCallback(async function refreshMeals(retry = false) {
    const id = current.current.userId;
    if (id === "guest") return;
    retryRequested.current ||= retry;
    if (syncingRef.current || busyRef.current) {
      refreshRequested.current = true;
      return;
    }
    const generation = ++refreshGeneration.current;
    const accountVersion = accountGeneration.current;
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
        if (isCurrent() && navigator.onLine) {
          cancelStatusProbe();
          setOnline(true);
          setSyncNotice("");
        }
      }
    } catch (error) {
      if (isCurrent()) {
        setSyncNotice(errorText(error));
        if (error instanceof TypeError) {
          cancelStatusProbe();
          setOnline(false);
        }
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
            setSavedDraftBaseline(null);
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
            if (value.kind === "pending-logout") {
              return state.jobs.length === 0 ? "" : value;
            }
            if (state.jobs.length === 0) return "";
            if (state.jobs.length === 1 && state.jobs[0].photoUpload) {
              return { kind: "pending-sync", message: "已保留本機；餐點及附圖待同步。" };
            }
            return pendingSyncNotice(state.jobs.length);
          });
          const saved = await localMeals.listDrafts(id).catch(() => null);
          if (isCurrent() && saved) setSavedDrafts({ uid: id, items: saved });
        }
      } catch {
        if (isCurrent()) setSyncNotice("本機儲存不可用，請勿關閉頁面。");
      }
      lastAttempt.current = Date.now();
      syncingRef.current = false;
      setSyncing(false);
      if (refreshRequested.current && !busyRef.current) void refreshMeals();
    }
  }, [cancelStatusProbe]);

  useEffect(() => {
    let active = true;
    const accountEpoch = accountGeneration;
    const refreshEpoch = refreshGeneration;
    let loadGeneration = 0;
    let loading = false;
    function clearVolatilePhoto() {
      photoGeneration.current++;
      preparedFile.current = null;
      preparingRef.current = false;
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
      const initialLoggedOutUid = localStorage.getItem("kcalcue-logout")?.split(":")[0];
      if (oldId !== "guest" && oldId !== id) {
        cacheEnabled.current = false;
        await writes.current;
        // Account changes preserve unsynced work; explicit logout clears local data.
        const currentLoggedOutUid = localStorage.getItem("kcalcue-logout")?.split(":")[0];
        if (currentLoggedOutUid === oldId) {
          await localMeals.clear(oldId);
          await clearOrphanedPhotoOutboxLocked(oldId);
        }
      }
      const latestLoggedOutUid = localStorage.getItem("kcalcue-logout")?.split(":")[0] ?? initialLoggedOutUid;
      if (latestLoggedOutUid && latestLoggedOutUid !== "guest" && latestLoggedOutUid !== oldId && latestLoggedOutUid !== id) {
        await clearOrphanedPhotoOutboxLocked(latestLoggedOutUid).catch(() => {});
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
      current.current = {
        userId: id,
        ...local,
        records: visibleRecords,
        syncedAt: knownSyncedAt,
        savedDraftBaseline: null,
      };
      cacheEnabled.current = true;
      setUserId(id);
      setEmail(address);
      setRecords(visibleRecords);
      setDraft(local.draft);
      setSavedDraftBaseline(null);
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
          if (nextId !== current.current.userId) finishConfirm(false);
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
    const probeStatus = () => {
      const probeId = statusProbeGeneration.current;
      const controller = new AbortController();
      statusProbeController.current = controller;
      const timeout = setTimeout(() => controller.abort(), 5_000);
      void fetch("/api/status", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!active || statusProbeGeneration.current !== probeId) return;
          setOnline(response.ok);
          if (response.ok) {
            const payload = await response.json().catch(() => null);
            if (
              active &&
              statusProbeGeneration.current === probeId &&
              typeof payload?.photoUploadsEnabled === "boolean"
            ) {
              setPhotoUploadsEnabled(payload.photoUploadsEnabled);
            }
          }
        })
        .catch(() => {
          if (active && statusProbeGeneration.current === probeId)
            setOnline(false);
        })
        .finally(() => {
          clearTimeout(timeout);
          if (statusProbeController.current === controller)
            statusProbeController.current = null;
        });
    };
    const connection = () => {
      lastAttempt.current = Date.now();
      cancelStatusProbe();
      setOnline(navigator.onLine);
      if (navigator.onLine) {
        probeStatus();
        void refresh();
      }
    };
    if (navigator.onLine) probeStatus();
    const foreground = () => {
      if (document.visibilityState === "visible") {
        setToday(localDate());
        connection();
      }
    };
    const signedOutElsewhere = (event: StorageEvent) => {
      if (event.key !== "kcalcue-logout") return;
      const loggedOut = event.newValue?.split(":")[0];
      if (!loggedOut || loggedOut === "guest") return;
      if (loggedOut !== current.current.userId) {
        void clearOrphanedPhotoOutboxLocked(loggedOut).catch(() => {});
        return;
      }
      const old = current.current.userId;
      accountGeneration.current++;
      cacheEnabled.current = false;
      refreshGeneration.current++;
      finishConfirm(false);
      clearVolatilePhoto();
      current.current = {
        userId: "guest",
        draft: null,
        records: [],
        syncedAt: null,
        savedDraftBaseline: null,
      };
      setReady(false);
      setEmail(null);
      setDraft(null);
      setSavedDraftBaseline(null);
      setSavedDrafts({ uid: "guest", items: [] });
      setInitialDraft(undefined);
      setRecords([]);
      setUserId("guest");
      setTab("today");
      loadGeneration++;
      void writes.current
        .then(() => localMeals.clear(old))
        .then(() => clearOrphanedPhotoOutboxLocked(old))
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
      } else if (isUntouchedSavedMeal(current.current.draft, current.current.savedDraftBaseline)) {
        setDraft(null);
        setSavedDraftBaseline(null);
        setInitialDraft(undefined);
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
        !syncingRef.current &&
        !busyRef.current &&
        Date.now() - lastAttempt.current >=
          (pendingRef.current || syncErrorRef.current ? 5_000 : 30_000)
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
      cancelStatusProbe();
      finishConfirm(false);
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
  }, [refresh, cancelStatusProbe, finishConfirm]);

  const activeUnsavedDraft = draft && !isUntouchedSavedMeal(draft, savedDraftBaseline) ? draft : null;

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
    if (!ready || !cacheEnabled.current || queuedDraft.current === activeUnsavedDraft) return;
    queuedDraft.current = activeUnsavedDraft;
    const state = { records, draft: activeUnsavedDraft, syncedAt };
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
  }, [ready, activeUnsavedDraft, userId, records, syncedAt]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (
        current.current.draft &&
        !isUntouchedSavedMeal(current.current.draft, current.current.savedDraftBaseline) &&
        !allowUpdateReload.current
      ) {
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
    if (next !== "new" && isUntouchedSavedMeal(current.current.draft, current.current.savedDraftBaseline)) {
      setDraft(null);
      setSavedDraftBaseline(null);
      setInitialDraft(undefined);
    }
    window.history.pushState(null, "", `#${next}`);
    setTab(next);
    setAccount(false);
  }
  function openDraft(next: MealDraft, isManual = false, savedBaseline: string | null = null) {
    photoGeneration.current++;
    preparedFile.current = null;
    preparingRef.current = false;
    setPreparing(false);
    setPhotoFailure(null);
    setDraft(next);
    setSavedDraftBaseline(savedBaseline);
    setInitialDraft(next);
    setManual(isManual);
    setEditorKey((key) => key + 1);
    setConflict(false);
    go("new");
  }
  function start(isManual = false) {
    if (activeUnsavedDraft) {
      openDraft(activeUnsavedDraft, !activeUnsavedDraft.items.length && isManual);
      return;
    }
    openDraft(newDraft(), isManual);
  }
  async function recoverDraft(source: SavedDraftSummary) {
    const scope = operationScope();
    if (activeUnsavedDraft) {
      const confirmed = await askConfirm({
        title: "開啟另一份草稿",
        message: "開啟另一份草稿？目前草稿會另外保留，可稍後恢復。",
        confirmLabel: "開啟草稿",
      });
      if (!confirmed || !scope.isCurrent()) return;
    }
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
    (file: File | null, options?: { autoOptIn?: boolean }) => {
      const generation = ++photoGeneration.current;
      preparedFile.current = file;
      if (!file) {
        setDraft((value) =>
          value
            ? { ...value, photo: undefined, photoPath: null, savePhoto: false, removePhoto: true }
            : value,
        );
        preparingRef.current = false;
        setPreparing(false);
        setPhotoFailure(null);
        setNotice(clearPhotoNotice);
        return;
      }
      const id = current.current.draft?.id;
      if (!id) return;
      setDraft((value) =>
        value?.id === id ? { ...value, photo: undefined, photoPath: null, savePhoto: false } : value,
      );
      preparingRef.current = true;
      setPreparing(true);
      setPhotoFailure(null);
      setNotice(clearPhotoNotice);
      void preparePhoto(file, id, initialProviderMode === "live" || photoUploadsEnabled)
        .then((photo) => {
          if (generation === photoGeneration.current)
            setDraft((value) =>
              value?.id === id
                ? {
                    ...value,
                    photo,
                    photoPath: null,
                    removePhoto: false,
                    ...(options?.autoOptIn ? { savePhoto: true } : {}),
                  }
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
          if (generation === photoGeneration.current) {
            preparingRef.current = false;
            setPreparing(false);
          }
        });
    },
    [initialProviderMode, photoUploadsEnabled],
  );

  async function save() {
    if (!draft || busyRef.current || preparingRef.current || preparing) return;
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
      const wantsPhotoUpload = Boolean(
        photoUploadsEnabled && source.savePhoto && source.photo && source.mode !== "demo",
      );
      const wantsRemovePhoto = Boolean(
        !wantsPhotoUpload && source.removePhoto && source.photoRef,
      );
      const fingerprint = commandFingerprint(source);
      const pendingMutation =
        source.pendingMutation?.fingerprint === fingerprint &&
        (!wantsPhotoUpload || Boolean(source.pendingMutation.uploadId))
          ? source.pendingMutation
          : {
              fingerprint,
              id: crypto.randomUUID(),
              ...(wantsPhotoUpload ? { uploadId: crypto.randomUUID() } : {}),
            };
      const retained = { ...source, pendingMutation };
      const command = {
        ...retained,
        photoPath: null,
        photo: undefined,
        savePhoto: undefined,
        removePhoto: undefined,
        calorieInput: undefined,
      };
      setDraft(retained);
      if (wantsPhotoUpload && source.photo && pendingMutation.uploadId) {
        await repository.saveWithPhoto(
          { ...command, photo: source.photo },
          pendingMutation.id,
          pendingMutation.uploadId,
          id,
        );
      } else {
        await repository.save(
          command,
          pendingMutation.id,
          id,
          undefined,
          wantsRemovePhoto ? { removePhoto: true } : undefined,
        );
      }
      if (!scope.isCurrent()) return;
      if (navigator.onLine) {
        try {
          await repository.sync(id);
          if (scope.isCurrent() && navigator.onLine) {
            cancelStatusProbe();
            setOnline(true);
            setSyncNotice("");
          }
        } catch (error) {
          if (scope.isCurrent()) {
            setSyncNotice(errorText(error));
            if (error instanceof TypeError) {
              cancelStatusProbe();
              setOnline(false);
            }
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
      setSavedDraftBaseline(null);
      setInitialDraft(undefined);
      setNotice(
        proved
          ? ""
          : wantsPhotoUpload
            ? { kind: "pending-sync", message: "已保留本機；餐點及附圖待同步。" }
            : { kind: "pending-sync", message: "已儲存到本機，連線時會自動同步。圖片不會保存到雲端。" },
      );
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
    const scope = operationScope();
    if (activeUnsavedDraft && activeUnsavedDraft.id !== record.id) {
      const confirmed = await askConfirm({
        title: "放棄目前草稿",
        message: "已有另一份草稿。放棄它並開啟這餐？",
        confirmLabel: "放棄並開啟",
        destructive: true,
      });
      if (!confirmed || !scope.isCurrent()) return;
    }
    const opened: MealDraft = { ...record, photoPath: null };
    openDraft(opened, false, record.version > 0 ? persistedMealFingerprint(opened) : null);
  }
  async function discard() {
    const scope = operationScope();
    if (activeUnsavedDraft) {
      const confirmed = await askConfirm({
        title: "放棄草稿",
        message: "放棄這份草稿？已儲存的記錄不會改變。",
        confirmLabel: "確認放棄",
        destructive: true,
      });
      if (!confirmed || !scope.isCurrent()) return;
    }
    photoGeneration.current++;
    preparedFile.current = null;
    preparingRef.current = false;
    setPreparing(false);
    setDraft(null);
    setSavedDraftBaseline(null);
    setInitialDraft(undefined);
    await writes.current;
    if (!scope.isCurrent()) return;
    await localMeals.write(
      scope.id,
      { records: current.current.records, draft: null, syncedAt: current.current.syncedAt },
      draftTabId(),
    );
    if (!scope.isCurrent()) return;
    go("today");
  }
  async function remove(record: MealRecord) {
    const scope = operationScope();
    await repository.delete(record);
    if (!scope.isCurrent()) return;
    setNotice({ kind: "pending-sync", message: "刪除已保留於本機，連線時自動同步。" });
    void refresh();
    setRecords((value) => value.filter((r) => r.id !== record.id));
    if (current.current.draft?.id === record.id) {
      setDraft(null);
      setSavedDraftBaseline(null);
    }
  }
  async function deleting(record: MealRecord) {
    if (busyRef.current) return;
    const scope = operationScope();
    const confirmed = await askConfirm({
      title: "刪除餐點",
      message: "刪除這餐？連線後會同步刪除。",
      confirmLabel: "確認刪除",
      destructive: true,
    });
    if (!confirmed || busyRef.current || !scope.isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
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
    if (busyRef.current) return;
    const scope = operationScope();
    const confirmed = await askConfirm({
      title: "清除全部記錄",
      message:
        "刪除本機可見的全部餐點及此分頁草稿？連線後會自動同步刪除。其他裝置尚未同步的新增記錄不包含在內。",
      confirmLabel: "確認清除",
      destructive: true,
    });
    if (!confirmed || busyRef.current || !scope.isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    try {
      for (const record of await repository.list(scope.id)) {
        if (!scope.isCurrent()) return;
        await remove(record);
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
      setSavedDraftBaseline(null);
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
    if (busyRef.current) return;
    const scope = operationScope();
    if (activeUnsavedDraft) {
      const confirmed = await askConfirm({
        title: "確認登出",
        message: "登出會清除這個帳戶的本機草稿、照片及快取。仍要登出？",
        confirmLabel: "確認登出",
        destructive: true,
      });
      if (!confirmed || busyRef.current || !scope.isCurrent()) return;
    }
    if ((await repository.state(scope.id)).jobs.length) {
      if (!scope.isCurrent()) return;
      setNotice({
        kind: "pending-logout",
        message: "仍有待同步或衝突的修改。請先連線完成同步或處理衝突，再登出。",
      });
      return;
    }
    if (busyRef.current || !scope.isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    cacheEnabled.current = false;
    refreshGeneration.current++;
    photoGeneration.current++;
    try {
      await navigator.locks.request(`kcalcue-sync-${scope.id}`, () =>
        navigator.locks.request(`kcalcue-account-${scope.id}`, async () => {
          if (!scope.isCurrent()) throw new Error("account_changed");
          if ((await repository.state(scope.id)).jobs.length)
            throw new Error("pending_sync");
          await writes.current;
          if (!scope.isCurrent()) throw new Error("account_changed");
          await localMeals.clear(scope.id);
          await clearSyncState(scope.id);
          if (!scope.isCurrent()) throw new Error("account_changed");
          setDraft(null);
          setSavedDraftBaseline(null);
          setRecords([]);
          current.current = { ...current.current, draft: null, records: [], savedDraftBaseline: null };
          localStorage.setItem("kcalcue-logout", `${scope.id}:${Date.now()}`);
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
      const record = next.find((r) => r.id === current.current.draft?.id);
      if (!record) {
        setNotice("這餐已被刪除。你可保留目前草稿，或放棄它。");
        return;
      }
      const confirmed = await askConfirm({
        title: "載入最新記錄",
        message: "載入最新記錄會取代目前的未儲存修改，是否繼續？",
        confirmLabel: "確認載入",
        destructive: true,
      });
      if (!confirmed || !scope.isCurrent()) return;
      const opened: MealDraft = { ...record, photoPath: null };
      openDraft(opened, false, record.version > 0 ? persistedMealFingerprint(opened) : null);
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    }
  }

  async function resolvePending(job: PendingMeal, preserve: boolean) {
    if (busyRef.current) return;
    const scope = operationScope();
    if (job.record.userId !== scope.id) return;
    const last = [...pending].reverse().find((other) => other.record.id === job.record.id)!;
    if (preserve) {
      if (activeUnsavedDraft) {
        const confirmed = await askConfirm({
          title: "取代目前草稿",
          message: "取代目前草稿並將這份修改保留為新餐點？",
          confirmLabel: "確認取代",
          destructive: true,
        });
        if (!confirmed || busyRef.current || !scope.isCurrent()) return;
      }
    } else {
      const confirmed = await askConfirm({
        title: "放棄待同步修改",
        message: "放棄這餐尚未同步的修改／刪除，使用雲端版本？",
        confirmLabel: "確認放棄",
        destructive: true,
      });
      if (!confirmed || busyRef.current || !scope.isCurrent()) return;
    }
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
        photoRef: undefined,
        photoPath: null,
        savePhoto: undefined,
        removePhoto: undefined,
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
      if (preserve) {
        openDraft(copy);
        if (last.record.photoRef || last.photoUpload) {
          setNotice("已保留為新餐點草稿。原有附圖不會轉移至新餐，如需附圖請重新選取。");
        }
      }
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refresh();
    }
  }
  async function saveWithoutPhoto(job: PendingMeal) {
    if (busyRef.current) return;
    const scope = operationScope();
    if (job.record.userId !== scope.id) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    try {
      await repository.saveQueuedWithoutPhoto(job.record.id, job.id, scope.id);
      if (!scope.isCurrent()) return;
      setNotice({ kind: "pending-sync", message: "已改為不附圖儲存餐點，待同步。" });
    } catch (error) {
      if (scope.isCurrent()) setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
      void refresh();
    }
  }
  async function retryExpiredPhoto(job: PendingMeal) {
    if (busyRef.current) return;
    const scope = operationScope();
    if (job.record.userId !== scope.id) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    try {
      const result = await repository.requeueExpiredPhotoUpload(job.record.id, job.id, scope.id);
      if (!scope.isCurrent()) return;
      setNotice(
        result
          ? { kind: "pending-sync", message: "已排程重新上傳附圖，待同步。" }
          : "",
      );
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
  const entryActions = (
    <div className="journal-title-actions">
      <button
        className="button button-primary journal-quick-action is-primary"
        aria-label="AI 相片辨識"
        disabled={busy}
        onClick={() => start()}
      >
        <span className="journal-quick-icon"><CameraIcon /></span>
        <span><strong>AI 相片辨識</strong><small>相片起草</small></span>
      </button>
      <button
        className="button button-secondary journal-quick-action"
        aria-label="＋ 手動記餐"
        disabled={busy}
        onClick={() => start(true)}
      >
        <span className="journal-quick-icon"><PlusIcon /></span>
        <span><strong>手動記餐</strong><small>最快記低</small></span>
      </button>
    </div>
  );

  return (
    <>
    <div
      className="journal-shell"
      inert={Boolean(confirmRequest)}
      aria-hidden={confirmRequest ? true : undefined}
    >
      <header className="journal-header">
        <a className="journal-brand" href="#today" aria-label="KcalCue 今日">
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
          <button className="journal-notice-close" aria-label="關閉訊息" onClick={() => { setNotice(""); setSyncNotice(""); }}>
            <CloseIcon />
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
                  {job.photoUpload ? "（含待同步附圖）" : ""}
                  ：{messages[job.error!] ?? "同步未完成，修改仍保留於本機。"}
                </p>
                {job.kind === "save" && job.photoUpload?.status === "staged" && job.error === "photo_not_staged" && (
                  <button
                    className="button button-secondary"
                    disabled={busy || syncing}
                    onClick={() => void retryExpiredPhoto(job)}
                  >
                    重新上傳附圖
                  </button>
                )}
                {job.kind === "save" && job.photoUpload && (
                  job.photoUpload.status === "pending" ||
                  (job.photoUpload.status === "staged" && job.error === "photo_not_staged")
                ) && (
                  <button
                    className="button button-secondary"
                    disabled={busy || syncing}
                    onClick={() => void saveWithoutPhoto(job)}
                  >
                    不附圖儲存餐點
                  </button>
                )}
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
          if (active.draft && !isUntouchedSavedMeal(active.draft, active.savedDraftBaseline)) {
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
            {photoUploadsEnabled ? (
              <p>
                Live 分析會將相片傳送至 AI 服務作食物辨識。只有在你明確勾選「儲存餐點縮圖供歷史查看」並儲存後，系統才會將單張壓縮縮圖（最長邊
                1600px JPEG、移除 EXIF 與 GPS 位置資料）私密保存於你的帳戶供日後查看；你可隨時移除附圖或刪除餐點，刪除後雲端會立即封鎖存取並於背景完成實體清理（可能會有短暫延遲）。AI
                分析與雲端保存均需要連線。
              </p>
            ) : (
              <p>
                Live 分析會將相片傳送至 AI 服務。圖片只用於分析請求，不會存入
                Firebase
                Storage；雲端只保存餐點及營養分析結果。本機草稿可暫存壓縮圖片，儲存或放棄草稿後清除。AI
                分析需要連線。
              </p>
            )}
          </section>
        </main>
      ) : !ready ? (
        <main className="journal-main" aria-busy="true">
          <section className="journal-card journal-loading-card">
            <span className="journal-loading-mark" aria-hidden="true"><JournalIcon /></span>
            <div>
              <h1>正在讀取記錄…</h1>
              <p className="subhead">準備你嘅日誌</p>
              <p>餐點同草稿會喺準備好之後出現。</p>
            </div>
          </section>
        </main>
      ) : tab === "new" ? (
        <div className="journal-editor">
          {!draft ? (
            <main className="journal-main journal-new-start">
              <section className="journal-start-hero">
                <div className="journal-start-copy">
                  <h1>記低新一餐</h1>
                  <p className="subhead">今日想記低啲咩？</p>
                  <p>
                    唔一定要影相。直接記低食物同份量就得；想快啲開始，亦可以用 AI 相片幫你起草。
                  </p>
                </div>
              </section>
              <div className="journal-entry-grid" aria-label="新增餐點方式">
                <button
                  className="journal-entry-card is-primary"
                  aria-label="用相片 AI 辨識"
                  onClick={() => start()}
                >
                  <span className="journal-entry-icon"><CameraIcon /></span>
                  <span>
                    <strong>用相片 AI 辨識</strong>
                    <small>先起草，再由你逐項確認</small>
                  </span>
                </button>
                <button
                  className="journal-entry-card"
                  aria-label="手動記一餐"
                  onClick={() => start(true)}
                >
                  <span className="journal-entry-icon"><JournalIcon /></span>
                  <span>
                    <strong>手動記一餐</strong>
                    <small>最直接 · 唔需要相片</small>
                  </span>
                </button>
              </div>
            </main>
          ) : (
            <>
              <section className="editor-heading">
                <div>
                  <h1>{draft.version ? "修正餐點" : "新餐點草稿"}</h1>
                  <p className="subhead">{draft.version ? "編輯日誌" : "新增日誌"}</p>
                </div>
                <span className={`editor-mode-chip ${draft.mode === "live" ? "is-ai" : "is-manual"}`}>
                  {draft.mode === "live" ? "AI 起草" : "手動記錄"}
                </span>
              </section>
              <fieldset className="editor-fields" disabled={busy}>
                <KcalCueApp
                  key={editorKey}
                  initialProviderMode={initialProviderMode}
                  initialDraft={initialDraft ?? draft}
                  calorieCorrection={draft.calorieCorrection}
                  mealNote={draft.journalNote}
                  manual={manual}
                  onDraftChange={onDraftChange}
                  onNutritionPendingChange={setNutritionPending}
                  onPhotoSelected={onPhotoSelected}
                  onExit={() => {
                    void discard();
                  }}
                  onNewMeal={() => {
                    if (busyRef.current) return;
                    const scope = operationScope();
                    void askConfirm({
                      title: "記另一餐",
                      message: "放棄這份草稿並開啟另一餐？已儲存的記錄不會改變。",
                      confirmLabel: "確認開啟",
                      destructive: true,
                    }).then((confirmed) => {
                      if (!confirmed || busyRef.current || !scope.isCurrent()) return;
                      openDraft(newDraft(), true);
                    });
                  }}
                />
              </fieldset>
              <section className="journal-card meal-metadata editor-card">
                <p className="editor-intro">先記低時間同餐次；食物、份量同營養可以逐項調整。</p>
                <div className="editor-section-label">
                  <span>時間與餐次</span>
                  <small>按 {draft.timezone} 記錄</small>
                </div>
                <div className="metadata-grid">
                  <label className="metadata-date">
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
              {draft.items.length > 0 && draft.mode !== "demo" && (
                <CalorieCorrectionInput
                  correction={draft.calorieCorrection}
                  input={draft.calorieInput}
                  disabled={busy}
                  onChange={(change) => setDraft((value) => value ? { ...value, ...change } : value)}
                />
              )}
              <section className="journal-card journal-note-card">
                <div className="journal-note-card-heading">
                  <span className="journal-note-icon" aria-hidden="true"><JournalIcon /></span>
                  <div>
                    <h2>餐點備註 <small>選填</small></h2>
                    <p className="subhead">留低少少背景</p>
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
                      備註主要作記錄。若寫明飲品是燕麥奶、豆漿或杏仁奶，該項不會當成乳製奶。
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
              <section className="journal-card journal-actions">
                {preparing && <p role="status">正在準備壓縮照片…</p>}
                {photoUploadsEnabled && draft.mode !== "demo" && draft.photo && (
                  <div className="meal-photo-controls">
                    <label className="meal-photo-optin">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={Boolean(draft.savePhoto)}
                        onChange={(e) =>
                          setDraft((value) =>
                            value
                              ? {
                                  ...value,
                                  savePhoto: e.target.checked,
                                  ...(e.target.checked ? { removePhoto: false } : {}),
                                }
                              : value,
                          )
                        }
                      />
                      <span>儲存餐點縮圖供歷史查看</span>
                    </label>
                    <p className="meal-photo-help">
                      只保存單張壓縮縮圖（≤ 1600px JPEG，移除 EXIF/GPS），可隨時移除；刪除後背景實體清理可能有短暫延遲。
                    </p>
                  </div>
                )}
                {draft.photoRef && !draft.removePhoto && !(photoUploadsEnabled && draft.savePhoto && draft.photo) && (
                  <div className="meal-photo-controls">
                    <p className="meal-photo-help" role="status">此餐已附有私人縮圖。</p>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        openDraft({
                          ...draft,
                          removePhoto: true,
                          savePhoto: false,
                        }, false, savedDraftBaseline)
                      }
                    >
                      移除已保存圖片
                    </button>
                  </div>
                )}
                {draft.photoRef && draft.removePhoto && (
                  <div className="meal-photo-controls">
                    <p className="meal-photo-help" role="status">儲存後將移除此餐附圖。</p>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        openDraft({
                          ...draft,
                          removePhoto: false,
                        }, false, savedDraftBaseline)
                      }
                    >
                      保留原附圖
                    </button>
                  </div>
                )}
                {photoUploadsEnabled && draft.version > 0 && draft.mode !== "demo" && (
                  <label className="button button-secondary meal-photo-picker">
                    <span>{draft.photoRef || draft.photo ? "更換餐點附圖" : "附設餐點縮圖"}</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={busy || preparing}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) onPhotoSelected(file, { autoOptIn: true });
                      }}
                    />
                  </label>
                )}
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
                        savePhoto: false,
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
                      if (busyRef.current) return;
                      const scope = operationScope();
                      void askConfirm({
                        title: "還原原始估算",
                        message: "還原到原始估算？目前修改會被取代。",
                        confirmLabel: "確認還原",
                        destructive: true,
                      }).then((confirmed) => {
                        const latestDraft = current.current.draft;
                        if (!confirmed || busyRef.current || !scope.isCurrent() || !latestDraft) return;
                        openDraft({
                          ...latestDraft,
                          items: structuredClone(latestDraft.originalItems),
                          calorieCorrection: null,
                          calorieInput: undefined,
                        }, false, current.current.savedDraftBaseline);
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
              <div className={draft.items.length ? "save-bar" : "save-bar is-idle"}>
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
                    busy ||
                    preparing ||
                    (nutritionPending && online) ||
                    !draft.items.length ||
                    draft.mode === "demo" ||
                    journalNoteTooLong
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
            <div className="journal-heading-copy">
              <h1>{tab === "today" ? "今日飲食" : "歷史記錄"}</h1>
              <p className="journal-date-line">
                {tab === "today" ? todayLabel : "按日回顧、查看備註，同埋修正已保存嘅餐點。"}
              </p>
              <p className="subhead">{tab === "today" ? "一餐一餐，慢慢記低" : "翻返你記低過嘅每一餐"}</p>
            </div>
          </section>
          {tab === "history" && entryActions}
          {activeUnsavedDraft && (
            <section className="journal-card draft-banner">
              <span className="draft-banner-icon" aria-hidden="true"><JournalIcon /></span>
              <div>
                <strong>有一份未儲存草稿</strong>
                <small>你可以返去繼續，唔使由頭再記。</small>
              </div>
              <button
                className="button button-secondary"
                onClick={() => openDraft(activeUnsavedDraft)}
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
              <div className="day-summary-count"><span>今日餐數</span><strong>0</strong><small>餐</small></div>
              <div className="day-summary-kcal is-unknown">
                <span>卡路里</span><strong>未記錄</strong><small>未知不代表零</small>
                <RangeRail range={null} ticks={false} />
              </div>
            </div>
          )}
          {tab === "today" && !visible.length && entryActions}
          {!visible.length && (
            <section className="journal-card empty-journal">
              <div className="empty-journal-copy">
                <h2>{cloudRecordsUnknown
                  ? tab === "today" ? "尚未確認今日記錄" : "尚未確認歷史記錄"
                  : tab === "today" ? "今日未有記錄" : "未有餐點記錄"}</h2>
                <p className="subhead">{cloudRecordsUnknown ? "仲未讀完雲端" : "今日由第一餐開始"}</p>
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
                  aria-label="用相片 AI 辨識"
                  onClick={() => start()}
                >
                  <CameraIcon />
                  用相片 AI 辨識
                </button>
                <button
                  className="button button-secondary"
                  aria-label="手動記一餐"
                  onClick={() => start(true)}
                >
                  <JournalIcon />
                  手動記一餐
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
                {tab === "history" && (
                  <div className="journal-day-heading">
                    <h2>{journalDateLabel(date)}</h2>
                    <span>{date}</span>
                  </div>
                )}
                <div className={`day-summary journal-card ${tab === "today" ? "today-summary" : "history-summary"}`} role="region" aria-label={tab === "today" ? "今日摘要" : `${date} 摘要`}>
                  <div className="day-summary-count"><span>{tab === "today" ? "今日餐數" : "餐數"}</span><strong>{calories.mealCount}</strong><small>餐</small></div>
                  <div className={calorieRange ? "day-summary-kcal" : "day-summary-kcal is-unknown"}>
                    <span>{calorieRange && calories.partialCount + calories.unknownCount > 0 ? "已知部分卡路里" : "卡路里"}</span>
                    <strong>{calorieRange
                      ? calories.referenceCount ? `${calorieRange.min}–${calorieRange.max}` : calorieRange.min
                      : "未知"}</strong>
                    <small>kcal</small>
                    <RangeRail range={calorieRange ? { min: calorieRange.min, max: calorieRange.max } : null} />
                  </div>
                  {Object.entries(nutrition.totals).filter(([key]) => key !== "calories").map(([key, range]) => {
                    const rounded = roundRange(range, 1);
                    return (
                      <div key={key} className="day-summary-macro">
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
                  {calories.manualCount > 0 && <p className="day-summary-note">含 {calories.manualCount} 餐手動卡路里記錄；營養素仍按食物參考估算。</p>}
                  {calories.partialCount + calories.unknownCount > 0 && <p className="day-summary-note is-gap">以上並非全日總數：{calories.partialCount + calories.unknownCount} 餐未完整計入，未知不代表零。</p>}
                  {nutrition.includedCount < nutrition.totalCount && (
                    <p className="day-summary-note is-gap">
                      營養素部分估算：只計入 {nutrition.includedCount}／
                      {nutrition.totalCount} 項食物，未計入項目不代表零營養。
                    </p>
                  )}
                </div>
                {tab === "today" && entryActions}
                {groups.map((group) => (
                  <section className="meal-group" key={group.key} aria-label={group.label ?? undefined}>
                    {group.label && <h3 className="meal-group-title">{group.label}</h3>}
                    {group.records.length === 0 && <p className="meal-group-empty">未有記錄</p>}
                    <div className="meal-list">
                      {group.records.map((record) => {
                        const view = mealView(record);
                        return (
                        <article className="meal-row" key={record.id}>
                          <div className="meal-row-content">
                            <div className="meal-meta-line">
                              <p className="meal-time">{record.time} · {mealTypes[record.mealType]}</p>
                              {tab === "history" && <span className="meal-current-note">已保存</span>}
                              <p className={view.calorieKnown ? "meal-calories" : "meal-calories is-unknown"}>{view.calorieLabel}</p>
                            </div>
                            <MealNameHeading className="sr-only">
                              {record.items
                                .map((item) => item.displayName)
                                .join("、")}
                            </MealNameHeading>
                            <ul className="placard-tray">
                              {view.placards.map((placard, index) => (
                                <li key={index} className={`placard is-${placard.state}`}>
                                  <span className="placard-name">{placard.name}</span>
                                  {placard.state !== "plain" && (
                                    <span className="placard-kcal">{placard.kcal ?? zhCopy.nutritionUnavailable}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {!!record.journalNote?.trim() && (
                              <div className="meal-journal-note">
                                <strong>備註</strong>
                                <span>{record.journalNote}</span>
                              </div>
                            )}
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
                        );
                      })}
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
              if (key === "new") start();
              else go(key);
            }}
          >
            <span className="journal-nav-icon" aria-hidden="true">
              {key === "today" ? <HomeIcon /> : key === "new" ? <CameraIcon /> : <HistoryIcon />}
            </span>
            <span className="journal-nav-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
    <ConfirmDialog request={confirmRequest} onResolve={finishConfirm} />
    </>
  );
}
