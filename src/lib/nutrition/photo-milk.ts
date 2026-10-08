/**
 * Photo versus manual milk.
 *
 * A photo item whose display name is only 牛奶, 奶, or milk (temperature and
 * size words allowed) is not mapped to USDA whole milk. The food card asks
 * for 全脂牛奶, 低脂牛奶, 燕麥奶, 豆漿, or 其他. Whole milk is used only after
 * the whole-milk choice. Low-fat uses a reduced or low-fat catalog entry when
 * one exists; this repo has none, so that choice stays uncomputed.
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
