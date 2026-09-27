"use client";

import { useEffect, useState } from "react";
import { authorizedFetch, firebaseAuth } from "@/lib/firebase/client";
import { photoRefSchema, type PhotoRef } from "@/lib/meals/types";

const maxPhotoBytes = 2 * 1024 * 1024;

export function PrivateMealPhoto({
  mealId,
  photoRef,
  expectedUid,
}: {
  mealId: string;
  photoRef: PhotoRef;
  expectedUid: string;
}) {
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "error" | "ready"; url?: string }>({ status: "loading" });
  const attachmentId = photoRef.attachmentId;
  const generation = photoRef.generation;
  const validPhotoRef = photoRefSchema.safeParse(photoRef).success;

  useEffect(() => {
    if (!requested) return;
    let active = true;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const current = () =>
      active && !controller.signal.aborted && firebaseAuth()?.currentUser?.uid === expectedUid;

    async function load() {
      setState({ status: "loading" });
      try {
        if (!validPhotoRef) throw new Error("invalid_photo_ref");
        const response = await authorizedFetch(
          `/api/meals/${encodeURIComponent(mealId)}/photo`,
          { cache: "no-store", signal: controller.signal },
          expectedUid,
        );
        if (!response.ok || !response.headers.get("Content-Type")?.toLowerCase().startsWith("image/jpeg"))
          throw new Error("photo_unavailable");
        const length = Number(response.headers.get("Content-Length"));
        if (length > maxPhotoBytes) throw new Error("photo_too_large");
        const blob = await response.blob();
        if (!current()) return;
        if (blob.size < 1 || blob.size > maxPhotoBytes) throw new Error("photo_too_large");
        objectUrl = URL.createObjectURL(blob);
        if (current()) setState({ status: "ready", url: objectUrl });
      } catch {
        if (current()) setState({ status: "error" });
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, expectedUid, mealId, attachmentId, generation, requested, validPhotoRef]);

  if (!requested) return <button className="button button-secondary meal-photo-open" type="button" onClick={() => setRequested(true)}>查看餐點附圖</button>;
  if (state.status === "loading") return <p className="meal-photo-status" role="status">正在載入餐點附圖…</p>;
  if (state.status === "error") return (
    <div className="meal-photo-error">
      <p role="status">餐點附圖暫時無法載入，連線後可重試。</p>
      <button className="button button-secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>重試載入圖片</button>
    </div>
  );
  return (
    <figure className="meal-photo">
      {/* A short-lived, account-scoped object URL cannot use Next's image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.url} alt="餐點附圖" onError={() => setState({ status: "error" })} />
      <figcaption>餐點附圖</figcaption>
    </figure>
  );
}
