import { authorizedFetch, firebaseAuth } from "@/lib/firebase/client";
import { mealInputSchema, type MealDraft, type MealRecord } from "./types";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
import {
  changeSyncState,
  changeSyncStateAndClearPhotos,
  enqueuePhotoMeal,
  hasCurrentMealVersion,
  markPhotoUploadStaged,
  readPhotoPayload,
  visibleMeals,
  type PendingMeal,
} from "./outbox";
import { resolveCalorieCorrection } from "./calories";

export class RepositoryError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

async function result(response: Response) {
  const body = await response.json();
  if (!response.ok)
    throw new RepositoryError(
      body.error?.code ?? "service_unavailable",
      response.status,
    );
  return body;
}

const mealCursorPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MEAL_SYNC_PAGES = 1_000;
type MealListPage = { records?: MealRecord[]; revision?: string; nextCursor?: string };

function mealListPage(value: unknown): MealListPage {
  if (!value || typeof value !== "object") throw new RepositoryError("invalid_response", 502);
  const page = value as Record<string, unknown>;
  if (page.revision !== undefined && typeof page.revision !== "string")
    throw new RepositoryError("invalid_response", 502);
  if (page.records !== undefined && (!Array.isArray(page.records) ||
    !page.records.every((record) => record && typeof record === "object" && typeof record.id === "string")))
    throw new RepositoryError("invalid_response", 502);
  if (page.nextCursor !== undefined &&
    (typeof page.nextCursor !== "string" || !mealCursorPattern.test(page.nextCursor) ||
      !Array.isArray(page.records) || page.records.at(-1)?.id !== page.nextCursor ||
      typeof page.revision !== "string"))
    throw new RepositoryError("invalid_response", 502);
  if (page.records === undefined && typeof page.revision !== "string")
    throw new RepositoryError("invalid_response", 502);
  return page as MealListPage;
}

function currentUser() {
  const user = firebaseAuth()?.currentUser;
  const uid = user?.uid;
  if (!uid) throw new RepositoryError("login_required", 401);
  const logout = localStorage.getItem("kcalcue-logout")?.split(":");
  if (logout?.[0] === uid) throw new RepositoryError("login_required", 401);
  return uid;
}

function signalChange(uid: string) {
  window.dispatchEvent(new Event("kcalcue-sync"));
  try {
    localStorage.setItem(
      "kcalcue-sync-change",
      `${uid}:${crypto.randomUUID()}`,
    );
  } catch {
    /* IDB is already durable; other tabs also refresh when foregrounded. */
  }
}

function sameQueuedSave(left: MealRecord, right: MealRecord) {
  // A retry may recreate the local timestamp, but must not change the
  // mutation sent to the server under the same idempotency key.
  return JSON.stringify({ ...left, updatedAt: undefined }) ===
    JSON.stringify({ ...right, updatedAt: undefined });
}

async function locked<T>(uid: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new RepositoryError("browser_unsupported", 400);
  return navigator.locks.request(`kcalcue-sync-${uid}`, operation);
}

export class MealRepository {
  async list(uid = currentUser()): Promise<MealRecord[]> {
    return visibleMeals(await changeSyncState(uid));
  }

  async state(uid = currentUser()) {
    return changeSyncState(uid);
  }

  async save(
    draft: MealDraft,
    mutationId: string,
    uid = currentUser(),
    photoUpload?: { uploadId: string; blob: Blob },
    options?: { removePhoto?: boolean },
  ): Promise<MealRecord> {
    if (currentUser() !== uid) throw new RepositoryError("login_required", 401);
    if (!navigator.locks) throw new RepositoryError("browser_unsupported", 400);
    const parsed = mealInputSchema.safeParse({
      ...draft,
      mutationId,
      photoPath: null,
    });
    if (!parsed.success) throw new RepositoryError("invalid_request", 400);
    const { calorieCorrection, journalNote, ...input } = parsed.data;
    const record: MealRecord = {
      ...input,
      analysisProvenance: input.analysis ? readAnalysisProvenance(input.analysisProvenance, input.mode) : null,
      ...(calorieCorrection === undefined ? {} : {
        calorieCorrection: resolveCalorieCorrection(calorieCorrection, input.items),
      }),
      ...(journalNote === undefined ? {} : { journalNote }),
      // Read-only cloud metadata may travel with an existing draft. A new
      // offline meal has no server creation time until its first acknowledgement.
      ...(draft.version === 0 || draft.schemaVersion === undefined ? {} : { schemaVersion: draft.schemaVersion }),
      ...(draft.version === 0 || draft.createdAt === undefined ? {} : { createdAt: draft.createdAt }),
      // The API input schema deliberately strips client nutrition metadata.
      // Preserve the already resolved match in the local outbox for offline
      // totals; the server independently resolves/validates the eventual write.
      items: parsed.data.items.map((item, index) => ({
        ...item,
        nutritionMatch: draft.items[index].nutritionMatch,
      })),
      originalItems: draft.originalItems.length
        ? draft.originalItems
        : draft.items,
      userId: uid,
      version: draft.version + 1,
      updatedAt: new Date().toISOString(),
    };
    let visible = record;
    await navigator.locks.request(`kcalcue-account-${uid}`, async () => {
      if (currentUser() !== uid)
        throw new RepositoryError("login_required", 401);
      const removePhoto = !photoUpload && Boolean(options?.removePhoto);
      const job: PendingMeal = {
        id: mutationId,
        kind: "save",
        record,
        expectedVersion: draft.version,
        ...(removePhoto ? { removePhoto: true } : {}),
      };
      if (photoUpload) {
        const state = await enqueuePhotoMeal(uid, {
          ...job,
          photoUpload: { uploadId: photoUpload.uploadId, pipelineVersion: 1 },
        }, photoUpload.blob);
        visible = visibleMeals(state).find((meal) => meal.id === draft.id) ?? record;
      } else {
        await changeSyncState(uid, (state) => {
          const mealJobs = state.jobs.filter((pending) => pending.record.id === draft.id);
          if (mealJobs.some((pending) => pending.kind === "delete" || (pending.error && pending.kind !== "save")))
            throw new RepositoryError("conflict", 409);
          // Once an ACK removes the job, the latest cloud snapshot still
          // carries its idempotency key. Reusing it for a new edit would get
          // the old server record back and silently lose the new fields.
          if (state.remote.some((saved) => saved.mutationId === mutationId))
            throw new RepositoryError("conflict", 409);
          const existing = state.jobs.find((pending) => pending.id === mutationId);
          if (existing) {
            if (existing.kind !== "save" || existing.photoUpload || existing.record.id !== draft.id)
              throw new RepositoryError("conflict", 409);
            if (existing.error) {
              const index = state.jobs.findIndex((pending) => pending.id === existing.id);
              state.jobs[index] = { ...existing, record, ...(removePhoto ? { removePhoto: true } : { removePhoto: undefined }), error: undefined };
            } else if (
              existing.expectedVersion !== draft.version ||
              Boolean(existing.removePhoto) !== removePhoto ||
              !sameQueuedSave(existing.record, record)
            ) {
              throw new RepositoryError("conflict", 409);
            }
          } else if (mealJobs.some((pending) => pending.kind === "save" && pending.error)) {
            // An edited draft replaces the rejected save. One meal, one command.
            if (mealJobs.some((pending) => pending.kind === "save" && !pending.error))
              throw new RepositoryError("conflict", 409);
            const blocked = mealJobs.filter((pending) => pending.kind === "save" && pending.error);
            if (blocked.some((pending) => pending.expectedVersion !== draft.version || pending.photoUpload))
              throw new RepositoryError("conflict", 409);
            const drop = new Set(blocked.map((pending) => pending.id));
            state.jobs = state.jobs.filter((pending) => !drop.has(pending.id));
            state.jobs.push(job);
          } else if (!hasCurrentMealVersion(state, draft.id, draft.version)) {
            throw new RepositoryError("conflict", 409);
          } else {
            state.jobs.push(job);
          }
          visible = visibleMeals(state).find((meal) => meal.id === draft.id) ?? record;
          return state;
        });
      }
    });
    signalChange(uid);
    return visible;
  }

  async saveWithPhoto(draft: MealDraft, mutationId: string, uploadId: string, uid = currentUser()) {
    if (!draft.photo) throw new RepositoryError("invalid_request", 400);
    return this.save(draft, mutationId, uid, { uploadId, blob: draft.photo });
  }

  // Escape hatch when a pending photo upload cannot complete before meal save.
  // Only allowed while the photo is still pending (meal POST has not been
  // dispatched). Allocates a fresh mutationId and clears the local Blob.
  async saveQueuedWithoutPhoto(mealId: string, blockedMutationId: string, uid = currentUser()): Promise<string> {
    if (currentUser() !== uid) throw new RepositoryError("login_required", 401);
    if (!navigator.locks) throw new RepositoryError("browser_unsupported", 400);
    const nextMutationId = crypto.randomUUID();
    await navigator.locks.request(`kcalcue-account-${uid}`, async () => {
      if (currentUser() !== uid) throw new RepositoryError("login_required", 401);
      const state = await changeSyncState(uid);
      const target = state.jobs.find((job) => job.id === blockedMutationId && job.record.id === mealId);
      if (!target || target.kind !== "save" || !target.photoUpload || target.photoUpload.status !== "pending") {
        throw new RepositoryError("conflict", 409);
      }
      const uploadId = target.photoUpload.uploadId;
      await changeSyncStateAndClearPhotos(uid, (current) => {
        const currentTarget = current.jobs.find((job) => job.id === blockedMutationId && job.record.id === mealId);
        if (!currentTarget || currentTarget.kind !== "save" || !currentTarget.photoUpload || currentTarget.photoUpload.status !== "pending") {
          throw new RepositoryError("conflict", 409);
        }
        return {
          ...current,
          jobs: current.jobs.map((job) =>
            job.id === blockedMutationId
              ? {
                  id: nextMutationId,
                  kind: "save",
                  record: {
                    ...currentTarget.record,
                    mutationId: nextMutationId,
                    updatedAt: new Date().toISOString(),
                  },
                  expectedVersion: currentTarget.expectedVersion,
                }
              : job,
          ),
        };
      }, [uploadId]);
    });
    signalChange(uid);
    return nextMutationId;
  }

  async delete(record: MealRecord) {
    const uid = currentUser();
    if (record.userId !== uid) throw new RepositoryError("login_required", 401);
    if (!navigator.locks) throw new RepositoryError("browser_unsupported", 400);
    await navigator.locks.request(`kcalcue-account-${uid}`, async () => {
      if (currentUser() !== uid)
        throw new RepositoryError("login_required", 401);
      await changeSyncState(uid, (state) => {
        if (state.jobs.some((job) => job.record.id === record.id && job.error))
          throw new RepositoryError("conflict", 409);
        if (!hasCurrentMealVersion(state, record.id, record.version, false))
          throw new RepositoryError("conflict", 409);
        state.jobs.push({
          id: crypto.randomUUID(),
          kind: "delete",
          record,
          expectedVersion: record.version,
        });
        return state;
      });
    });
    signalChange(uid);
  }

  async discardPending(mealId: string, uid = currentUser()) {
    if (currentUser() !== uid) throw new RepositoryError("login_required", 401);
    await locked(uid, async () => {
      await navigator.locks.request(`kcalcue-account-${uid}`, async () => {
        if (currentUser() !== uid)
          throw new RepositoryError("login_required", 401);
        const uploadIds = (await changeSyncState(uid)).jobs
          .filter((job) => job.record.id === mealId && job.photoUpload)
          .map((job) => job.photoUpload!.uploadId);
        await changeSyncStateAndClearPhotos(uid, (state) => ({
          ...state,
          jobs: state.jobs.filter((job) => job.record.id !== mealId),
        }), uploadIds);
      });
    });
    signalChange(uid);
  }

  private async stagePhotoForJob(
    job: PendingMeal,
    uid: string,
  ): Promise<
    | { status: "staged" }
    | { status: "blocked"; code: string }
    | { status: "transient"; error: unknown }
  > {
    const intent = job.photoUpload!;
    const blob = await readPhotoPayload(uid, intent.uploadId);
    if (!blob) return { status: "blocked", code: "photo_payload_missing" };

    const data = new FormData();
    data.set("image", blob, "meal.jpg");

    let uploadError: unknown = null;
    try {
      const response = await authorizedFetch(
        `/api/meals/${encodeURIComponent(job.record.id)}/photo-uploads/${encodeURIComponent(intent.uploadId)}`,
        { method: "POST", body: data },
        uid,
      );
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.state === "staged" || body?.state === "attached") {
          await markPhotoUploadStaged(uid, intent.uploadId);
          return { status: "staged" };
        }
        uploadError = new RepositoryError("invalid_response", 502);
      } else {
        const body = await response.json().catch(() => null);
        const code = typeof body?.error?.code === "string" ? body.error.code : "service_unavailable";
        if (response.status === 401) throw new RepositoryError(code, 401);
        const permanent =
          (response.status < 500 && response.status !== 429 && response.status !== 408) ||
          (response.status === 503 && (code === "photo_uploads_disabled" || code === "photo_quota_not_configured"));
        if (permanent) return { status: "blocked", code };
        uploadError = new RepositoryError(code, response.status);
      }
    } catch (error) {
      if (error instanceof RepositoryError && error.status === 401) throw error;
      uploadError = error;
    }

    // Outcome-unknown or transient upload failure: check server registry
    // status for the same uploadId before deciding whether to stage or retry.
    try {
      const statusResponse = await authorizedFetch(
        "/api/meals/photo/status",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mealId: job.record.id,
            uploadId: intent.uploadId,
            inputSha256: intent.sha256,
            inputBytes: intent.byteSize,
          }),
        },
        uid,
      );
      if (statusResponse.ok) {
        const body = await statusResponse.json().catch(() => null);
        const state = body?.registryState;
        if (state === "staged" || state === "attached") {
          await markPhotoUploadStaged(uid, intent.uploadId);
          return { status: "staged" };
        }
        if (state === "deleting" || state === "deleted") {
          return { status: "blocked", code: "photo_upload_expired" };
        }
      } else if (statusResponse.status === 401) {
        throw new RepositoryError("login_required", 401);
      } else if (statusResponse.status === 409) {
        return { status: "blocked", code: "photo_upload_conflict" };
      }
    } catch (error) {
      if (error instanceof RepositoryError && error.status === 401) throw error;
    }

    return { status: "transient", error: uploadError };
  }

  async sync(uid = currentUser(), retry = false) {
    if (!navigator.onLine || uid !== firebaseAuth()?.currentUser?.uid) return;
    await locked(uid, async () => {
      if (currentUser() !== uid) return;
      if (retry)
        // Explicit retry resends the blocked command once, including conflict.
        // Automatic sync leaves the error in place and does not post again.
        await changeSyncState(uid, (state) => ({
          ...state,
          jobs: state.jobs.map((job) => ({ ...job, error: undefined })),
        }));
      const blocked = new Set<string>();
      let photoTransientError: unknown = null;
      const jobs = (await changeSyncState(uid)).jobs;
      for (const originalJob of jobs) {
        if (uid !== firebaseAuth()?.currentUser?.uid || !navigator.onLine)
          return;
        if (originalJob.error || blocked.has(originalJob.record.id)) {
          blocked.add(originalJob.record.id);
          continue;
        }

        let job = originalJob;
        if (job.kind === "save" && job.photoUpload && job.photoUpload.status !== "staged") {
          const outcome = await this.stagePhotoForJob(job, uid);
          if (outcome.status === "blocked") {
            blocked.add(job.record.id);
            await changeSyncState(uid, (state) => ({
              ...state,
              jobs: state.jobs.map((pending) =>
                pending.id === job.id ? { ...pending, error: outcome.code } : pending,
              ),
            }));
            continue;
          }
          if (outcome.status === "transient") {
            blocked.add(job.record.id);
            photoTransientError ??= outcome.error;
            continue;
          }
          const refreshed = (await changeSyncState(uid)).jobs.find((pending) => pending.id === job.id);
          if (!refreshed || !refreshed.photoUpload || refreshed.photoUpload.status !== "staged") {
            blocked.add(job.record.id);
            continue;
          }
          job = refreshed;
        }

        try {
          const saved = await this.send(job, uid);
          const acknowledge = (state: Awaited<ReturnType<typeof changeSyncState>>) => ({
            ...state,
            remote: [
              ...state.remote.filter((record) => record.id !== job.record.id),
              ...(saved ? [saved] : []),
            ],
            jobs: state.jobs.filter((pending) => pending.id !== job.id),
          });
          if (job.photoUpload)
            await changeSyncStateAndClearPhotos(uid, acknowledge, [job.photoUpload.uploadId]);
          else
            await changeSyncState(uid, acknowledge);
        } catch (error) {
          if (
            !(error instanceof RepositoryError) ||
            error.status >= 500 ||
            error.status === 429 ||
            error.status === 401
          )
            throw error;
          blocked.add(job.record.id);
          await changeSyncState(uid, (state) => ({
            ...state,
            jobs: state.jobs.map((pending) =>
              pending.id === job.id
                ? { ...pending, error: error.code }
                : pending,
            ),
          }));
        }
      }
      if (uid !== firebaseAuth()?.currentUser?.uid) return;
      const since = (await changeSyncState(uid)).revision;
      const readSnapshot = async (): Promise<MealListPage | null> => {
        if (uid !== firebaseAuth()?.currentUser?.uid || !navigator.onLine) return null;
        const first = mealListPage(await result(await authorizedFetch(
          `/api/meals?paged=1${since ? `&since=${encodeURIComponent(since)}` : ""}`,
          { cache: "no-store" }, uid,
        )));
        let records = first.records;
        let cursor = first.nextCursor;
        if (cursor) {
          const received = new Set(records!.map((record) => record.id));
          const complete = [...records!];
          for (let pageNumber = 1; cursor; pageNumber++) {
            if (pageNumber >= MAX_MEAL_SYNC_PAGES)
              throw new RepositoryError("invalid_response", 502);
            if (uid !== firebaseAuth()?.currentUser?.uid || !navigator.onLine) return null;
            const page = mealListPage(await result(await authorizedFetch(
              `/api/meals?paged=1&cursor=${encodeURIComponent(cursor)}&revision=${encodeURIComponent(first.revision!)}`,
              { cache: "no-store" }, uid,
            )));
            if (page.revision !== first.revision || !page.records ||
              page.records.some((record) => received.has(record.id)) ||
              page.nextCursor === cursor)
              throw new RepositoryError("invalid_response", 502);
            for (const record of page.records) received.add(record.id);
            complete.push(...page.records);
            cursor = page.nextCursor;
          }
          records = complete;
        }
        return { records, revision: first.revision };
      };
      let snapshot: MealListPage | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          snapshot = await readSnapshot();
          break;
        } catch (error) {
          // A concurrent cloud write invalidates the page cursor. Restart the
          // read once without replaying any already-acknowledged meal writes.
          if (!(error instanceof RepositoryError && error.code === "snapshot_changed") || attempt === 1)
            throw error;
        }
      }
      if (!snapshot || uid !== firebaseAuth()?.currentUser?.uid) return;
      await changeSyncState(uid, (state) => ({
        ...state,
        remote: snapshot.records ?? state.remote,
        revision: snapshot.revision,
        syncedAt: new Date().toISOString(),
      }));
      if (photoTransientError) throw photoTransientError;
    });
  }

  private async send(
    job: PendingMeal,
    uid: string,
  ): Promise<MealRecord | null> {
    if (job.kind === "delete") {
      await result(
        await authorizedFetch(
          `/api/meals/${job.record.id}?version=${job.expectedVersion}&mutationId=${job.id}`,
          { method: "DELETE" },
          uid,
        ),
      );
      return null;
    }
    if (job.photoUpload && job.photoUpload.status !== "staged")
      throw new RepositoryError("photo_upload_pending", 409);
    const photoAction = job.photoUpload
      ? { kind: "attach" as const, uploadId: job.photoUpload.uploadId }
      : job.removePhoto
        ? { kind: "remove" as const }
        : undefined;
    return (
      await result(
        await authorizedFetch(
          "/api/meals",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...job.record,
              calorieInput: undefined,
              schemaVersion: undefined,
              createdAt: undefined,
              version: job.expectedVersion,
              mutationId: job.id,
              ...(photoAction ? { photoAction } : {}),
            }),
          },
          uid,
        ),
      )
    ).record;
  }
}
