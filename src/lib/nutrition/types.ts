import type { PortionUnit } from "@/lib/domain/food-analysis";

export interface NutrientValues {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface NutritionProfile {
  id: string;
  displayName: string;
  aliases: string[];
  nutrientsPer100g: NutrientValues;
  gramsPerUnit: Partial<Record<PortionUnit, number>>;
  dataNotice: string;
}

export interface NutritionProvider {
  readonly id: string;
  readonly dataNotice: string;
  findByName(name: string): NutritionProfile | null;
  listFoods(): NutritionProfile[];
}
