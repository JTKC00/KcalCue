"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserSupabase,
  authorizedFetch,
  cloudConfigured,
} from "@/lib/supabase/client";
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
import { roundRange } from "@/lib/nutrition/calculation";
import { KcalCueApp } from "./kcalcue-app";
import { PwaControls } from "./pwa-controls";

const repository = new MealRepository();
const messages: Record<string, string> = {
  login_required: "登入已過期，請重新輸入驗證碼。草稿仍保留，登入後再按儲存。",
  conflict:
    "這餐已在另一個裝置修改或刪除。你的草稿仍保留；請載入最新記錄後再修改。",
  invalid_request: "請檢查食物名稱、份量及日期時間。每餐最多 12 項食物。",
  photo_failed: "照片未能上傳，可再試一次，或選擇不保存照片。",
  cleanup_failed: "記錄已處理，但照片清理尚未完成。請按「重試照片清理」。",
  cloud_unavailable: "尚未設定 Supabase，目前只能保存本機草稿。",
};
function errorText(error: unknown) {
  return error instanceof RepositoryError
    ? (messages[error.code] ?? "未能連接雲端，草稿仍保留。請稍後再試。")
    : "未能完成操作，請檢查網絡後再試。";
}
function Account({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function send() {
    const client = browserSupabase();
    if (!client || busy || Date.now() < retryAt) return;
    setBusy(true);
    setMessage("");
    try {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false },
      });
      if (error) {
        setMessage("未能寄出驗證碼。請確認你已加入試用名單，稍後再試。");
        return;
      }
      setSent(true);
      setRetryAt(Date.now() + 60_000);
      setMessage("已寄出驗證碼，請查看收件箱及垃圾郵件。");
    } catch {
      setMessage("暫時未能連線，請再試。");
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    const client = browserSupabase();
    if (!client || busy) return;
    setBusy(true);
    try {
      const { error } = await client.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
      });
      if (error) setMessage("驗證碼不正確或已過期，請重試或重新寄送。");
      else onDone();
    } catch {
      setMessage("暫時未能連線，請再試。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="journal-card account-form"
      onSubmit={(e) => {
        e.preventDefault();
        void (sent ? verify() : send());
      }}
    >
      <h2>登入你的記錄</h2>
      <p>輸入試用帳戶的 Email，在這個畫面完成驗證。</p>
      <label>
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={busy || sent}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {sent && (
        <label>
          驗證碼
          <input
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6,10}"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
      )}
      <button
        className="button button-primary"
        disabled={busy || !cloudConfigured()}
      >
        {busy ? "處理中…" : sent ? "驗證並登入" : "寄出驗證碼"}
      </button>
      {sent && (
        <div className="journal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || now < retryAt}
            onClick={() => void send()}
          >
            重新寄送
            {now < retryAt ? `（${Math.ceil((retryAt - now) / 1000)}秒）` : ""}
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              setSent(false);
              setCode("");
            }}
          >
            更改 Email
          </button>
        </div>
      )}
      <p role="status">{message}</p>
    </form>
  );
}
function MealPhoto({ record, userId }: { record: MealRecord; userId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    void (async () => {
      if (!record.photoPath) return;
      let blob = await localMeals.photo(userId, record.photoPath);
      if (!blob && navigator.onLine) {
        blob = await repository.photo(record.photoPath);
        if (alive) await localMeals.putPhoto(userId, record.photoPath, blob);
      }
      if (blob && alive) {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }
    })().catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [record.photoPath, userId]);
  // The source is a private local Blob, never a public storage URL.
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="meal-thumbnail" src={url} alt="餐點照片" />
  ) : (
    <span className="meal-thumbnail photo-placeholder">
      {record.photoPath ? "照片未下載" : "手動記錄"}
    </span>
  );
}

export function MealJournal({
  initialProviderMode,
}: {
  initialProviderMode: "demo" | "live";
}) {
  const [tab, setTab] = useState("today");
  const [account, setAccount] = useState(false);
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
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [cleanup, setCleanup] = useState<
    Array<{ path?: string; record?: MealRecord }>
  >([]);
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
  useEffect(() => { allowUpdateReload.current = false; }, [draft]);

  const refresh = useCallback(async () => {
    const id = current.current.userId;
    if (id === "guest" || !navigator.onLine || busyRef.current) return;
    const generation = ++refreshGeneration.current;
    try {
      const next = await repository.list();
      if (
        current.current.userId !== id ||
        generation !== refreshGeneration.current
      )
        return;
      setRecords(next);
      setSyncedAt(new Date().toISOString());
    } catch (error) {
      if (current.current.userId === id) setNotice(errorText(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    let loadGeneration = 0;
    async function load(id: string, address: string | null) {
      const generation = ++loadGeneration;
      setReady(false);
      refreshGeneration.current++;
      const oldId = current.current.userId;
      const guestDraft =
        oldId === "guest" && id !== "guest" ? current.current.draft : null;
      if (oldId !== "guest" && oldId !== id) {
        cacheEnabled.current = false;
        await writes.current;
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
      if (!active || generation !== loadGeneration) return;
      if (guestDraft && !local.draft) {
        local.draft = guestDraft;
        await localMeals.write(id, local);
        await writes.current;
        await localMeals.clear("guest");
      }
      current.current = { userId: id, ...local };
      cacheEnabled.current = true;
      setUserId(id);
      setEmail(address);
      setRecords(local.records);
      setDraft(local.draft);
      setInitialDraft(local.draft ?? undefined);
      setEditorKey((key) => key + 1);
      setSyncedAt(local.syncedAt);
      setReady(true);
      if (id !== "guest") localStorage.setItem("kcalcue-account", id);
      void refresh();
    }
    const client = browserSupabase();
    void (async () => {
      const session = await client?.auth.getSession();
      if (!active) return;
      await load(
        session?.data.session?.user.id ??
          localStorage.getItem("kcalcue-account") ??
          "guest",
        session?.data.session?.user.email ?? null,
      );
    })().catch(() => {
      if (active)
        void load(localStorage.getItem("kcalcue-account") ?? "guest", null);
    });
    const subscription = client?.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        if (session.user.id === current.current.userId) {
          setEmail(session.user.email ?? null);
          void refresh();
        } else
          setTimeout(() => {
            if (active) void load(session.user.id, session.user.email ?? null);
          }, 0);
      }
      if (event === "SIGNED_OUT") {
        setEmail(null);
      }
    });
    const connection = () => {
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
    connection();
    navigate();
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    window.addEventListener("hashchange", navigate);
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("storage", signedOutElsewhere);
    return () => {
      active = false;
      subscription?.data.subscription.unsubscribe();
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

  function go(next: string) {
    location.hash = next;
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
    (change: Pick<MealDraft, "items" | "analysis" | "mode">) => {
      setDraft((value) =>
        value
          ? {
              ...value,
              ...change,
              originalItems: value.originalItems.length
                ? value.originalItems
                : change.analysis
                  ? change.items
                  : [],
            }
          : value,
      );
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
              "照片壓縮未完成，原相只保留於本次頁面。可重試或不保存照片。",
            );
          }
        })
        .finally(() => {
          if (generation === photoGeneration.current) setPreparing(false);
        });
    },
    [initialProviderMode],
  );

  async function cleanPhoto(path: string) {
    const response = await authorizedFetch(
      `/api/meals/photo?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    );
    if (!response.ok)
      throw new RepositoryError("cleanup_failed", response.status);
    await localMeals.removePhoto(current.current.userId, path).catch(() => {});
  }
  async function save() {
    if (!draft || busyRef.current || preparing || photoFailed) return;
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
    if (!online) {
      setNotice("草稿已留在本機，連線後請再次按儲存。");
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
    const old = records.find((record) => record.id === draft.id);
    let next = draft;
    try {
      if (next.photo && !next.photoPath && !next.removePhoto) {
        const path = await repository.upload(next.id, next.photo);
        next = { ...next, photoPath: path };
        setDraft(next);
      }
      if (next.removePhoto)
        next = { ...next, photoPath: null, photo: undefined };
      const fingerprint = JSON.stringify({
        ...next,
        photo: undefined,
        pendingMutation: undefined,
      });
      const pendingMutation =
        next.pendingMutation?.fingerprint === fingerprint
          ? next.pendingMutation
          : { fingerprint, id: crypto.randomUUID() };
      next = { ...next, pendingMutation };
      setDraft(next);
      const saved = await repository.save(next, pendingMutation.id);
      if (current.current.userId !== id) return;
      if (next.photo && saved.photoPath)
        await localMeals
          .putPhoto(id, saved.photoPath, next.photo)
          .catch(() => {});
      setRecords((value) => [
        ...value.filter((record) => record.id !== saved.id),
        saved,
      ]);
      setSyncedAt(new Date().toISOString());
      setDraft(null);
      setInitialDraft(undefined);
      setNotice("已儲存並同步。");
      go("today");
      if (old?.photoPath && old.photoPath !== saved.photoPath) {
        try {
          await cleanPhoto(old.photoPath);
        } catch {
          setCleanup((value) => [...value, { path: old.photoPath! }]);
          setNotice(messages.cleanup_failed);
        }
      }
    } catch (error) {
      setNotice(errorText(error));
      if (error instanceof RepositoryError && error.code === "conflict")
        setConflict(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function edit(record: MealRecord) {
    if (
      draft &&
      draft.id !== record.id &&
      !confirm("已有另一份草稿。放棄它並開啟這餐？")
    )
      return;
    let photo: Blob | undefined;
    try {
      if (record.photoPath) {
        photo = await localMeals.photo(userId, record.photoPath);
        if (!photo && online) photo = await repository.photo(record.photoPath);
      }
    } catch {
      setNotice("照片暫未下載，仍可修正記錄。");
    }
    openDraft({ ...record, photo });
  }
  async function discard() {
    if (!confirm("放棄這份草稿？已儲存的記錄不會改變。")) return;
    const path = draft?.photoPath;
    if (path && !records.some((r) => r.photoPath === path)) {
      try {
        await cleanPhoto(path);
      } catch {
        setCleanup((value) => [...value, { path }]);
      }
    }
    photoGeneration.current++;
    setDraft(null);
    setInitialDraft(undefined);
    go("today");
  }
  async function remove(record: MealRecord, ask = true) {
    if (ask && !confirm("刪除這餐及照片？此操作無法復原。")) return;
    await repository.delete(record);
    if (record.photoPath)
      await localMeals.removePhoto(userId, record.photoPath).catch(() => {});
    setRecords((value) => value.filter((r) => r.id !== record.id));
    if (draft?.id === record.id) setDraft(null);
  }
  async function deleting(record: MealRecord) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    try {
      await remove(record);
    } catch (error) {
      setNotice(errorText(error));
      if (error instanceof RepositoryError && error.code === "cleanup_failed")
        setCleanup((value) => [...value, { record }]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function clearAll() {
    if (
      !online ||
      busyRef.current ||
      !confirm("永久刪除全部餐點、照片及本機草稿？")
    )
      return;
    busyRef.current = true;
    setBusy(true);
    refreshGeneration.current++;
    try {
      for (const record of await repository.list()) await remove(record, false);
      const candidates = await authorizedFetch("/api/meals/cleanup", {
        cache: "no-store",
      });
      if (!candidates.ok)
        throw new RepositoryError("cleanup_failed", candidates.status);
      for (const path of (await candidates.json()).paths as string[])
        await cleanPhoto(path);
      await writes.current;
      await localMeals.clear(userId);
      setDraft(null);
      setRecords([]);
      setNotice("全部記錄已刪除。");
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    if (
      busyRef.current ||
      (draft &&
        !confirm("登出會清除這個帳戶的本機草稿、照片及快取。仍要登出？"))
    )
      return;
    busyRef.current = true;
    setBusy(true);
    cacheEnabled.current = false;
    refreshGeneration.current++;
    photoGeneration.current++;
    try {
      await writes.current;
      await localMeals.clear(userId);
      setDraft(null);
      setRecords([]);
      current.current = { ...current.current, draft: null, records: [] };
      const result = await browserSupabase()?.auth.signOut({ scope: "local" });
      if (result?.error) {
        const session = await browserSupabase()?.auth.getSession();
        if (session?.data.session) throw result.error;
      }
      localStorage.removeItem("kcalcue-account");
      localStorage.setItem("kcalcue-logout", `${userId}:${Date.now()}`);
      location.reload();
    } catch {
      cacheEnabled.current = true;
      setNotice("登出未完成，請連線後再試。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function latest() {
    try {
      const next = await repository.list();
      setRecords(next);
      const record = next.find((r) => r.id === draft?.id);
      if (!record) {
        setNotice("這餐已被刪除。你可保留目前草稿，或放棄它。");
        return;
      }
      if (confirm("載入最新記錄會取代目前的未儲存修改，是否繼續？"))
        await edit(record);
    } catch (error) {
      setNotice(errorText(error));
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
          : "離線中 · 可查看已下載記錄及保留草稿"}
        {!cloudConfigured() && <span> · 雲端尚未設定，無法登入或同步</span>}
      </div>
      {notice && (
        <div className="journal-notice" role="status">
          <span>{notice}</span>
          <button aria-label="關閉訊息" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      {!!cleanup.length && (
        <button
          className="button button-secondary"
          disabled={!online || busy}
          onClick={() => {
            void (async () => {
              const failed: typeof cleanup = [];
              for (const job of cleanup) {
                try {
                  if (job.path) await cleanPhoto(job.path);
                  if (job.record) await remove(job.record, false);
                } catch {
                  failed.push(job);
                }
              }
              setCleanup(failed);
              setNotice(
                failed.length ? messages.cleanup_failed : "照片清理完成。",
              );
            })();
          }}
        >
          重試照片清理
        </button>
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
          {email ? (
            <section className="journal-card">
              <p>{email}</p>
              <button
                className="button button-secondary"
                disabled={busy}
                onClick={() => void logout()}
              >
                登出並清除本機資料
              </button>
              <button
                className="button button-ghost danger"
                disabled={!online || busy}
                onClick={() => void clearAll()}
              >
                清除全部記錄
              </button>
            </section>
          ) : (
            <Account
              onDone={() => {
                setAccount(false);
                setNotice("登入成功。草稿需要你確認後才會儲存。");
              }}
            />
          )}
          <section className="journal-card">
            <h2>照片與私隱</h2>
            <p>
              Live 分析會將相片傳送至 AI
              服務。草稿及已下載的記錄可保留於本機；確認儲存後，餐點與壓縮照片會私人保存到你的帳戶。你可以刪除照片或整餐記錄。
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
              <fieldset className="editor-fields" disabled={busy}>
                <KcalCueApp
                  key={editorKey}
                  initialProviderMode={initialProviderMode}
                  initialDraft={initialDraft ?? draft}
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
                      onPhotoSelected(null);
                      setNotice("儲存後會移除雲端照片。");
                    }}
                  >
                    不保存照片
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
                    busy ||
                    preparing ||
                    photoFailed ||
                    !draft.items.length ||
                    draft.mode === "demo"
                  }
                  onClick={() => void save()}
                >
                  {busy ? "儲存中…" : !online ? "保留離線草稿" : "儲存餐點"}
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
            return (
              <section className="journal-day" key={date}>
                <h2>{date}</h2>
                <div className="day-summary journal-card">
                  {Object.entries(nutrition.totals).map(([key, range]) => {
                    const rounded = roundRange(
                      range,
                      key === "calories" ? 5 : 1,
                    );
                    return (
                      <div key={key}>
                        <span>
                          {
                            {
                              calories: "卡路里",
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
                        <small>{key === "calories" ? "kcal" : "g"}</small>
                      </div>
                    );
                  })}
                  {nutrition.includedCount < nutrition.totalCount && (
                    <p>
                      部分估算：只計入 {nutrition.includedCount}／
                      {nutrition.totalCount} 項食物，未計入項目不代表零營養。
                    </p>
                  )}
                </div>
                <div className="meal-list">
                  {meals.map((record) => (
                    <article className="journal-card meal-row" key={record.id}>
                      <MealPhoto record={record} userId={userId} />
                      <div>
                        <p>
                          {record.time} · {mealTypes[record.mealType]}
                        </p>
                        <h3>
                          {record.items
                            .map((item) => item.displayName)
                            .join("、")}
                        </h3>
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
                            disabled={!online || busy}
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
