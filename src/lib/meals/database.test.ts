import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const meal = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
async function asUser(id: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec("set role authenticated");
}
describe("meal migration and RLS on PostgreSQL", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth, storage, public to authenticated, anon;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
      alter table storage.objects enable row level security;
      grant select, insert, delete on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;`);
    await db.query("insert into auth.users values ($1), ($2)", [owner, other]);
    await db.exec(
      await readFile(
        path.resolve("supabase/migrations/20260909025204_meal_journal.sql"),
        "utf8",
      ),
    );
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  it("allows an owner to insert and prevents another account reading or updating", async () => {
    await asUser(owner);
    const record = {
      id: meal,
      userId: owner,
      version: 1,
      mode: "manual",
      items: [{}],
    };
    await db.query(
      "insert into meals(id,user_id,date,version,record,totals) values ($1,$2,'2026-09-09',1,$3,'{}')",
      [meal, owner, JSON.stringify(record)],
    );
    expect((await db.query("select * from meals")).rows).toHaveLength(1);
    await asUser(other);
    expect((await db.query("select * from meals")).rows).toHaveLength(0);
    expect(
      (
        await db.query("update meals set version=2 where id=$1 returning id", [
          meal,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(
      db.query(
        "insert into meals(id,user_id,date,version,record,totals) values ($1,$2,'2026-09-09',1,$3,'{}')",
        [crypto.randomUUID(), owner, JSON.stringify(record)],
      ),
    ).rejects.toThrow();
  });
  it("enforces version increments and compare-and-swap without overwriting newer edits", async () => {
    await asUser(owner);
    await expect(
      db.query(
        "update meals set version=3,record=jsonb_set(record,'{version}','3') where id=$1",
        [meal],
      ),
    ).rejects.toThrow("invalid version");
    const update =
      "update meals set version=2,record=jsonb_set(record,'{version}','2') where id=$1 and version=1 returning id";
    expect((await db.query(update, [meal])).rows).toHaveLength(1);
    expect((await db.query(update, [meal])).rows).toHaveLength(0);
  });
  it("protects private photo objects and prevents ownership reassignment", async () => {
    const photo = `${owner}/${meal}/44444444-4444-4444-8444-444444444444.jpg`;
    await asUser(owner);
    await db.query(
      "insert into meal_photos(path,user_id,meal_id) values ($1,$2,$3)",
      [photo, owner, meal],
    );
    await db.query(
      "insert into storage.objects(bucket_id,name) values ('meal-photos',$1)",
      [photo],
    );
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      1,
    );
    await expect(
      db.query("update meal_photos set user_id=$1", [other]),
    ).rejects.toThrow();
    await asUser(other);
    expect((await db.query("select * from meal_photos")).rows).toHaveLength(0);
    expect((await db.query("select * from storage.objects")).rows).toHaveLength(
      0,
    );
    expect(
      (await db.query("delete from storage.objects returning name")).rows,
    ).toHaveLength(0);
    await expect(
      db.query(
        "insert into storage.objects(bucket_id,name) values ('meal-photos',$1)",
        [photo],
      ),
    ).rejects.toThrow();
  });
  it("keeps deleted records immutable so an old save cannot resurrect them", async () => {
    await asUser(owner);
    await db.query(
      "update meals set deleted_at=now() where id=$1 and version=2",
      [meal],
    );
    await expect(
      db.query("update meals set deleted_at=null where id=$1", [meal]),
    ).rejects.toThrow("immutable meal");
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from meals")).rejects.toThrow(
      "permission denied",
    );
  });
});
