const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export interface GeminiServerConfig {
  apiKey: string;
  model: string;
}

export function getGeminiServerConfig(): GeminiServerConfig | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  };
}

export function getNutritionApiKey(): string | null {
  const apiKey = process.env.NUTRITION_API_KEY?.trim();
  return apiKey || null;
}
