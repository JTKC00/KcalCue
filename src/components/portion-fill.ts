/**
 * Chromium number inputs ignore select(), so a programmatic fill appends to
 * whatever is already shown. Entering the minimum first copies that number
 * into the empty maximum, and the next fill then produces 300300.
 * A real keystroke inserts one character and is left alone.
 */
export function portionValueAfterProgrammaticFill(
  previous: string,
  next: string,
  inserted: string | null,
  inputType: string,
): string {
  if (!previous || !next.startsWith(previous) || next.length <= previous.length) return next;
  const suffix = next.slice(previous.length);
  if (
    (inputType === "insertText" || inputType === "insertReplacementText") &&
    inserted !== null &&
    inserted.length > 1 &&
    suffix === inserted
  ) {
    return inserted;
  }
  if (inputType === "" && suffix === previous) return suffix;
  return next;
}
