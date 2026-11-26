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
  { keys: ["chow mein", "lo mein", "fried noodles", "stir-fried noodles", "stir fried noodles", "fried udon", "stir-fried udon", "stir fried udon", "yaki udon", "yakiudon", "炒麵", "撈麵", "炒烏冬", "乾炒烏冬", "干炒烏冬"], canonicalName: "fried-noodles", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["wonton noodles", "wonton noodle soup", "wonton mein", "雲吞麵", "餛飩麵"], canonicalName: "noodle-soup", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["noodle soup", "soup noodles", "noodles in soup", "noodles in broth", "湯麵", "清湯麵"], canonicalName: "noodle-soup", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["rice noodle roll", "rice rolls", "cheung fun", "腸粉"], canonicalName: "rice-noodle-roll", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["century egg pork congee", "pork congee", "皮蛋瘦肉粥"], canonicalName: "congee", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["congee", "rice porridge", "白粥", "粥"], canonicalName: "congee", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["hong kong milk tea", "milk tea", "港式奶茶", "奶茶"], canonicalName: "milk-tea", category: "dairy", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["carbonara", "spaghetti carbonara"], canonicalName: "carbonara", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["bolognese", "spaghetti bolognese", "肉醬意粉", "肉醬意大利粉", "肉醬麵", "肉醬"], canonicalName: "bolognese", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["ramen", "拉麵"], canonicalName: "ramen", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["laksa", "喇沙", "叻沙"], canonicalName: "laksa", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["pasta with sauce", "spaghetti", "pasta", "意粉", "意大利粉"], canonicalName: "pasta", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["beef curry", "咖喱牛腩", "咖哩牛腩", "咖喱", "咖哩", "curry"], canonicalName: "curry", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["stew", "stewed", "燉"], canonicalName: "stew", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["casserole"], canonicalName: "casserole", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["hotpot", "hot pot", "火鍋"], canonicalName: "hotpot", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  {
    keys: [
      "cream soup",
      "creamy soup",
      "cream of mushroom soup",
      "mushroom cream soup",
      "chowder",
      "bisque",
      "borscht",
      "忌廉湯",
      "忌廉蘑菇湯",
      "忌廉粟米湯",
      "忌廉雞湯",
      "濃湯",
      "羅宋湯",
    ],
    canonicalName: "creamy-soup",
    category: "mixed",
    kind: "named_dish",
    qualifiers: ["composite"],
  },
  { keys: ["pizza"], canonicalName: "pizza", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["burrito"], canonicalName: "burrito", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["wrap"], canonicalName: "wrap", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["sandwich", "sandwiches", "三文治", "三明治"], canonicalName: "sandwich", category: "mixed", kind: "dish_class", qualifiers: ["composite"] },
  { keys: ["dumpling", "gyoza", "水餃", "鍋貼", "餃子"], canonicalName: "dumpling", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["chicken wings", "chicken wing", "roasted chicken wings", "雞翼", "鸡翼", "雞翅", "鸡翅"], canonicalName: "chicken-wings", category: "poultry", kind: "specific_food" },
  { keys: ["chicken breast", "chicken-breast", "雞胸肉", "雞胸扒", "雞胸"], canonicalName: "chicken-breast", category: "poultry", kind: "specific_food" },
  { keys: ["chicken thigh", "chicken steak", "chicken cutlet", "雞扒", "雞腿", "雞脾"], canonicalName: "chicken-thigh", category: "poultry", kind: "specific_food" },
  { keys: ["chicken", "雞肉"], canonicalName: "chicken", category: "poultry", kind: "generic_ingredient" },
  { keys: ["beef steak", "beef", "牛扒", "牛肉"], canonicalName: "beef", category: "beef", kind: "generic_ingredient" },
  { keys: ["luncheon meat", "spam", "午餐肉"], canonicalName: "luncheon-meat", category: "pork", kind: "specific_food" },
  { keys: ["sliced ham", "ham", "火腿片", "火腿"], canonicalName: "ham", category: "pork", kind: "specific_food" },
  { keys: ["pork sausage", "frankfurter", "sausage", "香腸", "香肠", "腸仔", "肠仔"], canonicalName: "sausage", category: "pork", kind: "specific_food" },
  { keys: ["pork chop", "pork", "豬扒", "豬肉"], canonicalName: "pork", category: "pork", kind: "generic_ingredient" },
  { keys: ["salmon", "三文魚"], canonicalName: "salmon", category: "seafood", kind: "specific_food" },
  { keys: ["cooked shrimp", "shrimp", "prawns", "prawn", "蝦仁", "虾仁", "鮮蝦", "大蝦", "蝦"], canonicalName: "shrimp", category: "seafood", kind: "specific_food" },
  {
    keys: [
      "deep-fried fish",
      "deep fried fish",
      "battered fish",
      "breaded fish",
      "fried fish fillet",
      "fried fish",
      "crispy fried fish",
      "fish katsu",
      "tempura fish",
      "裹粉炸魚",
      "脆炸魚柳",
      "吉列魚柳",
      "炸魚柳",
      "炸鱼柳",
      "炸魚塊",
      "炸魚",
      "炸鱼",
    ],
    canonicalName: "fried-fish",
    category: "seafood",
    kind: "specific_food",
  },
  { keys: ["steamed fish", "white fish", "sea bass", "fish fillet", "蒸魚", "蒸鱼", "清蒸魚", "魚柳", "白肉魚"], canonicalName: "white-fish", category: "seafood", kind: "specific_food" },
  { keys: ["brown rice", "red rice", "紅米飯", "紅米", "糙米", "紫米"], canonicalName: "rice", category: "rice", kind: "specific_food", qualifiers: ["wholegrain"] },
  { keys: ["white rice", "cooked white rice", "白米飯", "白飯", "米飯"], canonicalName: "rice", category: "rice", kind: "specific_food" },
  { keys: ["rice", "飯"], canonicalName: "rice", category: "rice", kind: "generic_ingredient" },
  { keys: ["noodles", "egg noodles", "麵條", "麵"], canonicalName: "noodles", category: "noodles", kind: "generic_ingredient" },
  { keys: ["white bread", "toast", "方包", "多士", "白麵包", "麵包"], canonicalName: "bread", category: "bread", kind: "specific_food" },
  { keys: ["cooked broccoli", "steamed broccoli", "broccoli", "西蘭花", "西兰花", "花椰菜"], canonicalName: "broccoli", category: "vegetable", kind: "specific_food" },
  {
    keys: [
      "clear mushroom soup",
      "mushroom broth",
      "clear soup",
      "clear broth",
      "chicken broth",
      "vegetable soup",
      "miso soup",
      "蘑菇清湯",
      "冬瓜湯",
      "紫菜湯",
      "蔬菜湯",
      "清雞湯",
      "味噌湯",
      "清湯",
      "雞湯",
    ],
    canonicalName: "clear-soup",
    category: "vegetable",
    kind: "specific_food",
  },
  { keys: ["cooked mushrooms", "mushrooms", "mushroom", "shiitake", "菇類", "蘑菇", "冬菇", "鮮菇", "雜菇", "金針菇"], canonicalName: "mushrooms", category: "vegetable", kind: "specific_food" },
  { keys: ["cooked cabbage", "cabbage", "椰菜", "包菜", "高麗菜", "捲心菜"], canonicalName: "cabbage", category: "vegetable", kind: "specific_food" },
  { keys: ["eggplant", "aubergine", "茄子", "矮瓜"], canonicalName: "eggplant", category: "vegetable", kind: "specific_food" },
  { keys: ["sweet potatoes", "sweet potato", "蕃薯", "番薯", "地瓜", "紅薯"], canonicalName: "sweet-potato", category: "vegetable", kind: "specific_food" },
  { keys: ["boiled potato", "baked potato", "potatoes", "potato", "薯仔", "馬鈴薯", "马铃薯", "土豆"], canonicalName: "potato", category: "vegetable", kind: "specific_food" },
  { keys: ["sweet corn", "corn kernels", "corn", "甜粟米", "粟米", "玉米"], canonicalName: "corn", category: "vegetable", kind: "specific_food" },
  { keys: ["carrots", "carrot", "紅蘿蔔", "红萝卜", "甘筍", "胡蘿蔔"], canonicalName: "carrot", category: "vegetable", kind: "specific_food" },
  { keys: ["cucumbers", "cucumber", "青瓜", "黃瓜", "黄瓜"], canonicalName: "cucumber", category: "vegetable", kind: "specific_food" },
  { keys: ["iceberg lettuce", "romaine lettuce", "lettuce", "西生菜", "羅馬生菜", "生菜"], canonicalName: "lettuce", category: "vegetable", kind: "specific_food" },
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
  { keys: ["fried dough stick", "chinese cruller", "youtiao", "油炸鬼", "油條", "油条"], canonicalName: "youtiao", category: "fried", kind: "specific_food" },
  { keys: ["cheddar", "mozzarella", "cheese", "芝士", "起司"], canonicalName: "cheese", category: "dairy", kind: "specific_food" },
  { keys: ["greek yogurt", "plain yogurt", "yogurt", "yoghurt", "希臘乳酪", "乳酪", "酸奶", "優格"], canonicalName: "yogurt", category: "dairy", kind: "specific_food" },
  { keys: ["fresh milk", "whole milk", "milk", "鮮奶", "全脂奶", "牛奶"], canonicalName: "milk", category: "dairy", kind: "specific_food" },
  { keys: ["iced lemon tea", "lemon tea", "凍檸茶", "冻柠茶", "熱檸茶", "檸檬茶", "檸茶"], canonicalName: "iced-lemon-tea", category: "fruit", kind: "specific_food" },
  { keys: ["orange juice", "apple juice", "fruit juice", "橙汁", "蘋果汁", "果汁"], canonicalName: "fruit-juice", category: "fruit", kind: "specific_food" },
  { keys: ["avocados", "avocado", "牛油果", "酪梨"], canonicalName: "avocado", category: "fruit", kind: "specific_food" },
  { keys: ["oranges", "orange", "鮮橙", "甜橙", "橙"], canonicalName: "orange", category: "fruit", kind: "specific_food" },
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
  "creamy-soup",
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

const RICE_ADJUNCT_FOLLOW_PATTERN =
  "(?:noodles?|vermicelli|rolls?|porridge|soups?|broth|congee|paper|cakes?|flour|wine)";

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
    const pattern =
      needle === "rice" || needle.endsWith(" rice")
        ? `(?:^|\\s)${escapeRegExp(needle)}(?!\\s+${RICE_ADJUNCT_FOLLOW_PATTERN}(?:$|\\s))(?:$|\\s)`
        : `(?:^|\\s)${escapeRegExp(needle)}(?:$|\\s)`;
    const matched = new RegExp(pattern).test(haystack);
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
    case "chicken-wings":
    case "beef":
    case "pork":
    case "luncheon-meat":
    case "ham":
    case "sausage":
    case "salmon":
    case "shrimp":
    case "white-fish":
    case "fried-fish":
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
    suspectedDuplicateMilk?: boolean;
  },
  context?: MealPlantMilkContext,
): boolean {
  if (food.suspectedDuplicateMilk === true) return true;
  if (food.userMilkTypeChoice === "other" || food.otherMilkNotice === PHOTO_MILK_OTHER_REASON) return true;
  if (food.uncertaintyReasons?.includes(PHOTO_MILK_OTHER_REASON)) return true;
  return contradictoryDairyMilkLabel(food, context)
    || photoGenericMilkNeedsConfirmation(food, context)
    || chocolateMilkName(food)
    || isUnsweetenedLemonTea(food);
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

const DISH_COMPONENT_SUFFIX_RE =
  /(?:皮|醬|酱|汁|醋|油|湯底|汤底|醬料|酱料|餅底|饼底|調味粉|调味粉|湯粉|汤粉|味粉|咖喱粉|咖哩粉)$|(?:^|\s)(?:sauce|oil|vinegar|wrapper|wrappers|crust|broth|base|soup\s+base|skin|pastry|shell|stock|seasoning|powder|glaze|dip)$/;
const STIR_FRY_OR_DRY_NOODLE_NAME_CUE_RE =
  /炒|撈|捞|焗|乾拌|干拌|涼拌|凉拌|拌烏冬|拌乌冬|拌烏龍|拌乌龙|拌麵|拌面|拌米線|拌米线|拌河粉|拌拉麵|拌拉面|走湯|走汤|無湯|无汤|免湯|免汤|冷烏冬|冷乌冬|冷麵|冷面|沾麵|沾面|(?:^|\s)(?:fried|stir\s+fried|stirfried|pan\s+fried|dry\s+fried|baked|gratin|dry|tossed|brothless|no\s+soup|no\s+broth|without\s+soup|without\s+broth|chow|lo\s+mein|yakisoba|yaki\s+udon|yakiudon|zaru|bukkake|tsukemen|dipping|mazesoba|abura\s+soba|cold\s+udon|cold\s+noodles?)(?:$|\s)/;
const STIR_FRY_OR_DRY_NOODLE_PREP_CUE_RE =
  /炒|焗|乾拌|干拌|涼拌|凉拌|拌|乾撈|干捞|撈|捞|無湯|无汤|走湯|走汤|免湯|免汤|(?:^|\s)(?:stir\s+fried|stirfried|dry\s+fried|baked|gratin|dry|tossed|brothless|no\s+soup|no\s+broth|without\s+soup|without\s+broth)(?:$|\s)/;
const DRY_NOODLE_NOTE_CUE_RE =
  /乾拌|干拌|涼拌|凉拌|走湯|走汤|無湯|无汤|免湯|免汤|(?:^|\s)(?:dry\s+tossed|brothless|no\s+soup|no\s+broth|without\s+soup|without\s+broth)(?:$|\s)/;
const SOUP_NOODLE_DISH_IDS = new Set([
  "cart-noodles",
  "beef-brisket-noodles",
  "luncheon-meat-egg-noodles",
  "plain-noodle-soup",
  "beef-noodle-soup",
  "rice-vermicelli",
  "ho-fun",
  "shrimp-wonton-noodle-soup",
  "wonton-noodle-soup",
  "hong-kong-noodle-soup",
  "udon-noodle-soup",
  "ramen",
  "macaroni-soup-breakfast",
]);
const SOUP_NOODLE_CANONICALS = new Set(["ramen", "noodle-soup"]);
const RICH_BROTH_NOODLE_CONTRADICTION_RE =
  /咖喱|咖哩|喇沙|叻沙|忌廉|白汁|(?:^|\s)(?:curry|laksa|cream|creamy|carbonara)(?:$|\s)/;
const GENERIC_DISH_UMBRELLA_CANONICALS = new Set([
  "donburi",
  "pasta",
  "noodle-soup",
  "congee",
  "sandwich",
  "siu-mei-rice",
]);
const CONTAINER_BLOCKER_DISH_IDS = new Set(["cha-chaan-teng-set", "hotpot"]);
const LEMON_TEA_NAME_RE = /檸茶|柠茶|檸檬茶|柠檬茶|(?:^|\s)lemon\s+tea(?:$|\s)/;
const WHITE_FISH_NAME_RE =
  /魚|鱼|(?:^|\s)(?:fish|sea\s+bass|cod|tilapia|pollock|halibut|haddock)(?:$|\s)/;
const NON_WHITE_FISH_RE = /三文魚|三文鱼|吞拿魚|吞拿鱼|(?:^|\s)(?:salmon|tuna)(?:$|\s)/;
const PROCESSED_FISH_PRODUCT_RE =
  /魚蛋|鱼蛋|魚丸|鱼丸|魚餅|鱼饼|魚皮|鱼皮|魚片頭|鱼片头|魚餃|鱼饺|魚豆腐|鱼豆腐|魚鬆|鱼松|魚腐|鱼腐|魚肉燒賣|鱼肉烧卖|魚腸|鱼肠|魚糕|鱼糕|魚露|鱼露|魚膠|鱼胶|魚翅|鱼翅|魚子|鱼子|魚籽|鱼籽|魚滑|鱼滑|(?:^|\s)(?:fish\s+(?:balls?|cakes?|skins?|paste|tofu|dumplings?|sausages?|floss|sauce|roe|maw|sticks?|fingers?|crackers?|chips?|siu\s+mai)|fishballs?|fishcakes?|surimi|kamaboko)(?:$|\s)/;
const DEEP_FRIED_OR_BATTERED_CUE_RE =
  /油炸|炸|脆漿|脆浆|裹粉|吉列|天婦羅|天妇罗|(?:^|\s)(?:deep\s+fried|battered|breaded|katsu|tempura)(?:$|\s)|(?:^|\s)fried\s+(?:[a-z]+\s+)?fish(?:$|\s)/;
const NON_CLEAR_BROTH_CUE_RE =
  /拉麵|拉面|豚骨|火鍋|火锅|麻辣|沙嗲|忌廉|濃湯|浓汤|羅宋|罗宋|(?:^|\s)(?:ramen|tonkotsu|hotpot|hot\s+pot|cream|creamy|chowder|bisque|borscht)(?:$|\s)/;
const RICE_PLATE_CONTRADICTION_RE =
  /咖喱|咖哩|炒飯|炒饭|焗|燴|烩|煲仔|泡飯|泡饭|湯飯|汤饭|意大利飯|意大利饭|(?:^|\s)(?:curry|fried\s+rice|baked(?:\s+[a-z]+)*\s+rice|braised\s+rice|claypot|clay\s+pot|risotto)(?:$|\s)/;

type ContradictionFood = {
  displayName: string;
  normalizedName: string;
  preparationMethod?: string;
  notes?: string;
  visibleIngredients?: readonly string[];
  uncertaintyReasons?: readonly string[];
};

function hasDishComponentSuffix(name: string): boolean {
  const normalized = normalizeFoodName(name);
  if (!normalized) return false;
  if (
    /(?:^|\s)(?:with|in)\s+[a-z0-9\s]+$/.test(normalized) &&
    /(?:^|\s)(?:sauce|broth|stock|gravy|oil|glaze)$/.test(normalized)
  ) {
    return false;
  }
  return DISH_COMPONENT_SUFFIX_RE.test(normalized);
}

function isDishComponentOnly(food: Pick<ContradictionFood, "displayName" | "normalizedName">): boolean {
  return hasDishComponentSuffix(food.displayName) || hasDishComponentSuffix(food.normalizedName);
}

function hasStirFryNoodleContradiction(
  food: Pick<ContradictionFood, "displayName" | "normalizedName" | "preparationMethod" | "notes">,
): boolean {
  const names = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (STIR_FRY_OR_DRY_NOODLE_NAME_CUE_RE.test(names)) return true;
  const prep = normalizeFoodName(food.preparationMethod ?? "");
  if (prep && STIR_FRY_OR_DRY_NOODLE_PREP_CUE_RE.test(prep)) return true;
  const notes = normalizeFoodName(food.notes ?? "");
  return Boolean(notes && DRY_NOODLE_NOTE_CUE_RE.test(notes));
}

export function isUnsweetenedLemonTea(food: ContradictionFood): boolean {
  const names = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (!LEMON_TEA_NAME_RE.test(names)) return false;
  const rule = NEGATIVE_MATCH_RULES.find((item) => item.id === "unsweetened-lemon-tea-not-sweetened");
  if (!rule) return false;
  const evidence = normalizeFoodName(
    dropUnknownMilkOrPlantClauses(
      [
        food.displayName,
        food.normalizedName,
        food.preparationMethod ?? "",
        food.notes ?? "",
        ...(food.visibleIngredients ?? []),
        ...(food.uncertaintyReasons ?? []),
      ].join(" "),
    ),
  );
  return ruleMatchesName(rule, evidence);
}

export function hasFriedBatteredFishEvidence(food: ContradictionFood): boolean {
  const names = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (
    !WHITE_FISH_NAME_RE.test(names) ||
    NON_WHITE_FISH_RE.test(names) ||
    PROCESSED_FISH_PRODUCT_RE.test(names) ||
    isDishComponentOnly(food)
  ) {
    return false;
  }
  const evidence = normalizeFoodName(
    [food.displayName, food.normalizedName, food.preparationMethod ?? "", food.notes ?? ""].join(" "),
  ).replace(/(?:^|\s)(?:pan|stir)\s+fried(?=$|\s)/g, " ");
  return DEEP_FRIED_OR_BATTERED_CUE_RE.test(evidence);
}

function collectIdentityHits(text: string, food: FoodEstimate): IdentityHit[] {
  const hits: IdentityHit[] = [];
  const blockDairyMilk = blocksDairyMilkIdentity(food) || lowFatMilkEvidence(food) || chocolateMilkName(food);
  const blockCucumber = /(?:^|\s)sea\s+cucumbers?(?:$|\s)|海參|海参/.test(text);
  const dishNames = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  const blockWholeDishes = isDishComponentOnly(food);
  const blockSoupNoodles =
    hasStirFryNoodleContradiction(food) || RICH_BROTH_NOODLE_CONTRADICTION_RE.test(dishNames);
  const blockSweetLemonTea = isUnsweetenedLemonTea(food);
  const friedFish = hasFriedBatteredFishEvidence(food);
  const processedFish = PROCESSED_FISH_PRODUCT_RE.test(dishNames);
  const blockClearSoup = NON_CLEAR_BROTH_CUE_RE.test(text);

  for (const rule of IDENTITY_RULES) {
    if (blockWholeDishes && (rule.kind === "named_dish" || rule.kind === "dish_class")) continue;
    if (blockSoupNoodles && SOUP_NOODLE_CANONICALS.has(rule.canonicalName)) continue;
    if (rule.canonicalName === "milk" && blockDairyMilk) continue;
    if (rule.canonicalName === "cucumber" && blockCucumber) continue;
    if (rule.canonicalName === "iced-lemon-tea" && blockSweetLemonTea) continue;
    if (rule.canonicalName === "fried-fish" && !friedFish) continue;
    if (rule.canonicalName === "white-fish" && (friedFish || processedFish)) continue;
    if (rule.canonicalName === "clear-soup" && blockClearSoup) continue;
    const matchedKey = findLongestMatch(text, rule.keys, {
      singleCjkKeyMustBeStandalone: true,
    });
    if (matchedKey) hits.push({ ...rule, matchedKey });
  }
  if (friedFish && !hits.some((hit) => hit.canonicalName === "fried-fish")) {
    hits.push({
      keys: [],
      matchedKey: "fried fish",
      canonicalName: "fried-fish",
      category: "seafood",
      kind: "specific_food",
    });
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
  const hasOther = families.has("other");

  return (hasStarch && hasProtein) || (hasStarch && hasSauce) || (hasStarch && hasOther);
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

function orderedTokenSubsequenceWithSameHead(longer: string, shorter: string): boolean {
  const lTokens = longer.split(" ").filter(Boolean);
  const sTokens = shorter.split(" ").filter(Boolean);
  if (sTokens.length < 2 || lTokens.length <= sTokens.length) return false;
  if (lTokens[lTokens.length - 1] !== sTokens[sTokens.length - 1]) return false;
  let idx = 0;
  for (const token of lTokens) {
    if (token === sTokens[idx]) idx += 1;
    if (idx === sTokens.length) return true;
  }
  return false;
}

function containsAsTokenPhrase(longer: string, shorter: string): boolean {
  if (!shorter || longer === shorter) return false;
  return (
    longer.startsWith(`${shorter} `) ||
    longer.endsWith(` ${shorter}`) ||
    orderedTokenSubsequenceWithSameHead(longer, shorter)
  );
}

function isUmbrellaParentOf(umbrella: DishIdentity, specific: DishIdentity): boolean {
  if (umbrella.id === specific.id) return false;
  if (
    umbrella.id === "hong-kong-noodle-soup" &&
    SOUP_NOODLE_DISH_IDS.has(specific.id) &&
    specific.id !== "macaroni-soup-breakfast"
  ) {
    return true;
  }
  if (
    umbrella.id === "rice-plate" &&
    (specific.familyId === "rice-plate" || specific.familyId === "siu-mei-rice")
  ) {
    return true;
  }
  if (
    umbrella.id === "chicken-rice" &&
    (specific.id === "soy-sauce-chicken-rice" ||
      specific.id === "white-cut-chicken-rice" ||
      specific.id === "hainanese-chicken-rice" ||
      specific.id === "chicken-chop-rice")
  ) {
    return true;
  }
  return false;
}

const MULTI_DISH_JOINER_RE =
  /拼|加|配|及|與|和|同|\+|&|(?:^|\s)(?:and|plus|or|with)(?:$|\s)/;
const CJK_UMBRELLA_CLASS_SUFFIXES = new Set([
  "湯麵",
  "汤面",
  "碟頭飯",
  "碟头饭",
  "碗頭飯",
  "碗头饭",
]);

function countPhraseOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + Math.max(1, needle.length);
  }
  return count;
}

function aliasAbsorbedByLongerMatch(
  haystack: string,
  longerAlias: string,
  shorterAlias: string,
): boolean {
  if (longerAlias.length <= shorterAlias.length) return false;
  if (!textContainsKey(longerAlias, shorterAlias, { skipLongerAliasShadow: true })) return false;
  const remainder = haystack.split(longerAlias).join(" ").replace(/\s+/g, " ").trim();
  if (!remainder) return true;
  return !textContainsKey(remainder, shorterAlias, {
    singleCjkKeyMustBeStandalone: true,
    skipLongerAliasShadow: true,
  });
}

function describesSameDishMention(
  haystack: string,
  specificAlias: string,
  umbrellaAlias: string,
): boolean {
  if (!specificAlias || !umbrellaAlias || MULTI_DISH_JOINER_RE.test(haystack)) return false;
  if (
    countPhraseOccurrences(haystack, umbrellaAlias) !== 1 ||
    countPhraseOccurrences(haystack, specificAlias) !== 1
  ) {
    return false;
  }
  if (!/[\u4e00-\u9fff]/.test(specificAlias) && !/[\u4e00-\u9fff]/.test(umbrellaAlias)) {
    if (englishPhraseIn(haystack, `${specificAlias} ${umbrellaAlias}`)) return true;
    const sTokens = specificAlias.split(" ");
    const uTokens = umbrellaAlias.split(" ");
    const maxOverlap = Math.min(sTokens.length, uTokens.length);
    for (let k = maxOverlap; k >= 1; k -= 1) {
      if (sTokens.slice(-k).join(" ") === uTokens.slice(0, k).join(" ")) {
        const merged = [...sTokens, ...uTokens.slice(k)].join(" ");
        if (englishPhraseIn(haystack, merged)) return true;
      }
    }
    return false;
  }
  if (CJK_UMBRELLA_CLASS_SUFFIXES.has(umbrellaAlias)) {
    return haystack.includes(`${specificAlias}${umbrellaAlias}`);
  }
  return false;
}

/** One dish identity is a more specific refinement of another umbrella/parent identity. */
function dishIsMoreSpecific(specific: DishIdentity, general: DishIdentity): boolean {
  if (specific.id === general.id) return false;
  if (isUmbrellaParentOf(general, specific)) return true;
  const specificEnglish = specific.aliases
    .filter((alias) => alias.script === "english")
    .map((alias) => normalizeFoodName(alias.text));
  const generalAliases = general.aliases.map((alias) => normalizeFoodName(alias.text));
  return specificEnglish.some((longer) =>
    generalAliases.some((shorter) => containsAsTokenPhrase(longer, shorter)),
  );
}

function isChineseField(name: string): boolean {
  return /[\u4e00-\u9fff]/.test(name);
}

function curatedDishContradicted(
  identity: DishIdentity,
  food: ContradictionFood,
): boolean {
  if (isDishComponentOnly(food)) return true;
  if (SOUP_NOODLE_DISH_IDS.has(identity.id) && hasStirFryNoodleContradiction(food)) return true;
  if (identity.id === "creamy-macaroni-salad" && isHotCreamMacaroni(food as FoodEstimate)) return true;
  const names = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (SOUP_NOODLE_DISH_IDS.has(identity.id) && RICH_BROTH_NOODLE_CONTRADICTION_RE.test(names)) {
    return true;
  }
  if (
    (identity.familyId === "rice-plate" || identity.familyId === "siu-mei-rice") &&
    RICE_PLATE_CONTRADICTION_RE.test(names)
  ) {
    return true;
  }
  if (
    identity.familyId === "salad" &&
    SALAD_WORD.test(names) &&
    matchingSaladDressingRule(names)?.routeCanonicalName === null
  ) {
    return true;
  }
  return false;
}

function findContainerDishBlocker(
  food: Pick<ContradictionFood, "displayName" | "normalizedName">,
): DishIdentity | null {
  if (isDishComponentOnly(food)) return null;
  for (const field of [food.displayName, food.normalizedName]) {
    const normalized = normalizeFoodName(field);
    if (!normalized) continue;
    for (const identity of DISH_IDENTITIES) {
      if (!CONTAINER_BLOCKER_DISH_IDS.has(identity.id)) continue;
      const matched = identity.aliases.some((alias) => {
        const needle = normalizeFoodName(alias.text);
        if (!needle) return false;
        return textContainsKey(normalized, needle, { singleCjkKeyMustBeStandalone: true });
      });
      if (matched) return identity;
    }
  }
  return null;
}

/**
 * Exact alias match. Contradictory evidence (component suffixes, container
 * blockers, stir-fry vs soup-noodle, multi-dish names) always takes precedence
 * over a simplified exact alias on the other field.
 */
export function resolveCuratedDishIdentity(food: ContradictionFood): CuratedDishResolution {
  if (isDishComponentOnly(food)) return { status: "none" };

  const blocker = findContainerDishBlocker(food);
  if (blocker) return { status: "matched", identity: blocker };

  const displayContained = containedDishHits(food.displayName, food);
  const normalizedContained = containedDishHits(food.normalizedName, food);
  if (
    uniqueIdentities(displayContained.map((hit) => hit.identity)).length > 1 ||
    uniqueIdentities(normalizedContained.map((hit) => hit.identity)).length > 1
  ) {
    return { status: "ambiguous" };
  }

  const displayHits = uniqueIdentities(exactDishHits(food.displayName))
    .filter((identity) => !curatedDishContradicted(identity, food));
  const normalizedHits = uniqueIdentities(exactDishHits(food.normalizedName))
    .filter((identity) => !curatedDishContradicted(identity, food));
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
    if (english.length === 1 && english[0] && dishIsMoreSpecific(chineseIdentity, english[0])) {
      return { status: "matched", identity: chineseIdentity };
    }
    if (english.length === 1 && english[0] && isUmbrellaParentOf(chineseIdentity, english[0])) {
      return { status: "matched", identity: english[0] };
    }
    return { status: "ambiguous" };
  }
  if (english.length === 1 && english[0]) {
    const chineseContained = uniqueIdentities([
      ...(isChineseField(food.displayName) ? displayContained.map((hit) => hit.identity) : []),
      ...(isChineseField(food.normalizedName) ? normalizedContained.map((hit) => hit.identity) : []),
    ]);
    if (chineseContained.length === 1 && chineseContained[0] && chineseContained[0].id !== english[0].id) {
      if (dishIsMoreSpecific(chineseContained[0], english[0])) {
        return { status: "matched", identity: chineseContained[0] };
      }
      return { status: "ambiguous" };
    }
    return { status: "matched", identity: english[0] };
  }
  if (english.length > 1) return { status: "ambiguous" };
  return { status: "none" };
}

interface ContainedDishMatch {
  identity: DishIdentity;
  matchedAlias: string;
}

function containedDishHits(
  name: string,
  food: ContradictionFood,
): ContainedDishMatch[] {
  const normalized = normalizeFoodName(name);
  if (!normalized || isDishComponentOnly(food)) return [];
  const raw: ContainedDishMatch[] = [];
  for (const identity of DISH_IDENTITIES) {
    if (curatedDishContradicted(identity, food)) continue;
    let bestAlias: string | null = null;
    for (const alias of identity.aliases) {
      const needle = normalizeFoodName(alias.text);
      if (!needle) continue;
      // Avoid 1-char CJK aliases (e.g. 粥) in substring fallback.
      if (/[\u4e00-\u9fff]/.test(needle) && [...needle].length < 2) continue;
      if (!textContainsKey(normalized, needle, { singleCjkKeyMustBeStandalone: true })) continue;
      if (!bestAlias || needle.length > bestAlias.length) bestAlias = needle;
    }
    if (bestAlias) raw.push({ identity, matchedAlias: bestAlias });
  }
  // Drop shorter aliases strictly contained in a longer matched dish alias
  // (e.g. 叉燒碟頭飯 beats 碟頭飯; 壽司拼盤 beats 壽司) and generic umbrella
  // parents only when they form part of the same single-dish mention.
  return raw.filter((hit) =>
    !raw.some(
      (other) =>
        other.identity.id !== hit.identity.id &&
        (aliasAbsorbedByLongerMatch(normalized, other.matchedAlias, hit.matchedAlias) ||
          (isUmbrellaParentOf(hit.identity, other.identity) &&
            describesSameDishMention(normalized, other.matchedAlias, hit.matchedAlias))),
    ),
  );
}

/**
 * Modifier-tolerant curated dish lookup (e.g. 洋蔥豬扒飯, 蟹籽燒賣, 芝士漢堡).
 * Runs only after exact dish identity and explicit negative/named-dish rules.
 */
function resolveContainedCuratedDishIdentity(food: ContradictionFood): CuratedDishResolution {
  if (isDishComponentOnly(food)) return { status: "none" };

  const blocker = findContainerDishBlocker(food);
  if (blocker) return { status: "matched", identity: blocker };

  const displayHits = containedDishHits(food.displayName, food);
  const normalizedHits = containedDishHits(food.normalizedName, food);
  const all = [...displayHits, ...normalizedHits];
  if (all.length === 0) return { status: "none" };

  const chinese = uniqueIdentities([
    ...(isChineseField(food.displayName) ? displayHits.map((hit) => hit.identity) : []),
    ...(isChineseField(food.normalizedName) ? normalizedHits.map((hit) => hit.identity) : []),
  ]);
  const english = uniqueIdentities([
    ...(!isChineseField(food.displayName) ? displayHits.map((hit) => hit.identity) : []),
    ...(!isChineseField(food.normalizedName) ? normalizedHits.map((hit) => hit.identity) : []),
  ]);

  if (chinese.length > 1) return { status: "ambiguous" };
  if (chinese.length === 1) {
    const chineseIdentity = chinese[0];
    if (!chineseIdentity) return { status: "ambiguous" };
    if (english.length === 0 || english.every((hit) => hit.id === chineseIdentity.id)) {
      return { status: "matched", identity: chineseIdentity };
    }
    if (english.length === 1 && english[0] && dishIsMoreSpecific(chineseIdentity, english[0])) {
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
  if (curated.status === "matched") {
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
  const standaloneRiceRe = new RegExp(
    `飯|饭|(?:^|\\s)rice(?!\\s+${RICE_ADJUNCT_FOLLOW_PATTERN}(?:$|\\s))(?:$|\\s)`,
  );
  const bakedRiceDishRe = new RegExp(
    `焗[^拼加配及與和同+&,，/\\s]{0,8}[飯饭]|(?:^|\\s)baked(?:\\s+(?!and\\b|with\\b|on\\b|over\\b|beside\\b|plus\\b|or\\b|beans?\\b)[a-z]+){0,3}\\s+rice(?!\\s+${RICE_ADJUNCT_FOLLOW_PATTERN}(?:$|\\s))(?:$|\\s)`,
  );
  const hasRice =
    identityHits.some((rule) => rule.canonicalName === "rice") ||
    standaloneRiceRe.test(text);
  const dishNamesText = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  const hasCurryRiceDish =
    !isDishComponentOnly(food) &&
    (identityHits.some((rule) => rule.canonicalName === "curry-rice") ||
      (hasCurry && hasRice));
  const hasBakedRiceDish =
    !isDishComponentOnly(food) &&
    (identityHits.some((rule) => rule.canonicalName === "baked-rice") ||
      bakedRiceDishRe.test(dishNamesText));
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
    const explicitDish = hasCurryRiceDish
      ? synthesizedIdentityHit("curry-rice")
      : hasBakedRiceDish
        ? synthesizedIdentityHit("baked-rice")
        : rankedHits.find((hit) => hit.kind === "named_dish" || hit.kind === "dish_class");
    const allowContainedDish = !SALAD_WORD.test(saladName) && !hasCreamMacaroniStem(creamMacaroniText(food));
    const contained = allowContainedDish ? resolveContainedCuratedDishIdentity(food) : { status: "none" as const };
    if (contained.status === "ambiguous") {
      return {
        canonicalName: "unknown",
        category: "mixed",
        preparation,
        qualifiers: ["composite", "ambiguous"],
      };
    }
    if (
      contained.status === "matched" &&
      (!explicitDish || GENERIC_DISH_UMBRELLA_CANONICALS.has(explicitDish.canonicalName))
    ) {
      return identityFromDish(contained.identity, preparation);
    }
    if (explicitDish) {
      primary = explicitDish;
    } else {
      primary = synthesizedIdentityHit("mixed-dish");
    }
  } else if (tomatoSauceOverride) {
    canonicalName = "tomato-sauce";
    category = "sauce";
    qualifiers.add("tomato");
  } else if (hasCurryRiceDish) {
    primary = synthesizedIdentityHit("curry-rice", "named_dish");
  } else if (hasBakedRiceDish) {
    primary = synthesizedIdentityHit("baked-rice", "named_dish");
  } else if (hasNamedDish(identityHits)) {
    const explicitDish = rankedHits.find((hit) => hit.kind === "named_dish" || hit.kind === "dish_class");
    if (
      explicitDish &&
      GENERIC_DISH_UMBRELLA_CANONICALS.has(explicitDish.canonicalName) &&
      !SALAD_WORD.test(saladName) &&
      !hasCreamMacaroniStem(creamMacaroniText(food)) &&
      !grainWithMilk
    ) {
      const contained = resolveContainedCuratedDishIdentity(food);
      if (contained.status === "ambiguous") {
        return {
          canonicalName: "unknown",
          category: "mixed",
          preparation,
          qualifiers: ["composite", "ambiguous"],
        };
      }
      if (contained.status === "matched") {
        return identityFromDish(contained.identity, preparation);
      }
    }
    primary = explicitDish;
  } else if (!SALAD_WORD.test(saladName) && !hasCreamMacaroniStem(creamMacaroniText(food)) && !grainWithMilk) {
    const contained = resolveContainedCuratedDishIdentity(food);
    if (contained.status === "ambiguous") {
      return {
        canonicalName: "unknown",
        category: "mixed",
        preparation,
        qualifiers: ["composite", "ambiguous"],
      };
    }
    if (contained.status === "matched") {
      return identityFromDish(contained.identity, preparation);
    }
    if (isCrossFamilyComposite(identityHits)) {
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
      : rule.id === "unsweetened-lemon-tea-not-sweetened"
        ? isUnsweetenedLemonTea(food)
        : rule.id === "fried-fish-not-steamed-fish"
          ? hasFriedBatteredFishEvidence(food)
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
