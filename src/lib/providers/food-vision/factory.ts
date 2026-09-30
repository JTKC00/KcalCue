import { FoodVisionError } from "./errors";
import { DemoFoodVisionProvider } from "./demo";
import { GeminiFoodVisionProvider } from "./gemini";
import { OpenAIFoodVisionProvider } from "./openai";
import { getOpenAIServerConfig, readGeminiServerConfig } from "@/lib/server/env";
import type { FoodVisionProvider } from "./types";

export function getFoodVisionProviderMode(): FoodVisionProvider["mode"] {
  try {
    return createFoodVisionProvider().mode;
  } catch (error) {
    // A rejected RC provider is still a live path. The journal stays available;
    // analyze keeps the fail-closed error instead of silently using Demo.
    if (error instanceof FoodVisionError) return "live";
    throw error;
  }
}

export function createFoodVisionProvider(): FoodVisionProvider {
  const selected = (process.env.KCALCUE_VISION_PROVIDER ?? "openai").trim().toLowerCase() || "openai";
  if (selected === "gemini") {
    const gemini = readGeminiServerConfig();
    if (gemini.status === "missing_key") {
      throw new FoodVisionError("invalid_key", "Gemini authentication failed.");
    }
    if (gemini.status === "rejected_model") {
      throw new FoodVisionError("model_unavailable", "The configured Gemini model is unavailable.");
    }
    return new GeminiFoodVisionProvider(gemini.config);
  }
  if (selected !== "openai") {
    throw new FoodVisionError("model_unavailable", "The configured vision provider is unavailable.");
  }

  const config = getOpenAIServerConfig();
  return config
    ? new OpenAIFoodVisionProvider(config)
    : new DemoFoodVisionProvider();
}
