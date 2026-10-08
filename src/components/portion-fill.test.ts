import { describe, expect, it } from "vitest";

import { portionValueAfterProgrammaticFill } from "./portion-fill";

describe("portion programmatic fill", () => {
  it("replaces a prefilled maximum instead of appending the minimum", () => {
    expect(portionValueAfterProgrammaticFill("300", "300300", "300", "insertText")).toBe("300");
    expect(portionValueAfterProgrammaticFill("300", "300180", "180", "insertText")).toBe("180");
    expect(portionValueAfterProgrammaticFill("300", "300300", null, "")).toBe("300");
  });

  it("keeps a single typed digit", () => {
    expect(portionValueAfterProgrammaticFill("300", "3002", "2", "insertText")).toBe("3002");
    expect(portionValueAfterProgrammaticFill("300", "180", null, "insertText")).toBe("180");
  });
});
