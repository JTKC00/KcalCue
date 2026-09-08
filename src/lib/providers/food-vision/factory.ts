import { getOpenAIServerConfig } from "@/lib/server/env";
import { DemoFoodVisionProvider } from "./demo";
import { OpenAIFoodVisionProvider } from "./openai";
import type { FoodVisionProvider } from "./types";

export function getFoodVisionProviderMode(): FoodVisionProvider["mode"] {
  return createFoodVisionProvider().mode;
}

export function createFoodVisionProvider(): FoodVisionProvider {
  const config = getOpenAIServerConfig();
  return config
    ? new OpenAIFoodVisionProvider(config)
    : new DemoFoodVisionProvider();
}
