const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const GEMINI_RC_MODEL = "gemini-3.8-flash";

export interface OpenAIServerConfig {
  apiKey: string;
  model: string;
}

export function getOpenAIServerConfig(): OpenAIServerConfig | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
  };
}

export interface GeminiServerConfig {
  apiKey: string;
  model: typeof GEMINI_RC_MODEL;
}

export type GeminiConfigRead =
  | { status: "ready"; config: GeminiServerConfig }
  | { status: "missing_key" }
  | { status: "rejected_model" };

/** RC opt-in only. A missing key or any model other than the RC candidate fails closed. */
export function readGeminiServerConfig(): GeminiConfigRead {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return { status: "missing_key" };
  const requested = process.env.GEMINI_MODEL?.trim();
  if (requested && requested !== GEMINI_RC_MODEL) return { status: "rejected_model" };
  return { status: "ready", config: { apiKey, model: GEMINI_RC_MODEL } };
}

export function getNutritionApiKey(): string | null {
  const apiKey = process.env.NUTRITION_API_KEY?.trim();
  return apiKey || null;
}
