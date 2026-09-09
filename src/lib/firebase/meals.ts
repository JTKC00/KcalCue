import type { Firestore } from "firebase-admin/firestore";
import type { MealRecord } from "@/lib/meals/types";
import { accountPath } from "./admin";
import { HttpError } from "@/lib/server/auth";

export function mealCollection(db: Firestore, uid: string) {
  return db.collection(`${accountPath(uid)}/meals`);
}
export async function listMeals(
  db: Firestore,
  uid: string,
): Promise<MealRecord[]> {
  const snapshot = await mealCollection(db, uid)
    .where("deleted", "==", false)
    .get();
  return snapshot.docs.map((doc) => doc.data().record as MealRecord);
}
export async function previousMeal(db: Firestore, uid: string, id: string) {
  const snapshot = await mealCollection(db, uid).doc(id).get();
  return snapshot.data() as
    | {
        deleted: boolean;
        record?: MealRecord;
        version: number;
        mutationId: string;
      }
    | undefined;
}
// The version comparison and write run in one transaction. An uncertain retry
// is acknowledged by mutation ID; tombstones prevent deleted meals resurfacing.
export async function commitMeal(
  db: Firestore,
  uid: string,
  record: MealRecord,
  expected: number,
) {
  const ref = mealCollection(db, uid).doc(record.id);
  return db.runTransaction(async (tx) => {
    const previous = (await tx.get(ref)).data();
    if (previous?.deleted) throw new HttpError(409, "conflict");
    if (previous?.mutationId === record.mutationId)
      return previous.record as MealRecord;
    if ((previous?.version ?? 0) !== expected)
      throw new HttpError(409, "conflict");
    tx.set(
      ref,
      JSON.parse(
        JSON.stringify({
          deleted: false,
          version: record.version,
          mutationId: record.mutationId,
          record,
        }),
      ),
    );
    tx.set(db.doc(accountPath(uid)), { revision: crypto.randomUUID() });
    return record;
  });
}
export async function deleteMeal(
  db: Firestore,
  uid: string,
  id: string,
  expected: number,
  mutationId: string,
) {
  const ref = mealCollection(db, uid).doc(id);
  await db.runTransaction(async (tx) => {
    const previous = (await tx.get(ref)).data();
    if (previous?.deleted && previous.mutationId === mutationId) return;
    if (previous?.deleted || (previous?.version ?? 0) !== expected)
      throw new HttpError(409, "conflict");
    tx.set(ref, { deleted: true, version: expected + 1, mutationId });
    tx.set(db.doc(accountPath(uid)), { revision: crypto.randomUUID() });
  });
}
