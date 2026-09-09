"use client";
import { useEffect, useRef, useState } from "react";
import {
  cloudConfigured,
  completeEmailLink,
  googleLogin,
  hasEmailLink,
  sendEmailLink,
} from "@/lib/firebase/client";

export function Account({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const completing = useRef(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    // Browser-only URL/storage hydration must happen after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLink(hasEmailLink());
    const address = localStorage.getItem("kcalcue-login-email") ?? "";
    setEmail(address);
    if (hasEmailLink() && address && !completing.current) {
      completing.current = true;
      setBusy(true);
      void completeEmailLink(address)
        .then(() => done.current())
        .catch(() => setMessage("登入連結無效或已過期，請重新寄送。"))
        .finally(() => setBusy(false));
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (link) {
        await completeEmailLink(email.trim());
        onDone();
      } else {
        if (Date.now() < retryAt) return;
        await sendEmailLink(email.trim());
        setRetryAt(Date.now() + 60_000);
        setMessage(
          "已寄出登入連結，請查看收件箱及垃圾郵件。請在這個裝置開啟連結；跨裝置時需再次輸入 Email。PWA 草稿會保留在原來的瀏覽器／App。",
        );
      }
    } catch {
      setMessage(
        link
          ? "Email 或登入連結不正確，或連結已過期。可重新寄送。"
          : "未能寄出登入連結，請檢查 Email、網絡及稍後再試。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="journal-card account-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>登入你的記錄</h2>
      <p>
        {link
          ? "確認接收登入連結的 Email。"
          : "以 Email 登入連結或 Google 登入。試用資料權限由管理員開通。"}
      </p>
      <label>
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button
        className="button button-primary"
        disabled={busy || !cloudConfigured() || (!link && now < retryAt)}
      >
        {busy
          ? "處理中…"
          : link
            ? "完成 Email 登入"
            : now < retryAt
              ? `稍後重寄（${Math.ceil((retryAt - now) / 1000)}秒）`
              : "寄出登入連結"}
      </button>
      {link && (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() => {
            history.replaceState(null, "", "/");
            setLink(false);
          }}
        >
          重新寄送登入連結
        </button>
      )}
      <button
        type="button"
        className="button button-secondary"
        disabled={busy || !cloudConfigured()}
        onClick={() => {
          setBusy(true);
          void googleLogin()
            .then(onDone)
            .catch(() =>
              setMessage(
                "Google 登入未完成，請允許彈出視窗後重試，或使用 Email 登入連結。",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        使用 Google 登入
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
