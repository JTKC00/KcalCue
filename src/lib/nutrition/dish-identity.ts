import type { FoodCategory } from "./types";

export type DishAliasScript = "traditional" | "simplified" | "english" | "variant";

export interface DishAlias {
  text: string;
  script: DishAliasScript;
}

/**
 * A curated dish identity. Existing profiles stay on `nutritionCanonicalName`.
 * N2 recipe templates can complete a dish while leaving that field null.
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
    traditional: ["油雞飯", "豉油雞飯"],
    simplified: ["油鸡饭", "豉油鸡饭"],
    english: ["soy sauce chicken rice"],
  }),
  dish({
    id: "crispy-roast-pork-rice",
    familyId: "rice-plate",
    traditional: ["脆皮燒肉飯", "燒肉飯"],
    simplified: ["脆皮烧肉饭", "烧肉饭"],
    english: ["crispy roast pork rice", "roast pork rice", "siu yuk rice"],
  }),
  dish({
    id: "white-cut-chicken-rice",
    familyId: "rice-plate",
    traditional: ["白切雞飯", "切雞飯"],
    simplified: ["白切鸡饭", "切鸡饭"],
    english: ["white cut chicken rice"],
  }),
  dish({
    id: "hainanese-chicken-rice",
    familyId: "rice-plate",
    traditional: ["海南雞飯"],
    simplified: ["海南鸡饭"],
    english: ["hainanese chicken rice", "hainan chicken rice"],
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
    traditional: ["雞扒飯", "炸雞飯"],
    simplified: ["鸡扒饭", "炸鸡饭"],
    english: ["chicken steak rice", "chicken cutlet rice", "chicken chop rice", "fried chicken rice"],
  }),
  dish({
    id: "chicken-rice",
    familyId: "rice-plate",
    traditional: ["雞肉飯", "雞飯", "雞腿飯", "雞髀飯", "烤雞飯", "燒雞飯", "雞胸飯", "手撕雞飯"],
    simplified: ["鸡肉饭", "鸡饭", "鸡腿饭", "鸡髀饭", "烤鸡饭", "烧鸡饭", "鸡胸饭", "手撕鸡饭"],
    variant: ["雞脾飯", "鸡脾饭", "雞肉白飯", "鸡肉白饭", "雞肉配白飯", "雞肉配飯"],
    english: [
      "chicken rice",
      "chicken and rice",
      "chicken with rice",
      "grilled chicken rice",
      "roasted chicken rice",
      "roast chicken rice",
      "steamed chicken rice",
      "poached chicken rice",
      "chicken leg rice",
      "chicken thigh rice",
      "chicken breast rice",
      "shredded chicken rice",
      "chicken rice bowl",
    ],
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
    english: ["cart noodles", "cart noodle soup"],
  }),
  dish({
    id: "beef-brisket-noodles",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["牛腩麵", "牛腩湯麵", "清湯牛腩麵"],
    simplified: ["牛腩面", "牛腩汤面", "清汤牛腩面"],
    english: ["beef brisket noodles", "beef brisket noodle soup"],
  }),
  dish({
    id: "luncheon-meat-egg-noodles",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["餐蛋麵", "餐蛋湯麵", "餐蛋公仔麵"],
    simplified: ["餐蛋面", "餐蛋汤面", "餐蛋公仔面"],
    english: [
      "luncheon meat egg noodles",
      "luncheon meat egg noodle soup",
      "spam and egg noodles",
      "spam and egg noodle soup",
    ],
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
    traditional: ["牛肉麵", "牛肉湯麵", "紅燒牛肉麵"],
    simplified: ["牛肉面", "牛肉汤面", "红烧牛肉面"],
    english: ["beef noodle soup", "beef noodles", "braised beef noodle soup"],
  }),
  dish({
    id: "rice-vermicelli",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["米線", "湯米線", "湯米粉"],
    simplified: ["米线", "汤米线", "汤米粉"],
    english: ["rice vermicelli", "rice vermicelli soup", "rice noodle soup"],
  }),
  dish({
    id: "ho-fun",
    familyId: "cha-chaan-teng-noodles",
    traditional: ["河粉", "湯河", "湯河粉"],
    simplified: ["河粉", "汤河", "汤河粉"],
    english: ["ho fun", "hor fun", "ho fun soup", "hor fun soup", "flat rice noodle soup"],
  }),
  dish({
    id: "shrimp-wonton-noodle-soup",
    familyId: "wonton-noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["鮮蝦雲吞麵", "鮮蝦餛飩麵", "鮮蝦雲吞湯麵", "鮮蝦餛飩湯麵"],
    simplified: ["鲜虾云吞面", "鲜虾馄饨面", "鲜虾云吞汤面", "鲜虾馄饨汤面"],
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
    traditional: ["拉麵", "湯拉麵", "日式拉麵"],
    simplified: ["拉面", "汤拉面", "日式拉面"],
    english: ["ramen", "ramen soup", "ramen noodle soup"],
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
    id: "cha-chaan-teng-set",
    familyId: "cha-chaan-teng-set",
    traditional: ["茶餐廳常餐", "常餐"],
    simplified: ["茶餐厅常餐"],
    variant: ["茶餐常餐"],
    english: ["cha chaan teng set", "hong kong cafe set meal"],
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
    traditional: ["蝦餃", "鮮蝦餃", "水晶蝦餃"],
    simplified: ["虾饺", "鲜虾饺", "水晶虾饺"],
    english: ["har gow", "shrimp dumpling", "crystal shrimp dumpling"],
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
    traditional: ["漢堡", "漢堡包", "芝士漢堡"],
    simplified: ["汉堡", "汉堡包", "芝士汉堡"],
    english: ["hamburger", "burger", "cheeseburger"],
  }),
  dish({
    id: "sandwich",
    familyId: "sandwich",
    resolverCanonicalName: "sandwich",
    traditional: ["三文治", "火腿三文治", "雞蛋三文治", "吞拿魚三文治"],
    variant: ["三明治", "蛋治", "腿蛋治"],
    english: ["sandwich", "sandwiches", "ham sandwich", "egg sandwich", "tuna sandwich"],
  }),
  dish({
    id: "bolognese",
    familyId: "pasta",
    resolverCanonicalName: "bolognese",
    traditional: ["肉醬意粉", "番茄肉醬意粉"],
    simplified: ["肉酱意粉", "番茄肉酱意粉"],
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
    id: "creamy-macaroni-salad",
    familyId: "salad",
    nutritionCanonicalName: "creamy-salad",
    traditional: ["通粉沙律"],
    variant: ["忌廉通粉沙律"],
    english: ["macaroni salad"],
  }),
  dish({
    id: "char-siu-rice",
    familyId: "siu-mei-rice",
    nutritionCanonicalName: "siu-mei-rice",
    traditional: ["叉燒飯", "叉燒白飯", "燒味飯", "燒鴨飯"],
    simplified: ["叉烧饭", "叉烧白饭", "烧味饭", "烧鸭饭"],
    english: ["char siu rice", "cha siu rice", "char siu with rice", "siu mei rice", "roast duck rice"],
  }),
  dish({
    id: "wonton-noodle-soup",
    familyId: "wonton-noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["雲吞麵", "餛飩麵", "雲吞湯麵", "餛飩湯麵"],
    simplified: ["云吞面", "馄饨面", "云吞汤面", "馄饨汤面"],
    english: ["wonton noodles", "wonton noodle soup", "wonton mein"],
  }),
  dish({
    id: "hong-kong-noodle-soup",
    familyId: "noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["湯麵", "清湯麵"],
    simplified: ["汤面", "清汤面"],
    english: ["noodle soup", "soup noodles", "noodles in soup", "noodles in broth"],
  }),
  dish({
    id: "udon-noodle-soup",
    familyId: "noodle-soup",
    nutritionCanonicalName: "noodle-soup",
    traditional: ["烏冬", "湯烏冬", "烏冬麵", "烏冬湯麵", "烏龍麵", "湯烏龍麵"],
    simplified: ["乌冬", "汤乌冬", "乌冬面", "乌冬汤面", "乌龙面", "汤乌龙面"],
    english: ["udon", "udon noodles", "udon soup", "udon noodle soup"],
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
