import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import { containerMilkNameKey, normalizeFoodName } from "@/lib/nutrition/canonical";

export const MERGED_DUPLICATE_MILK_NOTICE =
  "已合併重複嘅牛奶項目，如果係兩杯可以再加返";

/**
 * Not the merged notice. Extra rows stay visible but stay out of the
 * confirmed total until the user says they are a separate serving.
 */
export const SUSPECTED_DUPLICATE_MILK_NOTICE =
  "可能係同一份飲品重複列出。請確認係一份定係分開嘅份量；未確認前，多餘項目唔會計入總 kcal。";

const SEPARATE_CONTAINER =
  /另一杯|另一盒|另一瓶|第二杯|第二盒|兩杯|兩盒|兩瓶|兩個杯|兩隻杯|兩個玻璃杯|旁邊|前方|後方|前面|後面|another glass|another cup|second glass|two glasses|two cups|two cartons|front|back|separate|distinct/;
const SAME_SERVING =
  /同一(?:紙盒|盒|瓶|樽|隻杯|杯|玻璃杯|份|容器)|只有一(?:個紙盒|隻杯|個杯)|same (?:carton|bottle|glass|cup|serving|container)|一(?:盒|杯)飲品被(?:拆|分)成兩項/;
const UNCERTAIN_SAME_SERVING =
  /未能|未知|未確定|不確定|無法|未確認|可能|是否|不是|並非|未必|\b(?:not|maybe|might|may|whether|unclear|cannot|could|unsure)\b/;
const CARTON = /紙盒|纸盒|紙包|纸包|利樂|利乐|carton|一盒|盒裝|盒装/;
const BOTTLE = /瓶子|玻璃樽|一瓶|一樽|瓶裝|瓶装|(?:^|\s)bottle(?:$|\s)/;
const GLASS = /玻璃杯|杯裝|杯装|另一(?:個|个|隻|只)?杯|第二(?:個|个|隻|只)?杯|(?<!同)一杯|(?:^|\s)(?:glass|cup)(?:$|\s)/;
const WRAPPED = /包裝/;

function releaseSuspect(food: ObservedFood): ObservedFood {
  if (food.suspectedDuplicateMilk !== true) return food;
  const cleared: ObservedFood = { ...food };
  delete cleared.suspectedDuplicateMilk;
  return cleared;
}

function withMergeNotice(food: ObservedFood): ObservedFood {
  const cleared = releaseSuspect(food);
  if (cleared.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE) return cleared;
  return { ...cleared, duplicateMilkNotice: MERGED_DUPLICATE_MILK_NOTICE };
}

function milkRowText(food: ObservedFood): string {
  return [
    food.displayName,
    food.normalizedName,
    food.notes ?? "",
    food.preparationMethod ?? "",
    ...(food.visibleIngredients ?? []),
    ...food.uncertaintyReasons,
  ].join(" ");
}

function containerKinds(food: ObservedFood): Set<"carton" | "bottle" | "glass" | "package"> {
  const text = normalizeFoodName(milkRowText(food));
  const kinds = new Set<"carton" | "bottle" | "glass" | "package">();
  if (CARTON.test(text)) kinds.add("carton");
  if (BOTTLE.test(text)) kinds.add("bottle");
  if (WRAPPED.test(text)) kinds.add("package");
  if (GLASS.test(text)) kinds.add("glass");
  return kinds;
}

/** Container kind named on this row's identity, not a note about another drink. */
function rowOwnContainerKinds(food: ObservedFood): Set<"carton" | "bottle" | "glass" | "package"> {
  const kinds = containerKinds({
    ...food,
    notes: undefined,
    visibleIngredients: undefined,
    uncertaintyReasons: [],
  });
  if (kinds.has("carton")) kinds.delete("package");
  return kinds;
}

type GroupVessel = "carton" | "bottle" | "glass" | "unknown";

function groupVesselFromOwnContainers(foods: readonly ObservedFood[]): GroupVessel {
  const kinds = new Set(foods.flatMap(food => [...rowOwnContainerKinds(food)]));
  if (kinds.has("carton")) return "carton";
  if (kinds.has("bottle")) return "bottle";
  if (kinds.has("glass")) return "glass";
  return "unknown";
}

function splitClauses(raw: string): string[] {
  // Question marks stay on the clause. Polarity has to see them; splitting
  // them off first would turn「不是同一紙盒？」into an affirmative contrast.
  return raw.split(/[，,。；;!！]/).map(item => item.trim()).filter(Boolean);
}

const COUNT_NEGATION =
  /沒有|没有|没|未見|未见|未有|未能|未知|未確|未确|不確|不确|不能|不見|不见|看不到|看不見|看不见|睇唔到|並非|并非|不是|並不|并不|無法|无法|可能|或許|或许|疑似|估計|估计|是否|大概|唔係|唔系|不係|不系|(?:無|无|冇|沒)(?=[一二兩两三四五六七八九1-9])|\b(?:no|not|without|none|neither|never|maybe|might|may|perhaps|whether|unclear|unsure|uncertain|unknown|cannot|could|possibly|apparently)\b/i;

function affirmativeCountEvidence(raw: string): boolean {
  if (/[?？]/.test(raw)) return false;
  return !COUNT_NEGATION.test(normalizeFoodName(raw));
}

type VesselKind = "carton" | "bottle" | "glass";
type SpatialSide = "front" | "back" | "left" | "right";

const UNCERTAIN_DISTINCT =
  /未能|未知|未確認|未确定|不確定|不确定|可能|是否|是不是|\b(?:maybe|might|unclear|whether|unknown|perhaps|unsure)\b/i;

const SAME_NEGATED: Record<VesselKind, RegExp> = {
  carton: /不是同一(?:個|个)?(?:紙盒|纸盒|盒)|並非同一(?:個|个)?(?:紙盒|纸盒|盒)|并非同一(?:個|个)?(?:紙盒|纸盒|盒)|並不是同一(?:個|个)?(?:紙盒|纸盒|盒)|并不是同一(?:個|个)?(?:紙盒|纸盒|盒)|不是同一個(?:紙盒|纸盒)|not the same (?:carton|package)/i,
  glass: /不是同一(?:個|个|隻|只)?(?:玻璃杯|杯)|並非同一(?:個|个|隻|只)?(?:玻璃杯|杯)|并非同一(?:個|个|隻|只)?(?:玻璃杯|杯)|並不是同一(?:個|个|隻|只)?(?:玻璃杯|杯)|并不是同一(?:個|个|隻|只)?(?:玻璃杯|杯)|not the same (?:glass|cup)/i,
  bottle: /不是同一(?:支|個|个)?(?:瓶|樽)|並非同一(?:支|個|个)?(?:瓶|樽)|并非同一(?:支|個|个)?(?:瓶|樽)|not the same bottle/i,
};

const BARE_DIFFERENT: Record<VesselKind, RegExp> = {
  carton: /不同(?:的)?(?:紙盒|纸盒|盒|包)|different (?:carton|package)/i,
  glass: /不同(?:的)?(?:玻璃杯|杯)|different (?:glass|cup)/i,
  bottle: /不同(?:的)?(?:瓶|樽)|different bottle/i,
};

function outerNegatesDifference(clause: string): boolean {
  return /(?:不是|並非|并非|並不|并不|唔係|唔系|不係|不系|沒有|没有|無|无)\s*不同(?:的)?(?:紙盒|纸盒|盒|包|瓶|樽|杯|玻璃杯|容器)/.test(clause)
    || /\b(?:no|not|without)\b\s+(?:a\s+|an\s+)?different\s+(?:carton|package|bottle|glass|cup|container)\b/i.test(clause);
}

/**
 * Affirmative contrast ("not the same carton") names one vessel.
 * A question, a hedge, or an outer negation ("not a different carton")
 * does not. The "not" inside "not the same" is the contrast itself.
 */
function affirmativeDistinctReferent(clause: string): VesselKind | "denied" | null {
  if (/[?？]/.test(clause)) return null;
  const normalized = normalizeFoodName(clause);
  if (UNCERTAIN_DISTINCT.test(normalized)) return null;
  if (outerNegatesDifference(clause) || outerNegatesDifference(normalized)) return "denied";
  for (const vessel of ["carton", "glass", "bottle"] as const) {
    if (SAME_NEGATED[vessel].test(clause) || SAME_NEGATED[vessel].test(normalized)) return vessel;
  }
  for (const vessel of ["carton", "glass", "bottle"] as const) {
    if (BARE_DIFFERENT[vessel].test(clause) || BARE_DIFFERENT[vessel].test(normalized)) return vessel;
  }
  return null;
}

function milkFamilyMarkers(): Record<MilkFamily, RegExp> {
  return {
    oat: /燕麥|燕麦|\boat\b/i,
    soy: /豆漿|豆浆|豆奶|\bsoy(?:a)?\b/i,
    almond: /杏仁|\balmond\b/i,
    coconut: /椰奶|椰子|\bcoconut\b/i,
    dairy: /全脂|低脂|脫脂|脱脂|鮮奶|鲜奶|牛奶|\b(?:dairy|whole milk|fresh milk|skim milk)\b/i,
    generic: /牛奶|乳|\bmilk\b/i,
  };
}

function specificMilkFamilies(text: string): MilkFamily[] {
  const markers = milkFamilyMarkers();
  return (["oat", "soy", "almond", "coconut", "dairy"] as const).filter(candidate =>
    markers[candidate].test(text));
}

function sameMilkFamilyClause(text: string, family: MilkFamily): boolean {
  const found = specificMilkFamilies(text);
  return found.length === 1 && found[0] === family;
}

const VESSEL_TOKEN =
  /紙盒|纸盒|紙包|纸包|利樂包|利乐包|利樂|利乐|盒裝|盒装|\bcarton\b|\bpackage\b|玻璃杯|杯子|杯裝|杯装|\bglass\b|\bcup\b|另一(?:個|个|隻|只)?杯|第二(?:個|个|隻|只)?杯|玻璃樽|瓶子|\bbottle\b|瓶裝|瓶装|一瓶|一樽/gi;

const SIDE_PATTERN: Record<SpatialSide, RegExp> = {
  front: /前方|前面|\bfront\b/i,
  back: /後方|后方|後面|后面|\bback\b/i,
  left: /左邊|左边|左側|左侧|\bleft\b/i,
  right: /右邊|右边|右側|右侧|\bright\b/i,
};

const ANOTHER_VESSEL =
  /另一(?:個|个)?(?:紙盒|纸盒|盒|包)|第二(?:個|个)?(?:紙盒|纸盒|盒|包)|another\s+(?:carton|package)|second\s+(?:carton|package)|另一(?:個|个|隻|只)?(?:玻璃杯|杯)|第二(?:個|个|隻|只)?(?:玻璃杯|杯)|another\s+(?:glass|cup)|second\s+(?:glass|cup)|另一(?:支|個|个)?(?:瓶|樽)|第二(?:支|個|个)?(?:瓶|樽)|another\s+bottle|second\s+bottle/gi;

function vesselKindOf(token: string): VesselKind {
  if (/carton|package|紙盒|纸盒|紙包|纸包|利樂|利乐|盒裝|盒装/i.test(token)) return "carton";
  if (/bottle|瓶|樽/i.test(token)) return "bottle";
  return "glass";
}

function vesselSpans(clause: string): Array<{ kind: VesselKind; start: number; end: number }> {
  return [...clause.matchAll(new RegExp(VESSEL_TOKEN.source, "gi"))].map(match => ({
    kind: vesselKindOf(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function rowNoteClaimsBothSides(note: string): boolean {
  const left = SIDE_PATTERN.left.test(note);
  const right = SIDE_PATTERN.right.test(note);
  if (left && right) return true;
  return SIDE_PATTERN.front.test(note) && SIDE_PATTERN.back.test(note);
}

function clauseHasOnlySide(clause: string, side: SpatialSide): boolean {
  const front = SIDE_PATTERN.front.test(clause);
  const back = SIDE_PATTERN.back.test(clause);
  const left = SIDE_PATTERN.left.test(clause);
  const right = SIDE_PATTERN.right.test(clause);
  if (side === "front") return front && !back;
  if (side === "back") return back && !front;
  if (side === "left") return left && !right;
  return right && !left;
}

/** The vessel a position word modifies: the next vessel before another position, else the previous one. */
function vesselModifiedBySide(clause: string, side: SpatialSide): VesselKind | null {
  const pos = new RegExp(SIDE_PATTERN[side].source, SIDE_PATTERN[side].flags).exec(clause);
  if (!pos || pos.index === undefined) return null;
  const posEnd = pos.index + pos[0].length;
  const vessels = vesselSpans(clause);
  const anySide = /前方|前面|後方|后方|後面|后面|左邊|左边|左側|左侧|右邊|右边|右側|右侧|\b(?:front|back|left|right)\b/gi;
  let nextSide = clause.length;
  for (const match of clause.matchAll(anySide)) {
    const at = match.index ?? 0;
    if (at >= posEnd) {
      nextSide = at;
      break;
    }
  }
  const following = vessels.find(span => span.start >= posEnd && span.start < nextSide);
  if (following) return following.kind;
  const preceding = [...vessels].reverse().find(span => span.end <= (pos.index ?? 0));
  return preceding?.kind ?? null;
}

function nearestFamilyVessel(clause: string, family: MilkFamily): VesselKind | null {
  if (!sameMilkFamilyClause(clause, family)) return null;
  const marker = new RegExp(milkFamilyMarkers()[family].source, "i").exec(clause);
  if (!marker || marker.index === undefined) return null;
  const vessels = vesselSpans(clause);
  if (vessels.length === 0) return null;
  const anchor = marker.index;
  const anchorEnd = anchor + marker[0].length;
  const positioned = new Set(
    (["front", "back", "left", "right"] as const)
      .map(side => vesselModifiedBySide(clause, side))
      .filter((kind): kind is VesselKind => kind !== null),
  );
  let best: { kind: VesselKind; distance: number; positioned: boolean } | null = null;
  for (const span of vessels) {
    const distance = anchorEnd <= span.start
      ? span.start - anchorEnd
      : span.end <= anchor ? anchor - span.end : 0;
    const isPositioned = positioned.has(span.kind);
    // 「前方玻璃杯旁燕麥奶紙盒」: 前方 binds to the glass. The oat phrase owns the carton.
    const better = !best
      || (best.positioned && !isPositioned)
      || (best.positioned === isPositioned && distance < best.distance);
    if (better) best = { kind: span.kind, distance, positioned: isPositioned };
  }
  return best?.kind ?? null;
}

/**
 * Vessel named as this row's own drink. A glass that is only the target of
 * "not the same glass" or of a position word beside a family-bound carton
 * is a nearby object, not a second vessel for this row.
 */
function inferNoteVessels(food: ObservedFood): Set<VesselKind> {
  const family = milkFamily(food);
  const found = new Set<VesselKind>();
  for (const clause of splitClauses(food.notes ?? "")) {
    if (/[?？]/.test(clause)) continue;
    const referent = affirmativeDistinctReferent(clause);
    if (family === "generic") {
      const kinds = new Set(vesselSpans(clause).map(span => span.kind).filter(kind => kind !== referent));
      if (kinds.size === 1) found.add([...kinds][0]);
      continue;
    }
    const owned = nearestFamilyVessel(clause, family);
    if (!owned || owned === referent) continue;
    found.add(owned);
  }
  return found;
}

function resolveGroupVessel(foods: readonly ObservedFood[]): GroupVessel {
  const identity = groupVesselFromOwnContainers(foods);
  if (identity !== "unknown") return identity;
  const family = foods.map(milkFamily).find(value => value !== "generic") ?? "generic";
  if (family === "generic") return "unknown";
  const inferred = new Set<VesselKind>();
  for (const food of foods) {
    for (const kind of inferNoteVessels(food)) inferred.add(kind);
  }
  return inferred.size === 1 ? [...inferred][0] : "unknown";
}

/** 「同一杯」rejects a second serving. 「不是同一杯」is the contrast, so it stays. */
function clauseDeniesSecondServing(clause: string): boolean {
  if (/不是同一|並非同一|并非同一|並不是同一|并不是同一|not the same/i.test(clause)) return false;
  return /同一(?:個|个|隻|只)?(?:杯|玻璃杯|盒|紙盒|纸盒|容器)|仍是同一|the same (?:glass|cup|carton|container)|same (?:glass|cup)/i.test(clause);
}

function secondServingKind(clause: string): VesselKind | "container" | null {
  if (/另一(?:個|个)?(?:白色)?容器|另有一個(?:白色)?容器|another\s+(?:white\s+)?container|second\s+container/i.test(clause)) {
    return "container";
  }
  if (/另一(?:個|个|隻|只)?(?:玻璃杯|杯)|第二(?:個|个|隻|只)?(?:玻璃杯|杯)|another\s+(?:glass|cup)|second\s+(?:glass|cup)/i.test(clause)) {
    return "glass";
  }
  if (/另一(?:個|个)?(?:紙盒|纸盒|盒|包)|第二(?:個|个)?(?:紙盒|纸盒|盒|包)|another\s+(?:carton|package)|second\s+(?:carton|package)/i.test(clause)) {
    return "carton";
  }
  if (/另一(?:支|個|个)?(?:瓶|樽)|another\s+bottle|second\s+bottle/i.test(clause)) return "bottle";
  return null;
}

/**
 * A second physical serving is a named other vessel, not a direction word.
 * 「另一個白色容器」counts. 「前方」and「後方同一杯」do not.
 * An untyped container does not invent a second carton for a known vessel.
 */
function clauseNamesSecondServing(clause: string, family: MilkFamily, vessel: GroupVessel): boolean {
  if (/[?？]/.test(clause) || !affirmativeCountEvidence(clause) || clauseDeniesSecondServing(clause)) return false;
  const kind = secondServingKind(clause);
  if (!kind) return false;
  if (vessel !== "unknown" && (kind === "container" || kind !== vessel)) return false;
  if (family === "generic") {
    return !/燕麥|燕麦|豆漿|豆浆|豆奶|杏仁|椰奶|椰子|\b(?:oat|soy|almond|coconut)\b/i.test(clause);
  }
  // 「另一杯」beside an oat carton is a different object. A second carton has
  // to name this milk family; an unlabelled 「另一盒」does not.
  if (vessel === "unknown" && kind === "glass") return false;
  const found = specificMilkFamilies(clause);
  return found.length === 1 && found[0] === family;
}

function boundCountsForFamily(clause: string, bound: VesselKind, family: MilkFamily): boolean {
  if (family === "generic") {
    return !/燕麥|燕麦|豆漿|豆浆|豆奶|杏仁|椰奶|椰子|\b(?:oat|soy|almond|coconut)\b/i.test(clause);
  }
  return nearestFamilyVessel(clause, family) === bound;
}

/** Front glass versus back carton is two servings. Front glass versus back glass is not. */
function distinctPhysicalVesselPair(foods: readonly ObservedFood[]): boolean {
  const family = foods.map(milkFamily).find(value => value !== "generic") ?? "generic";
  const collect = (side: SpatialSide) => foods.flatMap(food => {
    const note = food.notes ?? "";
    if (rowNoteClaimsBothSides(note)) return [];
    const kinds: VesselKind[] = [];
    for (const clause of splitClauses(note)) {
      if (!clauseHasOnlySide(clause, side)) continue;
      if (/[?？]/.test(clause) || UNCERTAIN_DISTINCT.test(normalizeFoodName(clause))) continue;
      if (clauseDeniesSecondServing(clause)) continue;
      const bound = vesselModifiedBySide(clause, side);
      if (!bound || !boundCountsForFamily(clause, bound, family)) continue;
      kinds.push(bound);
    }
    return kinds;
  });
  const differs = (left: VesselKind[], right: VesselKind[]) => left.some(item => right.some(other => item !== other));
  return differs(collect("front"), collect("back")) || differs(collect("left"), collect("right"));
}

function spatialSideQualifies(
  clause: string,
  side: SpatialSide,
  family: MilkFamily,
  vessel: GroupVessel,
): boolean {
  if (!clauseHasOnlySide(clause, side)) return false;
  if (/[?？]/.test(clause) || UNCERTAIN_DISTINCT.test(normalizeFoodName(clause))) return false;
  if (clauseDeniesSecondServing(clause)) return false;
  const bound = vesselModifiedBySide(clause, side);
  if (vessel === "unknown") {
    // Generic milk has no vessel yet. A bare direction, or a direction aimed
    // at a nearby object, is not a second serving.
    if (family === "generic" || bound === null) return false;
    return nearestFamilyVessel(clause, family) === bound;
  }
  if (bound !== vessel) return false;
  const families = specificMilkFamilies(clause);
  if (families.length > 1 || (families.length === 1 && families[0] !== family)) return false;
  const attributed = nearestFamilyVessel(clause, family);
  return attributed === null || attributed === vessel;
}

function opposedSpatialContainers(foods: readonly ObservedFood[]): boolean {
  const family = foods.map(milkFamily).find(value => value !== "generic") ?? "generic";
  const vessel = resolveGroupVessel(foods);
  const qualifies = (food: ObservedFood, side: SpatialSide) => {
    const note = food.notes ?? "";
    if (rowNoteClaimsBothSides(note)) return false;
    return splitClauses(note).some(clause => spatialSideQualifies(clause, side, family, vessel));
  };
  const opposed = (left: SpatialSide, right: SpatialSide) =>
    foods.some((food, index) => qualifies(food, left)
      && foods.some((other, otherIndex) => index !== otherIndex && qualifies(other, right)));
  return opposed("front", "back") || opposed("left", "right");
}

function anotherVesselKind(phrase: string): VesselKind {
  if (/盒|包|carton|package/i.test(phrase)) return "carton";
  if (/瓶|樽|bottle/i.test(phrase)) return "bottle";
  return "glass";
}

function namedSecondSameVessel(foods: readonly ObservedFood[], vessel: GroupVessel, family: MilkFamily): boolean {
  return foods.some(food => splitClauses(food.notes ?? "").some(clause => {
    if (!affirmativeCountEvidence(clause)) return false;
    return [...clause.matchAll(new RegExp(ANOTHER_VESSEL.source, "gi"))].some(match => {
      const kind = anotherVesselKind(match[0]);
      if (vessel !== "unknown" && kind !== vessel) return false;
      const following = clause.slice((match.index ?? 0) + match[0].length);
      return sameMilkFamilyClause(following, family);
    });
  }));
}

function clauseConfirmsDistinctVessel(clause: string, vessel: GroupVessel, family: MilkFamily): boolean {
  const referent = affirmativeDistinctReferent(clause);
  if (referent === null || referent === "denied") return false;
  if (vessel === "unknown" || referent !== vessel) return false;
  const found = specificMilkFamilies(clause);
  return found.length === 0 || sameMilkFamilyClause(clause, family);
}

function distinctOpposedPositionsAcrossRows(foods: readonly ObservedFood[]): boolean {
  return opposedSpatialContainers(foods);
}

function rowsAffirmSeparateSameVessel(foods: readonly ObservedFood[]): boolean {
  const family = foods.map(milkFamily).find(value => value !== "generic") ?? "generic";
  const vessel = resolveGroupVessel(foods);
  const namedSecond = foods.some(food => splitClauses(food.notes ?? "").some(clause =>
    clauseNamesSecondServing(clause, family, vessel)));
  return namedSecondSameVessel(foods, vessel, family)
    || opposedSpatialContainers(foods)
    || distinctPhysicalVesselPair(foods)
    || namedSecond;
}

type MilkFamily = "oat" | "soy" | "almond" | "coconut" | "dairy" | "generic";

export function isMilkDrink(food: ObservedFood): boolean {
  if (containerMilkNameKey(food)) return true;
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (/粥|麥片|麦片|布甸|布丁|奶茶|(?:^|\s)(?:tea|cereal|porridge|pudding)(?:$|\s)/.test(text)) return false;
  if (/燕麥|燕麦/.test(text) && /奶|飲|milk|drink|beverage/.test(text)) return true;
  if (/(?:^|\s)oat(?:$|\s)/.test(text) && /奶|milk|drink|beverage/.test(text)) return true;
  return false;
}

function milkFamily(food: ObservedFood): MilkFamily {
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (/燕麥奶|燕麦奶|(?:^|\s)oat milk(?:$|\s)/.test(text)) return "oat";
  if (/燕麥|燕麦|(?:^|\s)oat(?:$|\s)/.test(text)) return "oat";
  if (/豆漿|豆奶|(?:^|\s)(?:soy|soya)(?:$|\s)/.test(text)) return "soy";
  if (/杏仁奶|(?:^|\s)almond milk(?:$|\s)/.test(text)) return "almond";
  if (/椰奶|(?:^|\s)coconut milk(?:$|\s)/.test(text)) return "coconut";
  if (/全脂|低脂|脫脂|脱脂|鮮奶|(?:^|\s)(?:whole milk|fresh milk|skim milk|low-fat milk|low fat milk)(?:$|\s)/.test(text)) {
    return "dairy";
  }
  return "generic";
}

function specificity(food: ObservedFood): number {
  const family = milkFamily(food);
  if (family === "generic") return 1;
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (/燕麥奶|燕麦奶|豆漿|杏仁奶|椰奶|(?:^|\s)(?:oat milk|soy milk|almond milk|coconut milk)(?:$|\s)/.test(text)) return 3;
  return 2;
}

function compatibleFamilies(foods: readonly ObservedFood[]): boolean {
  const specific = new Set(foods.map(milkFamily).filter((family) => family !== "generic"));
  return specific.size <= 1;
}

function rowStatements(foods: readonly ObservedFood[]): string[] {
  return foods.flatMap(food => [
    food.displayName, food.normalizedName, food.notes ?? "",
    food.preparationMethod ?? "", ...(food.visibleIngredients ?? []),
    ...food.uncertaintyReasons,
  ]);
}

function evidenceStatements(analysis: FoodAnalysis, foods: readonly ObservedFood[], includeUnknown: boolean): string[] {
  return [
    ...rowStatements(foods),
    ...analysis.visibleEvidence,
    ...analysis.uncertaintyReasons,
    ...analysis.estimatedInformation,
    ...(includeUnknown ? analysis.unknownInformation : []),
  ].map(normalizeFoodName);
}

function servingEvidence(analysis: FoodAnalysis, foods: readonly ObservedFood[]): string {
  return evidenceStatements(analysis, foods, true).join(" ");
}

/**
 * A second container has to be written on the milk rows themselves.
 * Meal-level text that merely mentions a 杯 is not enough to count both rows.
 */
function rowsShowDistinctContainers(foods: readonly ObservedFood[]): boolean {
  if (distinctPhysicalContainers(foods)) return true;
  const ownKinds = foods.map(rowOwnContainerKinds);
  const hasCartonRow = ownKinds.some(kinds => kinds.has("carton"));
  const hasGlassRow = ownKinds.some(kinds => kinds.has("glass"));
  const hasBottleRow = ownKinds.some(kinds => kinds.has("bottle"));
  if (hasCartonRow && hasGlassRow) return true;
  if (hasBottleRow && hasGlassRow) return true;
  if (distinctOpposedPositionsAcrossRows(foods)) return true;
  return rowsAffirmSeparateSameVessel(foods);
}

/** Meal text can suggest another container, but that is a question for the user. */
function mealOnlySuggestsAnotherContainer(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  if (rowsShowDistinctContainers(foods)) return false;
  const evidence = servingEvidence(analysis, foods);
  return SEPARATE_CONTAINER.test(evidence)
    || (CARTON.test(evidence) && GLASS.test(evidence))
    || (BOTTLE.test(evidence) && GLASS.test(evidence));
}

/** A question or negation about the same serving is not an affirmative observation. */
function explicitlySameServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  const statements = evidenceStatements(analysis, foods, false).filter(text => SAME_SERVING.test(text));
  return statements.length > 0 && statements.every(text => !UNCERTAIN_SAME_SERVING.test(text));
}

function uncertainSameServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  return evidenceStatements(analysis, foods, true).some(text =>
    SAME_SERVING.test(text) && UNCERTAIN_SAME_SERVING.test(text));
}

function rawEvidenceText(analysis: FoodAnalysis, foods: readonly ObservedFood[]): string[] {
  return [
    ...foods.flatMap(food => [
      food.displayName, food.normalizedName, food.notes ?? "",
      food.preparationMethod ?? "", ...(food.visibleIngredients ?? []),
      ...food.uncertaintyReasons,
    ]),
    ...analysis.visibleEvidence,
    ...analysis.uncertaintyReasons,
    ...analysis.estimatedInformation,
    ...analysis.unknownInformation,
  ];
}

function negatedDistinctServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  const family = foods.map(milkFamily).find(value => value !== "generic") ?? "generic";
  const vessel = resolveGroupVessel(foods);
  // Keep the source text. Normalizing first deletes ? and would make a question
  // look like an affirmative contrast.
  return rawEvidenceText(analysis, foods).some(text =>
    splitClauses(text).some(clause => clauseConfirmsDistinctVessel(clause, vessel, family)));
}

function questionedContainerEvidence(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  return rawEvidenceText(analysis, foods).some(text =>
    splitClauses(text).some(clause => {
      const asks = /[?？]/.test(clause)
        || UNCERTAIN_DISTINCT.test(clause)
        || UNCERTAIN_DISTINCT.test(normalizeFoodName(clause));
      return asks && /同一|不同|另一|第二|not the same|different|another|second/i.test(clause);
    }));
}

/**
 * Carton beside a glass, or a bottle beside a glass, are two containers
 * even when the model never says 另一杯.
 */
function distinctPhysicalContainers(foods: readonly ObservedFood[]): boolean {
  const present = new Set(foods.flatMap(food => [...rowOwnContainerKinds(food)]));
  const pairs = [
    ["carton", "glass"],
    ["bottle", "glass"],
    ["package", "glass"],
    ["carton", "bottle"],
  ] as const;
  return pairs.some(([left, right]) => present.has(left) && present.has(right));
}

/**
 * Every milk row must carry the same container kind on its own fields.
 * A sandwich that says 包裝, or a meal note that says 紙盒, is not evidence
 * that two milk rows are one item. A carton of 鮮奶 beside a glass of 牛奶
 * does not share a container.
 */
function sameMilkContainer(foods: readonly ObservedFood[]): boolean {
  const kinds = foods.map(containerKinds);
  if (kinds.some((set) => set.size === 0)) return false;
  return [...kinds[0]].some((kind) => kinds.every((set) => set.has(kind)));
}

function sameCanonicalKey(foods: readonly ObservedFood[]): boolean {
  const keys = foods.map(containerMilkNameKey);
  const first = keys[0];
  return Boolean(first) && keys.every((key) => key === first);
}

function pickKept(foods: readonly ObservedFood[]): ObservedFood {
  return foods.reduce((kept, food) => (specificity(food) > specificity(kept) ? food : kept));
}

function mergeMilkRows(analysis: FoodAnalysis, milkIndexes: readonly number[], milkFoods: readonly ObservedFood[]): FoodAnalysis {
  const drop = new Set(milkIndexes);
  const preferred = withMergeNotice(pickKept(milkFoods));
  let inserted = false;
  const foods: ObservedFood[] = [];
  for (let index = 0; index < analysis.foods.length; index += 1) {
    if (!drop.has(index)) {
      foods.push(releaseSuspect(analysis.foods[index]));
      continue;
    }
    if (!inserted) {
      foods.push(preferred);
      inserted = true;
    }
  }
  return { ...analysis, foods };
}

function markSuspectedDuplicates(
  analysis: FoodAnalysis,
  milkIndexes: readonly number[],
): FoodAnalysis {
  const group = new Set(milkIndexes);
  const preferred = milkIndexes.reduce((best, index) => (
    specificity(analysis.foods[index]) > specificity(analysis.foods[best]) ? index : best
  ));
  return {
    ...analysis,
    foods: analysis.foods.map((food, index) => {
      const cleared = releaseSuspect(food);
      if (!group.has(index) || index === preferred) return cleared;
      return { ...cleared, suspectedDuplicateMilk: true };
    }),
  };
}

/**
 * Multi-row scenes are not one milk container. Build candidate groups by
 * milk family and by the physical kind named on each row. A separate glass
 * must never disable deduplication of a carton elsewhere in the same photo.
 *
 * Generic "milk" may join an explicit family only when its container kind
 * points to exactly one such family; otherwise we avoid guessing its identity.
 */
function candidateMilkGroups(foods: readonly ObservedFood[], milkIndexes: readonly number[]): number[][] {
  type ContainerKind = "carton" | "bottle" | "glass" | "package" | "unknown" | "mixed";
  const kind = (food: ObservedFood): ContainerKind => {
    // Identity fields can name two vessels. A note that mentions a carton
    // and a nearby glass must not: that would drop the row from its group.
    const own = rowOwnContainerKinds(food);
    const identity = [...own].filter((item): item is VesselKind =>
      item === "carton" || item === "bottle" || item === "glass");
    if (identity.length > 1) return "mixed";
    if (identity.length === 1) return identity[0];
    const inferred = inferNoteVessels(food);
    if (inferred.size === 1) return [...inferred][0];
    return "unknown";
  };
  const entries = milkIndexes.map(index => ({
    index, family: milkFamily(foods[index]), kind: kind(foods[index]),
  }));
  const resolved = entries.map(entry => {
    if (entry.family !== "generic") return { ...entry };
    const eligible = new Set(entries.filter(other =>
      other.family !== "generic" &&
      entry.kind !== "unknown" &&
      entry.kind !== "mixed" &&
      other.kind === entry.kind
    ).map(other => other.family));
    return { ...entry, family: eligible.size === 1 ? [...eligible][0] : entry.family };
  });

  const groups = new Map<string, number[]>();
  for (const entry of resolved) {
    // An unknown container can share the only concrete container kind in its
    // family; with multiple kinds it remains separate, not silently dropped.
    const possibleKinds = new Set(resolved.filter(other =>
      other.family === entry.family && other.kind !== "unknown" && other.kind !== "mixed"
    ).map(other => other.kind));
    const effectiveKind = entry.kind === "unknown" && possibleKinds.size === 1
      ? [...possibleKinds][0] : entry.kind;
    const key = `${entry.family}:${effectiveKind}`;
    groups.set(key, [...(groups.get(key) ?? []), entry.index]);
  }
  return [...groups.values()].filter(group => group.length >= 2);
}

/**
 * Derive a *bounded* physical serving count, rather than treating a mention of
 * "two cartons" as an all-or-nothing pass for arbitrarily many model rows.
 * An unmatched or contradictory row remains visible for explicit confirmation.
 *
 * Only cite an entire-meal count for this milk group when it actually refers
 * to its family, or this is the ONLY milk group with the same vessel kind.
 * Row-level descriptions of individual cartons are not additive evidence:
 * a duplicated model row can itself say "one carton" twice.
 */
function evidencedMilkCount(
  analysis: FoodAnalysis,
  group: readonly ObservedFood[],
): number {
  const family = group.map(milkFamily).find(value => value !== "generic") ?? "generic";
  const vessel = resolveGroupVessel(group);
  const number = (raw: string): number | null => {
    const value = normalizeFoodName(raw);
    if (/^[1-9]$/.test(value)) return Number(value);
    const names: Record<string, number> = {
      一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    };
    return names[value] ?? null;
  };
  const chineseUnit = vessel === "glass" ? "(?:玻璃杯|杯)" :
    vessel === "bottle" ? "(?:瓶|樽)" : "(?:紙盒|纸盒|盒|包)";
  const englishUnit = vessel === "glass" ? "glasses|cups?" :
    vessel === "bottle" ? "bottles?" : "cartons?|packages?";
  const quantity = new RegExp(
    `([一二兩两三四五六七八九1-9])\\s*(?:個|个|隻|只)?\\s*${chineseUnit}|\\b(one|two|three|four|five|six|seven|eight|nine|[1-9])\\s+(?:[a-z-]+\\s+){0,3}(?:${englishUnit})\\b`,
    "gi",
  );
  const specificFamilies = (text: string): MilkFamily[] => specificMilkFamilies(text);

  const perRowRaw = group.map(milkRowText);
  const statements = [
    ...analysis.visibleEvidence, ...analysis.estimatedInformation,
    ...analysis.uncertaintyReasons, ...analysis.unknownInformation,
  ];

  // "another carton of oat milk" raises this group. "another glass" does not.
  // A position word counts only when it modifies this group's own vessel.
  const evidenceClauses = [
    ...group.flatMap(food => splitClauses(food.notes ?? "")),
    ...statements.flatMap(splitClauses),
  ];
  const scopedDistinct = evidenceClauses.some(clause =>
    clauseConfirmsDistinctVessel(clause, vessel, family));
  const namedSecond = evidenceClauses.some(clause => clauseNamesSecondServing(clause, family, vessel));
  const minimumCount = namedSecondSameVessel(group, vessel, family)
    || opposedSpatialContainers(group)
    || distinctPhysicalVesselPair(group)
    || namedSecond
    || scopedDistinct ? 2 : 1;

  // Rows may repeat "一盒" because the model duplicated a serving. However,
  // an explicit two/three-plus count on an individual row is useful evidence
  // when it identifies this family and vessel.
  const countStatements = [
    ...statements.map(value => ({ value, fromRow: false })),
    ...perRowRaw.map(value => ({ value, fromRow: true })),
  ];
  const validCounts: number[] = [];
  for (const { value: raw, fromRow } of countStatements) {
    // Polarity is decided per clause, after the clause boundary is known.
    // A negated clause must not erase an affirmative count in another clause,
    // and a question mark must still be visible to that decision.
    for (const clause of splitClauses(raw)) {
    const value = clause.toLowerCase().replace(/\s+/g, " ").trim();
    if (!affirmativeCountEvidence(clause) ||
        /不止|超過|超过|more than|at least/i.test(value)) continue;
    const matches = [...value.matchAll(quantity)];
    for (const [offset, match] of matches.entries()) {
      const count = number(match[1] ?? match[2]);
      if (count === null || (fromRow && count === 1)) continue;
      const start = match.index ?? 0;
      const after = matches[offset + 1]?.index ?? value.length;
      const beforePunctuation = value.lastIndexOf("，", start);
      const beforeComma = value.lastIndexOf(",", start);
      const beforePeriod = value.lastIndexOf("。", start);
      const from = Math.max(beforePunctuation, beforeComma, beforePeriod) + 1;
      const punctuationAfter = ["，", ",", "。", ";", "；"].map(p => value.indexOf(p, start))
        .filter(x => x >= 0);
      const to = Math.min(after, ...punctuationAfter, value.length);
      // Bind count to the milk family immediately after the quantity when
      // possible (「兩盒豆漿」 / "two cartons of soy milk"), otherwise to a
      // uniquely named family immediately before it (「燕麥奶兩盒」).
      // Never infer a milk family from another row's name or from a different
      // family mentioned elsewhere in the overall meal.
      const afterCount = value.slice(start + match[0].length, to);
      const beforeCount = value.slice(from, start);
      const afterFamilies = specificFamilies(match[0] + afterCount);
      const beforeFamilies = specificFamilies(beforeCount);
      const boundFamilies = afterFamilies.length > 0 ? afterFamilies : beforeFamilies;
      if (boundFamilies.length !== 1 || boundFamilies[0] !== family) continue;
      // When the count describes several drinks in a single clause, it cannot
      // belong wholly to any one milk subgroup, even if that other milk type
      // was omitted from the model's foods array.
      if (specificFamilies(value.slice(from, to)).some(other => other !== family)
          && matches.length === 1) continue;
      validCounts.push(count);
    }
    }
  }
  if (validCounts.length > 0) {
    // Contradictory observations are not proof for the larger count. Withhold
    // the disputed surplus until the user confirms it.
    return Math.min(...validCounts);
  }
  return minimumCount;
}

/**
 * Which rows in one physical group stay confirmed.
 * A more specific milk identity outranks a generic label. Rows with equal
 * evidence keep the earliest model index. Display order is unchanged, and a
 * serving in another group is never dropped to make room.
 */
function selectConfirmedIndexes(
  indexes: readonly number[],
  foods: readonly ObservedFood[],
  limit: number,
): Set<number> {
  const ranked = indexes.slice().sort((left, right) => {
    const byEvidence = specificity(foods[right]) - specificity(foods[left]);
    if (byEvidence !== 0) return byEvidence;
    return left - right;
  });
  return new Set(ranked.slice(0, Math.max(0, limit)));
}

function dedupeMultipleMilkGroups(analysis: FoodAnalysis, milkIndexes: readonly number[]): FoodAnalysis {
  const groups = candidateMilkGroups(analysis.foods, milkIndexes);
  if (groups.length === 0) return analysis;
  const replacements = new Map<number, ObservedFood>();
  for (const indexes of groups) {
    const group = indexes.map(index => analysis.foods[index]);
    const confirmedLimit = Math.min(indexes.length, Math.max(1,
      evidencedMilkCount(analysis, group)));
    const confirmed = selectConfirmedIndexes(indexes, analysis.foods, confirmedLimit);
    for (const index of indexes) {
      const cleared = releaseSuspect(analysis.foods[index]);
      replacements.set(index, confirmed.has(index)
        ? cleared : { ...cleared, suspectedDuplicateMilk: true });
    }
  }
  return {
    ...analysis,
    foods: analysis.foods.map((food, index) => replacements.get(index) ?? food),
  };
}

/**
 * Merge only with shared-container evidence and no sign of a second container.
 * Identical canonical keys on the same container kind are enough: the model
 * often writes 「只顯示一盒」 instead of 「同一盒」. That merge is conservative
 * and can undercount two real cartons of the same drink. Same-family rows that
 * lack that evidence, including a 杯 that appears only in meal text, stay on
 * screen for confirmation and do not count twice.
 */
export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const milkIndexes = analysis.foods.flatMap((food, index) => (isMilkDrink(food) ? [index] : []));
  const milkFoods = milkIndexes.map((index) => analysis.foods[index]);
  if (milkIndexes.length >= 3) return dedupeMultipleMilkGroups(analysis, milkIndexes);
  // The original two-row deduper must also respect positive count evidence.
  // If the photo explicitly contains two or more distinct cartons, never
  // collapse both model rows into one just because the names and kinds match.
  // We do not invent missing rows when the photo has more than the AI found.
  if (milkIndexes.length === 2 && compatibleFamilies(milkFoods)
      && sameMilkContainer(milkFoods)
      && evidencedMilkCount(analysis, milkFoods) >= 2) {
    return analysis;
  }
  if (milkIndexes.length >= 2 && compatibleFamilies(milkFoods)) {
    const rowsAreDistinct = rowsShowDistinctContainers(milkFoods);
    const mealOnlySeparate = mealOnlySuggestsAnotherContainer(analysis, milkFoods);
    const uncertain = uncertainSameServing(analysis, milkFoods)
      || questionedContainerEvidence(analysis, milkFoods);
    const negated = negatedDistinctServing(analysis, milkFoods);
    if (
      !rowsAreDistinct &&
      !mealOnlySeparate &&
      !uncertain &&
      !negated &&
      sameMilkContainer(milkFoods) &&
      (explicitlySameServing(analysis, milkFoods) || sameCanonicalKey(milkFoods))
    ) {
      if (milkFoods.every(food => rowNoteClaimsBothSides(food.notes ?? ""))
          && evidencedMilkCount(analysis, milkFoods) < 2) {
        return markSuspectedDuplicates(analysis, milkIndexes);
      }
      return mergeMilkRows(analysis, milkIndexes, milkFoods);
    }
    if (!rowsAreDistinct && !negated) {
      return markSuspectedDuplicates(analysis, milkIndexes);
    }
  }
  // One model row may already have swallowed a second container. Do not
  // fabricate a split or portions; surface the existing add/split action.
  if (milkFoods.length === 1) {
    const evidence = normalizeFoodName([
      ...milkFoods.flatMap(food => [
        food.displayName, food.normalizedName, food.notes ?? "",
        food.preparationMethod ?? "", ...(food.visibleIngredients ?? []),
      ]),
      ...analysis.visibleEvidence,
    ].join(" "));
    const cartonAndGlass = CARTON.test(evidence) && GLASS.test(evidence);
    const multipleGlasses = /兩杯|兩隻杯|兩個杯|兩個玻璃杯|two glasses|two cups/.test(evidence) ||
      (/前方|前面|front/.test(evidence) && /後方|後面|back/.test(evidence));
    if ((cartonAndGlass || multipleGlasses) && !explicitlySameServing(analysis, milkFoods)) {
      return {
        ...analysis,
        foods: analysis.foods.map((food, index) =>
          index === milkIndexes[0] ? withMergeNotice(food) : releaseSuspect(food)),
      };
    }
  }
  if (!analysis.foods.some(food => food.suspectedDuplicateMilk === true)) return analysis;
  return { ...analysis, foods: analysis.foods.map(releaseSuspect) };
}
