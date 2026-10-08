/**
 * Negative match rules. The resolver and canonicalizer read this table;
 * they do not keep a second copy of these names in conditionals.
 *
 * A rule blocks a canonical name or profile. `routeCanonicalName` is the
 * identity to use instead. null means the name stays uncalculated.
 */
export type NegativeRuleKind =
  | "block-profile"
  | "salad-dressing"
  | "composite-not-ingredient";

export interface NegativeMatchRule {
  id: string;
  description: string;
  kind: NegativeRuleKind;
  /**
   * Matched against the dish name only (display + normalized), never against
   * guessed visible ingredients.
   */
  patterns: readonly string[];
  blockCanonicalNames: readonly string[];
  blockProfileIds: readonly string[];
  /** null keeps the food off every nutrition profile. */
  routeCanonicalName: string | null;
}

/** 沙律 and 沙拉 are the same word. 醬 after either one is a dressing, not a salad. */
export const SALAD_NAME_SPELLINGS = ["沙律", "沙拉"] as const;

export const NEGATIVE_MATCH_RULES: readonly NegativeMatchRule[] = [
  {
    id: "plant-milk-not-whole-milk",
    description: "植物奶不得配對 whole-milk。PR #118 已修好，這張表繼續擋住。",
    kind: "block-profile",
    patterns: [
      "soy milk",
      "soya milk",
      "oat milk",
      "almond milk",
      "coconut milk",
      "豆漿",
      "豆奶",
      "燕麥奶",
      "杏仁奶",
      "椰奶",
    ],
    blockCanonicalNames: ["milk"],
    blockProfileIds: ["whole-milk"],
    routeCanonicalName: null,
  },
  {
    id: "chicken-breast-salad-not-creamy",
    description: "雞胸沙拉／雞胸沙律維持瘦身沙律，不得落到 creamy-salad。",
    kind: "block-profile",
    patterns: ["雞胸沙拉", "雞胸沙律", "chicken breast salad"],
    blockCanonicalNames: ["creamy-salad"],
    blockProfileIds: ["creamy-salad"],
    routeCanonicalName: "protein-vegetable-salad",
  },
  {
    id: "creamy-dressing-not-lean-salad",
    description: "千島、凱撒、蛋黃醬、沙律醬與通粉沙律離開 60–160 的瘦身範圍，改走 creamy-salad。",
    kind: "salad-dressing",
    patterns: [
      "macaroni",
      "通粉",
      "通心粉",
      "mayonnaise",
      "mayo",
      "沙律醬",
      "沙拉醬",
      "蛋黃醬",
      "蛋黄酱",
      "千島醬",
      "千岛酱",
      "千島",
      "千岛",
      "thousand island",
      "caesar",
      "凱撒",
      "凯撒",
      "cheese",
      "芝士",
      "起司",
    ],
    blockCanonicalNames: ["protein-vegetable-salad"],
    blockProfileIds: ["protein-vegetable-salad"],
    routeCanonicalName: "creamy-salad",
  },
  {
    id: "sesame-or-vinaigrette-not-lean-salad",
    description: "胡麻醬與油醋汁不是瘦身沙律，也沒有對應的營養 profile，因此不計算。",
    kind: "salad-dressing",
    patterns: ["胡麻醬", "胡麻酱", "油醋汁"],
    blockCanonicalNames: ["protein-vegetable-salad", "creamy-salad"],
    blockProfileIds: ["protein-vegetable-salad", "creamy-salad"],
    routeCanonicalName: null,
  },
  {
    id: "composite-not-single-ingredient",
    description: "組合菜不得拆成單一食材 profile。",
    kind: "composite-not-ingredient",
    patterns: [],
    blockCanonicalNames: [],
    blockProfileIds: [],
    routeCanonicalName: null,
  },
];

export function negativeRuleById(id: string): NegativeMatchRule {
  const rule = NEGATIVE_MATCH_RULES.find((item) => item.id === id);
  if (!rule) throw new Error(`缺少負向規則 ${id}`);
  return rule;
}
