import type { FoodEstimate } from "@/lib/domain/food-analysis";
import type {
  CanonicalFoodIdentity,
  FoodCategory,
  FoodPreparation,
} from "./types";

interface TermRule {
  keys: string[];
  canonicalName: string;
  category: FoodCategory;
  qualifiers?: string[];
}

interface PreparationRule {
  keys: string[];
  preparation: FoodPreparation;
}

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
  { keys: ["chicken breast", "chicken-breast", "雞胸肉", "雞胸扒", "雞胸"], canonicalName: "chicken-breast", category: "poultry" },
  { keys: ["chicken thigh", "chicken steak", "chicken cutlet", "雞扒", "雞腿", "雞脾"], canonicalName: "chicken-thigh", category: "poultry" },
  { keys: ["chicken", "雞肉"], canonicalName: "chicken", category: "poultry" },
  { keys: ["beef steak", "beef", "牛扒", "牛肉"], canonicalName: "beef", category: "beef" },
  { keys: ["pork chop", "pork", "豬扒", "豬肉"], canonicalName: "pork", category: "pork" },
  { keys: ["salmon", "三文魚"], canonicalName: "salmon", category: "seafood" },
  { keys: ["brown rice", "red rice", "紅米飯", "紅米", "糙米", "紫米"], canonicalName: "rice", category: "rice", qualifiers: ["wholegrain"] },
  { keys: ["white rice", "cooked white rice", "白米飯", "白飯", "米飯"], canonicalName: "rice", category: "rice" },
  { keys: ["fried rice", "炒飯"], canonicalName: "fried-rice", category: "mixed", qualifiers: ["composite"] },
  { keys: ["rice", "飯"], canonicalName: "rice", category: "rice" },
  { keys: ["chow mein", "lo mein", "fried noodles", "stir-fried noodles", "stir fried noodles", "炒麵", "撈麵"], canonicalName: "fried-noodles", category: "mixed", qualifiers: ["composite"] },
  { keys: ["noodles", "egg noodles", "麵條", "麵"], canonicalName: "noodles", category: "noodles" },
  { keys: ["white bread", "toast", "方包", "多士", "白麵包", "麵包"], canonicalName: "bread", category: "bread" },
  { keys: ["mixed vegetables", "assorted vegetables", "什錦蔬菜", "雜菜"], canonicalName: "mixed-vegetables", category: "vegetable", qualifiers: ["mixed"] },
  { keys: ["leafy greens", "bok choy", "choy sum", "菜心", "白菜", "青菜"], canonicalName: "leafy-greens", category: "vegetable" },
  { keys: ["vegetables", "vegetable", "蔬菜"], canonicalName: "vegetables", category: "vegetable" },
  { keys: ["tomato sauce", "marinara", "番茄醬", "茄汁"], canonicalName: "tomato-sauce", category: "sauce", qualifiers: ["tomato"] },
  { keys: ["savory sauce", "豉油汁", "醬汁"], canonicalName: "sauce", category: "sauce" },
  { keys: ["tomato", "番茄", "蕃茄"], canonicalName: "tomato", category: "sauce", qualifiers: ["tomato"] },
  { keys: ["sauce", "gravy", "汁", "醬"], canonicalName: "sauce", category: "sauce" },
  { keys: ["fried egg", "boiled egg", "雞蛋", "煎蛋", "烚蛋", "egg"], canonicalName: "egg", category: "egg" },
  { keys: ["firm tofu", "bean curd", "豆腐", "tofu"], canonicalName: "tofu", category: "tofu" },
  { keys: ["dumpling", "gyoza", "水餃", "鍋貼", "餃子"], canonicalName: "dumpling", category: "mixed", qualifiers: ["composite"] },
  { keys: ["french fries", "fries", "chips", "薯條"], canonicalName: "french-fries", category: "fried" },
  { keys: ["whole milk", "milk", "全脂奶", "牛奶"], canonicalName: "milk", category: "dairy" },
  { keys: ["banana", "香蕉"], canonicalName: "banana", category: "fruit" },
  { keys: ["apple", "蘋果"], canonicalName: "apple", category: "fruit" },
  { keys: ["beef curry", "咖喱牛腩", "咖哩牛腩", "咖喱", "curry"], canonicalName: "curry", category: "mixed", qualifiers: ["composite"] },
  { keys: ["hotpot", "hot pot", "火鍋"], canonicalName: "hotpot", category: "mixed", qualifiers: ["composite"] },
  { keys: ["pizza"], canonicalName: "pizza", category: "mixed", qualifiers: ["composite"] },
];

const COMPOSITE_CANONICALS = new Set([
  "fried-rice",
  "fried-noodles",
  "curry",
  "hotpot",
  "pizza",
]);

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

function findLongestMatch(
  haystack: string,
  keys: string[],
): string | null {
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    const needle = normalizeFoodName(key);
    if (!needle) continue;
    if (haystack === needle || haystack.includes(needle)) return key;
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

  const identityHits: Array<TermRule & { matchedKey: string }> = [];
  for (const rule of IDENTITY_RULES) {
    const matchedKey = findLongestMatch(text, rule.keys);
    if (matchedKey) identityHits.push({ ...rule, matchedKey });
  }

  identityHits.sort((left, right) => right.matchedKey.length - left.matchedKey.length);

  const primary = identityHits[0];
  if (primary) {
    canonicalName = primary.canonicalName;
    category = primary.category;
    for (const qualifier of primary.qualifiers ?? []) qualifiers.add(qualifier);
  }

  const hasTomato = identityHits.some((rule) => rule.canonicalName === "tomato");
  const hasSauce = identityHits.some((rule) =>
    ["sauce", "tomato-sauce"].includes(rule.canonicalName),
  );
  if (hasTomato && (hasSauce || text.includes("風味") || text.includes("flavor"))) {
    canonicalName = "tomato-sauce";
    category = "sauce";
    qualifiers.add("tomato");
  }

  if (identityHits.some((rule) => rule.qualifiers?.includes("wholegrain"))) {
    qualifiers.add("wholegrain");
    if (canonicalName === "rice") canonicalName = "rice";
  }

  if (COMPOSITE_CANONICALS.has(canonicalName)) {
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
