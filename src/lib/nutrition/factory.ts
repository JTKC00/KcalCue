import { LocalNutritionProvider } from "./local-provider";
import type { NutritionProvider } from "./types";

export function createLocalNutritionProvider(): NutritionProvider {
  return new LocalNutritionProvider();
}
