import { z } from "zod";

export const MAX_JOURNAL_NOTE_CODE_POINTS = 500;

export function normalizeJournalNote(value: string): string | null {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized === "" ? null : normalized;
}

export function journalNoteCodePoints(value: string): number {
  return Array.from(value).length;
}

const normalizedJournalNoteSchema = z.string()
  .transform(normalizeJournalNote)
  .refine(
    (value) => value === null || journalNoteCodePoints(value) <= MAX_JOURNAL_NOTE_CODE_POINTS,
    { message: "journal note is too long" },
  );

export const journalNoteInputSchema = z.union([
  normalizedJournalNoteSchema,
  z.null(),
]);

export const storedJournalNoteSchema = z.union([
  z.string().refine(
    (value) =>
      normalizeJournalNote(value) === value &&
      journalNoteCodePoints(value) <= MAX_JOURNAL_NOTE_CODE_POINTS,
    { message: "stored journal note is not canonical" },
  ),
  z.null(),
]);

export function resolveJournalNote(
  input: string | null | undefined,
  previous: string | null | undefined,
): string | null {
  if (input !== undefined) return input;
  return previous ?? null;
}
