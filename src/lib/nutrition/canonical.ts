import type { FoodEstimate } from "@/lib/domain/food-analysis";
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
  { keys: ["fried rice", "炒飯"], canonicalName: "fried-rice", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["curry rice", "咖喱飯", "咖哩飯"], canonicalName: "curry", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["donburi", "丼飯", "丼"], canonicalName: "donburi", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["bibimbap", "石鍋拌飯", "拌飯"], canonicalName: "bibimbap", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
  { keys: ["chow mein", "lo mein", "fried noodles", "stir-fried noodles", "stir fried noodles", "炒麵", "撈麵"], canonicalName: "fried-noodles", category: "mixed", kind: "named_dish", qualifiers: ["composite"] },
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
  { keys: ["whole milk", "milk", "全脂奶", "牛奶"], canonicalName: "milk", category: "dairy", kind: "specific_food" },
  { keys: ["banana", "香蕉"], canonicalName: "banana", category: "fruit", kind: "specific_food" },
  { keys: ["apple", "蘋果"], canonicalName: "apple", category: "fruit", kind: "specific_food" },
];

const COMPOSITE_CANONICALS = new Set([
  "risotto",
  "baked-rice",
  "braised-rice",
  "fried-rice",
  "donburi",
  "bibimbap",
  "fried-noodles",
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

function textContainsKey(haystack: string, key: string): boolean {
  const needle = normalizeFoodName(key);
  if (!needle) return false;
  if (haystack === needle) return true;

  const hasCjk = /[\u4e00-\u9fff]/.test(needle);
  if (!hasCjk) {
    return new RegExp(`(?:^|\\s)${escapeRegExp(needle)}(?:$|\\s)`).test(haystack);
  }

  return haystack.includes(needle);
}

function findLongestMatch(haystack: string, keys: string[]): string | null {
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (textContainsKey(haystack, key)) return key;
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
    case "donburi":
    case "bibimbap":
    case "fried-noodles":
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

function collectIdentityHits(text: string): IdentityHit[] {
  const hits: IdentityHit[] = [];
  for (const rule of IDENTITY_RULES) {
    const matchedKey = findLongestMatch(text, rule.keys);
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

  return (hasStarch && hasProtein) || (hasStarch && hasSauce) || (hasProtein && hasSauce);
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

  const identityHits = collectIdentityHits(text);
  const rankedHits = rankIdentityHits(identityHits);

  const hasTomato = identityHits.some((rule) => rule.canonicalName === "tomato");
  const hasSauce = identityHits.some((rule) =>
    ["sauce", "tomato-sauce"].includes(rule.canonicalName),
  );
  const tomatoSauceOverride =
    hasTomato &&
    (hasSauce || text.includes("風味") || text.includes("flavor")) &&
    !hasNamedDish(identityHits) &&
    !identityHits.some((hit) => familyOf(hit.canonicalName) === "starch");

  let primary: IdentityHit | undefined;

  if (tomatoSauceOverride) {
    canonicalName = "tomato-sauce";
    category = "sauce";
    qualifiers.add("tomato");
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

  return {
    canonicalName,
    category,
    preparation,
    qualifiers: [...qualifiers],
  };
}

export function isCompositeIdentity(identity: CanonicalFoodIdentity): boolean {
  return (
    identity.qualifiers.includes("composite") ||
    identity.category === "mixed" ||
    COMPOSITE_CANONICALS.has(identity.canonicalName)
  );
}
