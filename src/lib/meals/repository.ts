import { authorizedFetch, firebaseAuth } from "@/lib/firebase/client";
import { mealInputSchema, type MealDraft, type MealRecord } from "./types";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
import { changeSyncState, hasCurrentMealVersion, visibleMeals, type PendingMeal } from "./outbox";
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
  ): Promise<MealRecord> {
    if (currentUser() !== uid) throw new RepositoryError("login_required", 401);
    if (!navigator.locks) throw new RepositoryError("browser_unsupported", 400);
    const parsed = mealInputSchema.safeParse({
      ...draft,
      mutationId,
      photoPath: null,
    });
    if (!parsed.success) throw new RepositoryError("invalid_request", 400);
    const { calorieCorrection, ...input } = parsed.data;
    const record: MealRecord = {
      ...input,
      analysisProvenance: input.analysis ? readAnalysisProvenance(input.analysisProvenance, input.mode) : null,
      ...(calorieCorrection === undefined ? {} : {
        calorieCorrection: resolveCalorieCorrection(calorieCorrection, input.items),
      }),
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
      await changeSyncState(uid, (state) => {
        const mealJobs = state.jobs.filter((job) => job.record.id === draft.id);
        if (mealJobs.some((job) => job.kind === "delete" || (job.error && job.kind !== "save")))
          throw new RepositoryError("conflict", 409);
        const existing = state.jobs.find((job) => job.id === mutationId);
        if (existing) {
          if (existing.kind !== "save" || existing.record.id !== draft.id)
            throw new RepositoryError("conflict", 409);
          // Same mutation after a rejection: reuse the command and clear the block.
          if (existing.error) {
            const index = state.jobs.findIndex((job) => job.id === existing.id);
            state.jobs[index] = { ...existing, record, error: undefined };
          }
        } else if (mealJobs.some((job) => job.kind === "save" && job.error)) {
          // An edited draft replaces the rejected save. One meal, one command.
          if (mealJobs.some((job) => job.kind === "save" && !job.error))
            throw new RepositoryError("conflict", 409);
          const blocked = mealJobs.filter((job) => job.kind === "save" && job.error);
          if (blocked.some((job) => job.expectedVersion !== draft.version))
            throw new RepositoryError("conflict", 409);
          const drop = new Set(blocked.map((job) => job.id));
          state.jobs = state.jobs.filter((job) => !drop.has(job.id));
          state.jobs.push({
            id: mutationId,
            kind: "save",
            record,
            expectedVersion: draft.version,
          });
        } else if (!hasCurrentMealVersion(state, draft.id, draft.version)) {
          throw new RepositoryError("conflict", 409);
        } else {
          state.jobs.push({
            id: mutationId,
            kind: "save",
            record,
            expectedVersion: draft.version,
          });
        }
        visible = visibleMeals(state).find((meal) => meal.id === draft.id) ?? record;
        return state;
      });
    });
    signalChange(uid);
    return visible;
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
        await changeSyncState(uid, (state) => ({
          ...state,
          jobs: state.jobs.filter((job) => job.record.id !== mealId),
        }));
      });
    });
    signalChange(uid);
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
      const jobs = (await changeSyncState(uid)).jobs;
      for (const job of jobs) {
        if (uid !== firebaseAuth()?.currentUser?.uid || !navigator.onLine)
          return;
        if (job.error || blocked.has(job.record.id)) {
          blocked.add(job.record.id);
          continue;
        }
        try {
          const saved = await this.send(job, uid);
          await changeSyncState(uid, (state) => ({
            ...state,
            remote: [
              ...state.remote.filter((record) => record.id !== job.record.id),
              ...(saved ? [saved] : []),
            ],
            jobs: state.jobs.filter((pending) => pending.id !== job.id),
          }));
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
            }),
          },
          uid,
        ),
      )
    ).record;
  }
}
