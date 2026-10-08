/**
 * USDA FoodData Central SR Legacy, April 2018 CSV (CC0).
 * Values are per 100 g: energy (nutrient 1008, kcal), protein (1003),
 * carbohydrate by difference (1005), total lipid (1004).
 * HK CFS and Open Food Facts are not used.
 */
export interface LicensedFood {
  id: string;
  fdcId: number;
  sourceName: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export const USDA_SR_LEGACY_DATASET = "USDA FoodData Central SR Legacy 2018-04";

export const USDA_SR_LEGACY_ATTRIBUTION =
  "U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. SR Legacy（2018-04）。公有領域／CC0 1.0。";

export const USDA_SR_LEGACY_LICENSE = "CC0-1.0";

export const licensedFoods = {
  rice: food(168878, "Rice, white, long-grain, regular, enriched, cooked", 130, 2.69, 28.17, 0.28),
  eggNoodles: food(169732, "Noodles, egg, enriched, cooked", 138, 4.54, 25.16, 2.07),
  riceNoodles: food(168914, "Rice noodles, cooked", 108, 1.79, 24.01, 0.2),
  glutinousRice: food(169711, "Rice, white, glutinous, unenriched, cooked", 97, 2.02, 21.09, 0.19),
  gooseRoasted: food(172412, "Goose, domesticated, meat and skin, cooked, roasted", 305, 25.16, 0, 21.92),
  chickenRoastedSkin: food(171450, "Chicken, broilers or fryers, meat and skin, cooked, roasted", 239, 27.3, 0, 13.6),
  chickenStewedSkin: food(171051, "Chicken, broilers or fryers, meat and skin, cooked, stewed", 219, 24.68, 0, 12.56),
  chickenStewedMeat: food(171451, "Chicken, broilers or fryers, meat only, cooked, stewed", 177, 27.29, 0, 6.71),
  chickenFried: food(171448, "Chicken, broilers or fryers, meat and skin, cooked, fried, batter", 289, 22.54, 9.42, 17.35),
  porkShoulder: food(168257, "Pork, fresh, shoulder, arm picnic, separable lean and fat, cooked, roasted", 317, 23.47, 0, 24.01),
  porkChop: food(168292, "Pork, fresh, loin, center loin (chops), bone-in, separable lean and fat, cooked, pan-fried", 238, 27.63, 0, 13.32),
  porkRibs: food(167854, "Pork, fresh, spareribs, separable lean and fat, cooked, braised", 397, 29.06, 0, 30.3),
  groundPork: food(167903, "Pork, fresh, ground, cooked", 297, 25.69, 0, 20.77),
  luncheonMeat: food(174571, "Luncheon meat, pork, canned", 334, 12.5, 2.1, 30.3),
  friedEgg: food(173423, "Egg, whole, cooked, fried", 196, 13.61, 0.83, 14.84),
  eggplant: food(169352, "Eggplant, cooked, boiled, drained, with salt", 33, 0.83, 8.14, 0.23),
  tofu: food(172475, "Tofu, raw, firm, prepared with calcium sulfate", 144, 17.27, 2.78, 8.72),
  beefChuck: food(168669, "Beef, chuck, arm pot roast, separable lean and fat, trimmed to 1/8\" fat, choice, cooked, braised", 309, 30.2, 0, 19.93),
  beefLean: food(171817, "Beef, chuck, arm pot roast, separable lean only, trimmed to 1/8\" fat, choice, cooked, braised", 224, 34.72, 0, 8.37),
  broth: food(174536, "Soup, chicken broth, ready-to-serve", 6, 0.64, 0.44, 0.21),
  soySauce: food(174277, "Soy sauce made from soy and wheat (shoyu)", 53, 8.14, 4.93, 0.57),
  oil: food(171411, "Oil, soybean, salad or cooking", 884, 0, 0, 100),
  barbecueSauce: food(174523, "Sauce, barbecue", 172, 0.82, 40.77, 0.63),
  hoisin: food(172886, "Sauce, hoisin, ready-to-serve", 220, 3.31, 44.08, 3.39),
  mustardGreens: food(170503, "Mustard greens, cooked, boiled, drained, with salt", 26, 2.56, 4.51, 0.47),
  shrimp: food(175180, "Crustaceans, shrimp, cooked", 99, 23.98, 0.2, 0.28),
  bread: food(174924, "Bread, white, commercially prepared (includes soft bread crumbs)", 266, 8.85, 49.42, 3.33),
  dinnerRoll: food(172793, "Rolls, dinner, plain, commercially prepared (includes brown-and-serve)", 310, 10.86, 52.04, 6.47),
  sugar: food(169655, "Sugars, granulated", 387, 0, 99.98, 0),
  butter: food(173430, "Butter, without salt", 717, 0.85, 0.06, 81.11),
  condensedMilk: food(171275, "Milk, canned, condensed, sweetened", 321, 7.91, 54.4, 8.7),
  frankfurter: food(172964, "Frankfurter, pork", 269, 12.81, 0.28, 23.68),
  smokedSausage: food(174584, "Sausage, smoked link sausage, pork", 309, 11.98, 0.94, 28.23),
  pasta: food(169737, "Pasta, cooked, enriched, without added salt", 158, 5.8, 30.86, 0.93),
  cabbage: food(168514, "Cabbage, common, cooked, boiled, drained, with salt", 23, 1.27, 5.51, 0.06),
  pakChoi: food(168517, "Cabbage, chinese (pak-choi), cooked, boiled, drained, with salt", 12, 1.56, 1.78, 0.16),
  wrapper: food(172802, "Wonton wrappers (includes egg roll wrappers)", 291, 9.8, 57.9, 1.5),
  pieCrust: food(175026, "Pie crust, standard-type, prepared from recipe, baked", 527, 6.4, 47.5, 34.6),
  eggCustard: food(169595, "Desserts, egg custard, baked, prepared-from-recipe", 104, 5.02, 11, 4.58),
  ham: food(173864, "Ham, sliced, regular (approximately 11% fat)", 164, 16.6, 3.63, 8.8),
  oysterSauce: food(174529, "Sauce, oyster, ready-to-serve", 51, 1.35, 10.92, 0.25),
  shiitake: food(170097, "Mushrooms, shiitake, cooked, with salt", 56, 1.56, 14.39, 0.22),
} as const satisfies Record<string, LicensedFood>;

export type LicensedFoodId = keyof typeof licensedFoods;

export interface PublishedReference {
  id: string;
  fdcId: number;
  sourceName: string;
  kcalPer100g: number;
}

export const publishedReferences = {
  friedRiceMeatless: reference(167668, "Restaurant, Chinese, fried rice, without meat", 174),
  chunkyChickenNoodle: reference(171148, "Soup, chunky chicken noodle, canned, ready-to-serve", 41),
  chickenChowMein: reference(168083, "Restaurant, Chinese, chicken chow mein", 85),
  vegetableLoMein: reference(167677, "Restaurant, Chinese, vegetable lo mein, without meat", 121),
  eggRolls: reference(167667, "Restaurant, Chinese, egg rolls, assorted", 250),
  eggCustardPie: reference(172783, "Pie, egg custard, commercially prepared", 210),
  frenchToast: reference(174998, "French toast, prepared from recipe, made with low fat (2%) milk", 229),
  sweetRoll: reference(175034, "Sweet rolls, cinnamon, commercially prepared with raisins", 372),
  dinnerRoll: reference(172793, "Rolls, dinner, plain, commercially prepared", 310),
  potsticker: reference(169773, "Potsticker or wonton, pork and vegetable, frozen, unprepared", 136),
  glutinousRice: reference(169711, "Rice, white, glutinous, unenriched, cooked", 97),
  frankfurter: reference(172964, "Frankfurter, pork", 269),
} as const satisfies Record<string, PublishedReference>;

export type PublishedReferenceId = keyof typeof publishedReferences;

export function fdcSourceId(fdcId: number): string {
  return `fdc:${fdcId}`;
}

function food(
  fdcId: number,
  sourceName: string,
  calories: number,
  protein: number,
  carbs: number,
  fat: number,
): LicensedFood {
  return { id: fdcSourceId(fdcId), fdcId, sourceName, calories, protein, carbs, fat };
}

function reference(fdcId: number, sourceName: string, kcalPer100g: number): PublishedReference {
  return { id: fdcSourceId(fdcId), fdcId, sourceName, kcalPer100g };
}
