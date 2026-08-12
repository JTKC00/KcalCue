import { getGeminiServerConfig } from "@/lib/server/env";
import { DemoFoodVisionProvider } from "./demo";
import { GeminiFoodVisionProvider } from "./gemini";
import type { FoodVisionProvider } from "./types";

export function getFoodVisionProviderMode(): FoodVisionProvider["mode"] {
  return createFoodVisionProvider().mode;
}

export function createFoodVisionProvider(): FoodVisionProvider {
  const config = getGeminiServerConfig();
  return config
    ? new GeminiFoodVisionProvider(config)
    : new DemoFoodVisionProvider();
}
