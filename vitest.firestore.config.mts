import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/*.emulator.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
