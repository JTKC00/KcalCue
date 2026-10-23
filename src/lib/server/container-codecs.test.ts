import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("pins a libvips version that satisfies the installed Sharp source-build floor", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const sharp = JSON.parse(readFileSync("node_modules/sharp/package.json", "utf8"));
  const pinned = /^ARG VIPS_VERSION=(\d+\.\d+\.\d+)$/m.exec(dockerfile)?.[1];
  // Fail on a changed range syntax so a future dependency change receives review.
  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(sharp.config.libvips)?.[1];
  expect(pinned, "Docker must pin an exact libvips release").toBeDefined();
  expect(minimum, "Sharp must declare a reviewed libvips minimum").toBeDefined();
  const actual = pinned!.split(".").map(Number);
  const required = minimum!.split(".").map(Number);
  const different = actual.findIndex((part, index) => part !== required[index]);
  expect(
    different === -1 || actual[different] > required[different],
    `Sharp ${sharp.version} requires libvips ${sharp.config.libvips}; Docker pins ${pinned}`,
  ).toBe(true);
});
