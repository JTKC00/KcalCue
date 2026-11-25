import type { PortionUnit } from "@/lib/domain/food-analysis";
import { DISH_IDENTITIES, type DishIdentity } from "./dish-identity";
import {
  licensedFoods,
  publishedReferences,
  USDA_SR_LEGACY_ATTRIBUTION,
  USDA_SR_LEGACY_DATASET,
  USDA_SR_LEGACY_LICENSE,
  type LicensedFood,
  type LicensedFoodId,
  type PublishedReferenceId,
} from "./recipe-catalog";
import {
  calculateRecipe,
  densityRange,
  RANGE_RATIO_FOLLOW_UP,
  type GramRange,
  type RecipeCalculation,
} from "./recipe-calculator";
import type { FoodPreparation, NutritionProfile } from "./types";

export const PILOT_FAMILY_IDS = [
  "rice-plate",
  "cha-chaan-teng-noodles",
  "dim-sum",
  "cha-chaan-teng-breakfast",
  "stir-fried-rice-noodles",
  "bento",
  "donburi",
  "bibimbap",
  "ramen",
  "dressed-noodles",
  "burger",
  "sandwich",
  "pasta",
  "fish-and-chips",
  "soup",
  "sushi",
] as const;

export type PilotFamilyId = (typeof PILOT_FAMILY_IDS)[number];

interface ComponentInput {
  role: string;
  label: string;
  food: LicensedFoodId;
  /** When set, the component density is the envelope of `food` and this food. */
  foodAtMax?: LicensedFoodId;
  grams: GramRange;
}

interface DishInput {
  dishId: string;
  servingGrams: GramRange;
  portion: Extract<PortionUnit, "bowl" | "piece">;
  components: ComponentInput[];
  proxyNote: string;
  sanity: PublishedReferenceId;
  sanityNote: string;
}

interface FamilyInput {
  id: PilotFamilyId;
  title: string;
  selectionReason: string;
  dishes: DishInput[];
}

export interface TemplateComponentRecord {
  role: string;
  label: string;
  sourceIds: string[];
  sourceNames: string[];
  licence: typeof USDA_SR_LEGACY_LICENSE;
  dataset: typeof USDA_SR_LEGACY_DATASET;
  grams: GramRange;
  gramsAtCalorieMin: number;
  gramsAtCalorieMax: number;
  caloriesPer100g: GramRange;
}

export interface CompiledDishTemplate {
  dishId: string;
  familyId: PilotFamilyId;
  familyTitle: string;
  displayName: string;
  aliases: string[];
  calculation: RecipeCalculation;
  rangeRatio: number;
  needsFollowUp: boolean;
  complete: boolean;
  components: TemplateComponentRecord[];
  proxyNote: string;
  sanity: {
    sourceId: string;
    sourceName: string;
    kcalPer100g: number;
    insideRange: boolean;
    note: string;
  };
  profile: NutritionProfile | null;
}

const TEMPLATE_DATA_NOTICE =
  "KcalCue 參考營養資料；密度範圍來自公開資料及已記錄的烹調不確定性規則，並非此餐的化驗結果。";

const TEMPLATE_PREPARATIONS: FoodPreparation[] = [
  "cooked", "steamed", "boiled", "pan_fried", "grilled", "stir_fried", "deep_fried", "sauced", "unknown",
];

const families: readonly FamilyInput[] = [
  {
    id: "rice-plate",
    title: "碟頭飯／碗頭飯",
    selectionReason: "附錄 A 有 16 道，是 52 道菜裡最多的一族，也是香港日常的一碟飯。燒味飯已經有 profile，而且不在這 65 個名稱裡，所以不拿這族去改它。",
    dishes: [
      dish("rice-plate", g(360, 460), "bowl", [
        part("rice", "熟白米", "rice", g(220, 300)),
        part("protein", "餸菜（烚雞到排骨）", "chickenStewedMeat", g(60, 130), "porkRibs"),
        part("sauce", "醬（海鮮醬到燒烤醬）", "hoisin", g(6, 16), "barbecueSauce"),
        part("vegetable", "熟白菜仔", "pakChoi", g(15, 50)),
      ], "沒有寫明餸菜時，蛋白質用烚雞胸腿肉到炆排骨的包絡。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("char-siu-rice-plate", g(360, 430), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "烤豬肩", "porkShoulder", g(70, 100)),
        part("sauce", "海鮮醬", "hoisin", g(8, 15)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 40)),
      ], "SR Legacy 沒有叉燒。烤豬肩加海鮮醬代表蜜汁叉燒，不是某一間燒臘店的配方。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("roast-goose-rice", g(360, 440), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "烤鵝連皮", "gooseRoasted", g(70, 110)),
        part("sauce", "海鮮醬", "hoisin", g(6, 14)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 40)),
      ], "燒鵝用家鵝連皮烤製。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("soy-sauce-chicken-rice", g(370, 450), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "烚雞連皮", "chickenStewedSkin", g(80, 120)),
        part("sauce", "豉油", "soySauce", g(8, 16)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 40)),
      ], "油雞用烚熟連皮雞加豉油，不是豉油雞的化驗。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("crispy-roast-pork-rice", g(350, 420), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "烤豬肩", "porkShoulder", g(60, 100)),
        part("oil", "食油", "oil", g(4, 10)),
        part("vegetable", "熟白菜仔", "pakChoi", g(15, 35)),
      ], "SR Legacy 沒有燒熟的脆皮五花。烤豬肩加油代表脆皮，脂肪可能仍低於真實燒肉。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("white-cut-chicken-rice", g(370, 440), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "烚雞肉", "chickenStewedMeat", g(80, 120)),
        part("oil", "食油", "oil", g(3, 8)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 40)),
      ], "白切雞用去皮烚雞，少量油代表薑蔥。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("hainanese-chicken-rice", g(360, 430), "bowl", [
        part("rice", "熟白米", "rice", g(240, 310)),
        part("protein", "烚雞肉", "chickenStewedMeat", g(80, 120)),
        part("oil", "食油", "oil", g(6, 14)),
        part("sauce", "豉油", "soySauce", g(6, 12)),
      ], "雞油飯用熟白米加食油代表，不是雞油飯的化驗。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("pork-chop-rice", g(380, 460), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "煎豬扒", "porkChop", g(90, 140)),
        part("oil", "食油", "oil", g(5, 12)),
        part("vegetable", "熟白菜仔", "pakChoi", g(15, 35)),
      ], "豬扒用連骨煎豬柳，另加油代表鑊氣。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("chicken-chop-rice", g(380, 470), "bowl", [
        part("rice", "熟白米", "rice", g(240, 300)),
        part("protein", "炸雞扒", "chickenFried", g(90, 140)),
        part("sauce", "燒烤醬", "barbecueSauce", g(8, 16)),
        part("vegetable", "熟白菜仔", "pakChoi", g(15, 35)),
      ], "雞扒用麵糊炸雞連皮。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("fried-egg-rice", g(320, 400), "bowl", [
        part("rice", "熟白米", "rice", g(240, 320)),
        part("egg", "煎蛋", "friedEgg", g(50, 100)),
        part("oil", "食油", "oil", g(2, 6)),
      ], "煎蛋本身已包含煎煮用油，另加少量鑊油。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("mui-choy-pork-rice", g(370, 450), "bowl", [
        part("rice", "熟白米", "rice", g(220, 280)),
        part("protein", "烤豬肩", "porkShoulder", g(70, 110)),
        part("vegetable", "熟芥菜", "mustardGreens", g(40, 80)),
        part("sauce", "蠔油", "oysterSauce", g(8, 16)),
      ], "梅菜用熟芥菜代替。SR Legacy 沒有梅菜。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("lu-rou-fan", g(280, 350), "bowl", [
        part("rice", "熟白米", "rice", g(200, 260)),
        part("protein", "熟絞肉", "groundPork", g(50, 90)),
        part("sauce", "豉油", "soySauce", g(8, 16)),
        part("sugar", "糖", "sugar", g(2, 6)),
      ], "滷肉用熟絞肉、豉油和糖，不是滷汁的化驗。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("spare-rib-rice", g(350, 430), "bowl", [
        part("rice", "熟白米", "rice", g(230, 290)),
        part("protein", "炆排骨", "porkRibs", g(70, 110)),
        part("sauce", "燒烤醬", "barbecueSauce", g(8, 16)),
        part("vegetable", "熟白菜仔", "pakChoi", g(15, 35)),
      ], "排骨用炆豬排。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("yuxiang-eggplant-rice", g(370, 460), "bowl", [
        part("rice", "熟白米", "rice", g(220, 280)),
        part("vegetable", "熟茄子", "eggplant", g(80, 140)),
        part("protein", "熟絞肉", "groundPork", g(20, 45)),
        part("sauce", "海鮮醬", "hoisin", g(10, 20)),
        part("oil", "食油", "oil", g(4, 10)),
        part("sugar", "糖", "sugar", g(2, 6)),
      ], "魚香醬用海鮮醬、糖和油代表甜鹹醬。SR Legacy 沒有豆瓣醬。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("mapo-tofu-rice", g(390, 480), "bowl", [
        part("rice", "熟白米", "rice", g(220, 280)),
        part("tofu", "硬豆腐", "tofu", g(100, 160)),
        part("protein", "熟絞肉", "groundPork", g(25, 50)),
        part("sauce", "海鮮醬", "hoisin", g(10, 20)),
        part("oil", "食油", "oil", g(4, 10)),
      ], "麻婆醬用海鮮醬加油代表，不是豆瓣醬的化驗。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
      dish("beef-rice", g(350, 430), "bowl", [
        part("rice", "熟白米", "rice", g(230, 290)),
        part("protein", "炆牛肩", "beefChuck", g(70, 110)),
        part("sauce", "蠔油", "oysterSauce", g(8, 16)),
        part("vegetable", "熟白菜仔", "pakChoi", g(15, 35)),
      ], "牛肉用連脂炆牛肩。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。"),
    ],
  },
  {
    id: "cha-chaan-teng-noodles",
    title: "茶餐廳麵",
    selectionReason: "附錄 A 有 7 道，與點心並列第二。麵、米線、河粉是茶餐廳午餐。通粉在早餐家族，不在這裡。",
    dishes: [
      dish("plain-noodle-soup", g(540, 700), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(140, 200)),
        part("broth", "雞湯", "broth", g(350, 500)),
        part("oil", "食油", "oil", g(2, 8)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 50)),
      ], "陽春麵連湯。湯用清雞湯，油代表麵底油。", "chunkyChickenNoodle", "美國罐裝塊粒雞麵湯比茶餐廳一碗麵更稀，用來核對連湯麵的下限。"),
      dish("cart-noodles", g(540, 680), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(150, 200)),
        part("broth", "雞湯", "broth", g(280, 400)),
        part("topping", "配料（熟蝦到午餐肉）", "shrimp", g(40, 110), "luncheonMeat"),
        part("oil", "食油", "oil", g(2, 8)),
      ], "車仔麵配料由客人決定，所以蛋白質用熟蝦到午餐肉的包絡。", "chickenChowMein", "美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。"),
      dish("beef-brisket-noodles", g(540, 720), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(150, 210)),
        part("broth", "雞湯", "broth", g(300, 450)),
        part("protein", "炆牛肩", "beefChuck", g(60, 100)),
        part("oil", "食油", "oil", g(2, 8)),
      ], "牛腩用連脂炆牛肩。清湯沒有牛骨湯的濃度。", "chickenChowMein", "美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。"),
      dish("luncheon-meat-egg-noodles", g(540, 700), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(150, 210)),
        part("broth", "雞湯", "broth", g(280, 420)),
        part("meat", "午餐肉", "luncheonMeat", g(30, 60)),
        part("egg", "煎蛋", "friedEgg", g(40, 60)),
        part("oil", "食油", "oil", g(2, 8)),
      ], "餐蛋是午餐肉加一隻煎蛋。", "chickenChowMein", "美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。"),
      dish("beef-noodle-soup", g(540, 730), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(150, 220)),
        part("broth", "雞湯", "broth", g(280, 420)),
        part("protein", "炆牛肩", "beefChuck", g(50, 90)),
        part("oil", "食油", "oil", g(3, 10)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 50)),
      ], "牛肉麵用連脂炆牛肩和清湯，不是紅燒牛肉湯的化驗。", "chickenChowMein", "美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。"),
      dish("rice-vermicelli", g(520, 700), "bowl", [
        part("noodles", "熟米粉", "riceNoodles", g(150, 220)),
        part("broth", "雞湯", "broth", g(300, 460)),
        part("oil", "食油", "oil", g(2, 8)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 50)),
      ], "茶餐廳的米線按湯米線，不是乾撈。", "chunkyChickenNoodle", "美國罐裝塊粒雞麵湯比茶餐廳一碗麵更稀，用來核對連湯麵的下限。"),
      dish("ho-fun", g(500, 680), "bowl", [
        part("noodles", "熟河粉", "riceNoodles", g(160, 240)),
        part("broth", "雞湯", "broth", g(280, 440)),
        part("oil", "食油", "oil", g(2, 8)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 50)),
      ], "這條河粉是湯河，不是乾炒牛河。", "chunkyChickenNoodle", "美國罐裝塊粒雞麵湯比茶餐廳一碗麵更稀，用來核對連湯麵的下限。"),
    ],
  },
  {
    id: "dim-sum",
    title: "點心",
    selectionReason: "附錄 A 有 7 道，與茶餐廳麵並列第二。點心是高頻港式食物。",
    dishes: [
      dish("char-siu-bao", g(75, 100), "piece", [
        part("dough", "餐包", "dinnerRoll", g(50, 70)),
        part("filling", "烤豬肩", "porkShoulder", g(18, 30)),
        part("sauce", "海鮮醬", "hoisin", g(3, 7)),
      ], "蒸包皮用市售餐包代表。餡用烤豬肩加海鮮醬，不是叉燒餡的化驗。", "dinnerRoll", "市售餐包是皮包絡的對照，叉燒包還有肉餡。"),
      dish("egg-tart", g(62, 90), "piece", [
        part("pastry", "烤批皮", "pieCrust", g(18, 32)),
        part("custard", "焗蛋奶醬", "eggCustard", g(40, 65)),
      ], "蛋撻用食譜批皮加焗蛋奶醬，不是某間茶樓的撻。", "eggCustardPie", "市售蛋奶批比港式蛋撻更多餡、更少酥皮。"),
      dish("sticky-rice-chicken", g(160, 210), "piece", [
        part("rice", "熟糯米", "glutinousRice", g(110, 150)),
        part("chicken", "烤雞連皮", "chickenRoastedSkin", g(20, 40)),
        part("sausage", "煙腸", "smokedSausage", g(8, 15)),
        part("mushroom", "熟冬菇", "shiitake", g(8, 16)),
      ], "糯米雞的臘腸用煙燻豬肉腸代替。", "glutinousRice", "熟糯米是主料對照。加了雞和腸之後，整份應高於淨糯米。"),
      dish("siu-mai", g(32, 44), "piece", [
        part("wrapper", "雲吞皮", "wrapper", g(8, 12)),
        part("pork", "熟絞肉", "groundPork", g(16, 26)),
        part("shrimp", "熟蝦", "shrimp", g(4, 10)),
      ], "一隻燒賣，不是一籠。", "potsticker", "急凍豬肉菜鍋貼比燒賣更多菜、更少肉。"),
      dish("har-gow", g(24, 36), "piece", [
        part("wrapper", "雲吞皮", "wrapper", g(8, 14)),
        part("shrimp", "熟蝦", "shrimp", g(14, 24)),
      ], "蝦餃皮用雲吞皮代表，SR Legacy 沒有澄麵皮。", "potsticker", "急凍豬肉菜鍋貼不是蝦餃，只核對餃子的數量級。"),
      dish("xiaolongbao", g(36, 52), "piece", [
        part("wrapper", "雲吞皮", "wrapper", g(12, 18)),
        part("pork", "熟絞肉", "groundPork", g(14, 24)),
        part("broth", "雞湯", "broth", g(6, 14)),
      ], "湯汁用清雞湯代表凍肉凍，濃度可能偏低。", "potsticker", "急凍豬肉菜鍋貼沒有小籠包的湯汁。"),
      dish("spring-roll", g(42, 64), "piece", [
        part("wrapper", "雲吞皮", "wrapper", g(12, 22)),
        part("vegetable", "熟椰菜", "cabbage", g(12, 25)),
        part("pork", "熟絞肉", "groundPork", g(8, 16)),
        part("oil", "食油", "oil", g(4, 9)),
      ], "春卷的吸油另列，不把整條卷當成純油。", "eggRolls", "美國中餐館雜錦蛋卷。"),
    ],
  },
  {
    id: "cha-chaan-teng-breakfast",
    title: "茶餐廳早餐",
    selectionReason: "附錄 A 有 3 道，是前三名之後最多的一族。通粉湯也在這族，但不在 65 個名稱裡，模板仍會蓋到它。",
    dishes: [
      dish("hong-kong-french-toast", g(120, 165), "piece", [
        part("bread", "白方包", "bread", g(60, 90)),
        part("egg", "煎蛋", "friedEgg", g(40, 55)),
        part("butter", "牛油", "butter", g(6, 14)),
        part("milk", "甜煉奶", "condensedMilk", g(8, 18)),
      ], "港式西多士計入牛油和煉奶。沒有花生醬這一列。", "frenchToast", "USDA 法式吐司用低脂奶、沒有煉奶，應靠近這條範圍的下限。"),
      dish("pineapple-bun", g(70, 98), "piece", [
        part("dough", "餐包", "dinnerRoll", g(55, 80)),
        part("sugar", "糖", "sugar", g(6, 14)),
        part("butter", "牛油", "butter", g(3, 8)),
      ], "菠蘿皮用糖和牛油代表，不是酥皮的化驗。", "sweetRoll", "市售肉桂甜包用來核對甜麵包的數量級。"),
      dish("sausage-and-egg", g(95, 125), "piece", [
        part("sausage", "豬肉腸", "frankfurter", g(40, 70)),
        part("egg", "煎蛋", "friedEgg", g(45, 60)),
        part("oil", "食油", "oil", g(2, 6)),
      ], "茶餐廳腸仔用豬肉法蘭克福腸。", "frankfurter", "豬肉腸是這碟的主料。加蛋之後整份密度應蓋過或接近腸本身。"),
      dish("macaroni-soup-breakfast", g(350, 480), "bowl", [
        part("pasta", "熟通粉", "pasta", g(80, 140)),
        part("ham", "火腿", "ham", g(25, 45)),
        part("broth", "雞湯", "broth", g(220, 340)),
        part("oil", "食油", "oil", g(1, 4)),
      ], "火腿通粉連湯。通粉用熟意粉。", "chunkyChickenNoodle", "美國罐裝塊粒雞麵湯比火腿通粉更稀。"),
    ],
  },
  {
    id: "stir-fried-rice-noodles",
    title: "炒河粉／炒米",
    selectionReason: "附錄 A 有 2 道，與便當、丼、拌麵、壽司打平。乾炒牛河和星洲炒米比那幾族更常出現在香港日常菜單。便當、火鍋、壽司拼盤的變異更大，這次不做。",
    dishes: [
      dish("dry-fried-beef-ho-fun", g(290, 390), "bowl", [
        part("noodles", "熟河粉", "riceNoodles", g(180, 240)),
        part("beef", "瘦炆牛肉", "beefLean", g(50, 85)),
        part("oil", "食油", "oil", g(8, 16)),
        part("sauce", "豉油", "soySauce", g(6, 12)),
        part("vegetable", "熟椰菜", "cabbage", g(30, 60)),
      ], "乾炒牛河的牛肉用瘦牛肩，油另外計算。", "vegetableLoMein", "美國中餐館素菜撈麵沒有牛肉，用來核對炒粉麵的數量級。"),
      dish("singapore-fried-vermicelli", g(260, 360), "bowl", [
        part("noodles", "熟米粉", "riceNoodles", g(150, 210)),
        part("pork", "烤豬肩", "porkShoulder", g(20, 40)),
        part("shrimp", "熟蝦", "shrimp", g(15, 35)),
        part("egg", "煎蛋", "friedEgg", g(20, 40)),
        part("vegetable", "熟椰菜", "cabbage", g(25, 50)),
        part("oil", "食油", "oil", g(8, 16)),
      ], "咖喱粉份量很小，沒有單獨列。顏色不當成熱量。", "vegetableLoMein", "美國中餐館素菜撈麵用來核對炒粉麵的數量級。"),
    ],
  },
  {
    id: "bento",
    title: "便當",
    selectionReason: "附錄 A 有 2 道（午餐便當、日式便當），為香港上班族常見盒飯組合。",
    dishes: [
      dish("lunch-bento", g(380, 500), "bowl", [
        part("rice", "熟白米", "rice", g(180, 260)),
        part("protein", "主菜（烚雞肉到煎豬扒）", "chickenStewedMeat", g(80, 140), "porkChop"),
        part("vegetable", "熟蔬菜（白菜仔到椰菜）", "pakChoi", g(50, 110), "cabbage"),
        part("oil", "食油", "oil", g(4, 12)),
        part("sauce", "醬汁（豉油到海鮮醬）", "soySauce", g(6, 16), "hoisin"),
      ], "便當配菜變化較大，蛋白質用烚雞肉到煎豬扒包絡，只作盒飯參考範圍。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的盒飯數量級。"),
      dish("japanese-bento", g(380, 500), "bowl", [
        part("rice", "熟白米", "rice", g(180, 250)),
        part("protein", "主菜（烤魚到炸雞）", "seaBass", g(80, 140), "chickenFried"),
        part("egg", "蛋（烚蛋到煎蛋）", "boiledEgg", g(25, 55), "friedEgg"),
        part("vegetable", "熟蔬菜（椰菜到紅蘿蔔）", "cabbage", g(45, 95), "carrotBoiled"),
        part("sauce", "醬汁（豉油到海鮮醬）", "soySauce", g(6, 16), "hoisin"),
      ], "日式便當主菜從烤魚到唐揚炸雞差異大，配菜以熟蔬菜和蛋類包絡。", "friedRiceMeatless", "美國中餐館無肉炒飯，只核對以飯為主的盒飯數量級。"),
    ],
  },
  {
    id: "donburi",
    title: "丼飯",
    selectionReason: "附錄 A 有 2 道（親子丼、牛丼），是日常高頻日式蓋飯。",
    dishes: [
      dish("oyakodon", g(380, 480), "bowl", [
        part("rice", "熟白米", "rice", g(200, 280)),
        part("chicken", "雞肉（去皮烚雞到連皮烚雞）", "chickenStewedMeat", g(80, 130), "chickenStewedSkin"),
        part("egg", "雞蛋（烚蛋到煎蛋）", "boiledEgg", g(50, 90), "friedEgg"),
        part("broth", "高湯", "broth", g(25, 60)),
        part("sauce", "豉油", "soySauce", g(8, 16)),
        part("sugar", "糖", "sugar", g(3, 8)),
      ], "親子丼以白飯、雞肉、蛋及甜醬油高湯代表，高湯用清雞湯代理。", "whiteRice", "熟白米作為底飯對照；加雞肉與蛋後密度應高於純白飯。"),
      dish("gyudon", g(380, 480), "bowl", [
        part("rice", "熟白米", "rice", g(200, 280)),
        part("beef", "牛肉（瘦炆牛肉到連脂炆牛肩）", "beefLean", g(80, 130), "beefChuck"),
        part("broth", "高湯", "broth", g(30, 70)),
        part("sauce", "豉油", "soySauce", g(8, 16)),
        part("sugar", "糖", "sugar", g(4, 10)),
      ], "牛丼的肥牛比例差異以瘦牛肩到連脂牛肩包絡。", "friedRiceMeatless", "無肉炒飯作為飯類主食的數量級對照。"),
    ],
  },
  {
    id: "bibimbap",
    title: "石鍋拌飯",
    selectionReason: "附錄 A 的韓式拌飯，結構明確（白飯、肉、蛋、蔬菜、醬與油）。",
    dishes: [
      dish("bibimbap", g(420, 540), "bowl", [
        part("rice", "熟白米", "rice", g(200, 280)),
        part("beef", "牛肉（瘦牛肩到連脂牛肩）", "beefLean", g(50, 100), "beefChuck"),
        part("egg", "煎蛋", "friedEgg", g(45, 60)),
        part("vegetable", "蔬菜（白菜仔到紅蘿蔔）", "pakChoi", g(80, 150), "carrotBoiled"),
        part("sauce", "拌飯醬（燒烤醬到海鮮醬）", "barbecueSauce", g(15, 30), "hoisin"),
        part("oil", "食油", "oil", g(4, 12)),
      ], "SR Legacy 沒有韓式辣醬，用燒烤醬到海鮮醬包絡甜鹹醬料，另計麻油／鍋底油。", "friedRiceMeatless", "無肉炒飯只核對飯類混合菜式的數量級。"),
    ],
  },
  {
    id: "ramen",
    title: "拉麵",
    selectionReason: "附錄 A 的日式拉麵，香港非常常見，湯底油脂差異以油量範圍反映。",
    dishes: [
      dish("ramen", g(580, 760), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(140, 200)),
        part("broth", "湯底", "broth", g(320, 460)),
        part("pork", "叉燒（烤豬肩）", "porkShoulder", g(45, 95)),
        part("egg", "半熟／烚蛋", "boiledEgg", g(25, 55)),
        part("oil", "湯面油脂", "oil", g(6, 18)),
        part("vegetable", "蔬菜", "pakChoi", g(15, 40)),
      ], "清湯醬油拉麵與濃豚骨拉麵油脂差距大，以湯底油量 6–18 g 包絡，不代表某間拉麵店配方。", "chickenChowMein", "中餐館雞炒麵作為有麵有肉的參考對照。"),
    ],
  },
  {
    id: "dressed-noodles",
    title: "拌麵",
    selectionReason: "附錄 A 有 2 道（擔擔麵、炸醬麵），香港中式麵店常見。",
    dishes: [
      dish("dan-dan-noodles", g(360, 500), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(150, 220)),
        part("broth", "湯底", "broth", g(100, 200)),
        part("pork", "熟豬絞肉", "groundPork", g(35, 70)),
        part("paste", "芝麻醬", "tahini", g(15, 35)),
        part("oil", "辣油／食油", "oil", g(4, 12)),
        part("vegetable", "熟白菜仔", "pakChoi", g(20, 50)),
      ], "擔擔麵的麻醬與紅油比例差異大，以芝麻醬 15–35 g 加食油反映。", "vegetableLoMein", "美國中餐館素菜撈麵只核對拌麵的數量級。"),
      dish("zhajiangmian", g(320, 440), "bowl", [
        part("noodles", "熟蛋麵", "eggNoodles", g(180, 260)),
        part("pork", "熟豬絞肉", "groundPork", g(50, 95)),
        part("sauce", "甜麵醬（海鮮醬代理）", "hoisin", g(20, 45)),
        part("vegetable", "生青瓜絲", "cucumberRaw", g(30, 65)),
        part("oil", "食油", "oil", g(4, 12)),
      ], "SR Legacy 沒有京式黃醬／甜麵醬，以海鮮醬代理肉醬醬料。", "vegetableLoMein", "美國中餐館素菜撈麵作為拌麵的數量級對照。"),
    ],
  },
  {
    id: "burger",
    title: "漢堡",
    selectionReason: "附錄 A 的西式快餐主食，麵包、肉扒、芝士及醬料結構清晰。",
    dishes: [
      dish("hamburger", g(170, 260), "piece", [
        part("bun", "漢堡包", "hamburgerRoll", g(55, 85)),
        part("patty", "熟牛肉漢堡扒", "groundBeef", g(75, 130)),
        part("cheese", "芝士（可選）", "mozzarellaCheese", g(0, 25), "cheddarCheese"),
        part("vegetable", "生菜／番茄", "lettuceRaw", g(15, 45), "tomatoRaw"),
        part("spread", "醬料（茄汁到蛋黃醬）", "tomatoSauce", g(8, 22), "mayonnaise"),
      ], "單層漢堡，醬料以茄汁到蛋黃醬包絡、芝士為可選配料，不是某間連鎖店化驗值。", "hamburgerPlain", "USDA 快餐原味漢堡（297 kcal／100 g）核對數量級。"),
    ],
  },
  {
    id: "sandwich",
    title: "三文治",
    selectionReason: "附錄 A 的茶餐廳及便利店常見輕食。",
    dishes: [
      dish("sandwich", g(130, 200), "piece", [
        part("bread", "白方包", "bread", g(65, 95)),
        part("filling", "餡料（火腿到午餐肉）", "ham", g(35, 70), "luncheonMeat"),
        part("spread", "塗醬（蛋黃醬到牛油）", "mayonnaise", g(4, 14), "butter"),
        part("vegetable", "生菜／番茄", "lettuceRaw", g(10, 40), "tomatoRaw"),
      ], "三文治餡料多變，以火腿到午餐肉及薄牛油／蛋黃醬包絡，不代表雙層厚餡三文治。", "whiteBread", "白方包（266 kcal／100 g）作為三文治主體的數量級對照。"),
    ],
  },
  {
    id: "pasta",
    title: "意粉",
    selectionReason: "附錄 A 的肉醬意粉，香港茶餐廳與西餐廳高頻菜式。",
    dishes: [
      dish("bolognese", g(340, 460), "bowl", [
        part("pasta", "熟意粉", "pasta", g(180, 260)),
        part("sauce", "番茄醬", "tomatoSauce", g(80, 140)),
        part("beef", "熟牛絞肉", "groundBeef", g(50, 95)),
        part("oil", "食油", "oil", g(4, 12)),
        part("cheese", "芝士（可選）", "mozzarellaCheese", g(0, 15), "cheddarCheese"),
      ], "番茄肉醬意粉以熟意粉、罐裝番茄醬、熟牛絞肉及少量食油與可選芝士構成。", "pastaPlain", "淨熟意粉（158 kcal／100 g）作為主體澱粉對照。"),
    ],
  },
  {
    id: "fish-and-chips",
    title: "炸魚薯條",
    selectionReason: "附錄 A 的西式炸魚柳配薯條，原料直接對應 USDA SR Legacy。",
    dishes: [
      dish("fish-and-chips", g(300, 420), "bowl", [
        part("fish", "炸魚柳", "friedFish", g(130, 200)),
        part("fries", "炸薯條", "frenchFries", g(140, 220)),
        part("oil", "額外炸油／蘸醬空間", "oil", g(4, 12)),
      ], "脆漿炸魚柳加炸薯條，不含額外大量他他醬。", "breadedFish", "USDA 脆漿炸魚柳（234 kcal／100 g）作為主料對照。"),
    ],
  },
  {
    id: "soup",
    title: "湯類",
    selectionReason: "附錄 A 的冬蔭功湯，以清湯到椰奶濃湯包絡。",
    dishes: [
      dish("tom-yum-soup", g(360, 480), "bowl", [
        part("broth", "清湯", "broth", g(250, 360)),
        part("shrimp", "熟蝦", "shrimp", g(45, 85)),
        part("mushroom", "熟白蘑菇", "whiteMushroom", g(25, 55)),
        part("tomato", "番茄", "tomatoRaw", g(20, 45)),
        part("cream", "椰奶（清湯為 0 到濃湯 30 g）", "coconutMilk", g(0, 30)),
        part("oil", "辣油／食油", "oil", g(2, 6)),
      ], "冬蔭功清湯與加椰奶／花奶版本熱量差異明顯，以椰奶 0–30 g 包絡並標記追問。", "chickenBroth", "清雞湯（6 kcal／100 g）作為純清湯下限對照。"),
    ],
  },
  {
    id: "sushi",
    title: "壽司",
    selectionReason: "附錄 A 有 2 道（壽司、壽司拼盤），為常見日式主食。",
    dishes: [
      dish("sushi", g(30, 44), "piece", [
        part("rice", "熟白米", "rice", g(18, 26)),
        part("topping", "魚生／熟蝦（熟蝦到生三文魚）", "shrimp", g(10, 18), "salmonRaw"),
        part("sugar", "壽司醋糖", "sugar", g(0.5, 1.5)),
      ], "一件握壽司，配料以熟蝦到生三文魚包絡，不含大量蛋黃醬或炸物卷。", "whiteRice", "熟白米（130 kcal／100 g）作為壽司飯主體對照。"),
      dish("sushi-platter", g(260, 400), "bowl", [
        part("rice", "熟白米", "rice", g(160, 240)),
        part("topping", "魚生／熟蝦（熟蝦到生三文魚）", "shrimp", g(85, 150), "salmonRaw"),
        part("accent", "配料（青瓜到牛油果）", "cucumberRaw", g(10, 35), "avocado"),
        part("sugar", "壽司醋糖", "sugar", g(4, 12)),
      ], "一般單人壽司拼盤（約 8–12 件），不含炸天婦羅卷或厚醬炙燒卷。", "whiteRice", "熟白米（130 kcal／100 g）作為壽司飯主體對照。"),
    ],
  },
];

const identities = new Map(DISH_IDENTITIES.map((identity) => [identity.id, identity]));

export const compiledDishTemplates: readonly CompiledDishTemplate[] = families.flatMap((family) =>
  family.dishes.map((input) => compileDish(family, input)),
);

const templateByDishId = new Map(compiledDishTemplates.map((template) => [template.dishId, template]));

export const templateNutritionProfiles: NutritionProfile[] = compiledDishTemplates.flatMap((template) =>
  template.profile ? [template.profile] : [],
);

export function dishTemplateIsComplete(dishId: string): boolean {
  return templateByDishId.get(dishId)?.complete === true;
}

/** Template profiles whose per-100 g calorie band exceeds the follow-up rule. */
export function templateRangeNeedsFollowUp(
  profile: { id: string; nutrientsPer100g: { calories: { min: number; max: number } } } | null | undefined,
): boolean {
  if (!profile?.id.startsWith("template:")) return false;
  const { min, max } = profile.nutrientsPer100g.calories;
  return min > 0 && max / min > RANGE_RATIO_FOLLOW_UP;
}

export function pilotFamilyDefinitions(): ReadonlyArray<{
  id: PilotFamilyId;
  title: string;
  selectionReason: string;
}> {
  return families.map((family) => ({
    id: family.id,
    title: family.title,
    selectionReason: family.selectionReason,
  }));
}

function compileDish(family: FamilyInput, input: DishInput): CompiledDishTemplate {
  const identity = identities.get(input.dishId);
  if (!identity) throw new Error(`食譜模板找不到菜色 ${input.dishId}`);
  if (identity.familyId !== family.id) {
    throw new Error(`${input.dishId} 屬於 ${identity.familyId}，不是 ${family.id}`);
  }
  if (identity.nutritionCanonicalName !== null) {
    throw new Error(`${input.dishId} 已有營養 profile，模板不可以取代它`);
  }

  const prepared = input.components.map((component) => {
    const low = requireFood(component.food);
    const high = component.foodAtMax ? requireFood(component.foodAtMax) : undefined;
    return {
      role: component.role,
      label: component.label,
      low,
      high,
      grams: component.grams,
      nutrientsPer100g: densityRange(nutrientsOf(low), high ? nutrientsOf(high) : undefined),
    };
  });
  const calculation = calculateRecipe({
    servingGrams: input.servingGrams,
    components: prepared.map((component) => ({
      grams: component.grams,
      nutrientsPer100g: component.nutrientsPer100g,
    })),
  });
  const reference = publishedReferences[input.sanity];
  const components: TemplateComponentRecord[] = prepared.map((component, index) => {
    const calculated = calculation.components[index];
    const sources = component.high ? [component.low, component.high] : [component.low];
    return {
      role: component.role,
      label: component.label,
      sourceIds: sources.map((source) => source.id),
      sourceNames: sources.map((source) => source.sourceName),
      licence: USDA_SR_LEGACY_LICENSE,
      dataset: USDA_SR_LEGACY_DATASET,
      grams: component.grams,
      gramsAtCalorieMin: calculated?.gramsAtCalorieMin ?? component.grams.min,
      gramsAtCalorieMax: calculated?.gramsAtCalorieMax ?? component.grams.max,
      caloriesPer100g: component.nutrientsPer100g.calories,
    };
  });
  const template: CompiledDishTemplate = {
    dishId: input.dishId,
    familyId: family.id,
    familyTitle: family.title,
    displayName: identity.aliases.find((alias) => alias.script === "traditional")?.text ?? input.dishId,
    aliases: identity.aliases.map((alias) => alias.text),
    calculation,
    rangeRatio: calculation.rangeRatio,
    needsFollowUp: calculation.needsFollowUp,
    complete: calculation.complete && calculation.feasible,
    components,
    proxyNote: input.proxyNote,
    sanity: {
      sourceId: reference.id,
      sourceName: reference.sourceName,
      kcalPer100g: reference.kcalPer100g,
      insideRange: calculation.feasible
        && reference.kcalPer100g >= calculation.per100g.calories.min
        && reference.kcalPer100g <= calculation.per100g.calories.max,
      note: input.sanityNote,
    },
    profile: null,
  };
  template.profile = template.complete ? profileFor(template, identity, input.portion) : null;
  return template;
}

function profileFor(
  template: CompiledDishTemplate,
  identity: DishIdentity,
  portion: Extract<PortionUnit, "bowl" | "piece">,
): NutritionProfile {
  const sourceIds = [...new Set(template.components.flatMap((component) => component.sourceIds))];
  const referenceGrams = Math.max(1, Math.round(
    (template.calculation.feasibleGrams.min + template.calculation.feasibleGrams.max) / 2,
  ));
  const followUp = template.needsFollowUp
    ? " R 大於 2.5，標記為需要後續追問，這次仍納入計算。"
    : "";
  return {
    id: `template:${template.dishId}`,
    displayName: template.displayName,
    canonicalName: identity.resolverCanonicalName,
    category: "mixed",
    preparations: TEMPLATE_PREPARATIONS,
    aliases: template.aliases,
    composite: true,
    nutrientsPer100g: template.calculation.per100g,
    gramsPerUnit: { g: 1, [portion]: referenceGrams },
    source: {
      provider: "kcalcue-reference",
      sourceId: sourceIds.join("+"),
      sourceName: `食譜模板：${template.displayName}（${USDA_SR_LEGACY_DATASET}）`,
      retrievedAt: "2018-04",
      attribution: USDA_SR_LEGACY_ATTRIBUTION,
    },
    dataNotice: TEMPLATE_DATA_NOTICE,
    densityBasis: [
      `港式一份的食譜模板，原料點值來自 ${USDA_SR_LEGACY_DATASET}（${USDA_SR_LEGACY_LICENSE}）。`,
      template.components.map((component) =>
        `${component.label} ${component.grams.min}–${component.grams.max} g（${component.sourceIds.join("、")}）`,
      ).join("；") + "。",
      `總重限制落在可行區間 ${template.calculation.feasibleGrams.min}–${template.calculation.feasibleGrams.max} g。`,
      `每 100 g 熱量 ${template.calculation.per100g.calories.min}–${template.calculation.per100g.calories.max}，R=${template.rangeRatio.toFixed(2)}。`,
      followUp,
      template.proxyNote,
      "這不是這碟的化驗，也不是模型估計。組合菜不會拆成單一食材。",
    ].filter(Boolean).join(""),
  };
}

function requireFood(id: LicensedFoodId): LicensedFood {
  return licensedFoods[id];
}

function nutrientsOf(food: LicensedFood) {
  return {
    calories: food.calories,
    protein: food.protein,
    carbs: food.carbs,
    fat: food.fat,
  };
}

function dish(
  dishId: string,
  servingGrams: GramRange,
  portion: Extract<PortionUnit, "bowl" | "piece">,
  components: ComponentInput[],
  proxyNote: string,
  sanity: PublishedReferenceId,
  sanityNote: string,
): DishInput {
  return { dishId, servingGrams, portion, components, proxyNote, sanity, sanityNote };
}

function part(
  role: string,
  label: string,
  food: LicensedFoodId,
  grams: GramRange,
  foodAtMax?: LicensedFoodId,
): ComponentInput {
  return { role, label, food, grams, ...(foodAtMax ? { foodAtMax } : {}) };
}

function g(min: number, max: number): GramRange {
  return { min, max };
}
