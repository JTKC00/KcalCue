"use client";
import { useEffect, useState } from "react";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export function PwaControls({
  visible,
  beforeUpdate,
}: {
  visible: boolean;
  beforeUpdate: () => Promise<void>;
}) {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [message, setMessage] = useState("");
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    // These values come from browser-only installation state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstalled(
      matchMedia("(display-mode: standalone)").matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    );
    setIos(
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    );
    setDismissed(localStorage.getItem("kcalcue-install-dismissed") === "yes");
    const prompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    const done = () => {
      setInstalled(true);
      setInstall(null);
    };
    const update = (event: Event) =>
      setWaiting((event as CustomEvent<ServiceWorker>).detail);
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("appinstalled", done);
    window.addEventListener("kcalcue-update", update);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg?.waiting) setWaiting(reg.waiting);
      });
    return () => {
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("appinstalled", done);
      window.removeEventListener("kcalcue-update", update);
    };
  }, []);
  async function update() {
    try {
      await beforeUpdate();
      if (waiting?.state === "activated") {
        location.reload();
        return;
      }
      window.dispatchEvent(new Event("kcalcue-update-requested"));
      waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
      setMessage("草稿已保留，正在更新…");
    } catch {
      setMessage("草稿未能保存，請先儲存或放棄修改後再更新。");
    }
  }
  return (
    <>
      {waiting && (
        <div className="journal-notice">
          有新版本可用
          <button
            className="button button-secondary"
            onClick={() => void update()}
          >
            保存草稿並更新
          </button>
        </div>
      )}
      {(visible || (!dismissed && (install || ios) && !installed)) && (
        <section className="pwa-card journal-card">
          <h2>安裝 KcalCue</h2>
          {installed ? (
            <p>你正在使用已安裝的 KcalCue。</p>
          ) : install ? (
            <button
              className="button button-secondary"
              onClick={() => {
                void install
                  .prompt()
                  .then(() => install.userChoice)
                  .then(() => setInstall(null))
                  .catch(() => setMessage("請使用瀏覽器選單安裝。"));
              }}
            >
              加入主畫面
            </button>
          ) : ios ? (
            <p>
              在 Safari 開啟
              KcalCue，按「分享」→「加入主畫面」→「加入」。如選單有「以網頁 App
              開啟」，請保持開啟。
            </p>
          ) : (
            <p>
              使用瀏覽器選單中的「安裝應用程式」或「加入主畫面」。是否提供安裝取決於瀏覽器。
            </p>
          )}
          <p>首次連線開啟後，可離線查看已下載記錄。照片分析仍需要網絡。</p>
          {!visible && (
            <button
              className="button button-ghost"
              onClick={() => {
                localStorage.setItem("kcalcue-install-dismissed", "yes");
                setDismissed(true);
              }}
            >
              稍後再說
            </button>
          )}
        </section>
      )}
      {message && (
        <p className="journal-notice" role="status">
          {message}
        </p>
      )}
    </>
  );
}
