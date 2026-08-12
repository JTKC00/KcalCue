import { localNutritionProfiles, LOCAL_DATA_NOTICE } from "./local-data";
import type { NutritionProfile, NutritionProvider } from "./types";

export function normalizeFoodName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[()（）,，.。]/g, " ")
    .replace(/\s+/g, " ");
}

export class LocalNutritionProvider implements NutritionProvider {
  readonly id = "local-reference";
  readonly dataNotice = LOCAL_DATA_NOTICE;

  findByName(name: string): NutritionProfile | null {
    const normalized = normalizeFoodName(name);
    if (!normalized) return null;

    return (
      localNutritionProfiles.find((profile) =>
        [profile.id, profile.displayName, ...profile.aliases].some(
          (alias) => normalizeFoodName(alias) === normalized,
        ),
      ) ?? null
    );
  }

  listFoods(): NutritionProfile[] {
    return localNutritionProfiles.map((profile) => ({ ...profile }));
  }
}
