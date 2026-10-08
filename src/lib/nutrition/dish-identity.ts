import type { FoodCategory } from "./types";

export type DishAliasScript = "traditional" | "simplified" | "english" | "variant";

export interface DishAlias {
  text: string;
  script: DishAliasScript;
}

/**
 * A curated dish identity. Nutrition numbers stay on existing profiles.
 * `nutritionCanonicalName` is null until a later gate adds a profile.
 */
export interface DishIdentity {
  id: string;
  familyId: string;
  category: FoodCategory;
  /** Canonical name the nutrition resolver already understands. */
  resolverCanonicalName: string;
  /** Existing profile canonical, or null when the dish must stay uncalculated. */
  nutritionCanonicalName: string | null;
  aliases: DishAlias[];
}

interface DishInput {
  id: string;
  familyId: string;
  category?: FoodCategory;
  /** Defaults to the nutrition canonical, then the id. */
  resolverCanonicalName?: string;
  nutritionCanonicalName?: string | null;
  traditional?: string[];
  simplified?: string[];
  english?: string[];
  variant?: string[];
}

function aliasList(texts: string[] | undefined, script: DishAliasScript): DishAlias[] {
  return (texts ?? []).map((text) => ({ text, script }));
}

function dish(input: DishInput): DishIdentity {
  const nutritionCanonicalName = input.nutritionCanonicalName ?? null;
  return {
    id: input.id,
    familyId: input.familyId,
    category: input.category ?? "mixed",
    resolverCanonicalName:
      input.resolverCanonicalName ?? nutritionCanonicalName ?? input.id,
    nutritionCanonicalName,
    aliases: [
      ...aliasList(input.traditional, "traditional"),
      ...aliasList(input.simplified, "simplified"),
      ...aliasList(input.english, "english"),
      ...aliasList(input.variant, "variant"),
    ],
  };
}

/**
 * Identities for the Appendix A dishes, plus the existing profiled dishes
 * whose English names must not swallow a longer plate or plain-noodle name.
 * No nutrition values are introduced here.
 */
export const DISH_IDENTITIES: readonly DishIdentity[] = [
  dish({
    id: "rice-plate",
    familyId: "rice-plate",
    traditional: ["碟頭飯"],
    simplified: ["碟头饭"],
    variant: ["碗頭飯", "碗头饭"],
    english: ["rice plate", "rice platter"],
  }),
  dish({
    id: "char-siu-rice-plate",
    familyId: "rice-plate",
    traditional: ["叉燒碟頭飯", "叉燒碗頭飯"],
    simplified: ["叉烧碟头饭", "叉烧碗头饭"],
    english: ["char siu rice plate", "cha siu rice plate"],
  }),
  dish({
    id: "lunch-bento",
    familyId: "bento",
    traditional: ["午餐便當"],
    simplified: ["午餐便当"],
    english: ["lunch bento", "lunch box"],
  }),
  dish({
    id: "japanese-bento",
    familyId: "bento",
    traditional: ["日式便當"],
    simplified: ["日式便当"],
    english: ["japanese bento"],
  }),
  dish({
    id: "roast-goose-rice",
    familyId: "rice-plate",
    traditional: ["燒鵝飯"],
    simplified: ["烧鹅饭"],
    english: ["roast goose rice"],
  }),
  dish({
    id: "soy-sauce-chicken-rice",
    familyId: "rice-plate",
    traditional: ["油雞飯"],
    simplified: ["油鸡饭"],
    english: ["soy sauce chicken rice"],
  }),
  dish({
    id: "crispy-roast-pork-rice",
    familyId: "rice-plate",
    traditional: ["脆皮燒肉飯"],
    simplified: ["脆皮烧肉饭"],
    english: ["crispy roast pork rice", "siu yuk rice"],
  }),
  dish({
    id: "white-cut-chicken-rice",
    familyId: "rice-plate",
    traditional: ["白切雞飯"],
    simplified: ["白切鸡饭"],
    english: ["white cut chicken rice"],
  }),
  dish({
    id: "hainanese-chicken-rice",
    familyId: "rice-plate",
    traditional: ["海南雞飯"],
    simplified: ["海南鸡饭"],
    english: ["hainanese chicken rice"],
  }),
  dish({
    id: "pork-chop-rice",
    familyId: "rice-plate",
    traditional: ["豬扒飯"],
    simplified: ["猪扒饭"],
    english: ["pork chop rice"],
  }),
  dish({
    id: "chicken-chop-rice",
    familyId: "rice-plate",
    traditional: ["雞扒飯"],
    simplified: ["鸡扒饭"],
    english: ["chicken steak rice", "chicken cutlet rice"],
  }),
  dish({
    id: "fried-egg-rice",
    familyId: "rice-plate",
    traditional: ["煎蛋飯"],
    simplified: ["煎蛋饭"],
    english: ["fried egg rice"],
  }),
  dish({
    id: "mui-choy-pork-rice",
    familyId: "rice-plate",
    traditional: ["梅菜扣肉飯"],
    simplified: ["梅菜扣肉饭"],
    english: ["preserved vegetable pork rice", "mui choy pork rice"],
  }),
  dish({
    id: "lu-rou-fan",
    familyId: "rice-plate",
    traditional: ["滷肉飯"],
    simplified: ["卤肉饭"],
    english: ["braised pork rice", "lu rou fan"],
  }),
  dish({
    id: "spare-rib-rice",
    familyId: "rice-plate",
    traditional: ["排骨飯"],
    simplified: ["排骨饭"],
    english: ["spare rib rice"],
  }),
  dish({
    id: "yuxiang-eggplant-rice",
    familyId: "rice-plate",
    traditional: ["魚香茄子飯"],
    simplified: ["鱼香茄子饭"],
    english: ["fish fragrant eggplant rice", "yuxiang eggplant rice"],
  }),
  dish({
    id: "mapo-tofu-rice",
    familyId: "rice-plate",
    traditional: ["麻婆豆腐飯"],
    simplified: ["麻婆豆腐饭"],
    english: ["mapo tofu rice"],
  }),
  dish({
    id: "beef-rice",
    familyId: "rice-plate",
    traditional: ["牛肉飯"],
    simplified: ["牛肉饭"],
    english: ["beef rice"],
  }),
  dish({
    id: "oyakodon",
    familyId: "donburi",
    traditional: ["親子丼"],
    simplified: ["亲子丼"],
    english: ["oyakodon", "oyako don"],
  }),
  dish({
    id: "gyudon",
    familyId: "donburi",
    traditional: ["牛丼"],
    simplified: ["牛丼"],
    english: ["gyudon", "beef bowl"],
  }),
  dish({
    id: "bibimbap",
    familyId: "bibimbap",
    resolverCanonicalName: "bibimbap",
    traditional: ["石鍋拌飯"],
    simplified: ["石锅拌饭"],
    english: ["bibimbap", "stone pot bibimbap"],
  }),
  dish({
    id: "dry-fried-beef-ho-fun",
    familyId: "stir-fried-rice-noodles",
    traditional: ["乾炒牛河"],
    simplified: ["干炒牛河"],
    english: ["dry fried beef ho fun", "beef chow fun"],
  }),
  dish({
    id: "singapore-fried-vermicelli",
    familyId: "stir-fried-rice-noodles",
    traditional: ["星洲炒米"],
    simplified: ["星洲炒米"],
    variant: ["星洲炒米線", "星洲炒米线"],
    english: ["singapore fried vermicelli", "singapore noodles"],
  }),
  dish({
    id: "cart-noodles",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["車仔麵"],
    simplified: ["车仔面"],
    english: ["cart noodles"],
  }),
  dish({
    id: "beef-brisket-noodles",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["牛腩麵"],
    simplified: ["牛腩面"],
    english: ["beef brisket noodles"],
  }),
  dish({
    id: "luncheon-meat-egg-noodles",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["餐蛋麵"],
    simplified: ["餐蛋面"],
    english: ["luncheon meat egg noodles"],
  }),
  dish({
    id: "plain-noodle-soup",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["陽春麵"],
    simplified: ["阳春面"],
    english: ["plain noodle soup", "yang chun noodles"],
  }),
  dish({
    id: "beef-noodle-soup",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["牛肉麵"],
    simplified: ["牛肉面"],
    english: ["beef noodle soup"],
  }),
  dish({
    id: "rice-vermicelli",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["米線"],
    simplified: ["米线"],
    english: ["rice vermicelli"],
  }),
  dish({
    id: "ho-fun",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["河粉"],
    simplified: ["河粉"],
    english: ["ho fun", "hor fun"],
  }),
  dish({
    id: "shrimp-wonton-noodle-soup",
    familyId: "wonton-noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["鮮蝦雲吞麵", "鮮蝦餛飩麵"],
    simplified: ["鲜虾云吞面", "鲜虾馄饨面"],
    english: ["shrimp wonton noodles", "shrimp wonton noodle soup"],
  }),
  dish({
    id: "tom-yum-soup",
    familyId: "soup",
    traditional: ["冬蔭功湯"],
    simplified: ["冬阴功汤"],
    english: ["tom yum soup", "tom yum"],
  }),
  dish({
    id: "ramen",
    familyId: "ramen",
    resolverCanonicalName: "ramen",
    traditional: ["拉麵"],
    simplified: ["拉面"],
    english: ["ramen"],
  }),
  dish({
    id: "dan-dan-noodles",
    familyId: "dressed-noodles",
    traditional: ["擔擔麵"],
    simplified: ["担担面"],
    english: ["dan dan noodles"],
  }),
  dish({
    id: "zhajiangmian",
    familyId: "dressed-noodles",
    traditional: ["炸醬麵"],
    simplified: ["炸酱面"],
    english: ["zhajiangmian", "fried sauce noodles"],
  }),
  dish({
    id: "hong-kong-french-toast",
    familyId: "cha-chaan-teng-breakfast",
    traditional: ["西多士"],
    simplified: ["西多士"],
    english: ["hong kong french toast"],
  }),
  dish({
    id: "pineapple-bun",
    familyId: "cha-chaan-teng-breakfast",
    traditional: ["菠蘿包"],
    simplified: ["菠萝包"],
    english: ["pineapple bun", "bo lo bao"],
  }),
  dish({
    id: "sausage-and-egg",
    familyId: "cha-chaan-teng-breakfast",
    traditional: ["腸仔蛋"],
    simplified: ["肠仔蛋"],
    english: ["sausage and egg"],
  }),
  dish({
    id: "macaroni-soup-breakfast",
    familyId: "cha-chaan-teng-breakfast",
    traditional: ["通粉湯", "火腿通粉"],
    simplified: ["通粉汤", "火腿通粉"],
    variant: ["通心粉湯", "通心粉汤"],
    english: ["macaroni soup", "ham macaroni soup"],
  }),
  dish({
    id: "char-siu-bao",
    familyId: "dim-sum",
    traditional: ["叉燒包"],
    simplified: ["叉烧包"],
    english: ["char siu bao"],
  }),
  dish({
    id: "egg-tart",
    familyId: "dim-sum",
    traditional: ["蛋撻"],
    simplified: ["蛋挞"],
    english: ["egg tart", "dan tat"],
  }),
  dish({
    id: "sticky-rice-chicken",
    familyId: "dim-sum",
    traditional: ["糯米雞"],
    simplified: ["糯米鸡"],
    english: ["sticky rice chicken", "lo mai gai"],
  }),
  dish({
    id: "siu-mai",
    familyId: "dim-sum",
    traditional: ["燒賣"],
    simplified: ["烧卖"],
    variant: ["燒麥", "烧麦"],
    english: ["siu mai", "shumai"],
  }),
  dish({
    id: "har-gow",
    familyId: "dim-sum",
    traditional: ["蝦餃"],
    simplified: ["虾饺"],
    english: ["har gow", "shrimp dumpling"],
  }),
  dish({
    id: "xiaolongbao",
    familyId: "dim-sum",
    traditional: ["小籠包"],
    simplified: ["小笼包"],
    english: ["xiaolongbao", "soup dumpling"],
  }),
  dish({
    id: "spring-roll",
    familyId: "dim-sum",
    traditional: ["春捲"],
    simplified: ["春卷"],
    variant: ["春卷"],
    english: ["spring roll"],
  }),
  dish({
    id: "sushi-platter",
    familyId: "sushi",
    traditional: ["壽司拼盤"],
    simplified: ["寿司拼盘"],
    english: ["sushi platter"],
  }),
  dish({
    id: "sushi",
    familyId: "sushi",
    resolverCanonicalName: "sushi",
    traditional: ["壽司"],
    simplified: ["寿司"],
    english: ["sushi"],
  }),
  dish({
    id: "hotpot",
    familyId: "hotpot",
    resolverCanonicalName: "hotpot",
    traditional: ["火鍋"],
    simplified: ["火锅"],
    english: ["hotpot", "hot pot"],
  }),
  dish({
    id: "hamburger",
    familyId: "burger",
    traditional: ["漢堡"],
    simplified: ["汉堡"],
    english: ["hamburger", "burger"],
  }),
  dish({
    id: "sandwich",
    familyId: "sandwich",
    resolverCanonicalName: "sandwich",
    traditional: ["三文治"],
    variant: ["三明治"],
    english: ["sandwich", "sandwiches"],
  }),
  dish({
    id: "bolognese",
    familyId: "pasta",
    resolverCanonicalName: "bolognese",
    traditional: ["肉醬意粉"],
    simplified: ["肉酱意粉"],
    variant: ["肉醬意大利粉", "肉酱意大利粉"],
    english: ["spaghetti bolognese", "bolognese"],
  }),
  dish({
    id: "fish-and-chips",
    familyId: "fish-and-chips",
    traditional: ["魚柳薯條"],
    simplified: ["鱼柳薯条"],
    english: ["fish and chips", "fish fillet and fries"],
  }),
  dish({
    id: "char-siu-rice",
    familyId: "siu-mei-rice",
    nutritionCanonicalName: "siu-mei-rice",
    traditional: ["叉燒飯", "叉燒白飯", "燒味飯"],
    simplified: ["叉烧饭", "叉烧白饭", "烧味饭"],
    english: ["char siu rice", "cha siu rice", "char siu with rice", "siu mei rice"],
  }),
  dish({
    id: "wonton-noodle-soup",
    familyId: "wonton-noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["雲吞麵", "餛飩麵"],
    simplified: ["云吞面", "馄饨面"],
    english: ["wonton noodles", "wonton noodle soup", "wonton mein"],
  }),
  dish({
    id: "hong-kong-noodle-soup",
    familyId: "noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["湯麵"],
    simplified: ["汤面"],
    english: ["noodle soup"],
  }),
  dish({
    id: "plain-congee",
    familyId: "congee",
    nutritionCanonicalName: "congee",
    traditional: ["白粥", "粥"],
    simplified: ["白粥", "粥"],
    english: ["congee", "rice porridge"],
  }),
  dish({
    id: "century-egg-pork-congee",
    familyId: "congee",
    nutritionCanonicalName: "congee",
    traditional: ["皮蛋瘦肉粥"],
    simplified: ["皮蛋瘦肉粥"],
    english: ["century egg pork congee", "pork congee"],
  }),
  dish({
    id: "hong-kong-milk-tea",
    familyId: "milk-tea",
    category: "dairy",
    nutritionCanonicalName: "milk-tea",
    traditional: ["港式奶茶", "奶茶"],
    simplified: ["港式奶茶", "奶茶"],
    english: ["hong kong milk tea", "milk tea"],
  }),
  dish({
    id: "claypot-rice",
    familyId: "claypot-rice",
    nutritionCanonicalName: "claypot-rice",
    traditional: ["煲仔飯"],
    simplified: ["煲仔饭"],
    english: ["claypot rice", "clay pot rice"],
  }),
];
