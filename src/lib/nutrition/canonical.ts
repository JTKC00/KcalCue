import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { DISH_IDENTITIES, type DishIdentity } from "./dish-identity";
import { dishTemplateIsComplete } from "./recipe-templates";
import {
  NEGATIVE_MATCH_RULES,
  PHOTO_MILK_OTHER_REASON,
  PLANT_MILK_CONTEXT_CUES,
  SALAD_NAME_SPELLINGS,
  type NegativeMatchRule,
} from "./negative-rules";
import type {
  CanonicalFoodIdentity,
  FoodCategory,
  FoodPreparation,
} from "./types";

export type IdentityKind =
  | "named_dish"
  | "dish_class"
  | "specific_food"
  | "generic_ingredient";

export const IDENTITY_KIND_RANK: Record<IdentityKind, number> = {
  named_dish: 4,
  dish_class: 3,
  specific_food: 2,
  generic_ingredient: 1,
};

interface TermRule {
  keys: string[];
  canonicalName: string;
  category: FoodCategory;
  kind: IdentityKind;
  qualifiers?: string[];
}

interface PreparationRule {
  keys: string[];
  preparation: FoodPreparation;
}

interface IdentityHit extends TermRule {
  matchedKey: string;
}

type IdentityFamily = "starch" | "protein" | "sauce" | "dish" | "other";

const PREPARATION_RULES: PreparationRule[] = [
  { keys: ["pan-seared", "pan seared", "pan-fried", "pan fried", "香煎", "煎"], preparation: "pan_fried" },
  { keys: ["stir-fried", "stir fried", "stirfried", "炒"], preparation: "stir_fried" },
  { keys: ["deep-fried", "deep fried", "油炸", "炸"], preparation: "deep_fried" },
  { keys: ["grilled", "roasted", "roast", "烤"], preparation: "grilled" },
  { keys: ["steamed", "蒸"], preparation: "steamed" },
  { keys: ["boiled", "烚", "水煮"], preparation: "boiled" },
  { keys: ["raw", "生"], preparation: "raw" },
  { keys: ["cooked", "熟"], preparation: "cooked" },
];

const IDENTITY_RULES: TermRule[] = [
  { keys: ["risotto", "意大利飯", "italian rice"], canonicalName: "risotto", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["baked rice", "焗飯"], canonicalName: "baked-rice", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["braised rice", "燴飯"], canonicalName: "braised-rice", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  {
    keys: [
      "fried rice",
      "fried white rice",
      "fried cooked rice",
      "fried leftover rice",
      "leftover rice dish",
      "leftover rice fried",
      "炒飯",
      "炒白飯",
      "炒白米飯",
      "炒米飯",
      "炒隔夜飯",
      "炒隔夜米飯",
      "炒剩飯",
      "炒剩餘飯",
      "剩飯炒",
    ],
    canonicalName: "fried-rice",
    category: "mixed",
    kind: "named_dish",
    qualifiers: ["composite"],
  },
  {
    keys: ["curry rice", "咖喱飯", "咖哩飯"],
    canonicalName: "curry-rice",
    category: "mixed",
    kind: "named_dish",
    qualifiers: ["composite"],
  },
  {
    keys: [
      "char siu rice",
      "cha siu rice",
      "char siu with rice",
      "siu mei rice",
      "叉燒飯",
      "叉燒白飯",
      "燒味飯",
    ],
    canonicalName: "siu-mei-rice",
    category: "mixed",
    kind: "named_dish",
    qualifiers: ["composite"],
  },
  { keys: ["claypot rice", "clay pot rice", "煲仔飯"], canonicalName: "claypot-rice", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["donburi", "丼飯", "丼"], canonicalName: "donburi", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["bibimbap", "石鍋拌飯", "拌飯"], canonicalName: "bibimbap", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["chow mein", "lo mein", "fried noodles", "stir-fried noodles", "stir fried noodles", "炒麵", "撈麵"], canonicalName: "fried-noodles", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["wonton noodles", "wonton noodle soup", "wonton mein", "雲吞麵", "餛飩麵"], canonicalName: "noodle-soup", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["noodle soup", "湯麵"], canonicalName: "noodle-soup", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["rice noodle roll", "rice rolls", "cheung fun", "腸粉"], canonicalName: "rice-noodle-roll", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["century egg pork congee", "pork congee", "皮蛋瘦肉粥"], canonicalName: "congee", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["congee", "rice porridge", "白粥", "粥"], canonicalName: "congee", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["hong kong milk tea", "milk tea", "港式奶茶", "奶茶"], canonicalName: "milk-tea", category: "dairy", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["carbonara", "spaghetti carbonara"], canonicalName: "carbonara", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["bolognese", "spaghetti bolognese", "肉醬意粉", "肉醬意大利粉", "肉醬麵", "肉醬"], canonicalName: "bolognese", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["ramen", "拉麵"], canonicalName: "ramen", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["laksa"], canonicalName: "laksa", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["pasta with sauce", "spaghetti", "pasta", "意粉", "意大利粉"], canonicalName: "pasta", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["beef curry", "咖喱牛腩", "咖哩牛腩", "咖喱", "咖哩", "curry"], canonicalName: "curry", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["stew", "stewed", "燉"], canonicalName: "stew", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["casserole"], canonicalName: "casserole", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["hotpot", "hot pot", "火鍋"], canonicalName: "hotpot", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["pizza"], canonicalName: "pizza", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["burrito"], canonicalName: "burrito", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["wrap"], canonicalName: "wrap", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["sandwich", "sandwiches", "三文治", "三明治"], canonicalName: "sandwich", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["dumpling", "gyoza", "水餃", "鍋貼", "餃子"], canonicalName: "dumpling", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["chicken breast", "chicken-breast", "雞胸肉", "雞胸扒", "雞胸"], canonicalName: "chicken-breast", category: "poultry", kind: "specific_food" },
  { keys: ["chicken thigh", "chicken steak", "chicken cutlet", "雞扒", "雞腿", "雞脾"], canonicalName: "chicken-thigh", category: "poultry", kind: "specific_food" },
  { keys: ["chicken", "雞肉"], canonicalName: "chicken", category: "poultry", kind: "generic_ingredient" },
  { keys: ["beef steak", "beef", "牛扒", "牛肉"], canonicalName: "beef", category: "beef", kind: "generic_ingredient" },
  { keys: ["pork chop", "pork", "豬扒", "豬肉"], canonicalName: "pork", category: "pork", kind: "generic_ingredient" },
  { keys: ["salmon", "三文魚"], canonicalName: "salmon", category: "seafood", kind: "specific_food" },
  { keys: ["brown rice", "red rice", "紅米飯", "紅米", "糙米", "紫米"], canonicalName: "rice", category: "rice", kind: "specific_food", qualifiers: ["wholegrain"] },
  { keys: ["white rice", "cooked white rice", "白米飯", "白飯", "米飯"], canonicalName: "rice", category: "rice", kind: "specific_food" },
  { keys: ["rice", "飯"], canonicalName: "rice", category: "rice", kind: "generic_ingredient" },
  { keys: ["noodles", "egg noodles", "麵條", "麵"], canonicalName: "noodles", category: "noodles", kind: "generic_ingredient" },
  { keys: ["white bread", "toast", "方包", "多士", "白麵包", "麵包"], canonicalName: "bread", category: "bread", kind: "specific_food" },
  { keys: ["mixed vegetables", "assorted vegetables", "什錦蔬菜", "雜菜"], canonicalName: "mixed-vegetables", category: "vegetable", kind: "specific_food", qualifiers: ["mixed"] },
  { keys: ["leafy greens", "bok choy", "choy sum", "菜心", "白菜", "青菜"], canonicalName: "leafy-greens", category: "vegetable", kind: "specific_food" },
  { keys: ["vegetables", "vegetable", "蔬菜"], canonicalName: "vegetables", category: "vegetable", kind: "generic_ingredient" },
  { keys: ["tomato sauce", "marinara", "番茄醬", "茄汁"], canonicalName: "tomato-sauce", category: "sauce", kind: "specific_food", qualifiers: ["tomato"] },
  { keys: ["savory sauce", "豉油汁", "醬汁"], canonicalName: "sauce", category: "sauce", kind: "specific_food" },
  { keys: ["tomato", "番茄", "蕃茄"], canonicalName: "tomato", category: "sauce", kind: "specific_food", qualifiers: ["tomato"] },
  { keys: ["sauce", "gravy", "汁", "醬"], canonicalName: "sauce", category: "sauce", kind: "generic_ingredient" },
  { keys: ["fried egg", "boiled egg", "雞蛋", "煎蛋", "烚蛋", "egg"], canonicalName: "egg", category: "egg", kind: "specific_food" },
  { keys: ["firm tofu", "bean curd", "豆腐", "tofu"], canonicalName: "tofu", category: "tofu", kind: "specific_food" },
  { keys: ["french fries", "fries", "chips", "薯條"], canonicalName: "french-fries", category: "fried", kind: "specific_food" },
  { keys: ["fresh milk", "whole milk", "milk", "鮮奶", "全脂奶", "牛奶"], canonicalName: "milk", category: "dairy", kind: "specific_food" },
  { keys: ["banana", "香蕉"], canonicalName: "banana", category: "fruit", kind: "specific_food" },
  { keys: ["apple", "蘋果"], canonicalName: "apple", category: "fruit", kind: "specific_food" },
];

const SALAD_WORD = new RegExp(
  `(?:^|\\s)salads?(?:$|\\s)|(?:${SALAD_NAME_SPELLINGS.join("|")})(?!醬)`,
);
const SALAD_LEAN_EXCLUSION =
  /banana|apple|mango|grape|fruit|potato|pasta|jelly|香蕉|蘋果|芒果|葡萄|水果|雜果|薯|意粉|啫喱|果沙律|果沙拉/;
const SALAD_COMPONENT =
  /vegetables?|veggies?|greens?|protein|chicken|salmon|beef|pork|tofu|tuna|shrimp|prawn|grilled|roasted|雜菜|蔬菜|生菜|青菜|蛋白質|蛋白|雞胸|雞腿|雞扒|雞肉|三文魚|牛肉|豬肉|豆腐|吞拿|蝦|燒烤|烤/;
const SALAD_DRESSING_CUE = /(?:^|\s)dressing(?:$|\s)/;
const SALAD_DRESSING_NEGATION =
  /(?:^|\s)(?:no|without) dressing(?:$|\s)|不加醬|沒有沙律醬|沒有沙拉醬|走醬/;

function saladSearchName(food: FoodEstimate): string {
  return normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
}

function ruleMatchesName(rule: NegativeMatchRule, name: string): boolean {
  return rule.patterns.some((pattern) =>
    textContainsKey(name, pattern, { skipLongerAliasShadow: true }),
  );
}

function saladDressingRules(name: string): NegativeMatchRule[] {
  return NEGATIVE_MATCH_RULES.filter(
    (rule) => rule.kind === "salad-dressing" && ruleMatchesName(rule, name),
  );
}

/**
 * Dressing rules come from the negative-match table. A rule that refuses
 * every profile wins over one that still has a creamy-salad route.
 * Visible ingredients are not consulted.
 */
function matchingSaladDressingRule(name: string): NegativeMatchRule | null {
  const rules = saladDressingRules(name);
  return rules.find((rule) => rule.routeCanonicalName === null) ?? rules[0] ?? null;
}

/**
 * Mayo, macaroni, caesar, cheese and thousand-island salads are high-fat.
 * The dish name itself must carry the cue. Visible ingredients are often
 * guesses and must not move a lean salad into this profile. 「沙律醬」 is the
 * dressing, not a salad: the salad word does not match when 醬 follows it.
 */
function creamMacaroniText(food: FoodEstimate): string {
  return normalizeFoodName(
    [food.displayName, food.normalizedName, food.notes ?? "", food.preparationMethod ?? ""].join(" "),
  );
}

/**
 * Hot or sauced cream macaroni. These must not use the cold salad profile.
 * Chinese and English cues are the same ideas: 熱食/hot, 粟米忌廉/corn cream,
 * 忌廉汁/cream sauce, 焗/baked/gratin, plus 熱辣. Bare 熱 would match 高熱量,
 * and corn or 粟米 alone is not the cream-corn dish.
 */
function hasHotCreamMacaroniCue(name: string): boolean {
  return /焗|熱食|熱辣|粟米忌廉|玉米忌廉|忌廉汁|(?:^|\s)(?:baked|gratin|hot|corn cream|cream sauce)(?:$|\s)/.test(name);
}

function hasColdCreamMacaroniCue(name: string): boolean {
  return SALAD_WORD.test(name) || /凍|冷盤|冷食|(?:^|\s)(?:cold|chilled)(?:$|\s)/.test(name);
}

function hasCreamMacaroniStem(name: string): boolean {
  if (/(?:^|\s)soup(?:$|\s)|湯/.test(name)) return false;
  return /忌廉通粉|忌廉通心粉|忌廉汁通粉|忌廉汁通心粉|(?:^|\s)(?:cream|creamy) macaroni(?:$|\s)|macaroni in cream/.test(name);
}

/** Salad or an explicit cold cue, and no hot/baked/sauce cue. */
function isColdCreamMacaroni(food: FoodEstimate): boolean {
  const name = creamMacaroniText(food);
  return hasCreamMacaroniStem(name) && hasColdCreamMacaroniCue(name) && !hasHotCreamMacaroniCue(name);
}

/** Plain, hot, baked, or cream-sauce macaroni. Not a completed salad. */
function isUnspecifiedCreamMacaroni(food: FoodEstimate): boolean {
  const name = creamMacaroniText(food);
  if (!hasCreamMacaroniStem(name) || isColdCreamMacaroni(food)) return false;
  return true;
}

function isHotCreamMacaroni(food: FoodEstimate): boolean {
  const name = creamMacaroniText(food);
  return hasCreamMacaroniStem(name) && hasHotCreamMacaroniCue(name);
}

function isCreamySalad(food: FoodEstimate): boolean {
  const name = saladSearchName(food);
  if (!SALAD_WORD.test(name)) return false;
  return matchingSaladDressingRule(name)?.routeCanonicalName === "creamy-salad";
}

function hasUnnegatedDressing(name: string): boolean {
  return SALAD_DRESSING_CUE.test(name) && !SALAD_DRESSING_NEGATION.test(name);
}

/**
 * A named protein or vegetable salad can use the lean wide-range profile.
 * A salad bowl alone is not enough. Fruit, potato, pasta, creamy dressings
 * and an unspecified dressing stay off this density.
 */
function isProteinVegetableSalad(food: FoodEstimate): boolean {
  const name = saladSearchName(food);
  if (!SALAD_WORD.test(name) || SALAD_LEAN_EXCLUSION.test(name)) return false;
  if (matchingSaladDressingRule(name) || hasUnnegatedDressing(name)) return false;
  const leanGuard = NEGATIVE_MATCH_RULES.find((rule) => rule.id === "chicken-breast-salad-not-creamy");
  if (leanGuard && ruleMatchesName(leanGuard, name) && leanGuard.routeCanonicalName === "protein-vegetable-salad") {
    return true;
  }
  return SALAD_COMPONENT.test(name);
}

const COMPOSITE_CANONICALS = new Set([
  "risotto",
  "baked-rice",
  "braised-rice",
  "fried-rice",
  "curry-rice",
  "siu-mei-rice",
  "claypot-rice",
  "donburi",
  "bibimbap",
  "fried-noodles",
  "noodle-soup",
  "rice-noodle-roll",
  "congee",
  "milk-tea",
  "carbonara",
  "bolognese",
  "pasta",
  "ramen",
  "laksa",
  "curry",
  "stew",
  "casserole",
  "hotpot",
  "pizza",
  "burrito",
  "wrap",
  "sandwich",
  "dumpling",
  "rice-dish",
  "noodle-dish",
  "bread-dish",
  "mixed-dish",
  "protein-vegetable-salad",
  "creamy-salad",
  "dressed-salad",
  "cream-macaroni",
]);

const SIMPLE_RICE_MODIFIERS = [
  "white rice",
  "brown rice",
  "red rice",
  "black rice",
  "purple rice",
  "cooked white rice",
  "plain cooked rice",
  "plain rice",
  "steamed rice",
  "boiled rice",
  "cooked rice",
  "白米飯",
  "白飯",
  "紅米飯",
  "糙米飯",
  "紫米飯",
  "黑米飯",
  "米飯",
  "白米",
  "紅米",
  "糙米",
  "紫米",
  "黑米",
  "white",
  "brown",
  "red",
  "black",
  "purple",
  "plain",
  "cooked",
  "steamed",
  "boiled",
  "hot",
  "mixed",
  "mix",
  "and",
  "with",
  "of",
  "the",
  "rice",
  "飯",
  "和",
  "與",
  "的",
  "熟",
  "蒸",
  "烚",
  "白",
];

const SIMPLE_NOODLE_MODIFIERS = [
  "egg noodles",
  "noodles",
  "noodle",
  "麵條",
  "蛋麵",
  "麵",
  "egg",
  "cooked",
  "steamed",
  "boiled",
  "plain",
  "and",
  "with",
  "of",
  "the",
  "熟",
  "蒸",
  "烚",
  "的",
];

export function normalizeFoodName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[()（）[\]【】,，.。!！?？:：;；'"`~～/\\|]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MatchOptions {
  singleCjkKeyMustBeStandalone?: boolean;
  /** Negative-rule patterns must still match inside a longer dish name. */
  skipLongerAliasShadow?: boolean;
}

function standaloneCjkRemainder(haystack: string): string {
  let remainder = haystack.replace(/[^\u4e00-\u9fff]/g, "");
  const cjkPreparationKeys = PREPARATION_RULES.flatMap((rule) => rule.keys)
    .filter((key) => /[\u4e00-\u9fff]/.test(key))
    .map((key) => normalizeFoodName(key))
    .sort((left, right) => right.length - left.length);

  for (const modifier of cjkPreparationKeys) {
    remainder = remainder.split(modifier).join("");
  }

  return remainder;
}

function textContainsKey(
  haystack: string,
  key: string,
  options: MatchOptions = {},
): boolean {
  const needle = normalizeFoodName(key);
  if (!needle) return false;
  if (haystack === needle) return true;

  const hasCjk = /[\u4e00-\u9fff]/.test(needle);
  if (!hasCjk) {
    const matched = new RegExp(`(?:^|\\s)${escapeRegExp(needle)}(?:$|\\s)`).test(haystack);
    if (!matched) return false;
    if (options.skipLongerAliasShadow) return true;
    return !longerEnglishAliasShadows(haystack, needle);
  }

  if (
    options.singleCjkKeyMustBeStandalone &&
    [...needle].length === 1
  ) {
    return standaloneCjkRemainder(haystack) === needle;
  }

  return haystack.includes(needle);
}

function englishPhraseIn(haystack: string, phrase: string): boolean {
  const needle = normalizeFoodName(phrase);
  if (!needle) return false;
  if (haystack === needle) return true;
  return new RegExp(`(?:^|\\s)${escapeRegExp(needle)}(?:$|\\s)`).test(haystack);
}

let cachedEnglishAliases: string[] | null = null;

function englishAliases(): string[] {
  if (cachedEnglishAliases) return cachedEnglishAliases;
  const fromRules = IDENTITY_RULES.flatMap((rule) =>
    rule.keys.filter((key) => !/[\u4e00-\u9fff]/.test(key)),
  );
  const fromCatalog = DISH_IDENTITIES.flatMap((identity) =>
    identity.aliases.filter((alias) => alias.script === "english").map((alias) => alias.text),
  );
  cachedEnglishAliases = [...fromRules, ...fromCatalog];
  return cachedEnglishAliases;
}

/**
 * "char siu rice" must not hit "char siu rice plate", and "noodle soup"
 * must not hit "plain noodle soup", once the longer alias is in the catalog.
 * A modifier in front ("seafood fried rice") still matches "fried rice"
 * because no longer alias covers that whole name.
 */
function longerEnglishAliasShadows(haystack: string, key: string): boolean {
  const needle = normalizeFoodName(key);
  return englishAliases().some((alias) => {
    const longer = normalizeFoodName(alias);
    if (longer.length <= needle.length || !longer.includes(needle)) return false;
    return englishPhraseIn(haystack, longer);
  });
}

function findLongestMatch(
  haystack: string,
  keys: string[],
  options: MatchOptions = {},
): string | null {
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (textContainsKey(haystack, key, options)) return key;
  }
  return null;
}

function collectSearchText(food: FoodEstimate): string {
  return normalizeFoodName(
    [
      food.displayName,
      food.normalizedName,
      food.preparationMethod ?? "",
      ...(food.visibleIngredients ?? []),
    ].join(" "),
  );
}

function familyOf(canonicalName: string): IdentityFamily {
  switch (canonicalName) {
    case "rice":
    case "noodles":
    case "bread":
    case "pasta":
    case "risotto":
    case "baked-rice":
    case "braised-rice":
    case "fried-rice":
    case "siu-mei-rice":
    case "claypot-rice":
    case "congee":
    case "donburi":
    case "bibimbap":
    case "fried-noodles":
    case "noodle-soup":
    case "rice-noodle-roll":
    case "rice-dish":
    case "noodle-dish":
    case "bread-dish":
      return "starch";
    case "chicken":
    case "chicken-breast":
    case "chicken-thigh":
    case "beef":
    case "pork":
    case "salmon":
    case "egg":
    case "tofu":
      return "protein";
    case "sauce":
    case "tomato-sauce":
    case "tomato":
      return "sauce";
    default:
      return COMPOSITE_CANONICALS.has(canonicalName) ? "dish" : "other";
  }
}

export function rankIdentityHits(hits: IdentityHit[]): IdentityHit[] {
  return [...hits].sort((left, right) => {
    const leftContainsRight =
      left.matchedKey !== right.matchedKey &&
      textContainsKey(normalizeFoodName(left.matchedKey), right.matchedKey);
    const rightContainsLeft =
      left.matchedKey !== right.matchedKey &&
      textContainsKey(normalizeFoodName(right.matchedKey), left.matchedKey);
    if (leftContainsRight && !rightContainsLeft) return -1;
    if (rightContainsLeft && !leftContainsRight) return 1;

    const kindDelta = IDENTITY_KIND_RANK[right.kind] - IDENTITY_KIND_RANK[left.kind];
    if (kindDelta !== 0) return kindDelta;
    return right.matchedKey.length - left.matchedKey.length;
  });
}

function stripTokens(text: string, tokens: string[]): string {
  const sorted = [...tokens]
    .map((token) => normalizeFoodName(token))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  let remaining = text;
  for (const token of sorted) {
    remaining = remaining.split(token).join(" ");
  }

  return remaining.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ").replace(/\s+/g, " ").trim();
}

function isSimpleRemainder(text: string, modifiers: string[]): boolean {
  const preparationTokens = PREPARATION_RULES.flatMap((rule) => rule.keys);
  return stripTokens(text, [...modifiers, ...preparationTokens]).length === 0;
}

const DAIRY_MILK_LABELS = [
  "semi-skimmed milk",
  "semi skimmed milk",
  "low-fat milk",
  "low fat milk",
  "skimmed milk",
  "skim milk",
  "fresh milk",
  "whole milk",
  "milk",
  "脫脂奶",
  "脱脂奶",
  "低脂奶",
  "全脂牛奶",
  "全脂奶",
  "鮮奶",
  "牛奶",
] as const;

type PlantMilkFood = {
  displayName: string;
  normalizedName: string;
  preparationMethod?: string;
  notes?: string;
  visibleIngredients?: readonly string[];
  uncertaintyReasons?: readonly string[];
};

function plantMilkProductName(text: string): boolean {
  const rule = NEGATIVE_MATCH_RULES.find((item) => item.id === "plant-milk-not-whole-milk");
  return rule ? ruleMatchesName(rule, text) : false;
}

function textHasDairyMilkLabel(text: string): boolean {
  return DAIRY_MILK_LABELS.some((label) =>
    textContainsKey(text, label, { skipLongerAliasShadow: true }),
  );
}

/** Oat or cereal named with dairy milk is not a plant-milk drink. */
function isGrainWithDairyMilk(name: string): boolean {
  const text = normalizeFoodName(name);
  if (!text || plantMilkProductName(text)) return false;
  const grain = /燕麥|燕麦|麥片|麦片|粥|(?:^|\s)(?:cereal|oatmeal|porridge)(?:$|\s)/.test(text);
  return grain && textHasDairyMilkLabel(text);
}

const ENGLISH_MILK_MODIFIER = "a glass of|a cup of|glass of|cup of|hot|iced|cold|warm|chilled|small|large|medium";
const CJK_MILK_MODIFIER = "一杯|[熱凍暖大細]";
const GENERIC_MILK_PHRASES = [
  "玻璃杯中的",
  "玻璃樽",
  "玻璃杯",
  "杯中的",
  "carton of",
  "bottle of",
  "beverage",
  "玻璃",
  "杯裝",
  "瓶裝",
  "盒裝",
  "紙盒",
  "紙包",
  "飲品",
  "飲料",
  "中的",
  "glass",
  "carton",
  "bottle",
  "drink",
  "plain",
  "white",
  "cup",
];

/**
 * Temperature and size words may wrap a milk label. 熱牛奶、暖鮮奶、
 * 一杯牛奶、hot milk、"a cup of milk" and small/large/medium milk are
 * still milk. Dish words are not modifiers, so 牛奶布甸、奶茶、milk tea
 * and 牛奶麥片 stay excluded.
 */
function milkLabelCore(text: string): string {
  const leadingEnglish = new RegExp(`^(?:(?:${ENGLISH_MILK_MODIFIER})\\s+)+`);
  const trailingEnglish = new RegExp(`(?:\\s+(?:${ENGLISH_MILK_MODIFIER}))+$`);
  const leadingCjk = new RegExp(`^(?:${CJK_MILK_MODIFIER})+`);
  const trailingCjk = new RegExp(`(?:${CJK_MILK_MODIFIER})+$`);
  let remaining = text;
  let previous = "";
  while (remaining !== previous) {
    previous = remaining;
    remaining = remaining
      .replace(leadingEnglish, "")
      .replace(leadingCjk, "")
      .replace(trailingEnglish, "")
      .replace(trailingCjk, "")
      .trim();
  }
  return remaining;
}

/**
 * The food name is a dairy-milk label, not a longer dish that merely
 * contains the word. 牛奶布甸、奶茶 and 牛奶麥片 are not milk drinks.
 */
function dairyMilkLabel(name: string): boolean {
  const text = normalizeFoodName(name);
  if (!text || plantMilkProductName(text)) return false;
  const core = milkLabelCore(text);
  return DAIRY_MILK_LABELS.some((label) => normalizeFoodName(label) === core);
}

const EXPLICIT_DAIRY_QUALIFIER =
  /全脂|鮮奶|低脂|脫脂|脱脂|(?:^|\s)(?:whole|fresh|skimmed|skim|semi-skimmed|semi skimmed|low-fat|low fat|reduced-fat|reduced fat)(?:$|\s)/;

const NON_MILK_DISH =
  /奶茶|布甸|布丁|麥片|麦片|粥|咖啡|拿鐵|latte|(?:^|\s)tea(?:$|\s)|pudding|cereal|porridge/;

/**
 * Drop glass, carton, and "drink" wording so 冷牛奶、牛奶飲品、玻璃杯牛奶
 * and "glass of milk" still read as plain milk. 鮮奶 is handled earlier.
 */
function unwrapGenericMilkPhrase(text: string): string {
  const phrases = [...GENERIC_MILK_PHRASES].sort((left, right) => right.length - left.length);
  let remaining = text;
  let previous = "";
  while (remaining !== previous) {
    previous = remaining;
    remaining = milkLabelCore(remaining);
    for (const phrase of phrases) remaining = remaining.split(phrase).join(" ");
    remaining = remaining
      .replace(/^[冷冰純白鮮杯]+/u, "")
      .replace(/[冷冰純白鮮杯]+$/u, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return remaining;
}

/**
 * 牛奶 / milk / 奶, including temperature, glass, and "drink" wording.
 * 鮮奶、全脂、低脂、脫脂 are explicit dairy qualifiers, not this generic label.
 * Chocolate milk is neither: it must not fall through to whole milk.
 *
 * Photo versus manual: a photo item with this label does not use the Hong
 * Kong fresh-milk default. Typed manual 鮮奶 / 牛奶 still does, because
 * that default is what the manual QA cases lock in.
 */
export function genericMilkLabel(name: string): boolean {
  const text = normalizeFoodName(name);
  if (!text || plantMilkProductName(text)) return false;
  if (EXPLICIT_DAIRY_QUALIFIER.test(text)) return false;
  if (/朱古力|巧克力|chocolate/.test(text)) return false;
  if (NON_MILK_DISH.test(text)) return false;
  const core = unwrapGenericMilkPhrase(text);
  return core === "milk" || core === "牛奶" || core === "奶";
}

/**
 * Photo item that is still plain milk. The chooser depends on the names,
 * not on identityLevel or meal-level visibleEvidence. A model guess of
 * "whole milk" in normalizedName does not count as type evidence when the
 * display name is still generic. Meal text that only says the drink might
 * be milk or plant milk is not plant evidence and must not hide the chooser.
 */
export function photoGenericMilkNeedsConfirmation(
  food: PlantMilkFood & { entrySource?: "photo" | "manual" },
  context?: MealPlantMilkContext,
): boolean {
  // Meal-level visibleEvidence must not hide the chooser. Callers still pass it.
  void context;
  if (food.entrySource !== "photo") return false;
  const display = normalizeFoodName(food.displayName);
  const normalized = normalizeFoodName(food.normalizedName);
  if (plantMilkProductName(display) || chocolateMilkName(food)) return false;
  if (NON_MILK_DISH.test(`${display} ${normalized}`)) return false;
  if (genericMilkLabel(food.displayName)) return true;
  if (EXPLICIT_DAIRY_QUALIFIER.test(display) || EXPLICIT_DAIRY_QUALIFIER.test(normalized)) return false;
  if (plantMilkProductName(normalized)) return false;
  return genericMilkLabel(food.normalizedName);
}

export function blocksUsdaLiveLookup(
  food: PlantMilkFood & {
    entrySource?: "photo" | "manual";
    userMilkTypeChoice?: string;
    otherMilkNotice?: string;
  },
  context?: MealPlantMilkContext,
): boolean {
  if (food.userMilkTypeChoice === "other" || food.otherMilkNotice === PHOTO_MILK_OTHER_REASON) return true;
  if (food.uncertaintyReasons?.includes(PHOTO_MILK_OTHER_REASON)) return true;
  return contradictoryDairyMilkLabel(food, context)
    || photoGenericMilkNeedsConfirmation(food, context)
    || chocolateMilkName(food);
}

const LOW_FAT_MILK_LABELS = [
  "semi-skimmed milk",
  "semi skimmed milk",
  "low-fat milk",
  "low fat milk",
  "skimmed milk",
  "skim milk",
  "脫脂奶",
  "脱脂奶",
  "低脂奶",
] as const;

/** Skim or low-fat milk. 鮮奶 with this evidence stays off the whole-milk profile. */
function lowFatMilkEvidence(food: PlantMilkFood): boolean {
  const text = normalizeFoodName(
    [
      food.displayName,
      food.normalizedName,
      food.preparationMethod ?? "",
      food.notes ?? "",
      ...(food.visibleIngredients ?? []),
      ...(food.uncertaintyReasons ?? []),
    ].join(" "),
  );
  if (/低脂|脫脂|脱脂/.test(text)) return true;
  return LOW_FAT_MILK_LABELS.some((label) =>
    textContainsKey(text, label, { skipLongerAliasShadow: true }),
  );
}

/** Low-fat or skim dairy milk. Plant-milk names and milk tea stay out. */
export function explicitLowFatMilk(food: PlantMilkFood): boolean {
  if (!lowFatMilkEvidence(food)) return false;
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (!text || plantMilkProductName(text)) return false;
  if (/奶茶|布甸|麥片|粥|(?:^|\s)(?:tea|pudding|cereal|porridge)(?:$|\s)/.test(text)) return false;
  return /奶|milk/.test(text);
}

/**
 * Same container when the vision model splits one milk drink into copies.
 * Null when the food is not a milk drink. Visual notes, preparation, and
 * visible ingredients stay in the caller so two different cups do not merge.
 */
export function containerMilkNameKey(food: {
  displayName: string;
  normalizedName: string;
}): string | null {
  const display = normalizeFoodName(food.displayName);
  const normalized = normalizeFoodName(food.normalizedName);
  const milkish =
    genericMilkLabel(food.displayName) ||
    genericMilkLabel(food.normalizedName) ||
    dairyMilkLabel(food.displayName) ||
    dairyMilkLabel(food.normalizedName) ||
    plantMilkProductName(display) ||
    plantMilkProductName(normalized);
  if (!milkish) return null;
  return `${display}\n${normalized}`;
}

/**
 * Grain words inside a porridge or cereal-with-milk name. They are the
 * grain, not a plant-milk drink. Soy, almond, and explicit plant-milk
 * product names still count.
 */
const GRAIN_NOT_PLANT_MILK_CUES = new Set<string>(["oat", "oats", "燕麥", "燕麦"]);

/** Almond slices and soybeans are ingredients, not almond milk or soy milk. */
function plantMilkCueText(text: string): string {
  return text
    .replace(/杏仁片/g, " ")
    .replace(/黃豆/g, " ")
    .replace(/\balmond (?:slices|flakes|slivers)\b/g, " ")
    .replace(/\bsoy ?beans?\b/g, " ");
}

/**
 * "Could not tell whether this is milk or plant milk" is uncertainty, not
 * a sighting. 紙盒寫有燕麥奶 and 植物奶字樣 stay as evidence.
 */
function dropUnknownMilkOrPlantClauses(text: string): string {
  return text
    .replace(/未能確認是否為[^。；;]*/g, " ")
    .replace(/未能確定是否為[^。；;]*/g, " ")
    .replace(/未知是否為[^。；;]*/g, " ")
    .replace(/不確定是否為[^。；;]*/g, " ")
    .replace(/未能確認是[^。；;]*還是[^。；;]*/g, " ");
}

/**
 * Plant-milk evidence on this food. A porridge or cereal-with-milk name
 * does not count bare oat words: 燕麥 there is a separate grain, not oat milk.
 * A meal note that only says the drink might be milk or plant milk does not
 * count either, so it cannot hide the generic-milk chooser.
 */
function plantMilkEvidence(food: PlantMilkFood, context?: MealPlantMilkContext): boolean {
  const text = normalizeFoodName(dropUnknownMilkOrPlantClauses(
    [
      food.displayName,
      food.normalizedName,
      food.preparationMethod ?? "",
      food.notes ?? "",
      ...(food.visibleIngredients ?? []),
      ...(food.uncertaintyReasons ?? []),
      context?.mealNote ?? "",
      ...(context?.visibleEvidence ?? []),
      ...(context?.uncertaintyText ?? []),
    ].join(" "),
  ));
  if (plantMilkProductName(text)) return true;
  const cueText = plantMilkCueText(text);
  const grainWithDairy = [food.displayName, food.normalizedName].some((name) => isGrainWithDairyMilk(name));
  const cues = grainWithDairy
    ? PLANT_MILK_CONTEXT_CUES.filter((cue) => !GRAIN_NOT_PLANT_MILK_CUES.has(cue))
    : PLANT_MILK_CONTEXT_CUES;
  return cues.some((cue) => textContainsKey(cueText, cue, { skipLongerAliasShadow: true }));
}

function blocksDairyMilkIdentity(food: PlantMilkFood): boolean {
  const names = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  return plantMilkProductName(names) || plantMilkEvidence(food);
}

/** 朱古力奶 is not plain dairy milk and must not use the whole-milk profile. */
export function chocolateMilkName(food: PlantMilkFood): boolean {
  const rule = NEGATIVE_MATCH_RULES.find((item) => item.id === "chocolate-milk-not-whole-milk");
  if (!rule) return false;
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  return ruleMatchesName(rule, text);
}

/**
 * Meal-level text that can identify a milk item as plant milk.
 * The food editor has no item note, so the journal note and the photo
 * analysis have to count.
 */
export interface MealPlantMilkContext {
  visibleEvidence?: readonly string[];
  uncertaintyText?: readonly string[];
  mealNote?: string | null;
}

export function mealPlantMilkContext(input: {
  analysis?: {
    visibleEvidence?: readonly string[];
    uncertaintyReasons?: readonly string[];
    estimatedInformation?: readonly string[];
    unknownInformation?: readonly string[];
  } | null;
  mealNote?: string | null;
}): MealPlantMilkContext {
  const analysis = input.analysis;
  return {
    visibleEvidence: analysis?.visibleEvidence,
    uncertaintyText: [
      ...(analysis?.uncertaintyReasons ?? []),
      ...(analysis?.estimatedInformation ?? []),
      ...(analysis?.unknownInformation ?? []),
    ],
    mealNote: input.mealNote,
  };
}

/**
 * The name is dairy milk, including fresh, skim, and low-fat labels, but
 * the item or the rest of the meal says oat, soy, or almond milk.
 * Meal-level visible evidence, the meal note, and meal uncertainty text
 * count for that milk item. A porridge that merely contains dairy milk
 * does not read the meal context.
 */
export function contradictoryDairyMilkLabel(
  food: PlantMilkFood,
  context?: MealPlantMilkContext,
): boolean {
  if (dairyMilkLabel(food.displayName) || dairyMilkLabel(food.normalizedName)) {
    return plantMilkEvidence(food, context);
  }
  // Oat porridge or cereal with milk stays dairy unless the text names a
  // plant-milk product such as 杏仁奶. Almond slices and soybeans do not.
  const grainWithDairy = [food.displayName, food.normalizedName].some((name) => isGrainWithDairyMilk(name));
  if (!grainWithDairy) return false;
  const text = normalizeFoodName(
    [
      food.displayName,
      food.normalizedName,
      food.preparationMethod ?? "",
      food.notes ?? "",
      ...(food.visibleIngredients ?? []),
      ...(food.uncertaintyReasons ?? []),
    ].join(" "),
  );
  return plantMilkProductName(text);
}

function collectIdentityHits(text: string, food: FoodEstimate): IdentityHit[] {
  const hits: IdentityHit[] = [];
  const blockDairyMilk = blocksDairyMilkIdentity(food) || lowFatMilkEvidence(food) || chocolateMilkName(food);
  for (const rule of IDENTITY_RULES) {
    if (rule.canonicalName === "milk" && blockDairyMilk) continue;
    const matchedKey = findLongestMatch(text, rule.keys, {
      singleCjkKeyMustBeStandalone: true,
    });
    if (matchedKey) hits.push({ ...rule, matchedKey });
  }
  return hits;
}

function hasNamedDish(hits: IdentityHit[]): boolean {
  return hits.some((hit) => hit.kind === "named_dish" || hit.kind === "dish_class");
}

function isContainedByLongerHit(hit: IdentityHit, hits: IdentityHit[]): boolean {
  return hits.some(
    (other) =>
      other.matchedKey !== hit.matchedKey &&
      other.matchedKey.length > hit.matchedKey.length &&
      textContainsKey(normalizeFoodName(other.matchedKey), hit.matchedKey),
  );
}

function isCrossFamilyComposite(hits: IdentityHit[]): boolean {
  if (hasNamedDish(hits)) return false;

  const independentHits = hits.filter((hit) => !isContainedByLongerHit(hit, hits));
  const families = new Set(independentHits.map((hit) => familyOf(hit.canonicalName)));
  const hasStarch = families.has("starch");
  const hasProtein = families.has("protein");
  const hasSauce = families.has("sauce");

  return (hasStarch && hasProtein) || (hasStarch && hasSauce);
}

function synthesizedComposite(hits: IdentityHit[]): Pick<
  TermRule,
  "canonicalName" | "category" | "kind" | "qualifiers"
> {
  const names = new Set(hits.map((hit) => hit.canonicalName));
  if (names.has("rice")) {
    return {
      canonicalName: "rice-dish",
      category: "mixed",
      kind: "dish_class",
      qualifiers: ["composite"],
    };
  }
  if (names.has("noodles") || names.has("pasta")) {
    return {
      canonicalName: "noodle-dish",
      category: "mixed",
      kind: "dish_class",
      qualifiers: ["composite"],
    };
  }
  if (names.has("bread")) {
    return {
      canonicalName: "bread-dish",
      category: "mixed",
      kind: "dish_class",
      qualifiers: ["composite"],
    };
  }
  return {
    canonicalName: "mixed-dish",
    category: "mixed",
    kind: "dish_class",
    qualifiers: ["composite"],
  };
}

function synthesizedIdentityHit(
  canonicalName: string,
  kind: IdentityKind = "dish_class",
): IdentityHit {
  return {
    keys: [],
    matchedKey: "",
    canonicalName,
    category: "mixed",
    kind,
    qualifiers: ["composite"],
  };
}

function promoteSimpleStarchIfComposite(
  hit: IdentityHit,
  text: string,
): IdentityHit {
  if (hit.canonicalName === "rice" && !isSimpleRemainder(text, SIMPLE_RICE_MODIFIERS)) {
    return {
      ...hit,
      canonicalName: "rice-dish",
      category: "mixed",
      kind: "dish_class",
      qualifiers: ["composite"],
    };
  }

  if (hit.canonicalName === "noodles" && !isSimpleRemainder(text, SIMPLE_NOODLE_MODIFIERS)) {
    return {
      ...hit,
      canonicalName: "noodle-dish",
      category: "mixed",
      kind: "dish_class",
      qualifiers: ["composite"],
    };
  }

  return hit;
}

export type CuratedDishResolution =
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "matched"; identity: DishIdentity };

function exactDishHits(name: string): DishIdentity[] {
  const normalized = normalizeFoodName(name);
  if (!normalized) return [];
  return DISH_IDENTITIES.filter((identity) =>
    identity.aliases.some((alias) => normalizeFoodName(alias.text) === normalized),
  );
}

function uniqueIdentities(hits: DishIdentity[]): DishIdentity[] {
  return [...new Map(hits.map((hit) => [hit.id, hit])).values()];
}

function containsAsTokenPhrase(longer: string, shorter: string): boolean {
  if (!shorter || longer === shorter) return false;
  return longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`);
}

/** The Chinese dish's English alias properly extends the other identity's alias. */
function chineseIsMoreSpecific(chinese: DishIdentity, english: DishIdentity): boolean {
  const chineseEnglish = chinese.aliases
    .filter((alias) => alias.script === "english")
    .map((alias) => normalizeFoodName(alias.text));
  const englishAliases = english.aliases.map((alias) => normalizeFoodName(alias.text));
  return chineseEnglish.some((longer) =>
    englishAliases.some((shorter) => containsAsTokenPhrase(longer, shorter)),
  );
}

function isChineseField(name: string): boolean {
  return /[\u4e00-\u9fff]/.test(name);
}

/**
 * Exact alias match. A Chinese name is decided before the English name.
 * English cannot replace a more specific Chinese identity. Unrelated
 * Chinese and English identities are ambiguous instead of a guess.
 */
export function resolveCuratedDishIdentity(food: {
  displayName: string;
  normalizedName: string;
}): CuratedDishResolution {
  const displayHits = uniqueIdentities(exactDishHits(food.displayName));
  const normalizedHits = uniqueIdentities(exactDishHits(food.normalizedName));
  const sameName = normalizeFoodName(food.displayName) === normalizeFoodName(food.normalizedName);

  if (sameName) {
    if (displayHits.length === 1) return { status: "matched", identity: displayHits[0] };
    if (displayHits.length > 1) return { status: "ambiguous" };
    return { status: "none" };
  }

  const chinese = uniqueIdentities([
    ...(isChineseField(food.displayName) ? displayHits : []),
    ...(isChineseField(food.normalizedName) ? normalizedHits : []),
  ]);
  const english = uniqueIdentities([
    ...(!isChineseField(food.displayName) ? displayHits : []),
    ...(!isChineseField(food.normalizedName) ? normalizedHits : []),
  ]);

  if (chinese.length > 1) return { status: "ambiguous" };
  if (chinese.length === 1) {
    const chineseIdentity = chinese[0];
    if (!chineseIdentity) return { status: "ambiguous" };
    if (english.length === 0 || english.every((hit) => hit.id === chineseIdentity.id)) {
      return { status: "matched", identity: chineseIdentity };
    }
    if (english.length === 1 && english[0] && chineseIsMoreSpecific(chineseIdentity, english[0])) {
      return { status: "matched", identity: chineseIdentity };
    }
    if (
      english.length === 1 &&
      english[0] &&
      english[0].familyId === chineseIdentity.id &&
      english[0].id !== chineseIdentity.id
    ) {
      return { status: "matched", identity: chineseIdentity };
    }
    return { status: "ambiguous" };
  }
  if (english.length === 1 && english[0]) return { status: "matched", identity: english[0] };
  if (english.length > 1) return { status: "ambiguous" };
  return { status: "none" };
}

function identityFromDish(
  identity: DishIdentity,
  preparation: FoodPreparation,
): CanonicalFoodIdentity {
  return {
    canonicalName: identity.resolverCanonicalName,
    category: identity.category,
    preparation,
    qualifiers: ["composite"],
    dishId: identity.id,
    familyId: identity.familyId,
    hasNutritionProfile:
      identity.nutritionCanonicalName !== null || dishTemplateIsComplete(identity.id),
  };
}

export function canonicalizeFood(food: FoodEstimate): CanonicalFoodIdentity {
  const text = collectSearchText(food);
  const qualifiers = new Set<string>();
  let preparation: FoodPreparation = "unknown";
  let canonicalName = "unknown";
  let category: FoodCategory = "unknown";

  for (const rule of PREPARATION_RULES) {
    if (findLongestMatch(text, rule.keys)) {
      preparation = rule.preparation;
      break;
    }
  }

  const curated = resolveCuratedDishIdentity(food);
  if (curated.status === "ambiguous") {
    return {
      canonicalName: "unknown",
      category: "mixed",
      preparation,
      qualifiers: ["composite", "ambiguous"],
    };
  }
  if (
    curated.status === "matched" &&
    !(curated.identity.id === "creamy-macaroni-salad" && isHotCreamMacaroni(food))
  ) {
    return identityFromDish(curated.identity, preparation);
  }

  const identityHits = collectIdentityHits(text, food);
  const saladName = saladSearchName(food);
  const dressingRule = SALAD_WORD.test(saladName) ? matchingSaladDressingRule(saladName) : null;
  if (!hasNamedDish(identityHits)) {
    if (isUnspecifiedCreamMacaroni(food)) {
      identityHits.push({
        keys: [],
        matchedKey: "cream macaroni",
        canonicalName: "cream-macaroni",
        category: "mixed",
        kind: "named_dish",
        qualifiers: ["composite"],
      });
    } else if (dressingRule?.routeCanonicalName === null) {
      identityHits.push({
        keys: [],
        matchedKey: "dressed salad",
        canonicalName: "dressed-salad",
        category: "mixed",
        kind: "named_dish",
        qualifiers: ["composite"],
      });
    } else if (isColdCreamMacaroni(food) || isCreamySalad(food)) {
      identityHits.push({
        keys: [],
        matchedKey: "creamy salad",
        canonicalName: "creamy-salad",
        category: "mixed",
        kind: "named_dish",
        qualifiers: ["composite"],
      });
    } else if (isProteinVegetableSalad(food)) {
      identityHits.push({
        keys: [],
        matchedKey: "protein vegetable salad",
        canonicalName: "protein-vegetable-salad",
        category: "mixed",
        kind: "named_dish",
        qualifiers: ["composite"],
      });
    }
  }
  const rankedHits = rankIdentityHits(identityHits);

  const hasTomato = identityHits.some((rule) => rule.canonicalName === "tomato");
  const hasSauce = identityHits.some((rule) =>
    ["sauce", "tomato-sauce"].includes(rule.canonicalName),
  );
  const hasCurry = identityHits.some((rule) =>
    ["curry", "curry-rice"].includes(rule.canonicalName),
  );
  const hasRice = identityHits.some((rule) => rule.canonicalName === "rice");
  const hasCurryRiceDish =
    identityHits.some((rule) => rule.canonicalName === "curry-rice") ||
    (hasCurry && hasRice);
  const tomatoSauceOverride =
    hasTomato &&
    (hasSauce || text.includes("風味") || text.includes("flavor")) &&
    !hasNamedDish(identityHits) &&
    !identityHits.some((hit) => familyOf(hit.canonicalName) === "starch");

  let primary: IdentityHit | undefined;

  const grainWithMilk =
    (isGrainWithDairyMilk(food.displayName) || isGrainWithDairyMilk(food.normalizedName))
    && !plantMilkEvidence(food);
  const milkHit = identityHits.find((hit) => hit.canonicalName === "milk");
  if (food.identityLevel === "dish" && grainWithMilk && milkHit) {
    primary = milkHit;
  } else if (food.identityLevel === "dish") {
    primary = hasCurryRiceDish
      ? synthesizedIdentityHit("curry-rice")
      : rankedHits.find((hit) => hit.kind === "named_dish" || hit.kind === "dish_class") ??
        synthesizedIdentityHit("mixed-dish");
  } else if (tomatoSauceOverride) {
    canonicalName = "tomato-sauce";
    category = "sauce";
    qualifiers.add("tomato");
  } else if (hasCurryRiceDish) {
    primary = synthesizedIdentityHit("curry-rice", "named_dish");
  } else if (hasNamedDish(identityHits)) {
    primary = rankedHits.find((hit) => hit.kind === "named_dish" || hit.kind === "dish_class");
  } else if (isCrossFamilyComposite(identityHits)) {
    const synthesized = synthesizedComposite(identityHits);
    primary = {
      keys: [],
      matchedKey: "",
      canonicalName: synthesized.canonicalName,
      category: synthesized.category,
      kind: synthesized.kind,
      qualifiers: synthesized.qualifiers,
    };
  } else if (rankedHits[0]) {
    primary = promoteSimpleStarchIfComposite(rankedHits[0], text);
  }

  if (primary && !tomatoSauceOverride) {
    canonicalName = primary.canonicalName;
    category = primary.category;
    for (const qualifier of primary.qualifiers ?? []) qualifiers.add(qualifier);
  }

  if (identityHits.some((rule) => rule.qualifiers?.includes("wholegrain"))) {
    qualifiers.add("wholegrain");
  }

  if (
    COMPOSITE_CANONICALS.has(canonicalName) ||
    primary?.kind === "named_dish" ||
    primary?.kind === "dish_class"
  ) {
    qualifiers.add("composite");
  }

  const identified: CanonicalFoodIdentity = {
    canonicalName,
    category,
    preparation,
    qualifiers: [...qualifiers],
  };
  if (canonicalName === "dressed-salad") {
    identified.dishId = "dressed-salad";
    identified.familyId = "salad";
    identified.hasNutritionProfile = false;
  }
  if (canonicalName === "cream-macaroni") {
    identified.dishId = "cream-macaroni";
    identified.familyId = "pasta";
    identified.hasNutritionProfile = false;
  }
  return identified;
}

export function isCompositeIdentity(identity: CanonicalFoodIdentity): boolean {
  return (
    identity.qualifiers.includes("composite") ||
    identity.category === "mixed" ||
    COMPOSITE_CANONICALS.has(identity.canonicalName)
  );
}

export function profileBlockedByNegativeRule(
  food: FoodEstimate,
  identity: CanonicalFoodIdentity,
  profile: { id: string; canonicalName: string; composite: boolean },
): boolean {
  const name = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  for (const rule of NEGATIVE_MATCH_RULES) {
    if (rule.kind === "composite-not-ingredient") {
      if (isCompositeIdentity(identity) && profile.composite !== true) return true;
      continue;
    }
    const described = rule.id === "plant-milk-not-whole-milk"
      ? blocksDairyMilkIdentity(food) || lowFatMilkEvidence(food)
      : ruleMatchesName(rule, name);
    if (!described) continue;
    if (
      rule.blockProfileIds.includes(profile.id) ||
      rule.blockCanonicalNames.includes(profile.canonicalName)
    ) {
      return true;
    }
  }
  return false;
}
