const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

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

export function getNutritionApiKey(): string | null {
  const apiKey = process.env.NUTRITION_API_KEY?.trim();
  return apiKey || null;
}
