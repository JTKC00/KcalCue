import { describe, expect, it } from "vitest";
import {
  MAX_JOURNAL_NOTE_CODE_POINTS,
  journalNoteInputSchema,
  normalizeJournalNote,
  storedJournalNoteSchema,
} from "./journal-note";

describe("journal note contract", () => {
  it("normalizes newlines and surrounding whitespace", () => {
    expect(journalNoteInputSchema.parse("  第一行\r\n第二行\r  ")).toBe("第一行\n第二行");
  });

  it("normalizes blank text to null and preserves explicit null", () => {
    expect(journalNoteInputSchema.parse(" \n\t ")).toBeNull();
    expect(journalNoteInputSchema.parse(null)).toBeNull();
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(Array.from("🧸")).toHaveLength(1);
    expect(journalNoteInputSchema.parse("🧸".repeat(MAX_JOURNAL_NOTE_CODE_POINTS)))
      .toBe("🧸".repeat(MAX_JOURNAL_NOTE_CODE_POINTS));
    expect(journalNoteInputSchema.safeParse(
      "🧸".repeat(MAX_JOURNAL_NOTE_CODE_POINTS + 1),
    ).success).toBe(false);
  });

  it("keeps HTML-looking content as inert plain text data", () => {
    expect(journalNoteInputSchema.parse(" <b>少飯</b> ")).toBe("<b>少飯</b>");
  });

  it("requires stored notes to already be canonical", () => {
    expect(storedJournalNoteSchema.safeParse("第一行\n第二行").success).toBe(true);
    expect(storedJournalNoteSchema.safeParse(" 第一行 ").success).toBe(false);
    expect(storedJournalNoteSchema.safeParse("第一行\r\n第二行").success).toBe(false);
  });

  it("exposes the same normalization helper used by the schema", () => {
    expect(normalizeJournalNote("\r\n 記低呢餐 \r\n")).toBe("記低呢餐");
  });
});
