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
 * chooser and do not invent a direct calorie. Meal unknownInformation that
 * only says the drink might be milk or plant milk is not plant evidence.
 *
 * Choosing 全脂牛奶 sets userMilkTypeChoice. Only that flag forces one
 * whole-milk ingredient, even when the model called the row a dish.
 * A model row already named 全脂牛奶 is not a choice: oat-carton notes
 * still fail the plant-milk check. Choosing 其他 stores its note on
 * otherMilkNotice, hides the buttons, and does not open a text field.
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
/** Set only when the user taps a chooser button. Never inferred from the name. */
export type UserMilkTypeChoice = PhotoMilkChoiceId;

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
  userMilkTypeChoice?: UserMilkTypeChoice;
};

/**
 * A tapped milk-type button forces that ingredient. The flag is the only
 * signal. A model row named 全脂牛奶 keeps its notes so an oat carton can
 * still contradict dairy milk. Generic 牛奶 stays generic. A model dish
 * already named 全脂 or 鮮奶, with no plant or low-fat evidence, is one
 * whole-milk ingredient so it does not fall through as an unknown dish.
 */
export function milkResolveSubject<T extends MilkSubject>(food: T): T {
  const choice = food.userMilkTypeChoice && food.userMilkTypeChoice !== "other"
    ? PHOTO_MILK_CHOICES.find((item) => item.id === food.userMilkTypeChoice)
    : undefined;
  if (choice && choice.id !== "other") {
    return {
      ...food,
      displayName: choice.displayName,
      normalizedName: choice.normalizedName,
      identityLevel: "ingredient",
      preparationMethod: undefined,
      visibleIngredients: undefined,
      notes: undefined,
      uncertaintyReasons: food.uncertaintyReasons.filter((reason) => !isMilkTypeUncertainty(reason)),
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
