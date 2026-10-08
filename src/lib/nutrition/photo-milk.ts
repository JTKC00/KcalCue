import type { FoodIdentityLevel } from "@/lib/domain/food-analysis";
import {
  contradictoryDairyMilkLabel,
  explicitLowFatMilk,
  genericMilkLabel,
  normalizeFoodName,
} from "./canonical";

/**
 * Photo versus manual milk.
 *
 * A photo item that still reads as 牛奶, 奶, or milk — after temperature,
 * glass, carton, or "drink" wording — is not mapped to USDA whole milk.
 * The food card asks for 全脂牛奶, 低脂牛奶, 燕麥奶, 豆漿, or 其他. That
 * decision uses the names only. identityLevel, a guessed normalizedName
 * such as "whole milk", and meal-level visibleEvidence do not hide the
 * chooser and do not invent a direct calorie.
 *
 * Choosing 全脂牛奶 forces one whole-milk ingredient, even when the model
 * called the row a dish. Choosing 其他 keeps the row uncomputed and hides
 * the buttons; there is no free-text field. Rename the food to change it.
 *
 * Typed manual 鮮奶 and 牛奶 keep the existing product default: fresh milk
 * with no low-fat or plant-milk evidence maps to whole milk. Manual QA
 * depends on that default. 鮮奶, 全脂, 低脂, and 脫脂 on a photo are explicit
 * dairy qualifiers and follow the same default as manual input.
 */
export const PHOTO_MILK_CHOICES = [
  { id: "whole", label: "全脂牛奶", displayName: "全脂牛奶", normalizedName: "whole milk" },
  { id: "low-fat", label: "低脂牛奶", displayName: "低脂牛奶", normalizedName: "low-fat milk" },
  { id: "oat", label: "燕麥奶", displayName: "燕麥奶", normalizedName: "oat milk" },
  { id: "soy", label: "豆漿", displayName: "豆漿", normalizedName: "soy milk" },
  { id: "other", label: "其他" },
] as const;

export type PhotoMilkChoice = (typeof PHOTO_MILK_CHOICES)[number];
export type PhotoMilkChoiceId = PhotoMilkChoice["id"];

/**
 * Vision uncertainty that is only about which milk it might be.
 * An explicit card choice drops these sentences. A model label of 全脂奶
 * that still carries 杏仁奶 in uncertaintyReasons is not a user choice
 * and keeps that evidence.
 */
const MILK_TYPE_UNCERTAINTY =
  /低脂|脫脂|脱脂|全脂|鮮奶|植物奶|燕麥|燕麦|豆漿|杏仁奶|(?:^|\s)(?:oat|oats|soy|soya|almond|skim|low fat|reduced fat|whole milk|fresh milk|plant milk)(?:$|\s)/;

export function isMilkTypeUncertainty(reason: string): boolean {
  return MILK_TYPE_UNCERTAINTY.test(normalizeFoodName(reason));
}

export function photoMilkChoiceByLabel(name: string): Exclude<PhotoMilkChoice, { id: "other" }> | null {
  const text = normalizeFoodName(name);
  const choice = PHOTO_MILK_CHOICES.find((item) => item.id !== "other" && normalizeFoodName(item.displayName) === text);
  return choice && choice.id !== "other" ? choice : null;
}

type MilkSubject = {
  displayName: string;
  normalizedName: string;
  identityLevel: FoodIdentityLevel;
  uncertaintyReasons: string[];
  preparationMethod?: string;
  visibleIngredients?: string[];
  notes?: string;
};

/**
 * A tapped milk-type button, or a model row already named 全脂 / 鮮奶 but
 * filed as a dish. Generic 牛奶 stays generic so the chooser still appears.
 * Item-level plant or low-fat evidence is left alone for 全脂奶 / 鮮奶;
 * the button label 全脂牛奶 is the user's choice and clears that evidence.
 */
export function milkResolveSubject<T extends MilkSubject>(food: T): T {
  const choice = photoMilkChoiceByLabel(food.displayName);
  if (choice) {
    // A model can name the row 全脂牛奶 while still saying it could not tell
    // low-fat or plant milk apart. That doubt stays in force until the card
    // choice removes it. After that, the label is one ingredient.
    if (food.uncertaintyReasons.some((reason) => isMilkTypeUncertainty(reason))) return food;
    return {
      ...food,
      displayName: choice.displayName,
      normalizedName: choice.normalizedName,
      identityLevel: "ingredient",
      preparationMethod: undefined,
      visibleIngredients: undefined,
      notes: undefined,
    };
  }
  if (food.identityLevel !== "dish") return food;
  if (genericMilkLabel(food.displayName)) return food;
  if (explicitLowFatMilk(food) || contradictoryDairyMilkLabel(food)) return food;
  const named = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  const explicitWhole = /全脂|鮮奶|(?:^|\s)(?:whole milk|fresh milk)(?:$|\s)/.test(named);
  if (!explicitWhole) return food;
  return {
    ...food,
    identityLevel: "ingredient",
    normalizedName: "whole milk",
    preparationMethod: undefined,
    visibleIngredients: undefined,
    notes: undefined,
  };
}
