"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      let reloadOnChange = false;
      const alreadyControlled = Boolean(navigator.serviceWorker.controller);
      const requested = () => { reloadOnChange = true; };
      const changed = () => {
        if (reloadOnChange) location.reload();
        else if (alreadyControlled) window.dispatchEvent(new CustomEvent("kcalcue-update", { detail: navigator.serviceWorker.controller }));
      };
      window.addEventListener("kcalcue-update-requested", requested);
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(reg => {
        const announce = () => {
          if (reg.waiting && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent("kcalcue-update", { detail: reg.waiting }));
          }
        };
        announce();
        reg.addEventListener("updatefound", () => reg.installing?.addEventListener("statechange", announce));
      }).catch(() => { /* Online application remains usable without offline installation. */ });
      return () => { navigator.serviceWorker.removeEventListener("controllerchange", changed); window.removeEventListener("kcalcue-update-requested", requested); };
    }
  }, []);

  return null;
}
