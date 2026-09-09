import { authorizedFetch, firebaseAuth } from "@/lib/firebase/client";
import { mealInputSchema, type MealDraft, type MealRecord } from "./types";
import { changeSyncState, visibleMeals, type PendingMeal } from "./outbox";
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
    const record: MealRecord = {
      ...parsed.data,
      originalItems: draft.originalItems.length
        ? draft.originalItems
        : draft.items,
      userId: uid,
      version: draft.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await navigator.locks.request(`kcalcue-account-${uid}`, async () => {
      if (currentUser() !== uid)
        throw new RepositoryError("login_required", 401);
      await changeSyncState(uid, (state) => {
        if (state.jobs.some((job) => job.record.id === draft.id && job.error))
          throw new RepositoryError("conflict", 409);
        if (!state.jobs.some((job) => job.id === mutationId))
          state.jobs.push({
            id: mutationId,
            kind: "save",
            record,
            expectedVersion: draft.version,
          });
        return state;
      });
    });
    signalChange(uid);
    return record;
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
  async discardPending(mealId: string) {
    const uid = currentUser();
    await locked(uid, async () => {
      await changeSyncState(uid, (state) => ({
        ...state,
        jobs: state.jobs.filter((job) => job.record.id !== mealId),
      }));
    });
    signalChange(uid);
  }
  async sync(uid = currentUser(), retry = false) {
    if (!navigator.onLine || uid !== firebaseAuth()?.currentUser?.uid) return;
    await locked(uid, async () => {
      if (currentUser() !== uid) return;
      if (retry)
        await changeSyncState(uid, (state) => ({
          ...state,
          jobs: state.jobs.map((job) =>
            job.error === "conflict" ? job : { ...job, error: undefined },
          ),
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
      const response = await result(
        await authorizedFetch(
          `/api/meals${since ? `?since=${encodeURIComponent(since)}` : ""}`,
          { cache: "no-store" },
          uid,
        ),
      );
      await changeSyncState(uid, (state) => ({
        ...state,
        remote: response.records ?? state.remote,
        revision: response.revision,
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
