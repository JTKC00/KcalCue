import type { FoodAnalysis, ObservedFood, PortionUnit } from "@/lib/domain/food-analysis";
import { foodAnalysisSchema } from "@/lib/domain/food-analysis";
import {
  canonicalJson,
  MAX_OBSERVED_ROWS,
  rowEntityId,
  SERVING_GRAMMAR_VERSION,
  ServingContractError,
  stableDigest,
  type ClaimBody,
  type ClaimField,
  type ClaimUse,
  type DairyQualifier,
  type DistinctiveMark,
  type EvidenceClaim,
  type MilkFamily,
  type ObservedFoodRow,
  type Polarity,
  type QuantityPurpose,
  type Referent,
  type SpatialRelation,
  type VesselKind,
} from "@/lib/domain/milk-serving-contract";

/**
 * Bounded, deterministic evidence interpretation (grammar v1).
 *
 * Regexes only lex; they never decide a serving. A count is admitted only
 * when the complete clause parses as an affirmative production. Questions,
 * negation, hedges, quotes, double negation and partial parses produce
 * refused claims that can restrict but never strengthen reconciliation.
 * Non-milk rows contribute no milk evidence at all.
 */

export interface ServingSceneInput {
  sceneId: string;
  analysis: FoodAnalysis;
}

export interface InterpretedServingEvidence {
  sceneId: string;
  rows: ObservedFoodRow[];
  claims: EvidenceClaim[];
}

export interface CountStatementReading {
  polarity: Polarity;
  quoted: boolean;
  count: { count: number; family: string; vessel: string } | null;
  admitted: boolean;
  refusalReasons: string[];
}

// ---------------------------------------------------------------------------
// Normalisation and clause segmentation (spans stay on the raw text)
// ---------------------------------------------------------------------------

/** Safe matching view. Keeps question marks, negators, quotes and brackets. */
export function normalizeEvidenceText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/\bcan't\b|\bcannot\b/g, "can not")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bshan't\b/g, "shall not")
    .replace(/n't\b/g, " not")
    .replace(/\s+/g, " ")
    .trim();
}

interface Clause {
  raw: string;
  text: string;
  start: number;
  end: number;
}

const OPEN_QUOTES = new Set(["「", "『", "“", "《"]);
const CLOSE_QUOTES = new Set(["」", "』", "”", "》"]);
const SEPARATORS = new Set(["，", ",", "。", "；", ";", "！", "!", "\n", "、"]);
const QUESTION_MARKS = new Set(["？", "?"]);

function splitClauses(raw: string): Clause[] {
  const clauses: Clause[] = [];
  let depth = 0;
  let straightQuoteOpen = false;
  let start = 0;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(raw[s])) s += 1;
    while (e > s && /\s/.test(raw[e - 1])) e -= 1;
    if (e > s) clauses.push({ raw: raw.slice(s, e), text: normalizeEvidenceText(raw.slice(s, e)), start: s, end: e });
  };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (OPEN_QUOTES.has(char)) depth += 1;
    else if (CLOSE_QUOTES.has(char)) depth = Math.max(0, depth - 1);
    else if (char === "\"") straightQuoteOpen = !straightQuoteOpen;
    if (depth > 0 || straightQuoteOpen) continue;
    if (QUESTION_MARKS.has(char)) {
      push(index + 1);
      start = index + 1;
    } else if (SEPARATORS.has(char)) {
      push(index);
      start = index + 1;
    }
  }
  push(raw.length);
  return mergeContinuations(raw, clauses);
}

const CONTINUATION = /^(?:內|内|裡|里|裏|中|入面|裝|装|盛|載|载|\b(?:contains?|holds?|with|inside|filled)\b)/;

/**
 * A clause that only continues the previous noun phrase ("…白色容器，內有湯匙")
 * inherits that unique antecedent. Nothing is inherited across fields or rows.
 */
function mergeContinuations(raw: string, clauses: Clause[]): Clause[] {
  const merged: Clause[] = [];
  for (const clause of clauses) {
    const previous = merged[merged.length - 1];
    if (previous && CONTINUATION.test(clause.text) && vesselOf(clause.text) === null && vesselOf(previous.text) !== null &&
      !QUESTIONED.test(previous.text)) {
      const text = raw.slice(previous.start, clause.end);
      merged[merged.length - 1] = { raw: text, text: normalizeEvidenceText(text), start: previous.start, end: clause.end };
    } else {
      merged.push(clause);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

const NON_MILK_SUBJECT =
  /粥|麥片|麦片|布甸|布丁|奶茶|咖啡|拿鐵|拿铁|鴛鴦|鸳鸯|茶|三明治|蛋糕|麵包|面包|奶昔|乳酪|酸奶|優格|优格|芝士|雪糕|朱古力|巧克力|奶油|煉奶|炼奶|奶粉|奶凍|奶冻|\b(?:cereal|porridge|pudding|tea|coffee|latte|cappuccino|sandwich|cake|bread|shake|milkshake|smoothie|yogh?urt|cheese|ice cream|chocolate|cream|condensed|powder)\b/;
const MILK_SUBJECT =
  /牛奶|鮮奶|鲜奶|全脂奶|低脂奶|脫脂奶|脱脂奶|豆漿|豆浆|豆奶|燕麥奶|燕麦奶|燕麥飲|燕麦饮|杏仁奶|杏仁飲|椰奶|椰子奶|^奶$|\bmilk\b|\bsoymilk\b|\boat drink\b/;

interface FamilyHit { family: MilkFamily; qualifier: DairyQualifier | null }

const FAMILY_RULES: Array<[RegExp, FamilyHit]> = [
  [/燕麥|燕麦|\boats?\b/, { family: "oat", qualifier: null }],
  [/豆漿|豆浆|豆奶|\bsoya?\b|soymilk/, { family: "soy", qualifier: null }],
  [/杏仁|\balmond\b/, { family: "almond", qualifier: null }],
  [/椰奶|椰子|\bcoconut\b/, { family: "coconut", qualifier: null }],
  [/脫脂|脱脂|\bskim(?:med)?\b/, { family: "dairy", qualifier: "skim" }],
  [/低脂|\blow[- ]?fat\b|\breduced fat\b|\bsemi[- ]skimmed\b/, { family: "dairy", qualifier: "low_fat" }],
  [/全脂|鮮奶|鲜奶|\bwhole\b|\bfresh milk\b/, { family: "dairy", qualifier: "whole" }],
];
const GENERIC_MILK_WORD = /牛奶|奶|\bmilk\b/;
const DRINK_WORD = /飲品|饮品|液體|液体|\bdrink\b|\bliquid\b|\bbeverage\b/;
const BLEND_MARKER = /混合|混和|\bblend(?:ed)?\b|\bmix(?:ed)?\b/;

function familyHits(text: string): FamilyHit[] {
  const hits: FamilyHit[] = [];
  for (const [pattern, hit] of FAMILY_RULES) {
    if (pattern.test(text) && !hits.some(item => item.family === hit.family && item.qualifier === hit.qualifier)) {
      // Dairy qualifiers are mutually exclusive descriptions of one dairy family.
      hits.push(hit);
    }
  }
  return hits;
}

/** Single family reading of a fragment, or null when it names no milk. */
function familyOf(text: string): FamilyHit | null {
  const hits = familyHits(text);
  if (hits.length > 1 && BLEND_MARKER.test(text)) return { family: "blend", qualifier: null };
  if (hits.length >= 1) return hits[0];
  if (GENERIC_MILK_WORD.test(text)) return { family: "generic_milk", qualifier: null };
  return null;
}

const VESSEL_RULES: Array<[VesselKind, RegExp]> = [
  ["glass", /玻璃杯|\bglass(?:es)?\b/],
  ["carton", /紙盒|纸盒|紙包|纸包|利樂包|利乐包|盒裝|盒装|盒|\bcartons?\b|\bboxe?s?\b|\btetra ?pak\b/],
  ["bottle", /瓶裝|瓶装|瓶|樽|\bbottles?\b/],
  ["cup", /馬克杯|马克杯|紙杯|纸杯|量杯|杯裝|杯装|杯子|杯|\bcups?\b|\bmugs?\b/],
  ["container", /容器|\bcontainers?\b|\bjars?\b/],
];

function vesselOf(text: string): VesselKind | null {
  let best: { kind: VesselKind; index: number } | null = null;
  for (const [kind, pattern] of VESSEL_RULES) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = { kind, index: match.index };
  }
  return best?.kind ?? null;
}

export function vesselClass(kind: VesselKind): "open" | "carton" | "bottle" | "container" | "unknown" {
  if (kind === "glass" || kind === "cup") return "open";
  return kind;
}

const RELATIVE_MARKER = /旁邊|旁边|身旁|隔離|隔篱|隔籬|附近|鄰近|邻近|旁|\bnext to\b|\bbeside\b|\bnearby\b|\bnear\b/;
const NON_DRINK_CONTENT =
  /湯匙|汤匙|匙羹|匙|叉|筷子|餐具|紙巾|纸巾|飲管|吸管|水果|蘋果|苹果|香蕉|曲奇|餅乾|饼干|三明治|麵包|面包|糖果|\b(?:spoons?|forks?|utensils?|fruits?|apples?|bananas?|cookies?|biscuits?|sandwich(?:es)?|bread|napkins?|straws?)\b/;
const EMPTY_CONTENT = /空的|空(?:紙盒|纸盒|盒|杯|瓶|樽|容器)|\bempty\b/;
const PART_MARKER =
  /(?:杯|瓶|樽|盒|容器|飲品|饮品|牛奶|奶)(?:子)?的(?:前方|前面|前邊|後方|后方|後面|后面|左邊|左边|右邊|右边|側面|侧面|底部|頂部|顶部)|\b(?:front|back|side|bottom|top|left|right) (?:side )?of (?:the|this|that|a)\b/;
const VIEW_MARKER = /鏡|镜|倒影|反射|另一面|另一個角度|另一个角度|另一角度|轉到|转到|視角|视角|\bmirror\b|\breflection\b|\bother side\b|\bangle\b/;
const SIDE_RULES: Array<[SpatialRelation, RegExp]> = [
  ["front", /前方|前面|前邊|前边|\bin front\b|\bfront\b/],
  ["back", /後方|后方|後面|后面|後邊|后边|\bbehind\b|\bback\b|\brear\b/],
  ["left", /左邊|左边|左方|左側|左侧|左手邊|\bleft\b/],
  ["right", /右邊|右边|右方|右側|右侧|右手邊|\bright\b/],
];
const STOCK_MARKER = /倒(?!影)(?:咗|了|左|入|進|进|到|出|落)?|\bpour(?:ed|ing)?\b/;
const AGGREGATE_MARKER = /合共|合計|合计|總共|总共|一共|共飲|共饮|\bin total\b|\baltogether\b|\bcombined\b/;
const CAPACITY_MARKER = /容量|容積|容积|\bcapacity\b|標示|标示|包裝|包装|標籤|标签|\blabel(?:led|ed)?\b/;
const CONSUMED_MARKER = /飲咗|飲了|飲用了|飲用|喝咗|喝了|喝|饮咗|饮了|饮用了|饮用|\b(?:consumed|drank|drunk)\b/;
const STORAGE_MARKER = /儲存|储存|存放|備用|备用|雪櫃|雪柜|冰箱|\b(?:storage|store|stash)\b/;
const DRINK_DESTINATION = /玻璃杯|飲杯|杯子|\b(?:glass|cup)\b/;
const PACKAGE_NOUN = /^(?:的)?(?:紙盒|纸盒|利樂盒|利乐盒|carton|pack|package)/;
const MARK_RULES: Array<[DistinctiveMark, RegExp]> = [
  ["blue-dot", /藍色圓點|蓝色圆点|藍點杯|蓝点杯|blue[- ]dot/],
  ["star-sticker", /星形貼紙|星形贴纸|星星貼紙|star sticker/],
  ["round-handle", /圓柄|圆柄|round[- ]handl/],
];
const AMOUNT = /(?<![\d.])(\d{1,4}(?:\.\d+)?)\s*(ml|毫升|l|公升|升|litres?|liters?)(?![a-z])/;

const NOT_SAME = /(?:不是|並非|并非|唔係|唔系|不係|不系|並不是|并不是)同一|\b(?:is |are )?not the same\b/;
const NOT_ANOTHER = /(?:不是|並非|并非|唔係|唔系|不係|沒有|没有)(?:另一|另外|第二|不同)|\bnot (?:a |an )?(?:different|another|second|separate)\b/;
const SAME = /同一|\bsame\b/;
const DIFFERENT = /不同|另一|另外一|第二(?:個|个|隻|只|杯|盒|瓶)|獨立|独立|\bdifferent\b|\banother\b|\bseparate\b|\bindependent\b|\bsecond\b/;

const QUALIFIER_MASK = /無糖|无糖|無添加糖|无添加糖|\bunsweetened\b|\bno added sugar\b|\bsugar[- ]free\b/g;
const QUOTED = /[「」『』"《》]|優惠|优惠|特價|特价|買一送一|买一送一|\bpromotion\b|\boffer\b|\bdeal\b|寫住|写着|印有/;
const QUESTIONED =
  /[?？]|嗎|吗|係咪|系咪|係唔係|系唔系|是不是|是否|會唔會|会不会|會不會|有冇|有沒有|有没有|可唔可能|可不可能|可否|定係|還是|还是|請核對|请核对|請確認|请确认|\bwhether\b|\bif there\b|\bplease (?:check|verify|confirm)\b|^(?:are|is|do|does|did|could|can|would|will|should|has|have|was|were|might|may|shall) (?:there|it|this|that|these|those|the|a|an|you|we|i|they|he|she)\b/;
const UNCERTAIN =
  /未證實|未证实|未確認|未确认|未能確定|未能确定|未確定|未确定|不確定|不确定|未證明|未证明|未能證實|可能|或許|或许|也許|也许|疑似|估計|估计|大概|似乎|好似|好像|應該|应该|唔肯定|唔確定|未必|看似|\b(?:unconfirmed|unverified|uncertain|unclear|maybe|might|may|possibly|perhaps|probably|appears?|seems?|likely|unsure|unknown)\b|\bnot sure\b|\bcould be\b|\bnot confirmed\b|\bcan not confirm\b/;
const NEGATOR = /沒有|没有|沒|没|冇|無|无|不是|不係|唔係|唔系|並非|并非|非|未見|未见|未有|看不到|看不見|看不见|睇唔到|睇唔見|見不到|见不到|不見|不见|唔見|不(?!同|透明|鏽鋼|锈钢)|唔|未|\b(?:no|not|never|none|without|neither|nor)\b/g;

/** Replace every occurrence of a lexical production with a space. */
function strip(text: string, pattern: RegExp): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return text.replace(new RegExp(pattern.source, flags), " ");
}

function polarityOf(text: string): { polarity: Polarity; doubleNegation: boolean } {
  const masked = text.replace(QUALIFIER_MASK, " ");
  if (QUESTIONED.test(masked)) return { polarity: "questioned", doubleNegation: false };
  if (UNCERTAIN.test(masked)) return { polarity: "uncertain", doubleNegation: false };
  const negators = masked.match(NEGATOR) ?? [];
  if (negators.length >= 2) return { polarity: "uncertain", doubleNegation: true };
  if (negators.length === 1) return { polarity: "negative", doubleNegation: false };
  return { polarity: "affirmative", doubleNegation: false };
}

// ---------------------------------------------------------------------------
// Count productions
// ---------------------------------------------------------------------------

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const EN_DIGITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const CN_NUM = "([一二兩两三四五六七八九]|(?<![\\d.])[1-9](?![\\d.]))";
const CN_CLS = "(盒|杯|瓶|樽|包|支|罐)";
const CN_QUAL = "(?:無糖|无糖|原味|有機|有机|低糖)?";
const CN_FAM = "(燕麥奶|燕麦奶|燕麥飲品?|燕麦饮品?|豆漿|豆浆|豆奶|杏仁奶|椰奶|全脂牛奶|全脂奶|低脂牛奶|低脂奶|脫脂牛奶|脱脂牛奶|脫脂奶|脱脂奶|鮮奶|鲜奶|牛奶|奶|飲品|饮品)";
const CN_COUNT_A = new RegExp(`${CN_NUM}${CN_CLS}(?:的)?${CN_QUAL}${CN_FAM}`);
const CN_COUNT_B = new RegExp(`${CN_QUAL}${CN_FAM}${CN_NUM}${CN_CLS}`);
const CN_HEADLESS = new RegExp(`${CN_NUM}${CN_CLS}`);
const EN_NUM = "(one|two|three|four|five|six|seven|eight|nine|(?<![\\d.])[1-9](?![\\d.]))";
const EN_QUAL = "(?:(?:unsweetened|organic|plain|sugar-free) )?";
const EN_FAM = "(?:(oat|soy|soya|almond|coconut|whole|low-fat|low fat|skim|skimmed|fresh) )?";
const EN_VESSEL = "(cartons?|glass(?:es)?|cups?|bottles?|box(?:es)?|cans?)";
const EN_COUNT_C = new RegExp(`\\b${EN_NUM} ${EN_QUAL}${EN_FAM}(?:(milk|drink) )?${EN_VESSEL}\\b`);
const EN_COUNT_D = new RegExp(`\\b${EN_NUM} ${EN_VESSEL} of ${EN_QUAL}${EN_FAM}(milk|drink)\\b`);
const COUNT_FRAME =
  /^(?:(?:畫面|画面|相片|照片|圖中|图中|桌上|枱上|台上)?(?:中)?(?:一共有|總共有|总共有|共有|有|可見|可见|見到|见到|看到|睇到)|there are|there're|i see|we see|visible:?|showing|shows|the photo shows|photo shows)\s*/;

interface CountReading {
  count: number;
  family: MilkFamily;
  qualifier: DairyQualifier | null;
  vessel: VesselKind;
  headless: boolean;
  start: number;
  end: number;
}

function numberOf(token: string): number {
  return CN_DIGITS[token] ?? EN_DIGITS[token] ?? Number(token);
}

function classifierVessel(token: string): VesselKind {
  if (/盒|包|carton|box/.test(token)) return "carton";
  if (/杯|glass/.test(token)) return "glass";
  if (/cup/.test(token)) return "cup";
  if (/瓶|樽|支|bottle/.test(token)) return "bottle";
  return "container";
}

function headFamily(head: string | undefined): FamilyHit {
  if (!head) return { family: "generic_milk", qualifier: null };
  return familyOf(head) ?? { family: "generic_milk", qualifier: null };
}

function findCount(text: string, allowHeadless: boolean): CountReading | null {
  const readings: CountReading[] = [];
  const a = CN_COUNT_A.exec(text);
  if (a) readings.push({ count: numberOf(a[1]), ...headFamily(a[3]), vessel: classifierVessel(a[2]), headless: false, start: a.index, end: a.index + a[0].length });
  const b = CN_COUNT_B.exec(text);
  if (b) readings.push({ count: numberOf(b[2]), ...headFamily(b[1]), vessel: classifierVessel(b[3]), headless: false, start: b.index, end: b.index + b[0].length });
  const c = EN_COUNT_C.exec(text);
  if (c && (c[2] || c[3])) {
    readings.push({ count: numberOf(c[1]), ...headFamily(c[2] ? `${c[2]} milk` : c[3]), vessel: classifierVessel(c[4]), headless: false, start: c.index, end: c.index + c[0].length });
  }
  const d = EN_COUNT_D.exec(text);
  if (d) readings.push({ count: numberOf(d[1]), ...headFamily(d[3] ? `${d[3]} milk` : d[4]), vessel: classifierVessel(d[2]), headless: false, start: d.index, end: d.index + d[0].length });
  if (readings.length === 0 && allowHeadless) {
    const h = CN_HEADLESS.exec(text);
    if (h) readings.push({ count: numberOf(h[1]), family: "unknown", qualifier: null, vessel: classifierVessel(h[2]), headless: true, start: h.index, end: h.index + h[0].length });
  }
  if (readings.length === 0) return null;
  // Longest match wins; a tie keeps the earliest. Never sums two phrases.
  readings.sort((x, y) => (y.end - y.start) - (x.end - x.start) || x.start - y.start);
  return readings[0];
}

function remainderAfter(text: string, reading: CountReading): string {
  return `${text.slice(0, reading.start)} ${text.slice(reading.end)}`
    .replace(QUALIFIER_MASK, " ")
    .trim()
    .replace(COUNT_FRAME, "")
    .replace(/[\s。.!！]+/g, "");
}

export function interpretCountStatement(text: string): CountStatementReading {
  const normalized = normalizeEvidenceText(text);
  const quoted = QUOTED.test(normalized);
  const { polarity, doubleNegation } = polarityOf(normalized);
  const reading = findCount(normalized, false);
  const refusalReasons: string[] = [];
  if (!reading || reading.count < 2) refusalReasons.push("no_count_production");
  if (quoted) refusalReasons.push("quoted_text");
  if (doubleNegation) refusalReasons.push("double_negation_unsupported");
  if (polarity !== "affirmative") refusalReasons.push(`${polarity}_scope`);
  if (reading && reading.count >= 2 && remainderAfter(normalized, reading) !== "") refusalReasons.push("unsupported_production");
  return {
    polarity,
    quoted,
    count: reading && reading.count >= 2 ? { count: reading.count, family: reading.family, vessel: reading.vessel } : null,
    admitted: refusalReasons.length === 0,
    refusalReasons: [...new Set(refusalReasons)],
  };
}

// ---------------------------------------------------------------------------
// Claim construction
// ---------------------------------------------------------------------------

interface SourceSpec {
  rowId?: string;
  field: ClaimField;
  entryText?: string;
  span: readonly [number, number];
  rule: string;
}

class ClaimSink {
  private readonly claims = new Map<string, EvidenceClaim>();
  constructor(private readonly sceneId: string) {}

  add(source: SourceSpec, body: ClaimBody, polarity: Polarity, uses: ClaimUse[], refusals: string[] = []): EvidenceClaim {
    const usableFor = polarity === "affirmative" ? uses : uses.filter(use => use !== "count" && use !== "existence");
    const refusalReasons = [...new Set([
      ...refusals,
      ...(polarity !== "affirmative" ? [`${polarity}_scope`] : []),
      ...(usableFor.length === 0 && refusals.length === 0 && polarity === "affirmative" ? ["context_only"] : []),
    ])].sort();
    const claimSource = {
      sceneId: this.sceneId,
      ...(source.rowId ? { rowId: source.rowId } : {}),
      field: source.field,
      ...(source.entryText !== undefined ? { entryKey: stableDigest(source.entryText) } : {}),
      span: [source.span[0], source.span[1]] as const,
      origin: "model_reported" as const,
      grammarRule: source.rule,
      grammarVersion: SERVING_GRAMMAR_VERSION,
    };
    let finalBody = body;
    if (body.predicate === "quantity") {
      const proposalId = `qty:${stableDigest(canonicalJson({ source: claimSource, proposal: { ...body.proposal, proposalId: "", claimIds: [] } }))}`;
      finalBody = { predicate: "quantity", proposal: { ...body.proposal, proposalId } };
    }
    const claimId = `clm:${stableDigest(canonicalJson({ source: claimSource, body: finalBody, polarity }))}`;
    if (finalBody.predicate === "quantity") {
      finalBody = { predicate: "quantity", proposal: { ...finalBody.proposal, claimIds: [claimId] } };
    }
    const claim: EvidenceClaim = {
      claimId,
      source: claimSource,
      body: finalBody,
      polarity,
      scopeId: source.rowId ? `row:${source.rowId}` : "scene",
      usableFor: [...new Set(usableFor)].sort(),
      refusalReasons,
      contradictsClaimIds: [],
    };
    this.claims.set(claimId, claim);
    return claim;
  }

  list(): EvidenceClaim[] {
    return [...this.claims.values()].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
  }
}

const own = (rowId: string): Referent => ({ kind: "entity", entityId: rowEntityId(rowId) });
const UNBOUND: Referent = { kind: "unbound", possibleEntityIds: [] };
function population(family: MilkFamily, vessel: VesselKind): Referent {
  return { kind: "population", scopeId: `pop:${family}:${vessel}`, family, vessel };
}

function toMillilitres(value: number, unit: string): number {
  return /^(?:l|公升|升|litres?|liters?)$/.test(unit) ? value * 1000 : value;
}

// ---------------------------------------------------------------------------
// Row identity
// ---------------------------------------------------------------------------

const APP_ANNOTATIONS = ["duplicateMilkNotice", "otherMilkNotice", "suspectedDuplicateMilk"] as const;

function modelObservation(food: ObservedFood): ObservedFood {
  const copy: Record<string, unknown> = { ...food };
  for (const key of APP_ANNOTATIONS) delete copy[key];
  for (const key of Object.keys(copy)) if (copy[key] === undefined) delete copy[key];
  return copy as ObservedFood;
}

function semanticView(food: ObservedFood): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...modelObservation(food) };
  delete copy.recognitionConfidence;
  delete copy.portionConfidence;
  return copy;
}

function classifySubject(food: ObservedFood): ObservedFoodRow["subject"] {
  const label = normalizeEvidenceText(`${food.displayName} ${food.normalizedName}`);
  if (NON_MILK_SUBJECT.test(label)) {
    return { milkCandidate: false, exclusionReason: MILK_SUBJECT.test(label) ? "composite_or_flavoured_milk" : "non_milk_subject" };
  }
  if (MILK_SUBJECT.test(label)) return { milkCandidate: true, exclusionReason: null };
  return { milkCandidate: false, exclusionReason: "non_milk_subject" };
}

function buildRows(sceneId: string, foods: readonly ObservedFood[]): ObservedFoodRow[] {
  const keyed = foods.map((food, originalIndex) => {
    const raw = modelObservation(food);
    return {
      originalIndex,
      raw,
      semanticKey: stableDigest(canonicalJson(semanticView(food))),
      fullKey: canonicalJson(raw),
    };
  });
  const ordered = keyed.slice().sort((a, b) =>
    a.semanticKey < b.semanticKey ? -1 : a.semanticKey > b.semanticKey ? 1
      : a.fullKey < b.fullKey ? -1 : a.fullKey > b.fullKey ? 1 : 0);
  const ordinals = new Map<string, number>();
  const rows: ObservedFoodRow[] = [];
  for (const item of ordered) {
    const ordinal = ordinals.get(item.semanticKey) ?? 0;
    ordinals.set(item.semanticKey, ordinal + 1);
    rows.push({
      rowId: `row:${item.semanticKey}:${ordinal}`,
      sceneId,
      originalIndex: item.originalIndex,
      semanticKey: item.semanticKey,
      raw: item.raw,
      subject: classifySubject(item.raw),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Row-level interpretation (milk candidate rows only)
// ---------------------------------------------------------------------------

interface RowState {
  ownVessels: Set<VesselKind>;
  countSeen: boolean;
  aggregateSeen: boolean;
  hasDrinkWitnessText: boolean;
  /** Millilitres the notes semantically classified as package capacity. */
  capacityAmounts: number[];
}

function interpretLabel(sink: ClaimSink, row: ObservedFoodRow, state: RowState) {
  const display = normalizeEvidenceText(row.raw.displayName);
  const normalized = normalizeEvidenceText(row.raw.normalizedName);
  const rowId = row.rowId;
  const displaySpan = [0, row.raw.displayName.length] as const;
  sink.add({ rowId, field: "displayName", span: displaySpan, rule: "row_label_presence" },
    { predicate: "presence", subject: own(rowId), content: "milk" }, "affirmative", ["existence"]);

  const displayFamily = familyOf(display);
  const normalizedFamily = familyOf(normalized);
  if (displayFamily) {
    sink.add({ rowId, field: "displayName", span: displaySpan, rule: "row_label_family" },
      { predicate: "family", subject: own(rowId), ...displayFamily }, "affirmative", ["family"]);
  }
  if (normalizedFamily) {
    const displaySpecific = displayFamily && displayFamily.family !== "generic_milk";
    const normalizedSpecific = normalizedFamily.family !== "generic_milk";
    const usable = !displayFamily || (displaySpecific && normalizedSpecific);
    sink.add({ rowId, field: "normalizedName", span: [0, row.raw.normalizedName.length], rule: "row_label_family" },
      { predicate: "family", subject: own(rowId), ...normalizedFamily }, "affirmative",
      usable ? ["family"] : [], usable ? [] : ["normalized_name_not_type_evidence"]);
  }
  const labelVessel = vesselOf(display);
  if (labelVessel) {
    state.ownVessels.add(labelVessel);
    sink.add({ rowId, field: "displayName", span: displaySpan, rule: "row_label_vessel" },
      { predicate: "vessel", subject: own(rowId), vessel: labelVessel }, "affirmative", ["existence"]);
  }
}

function interpretPreparation(sink: ClaimSink, row: ObservedFoodRow, state: RowState) {
  const prep = row.raw.preparationMethod;
  if (!prep) return;
  const vessel = vesselOf(normalizeEvidenceText(prep));
  if (!vessel) return;
  state.ownVessels.add(vessel);
  sink.add({ rowId: row.rowId, field: "preparationMethod", span: [0, prep.length], rule: "preparation_vessel" },
    { predicate: "vessel", subject: own(row.rowId), vessel }, "affirmative", ["existence"]);
}

function interpretOwnClause(sink: ClaimSink, row: ObservedFoodRow, state: RowState, clause: Clause, field: ClaimField, entryText?: string) {
  const rowId = row.rowId;
  const source = (rule: string): SourceSpec => ({ rowId, field, entryText, span: [clause.start, clause.end], rule });
  let text = clause.text;

  // View/part phrases are consumed first so 另一面 is never read as 另一.
  const view = VIEW_MARKER.test(text);
  const part = PART_MARKER.test(text);
  text = strip(strip(text, VIEW_MARKER), PART_MARKER);

  const notSame = NOT_SAME.test(text);
  const notAnother = !notSame && NOT_ANOTHER.test(text);
  let relationText = text;
  if (notSame) relationText = strip(relationText, NOT_SAME);
  if (notAnother) relationText = strip(relationText, NOT_ANOTHER);
  const same = !notSame && SAME.test(relationText);
  const different = !notAnother && DIFFERENT.test(relationText);
  const polarityText = strip(strip(relationText, SAME), DIFFERENT);
  const { polarity, doubleNegation } = polarityOf(polarityText);
  const quoted = QUOTED.test(clause.text);

  const relative = RELATIVE_MARKER.test(text);
  const vessel = vesselOf(text);
  const nonDrink = NON_DRINK_CONTENT.test(text);
  const empty = EMPTY_CONTENT.test(text);
  const contentFamily = familyOf(text);
  const drink = contentFamily !== null || DRINK_WORD.test(text);
  const stock = STOCK_MARKER.test(text);

  // Nearby clauses never rewrite this row's count or portion basis.
  if (relative) {
    if (drink && vessel && polarity === "affirmative") {
      sink.add(source("nearby_drink_object"), { predicate: "presence", subject: UNBOUND, content: contentFamily ? "milk" : "white_drink" },
        polarity, [], ["unbound_referent"]);
      if (contentFamily) {
        sink.add(source("nearby_drink_family"), { predicate: "family", subject: UNBOUND, ...contentFamily }, polarity, [], ["unbound_referent"]);
      }
    }
    return;
  }

  // Counts first: a count clause never also describes the row's own vessel.
  const count = findCount(text, !nonDrink);
  if (count && count.count >= 2 && !quoted) {
    const remainder = remainderAfter(text, count);
    const aggregate = AGGREGATE_MARKER.test(text);
    const amount = AMOUNT.exec(text);
    const aggregateProduction = aggregate && amount !== null &&
      remainder.replace(AGGREGATE_MARKER, "").replace(AMOUNT, "").replace(/飲用了|飲了|喝了|饮用了|饮了|飲用|喝|\b(?:drank|consumed)\b/g, "").replace(/[\s。.]+/g, "") === "";
    const full = remainder === "" || aggregateProduction;
    const admitted = polarity === "affirmative" && !doubleNegation && full && !nonDrink;
    if (admitted) state.countSeen = true;
    if (aggregateProduction && admitted) {
      state.aggregateSeen = true;
      sink.add(source("row_aggregate_count"), { predicate: "cardinality", population: own(rowId), relation: "exact", count: count.count },
        polarity, ["count"]);
      const ml = toMillilitres(Number(amount![1]), amount![2]);
      sink.add(source("row_aggregate_amount"), {
        predicate: "quantity",
        proposal: { proposalId: "", target: own(rowId), min: ml, max: ml, unit: "ml", purpose: "aggregate_consumed", claimIds: [] },
      }, polarity, ["portion"]);
      return;
    }
    const family = count.headless ? labelFamily(row) : { family: count.family, qualifier: count.qualifier };
    const refusals = [
      ...(doubleNegation ? ["double_negation_unsupported"] : []),
      ...(!full ? ["unsupported_production"] : []),
    ];
    sink.add(source(count.headless ? "row_headless_count" : "row_count"), {
      predicate: "cardinality", population: population(family.family, count.vessel), relation: "exact", count: count.count,
    }, polarity, admitted ? ["count"] : [], refusals);
    return;
  }
  if (count && count.count >= 2 && quoted) {
    sink.add(source("quoted_count"), {
      predicate: "cardinality", population: population(count.family, count.vessel), relation: "exact", count: count.count,
    }, polarity, [], ["quoted_text"]);
    return;
  }

  const prepClasses = new Set([...state.ownVessels].map(vesselClass));
  const conflictingVessel = vessel !== null && prepClasses.size > 0 && !prepClasses.has(vesselClass(vessel));

  // A pour names the stock container and, when present, the amount that left it.
  // Destination decides whether that amount is intake, storage, or still pending.
  if (stock) {
    if (polarity === "affirmative") {
      sink.add(source("stock_transfer"), { predicate: "stock_transfer", from: own(rowId), into: UNBOUND }, polarity, ["separate_identity"]);
      emitAttributedAmounts(sink, source, rowId, text, polarity, state, true);
    }
    return;
  }

  if (empty || (nonDrink && !drink)) {
    if (!vessel || conflictingVessel || polarity !== "affirmative") return;
    sink.add(source(empty ? "own_vessel_empty" : "own_vessel_non_drink"),
      { predicate: "presence", subject: own(rowId), content: empty ? "empty" : "non_drink" }, polarity, ["existence"]);
    sink.add(source("own_vessel_non_drink"), { predicate: "vessel", subject: own(rowId), vessel }, polarity, [], ["vessel_holds_non_drink"]);
    return;
  }

  // A vessel of another class with no drink contents is a different object.
  if (conflictingVessel && !drink) return;

  if (notAnother) {
    sink.add(source("denies_another"), { predicate: "different_vessel", left: own(rowId), right: UNBOUND }, "negative", [], ["denial_of_distinction"]);
  }
  if (notSame) {
    const mismatch = vessel !== null && prepClasses.size > 0 && !prepClasses.has(vesselClass(vessel));
    sink.add(source("not_same_contrast"), { predicate: "same_vessel", left: own(rowId), right: UNBOUND }, "negative", [],
      [mismatch ? "referent_vessel_mismatch" : "unbound_referent"]);
  }
  if (same && polarity === "affirmative") {
    sink.add(source("same_marker"), { predicate: "same_vessel", left: own(rowId), right: UNBOUND }, polarity, [], ["unbound_referent"]);
  }
  if (different && polarity === "affirmative") {
    sink.add(source("distinct_marker"), { predicate: "different_vessel", left: own(rowId), right: UNBOUND }, polarity, [], ["unbound_referent"]);
  }
  if (view) {
    sink.add(source("view_marker"), { predicate: "spatial", subject: own(rowId), relativeTo: "scene", relation: "view" }, polarity, [], ["view_not_separate"]);
  }
  if (part) {
    sink.add(source("part_marker"), { predicate: "spatial", subject: own(rowId), relativeTo: "scene", relation: "part" }, polarity, [], ["part_not_separate"]);
  }

  if (polarity !== "affirmative") return;

  if (vessel) {
    state.ownVessels.add(vessel);
    sink.add(source("own_vessel"), { predicate: "vessel", subject: own(rowId), vessel }, polarity, ["existence"]);
  }
  if (drink && (vessel || contentFamily)) {
    state.hasDrinkWitnessText = true;
    sink.add(source("own_contents"), { predicate: "presence", subject: own(rowId), content: contentFamily ? "milk" : "white_drink" }, polarity, ["existence"]);
  }
  if (contentFamily) {
    sink.add(source("own_contents_family"), { predicate: "family", subject: own(rowId), ...contentFamily }, polarity, ["family"]);
  }
  if (!view && !part) {
    for (const [relation, pattern] of SIDE_RULES) {
      if (pattern.test(text)) {
        sink.add(source("own_position"), { predicate: "spatial", subject: own(rowId), relativeTo: "scene", relation }, polarity, ["separate_identity"]);
      }
    }
  }
  emitAttributedAmounts(sink, source, rowId, text, polarity, state, false);
}

function amountRule(purpose: QuantityPurpose): string {
  if (purpose === "package_capacity") return "package_capacity";
  if (purpose === "transferred_amount") return "transferred_amount";
  if (purpose === "stock_amount") return "stock_amount";
  if (purpose === "unknown") return "uncertain_transfer";
  if (purpose === "aggregate_consumed") return "aggregate_amount";
  return "note_amount";
}

function amountRefusal(purpose: QuantityPurpose): string | null {
  if (purpose === "package_capacity") return "package_capacity_not_intake";
  if (purpose === "stock_amount") return "stock_not_intake";
  if (purpose === "unknown") return "transfer_destination_uncertain";
  return null;
}

function emitAttributedAmounts(
  sink: ClaimSink,
  source: (rule: string) => SourceSpec,
  rowId: string,
  text: string,
  polarity: Polarity,
  state: RowState,
  pouring: boolean,
) {
  for (const amount of attributeAmounts(text, pouring)) {
    const usable = amount.purpose === "row_personal_estimate" || amount.purpose === "aggregate_consumed" || amount.purpose === "transferred_amount";
    const refusal = amountRefusal(amount.purpose);
    if (amount.purpose === "package_capacity") state.capacityAmounts.push(amount.ml);
    if (amount.purpose === "aggregate_consumed") state.aggregateSeen = true;
    sink.add(source(amountRule(amount.purpose)), {
      predicate: "quantity",
      proposal: {
        proposalId: "", target: own(rowId), min: amount.ml, max: amount.ml, unit: "ml", purpose: amount.purpose, claimIds: [],
      },
    }, polarity, usable ? ["portion"] : [], refusal ? [refusal] : []);
  }
}

function interpretAnchors(sink: ClaimSink, row: ObservedFoodRow) {
  const fields = ["displayName", "normalizedName", "notes", "preparationMethod"] as const;
  for (const field of fields) {
    const raw = row.raw[field];
    if (typeof raw !== "string" || raw.length === 0) continue;
    const text = normalizeEvidenceText(raw);
    for (const [mark, pattern] of MARK_RULES) {
      if (!pattern.test(text)) continue;
      sink.add({ rowId: row.rowId, field, span: [0, raw.length], rule: "distinctive_mark" }, {
        predicate: "anchor", subject: own(row.rowId), mark,
      }, "affirmative", ["same_identity"]);
    }
  }
}

function labelFamily(row: ObservedFoodRow): FamilyHit {
  return familyOf(normalizeEvidenceText(row.raw.displayName))
    ?? familyOf(normalizeEvidenceText(row.raw.normalizedName))
    ?? { family: "generic_milk", qualifier: null };
}

/** Uncertainty-bearing fields may restrict counts but never authorise anything. */
function interpretUncertainField(sink: ClaimSink, text: string, field: ClaimField, rowId: string | undefined) {
  for (const clause of splitClauses(text)) {
    const count = findCount(clause.text, false);
    if (!count || count.count < 2) continue;
    sink.add({ rowId, field, entryText: text, span: [clause.start, clause.end], rule: "uncertain_field_count" }, {
      predicate: "cardinality", population: population(count.family, count.vessel), relation: "exact", count: count.count,
    }, "uncertain", [], ["uncertain_field"]);
  }
}

interface AttributedAmount {
  ml: number;
  purpose: QuantityPurpose;
}

function textScopes(text: string): string[] {
  const scopes: string[] = [];
  const pattern = /[（(]([^）)]*)[）)]/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    scopes.push(text.slice(cursor, match.index ?? cursor));
    scopes.push(match[1] ?? "");
    cursor = (match.index ?? 0) + match[0].length;
  }
  scopes.push(text.slice(cursor));
  return scopes.filter(scope => scope.trim() !== "");
}

/** Each amount is classified from the words that govern it, not from the whole clause. */
function attributeAmounts(text: string, pouring: boolean): AttributedAmount[] {
  const storage = STORAGE_MARKER.test(text);
  const found: AttributedAmount[] = [];
  for (const scope of textScopes(text)) {
    const pattern = new RegExp(AMOUNT.source, "g");
    const matches = [...scope.matchAll(pattern)];
    matches.forEach((match, index) => {
      const start = match.index ?? 0;
      const previousEnd = index === 0 ? 0 : (matches[index - 1].index ?? 0) + matches[index - 1][0].length;
      const nextStart = index + 1 < matches.length ? (matches[index + 1].index ?? scope.length) : scope.length;
      const prefix = scope.slice(previousEnd, start);
      const suffix = scope.slice(start + match[0].length, nextStart);
      const unit = match[2] ?? "";
      const ml = toMillilitres(Number(match[1]), unit);
      const litre = /^(?:l|公升|升|litres?|liters?)$/.test(unit);
      const consumedHere = CONSUMED_MARKER.test(prefix);
      let purpose: QuantityPurpose;
      if (CAPACITY_MARKER.test(prefix) || CAPACITY_MARKER.test(suffix.slice(0, 4))) purpose = "package_capacity";
      else if (litre && !consumedHere) purpose = "package_capacity";
      else if (pouring && PACKAGE_NOUN.test(suffix)) purpose = "package_capacity";
      else if ((storage || STORAGE_MARKER.test(suffix)) && !consumedHere) purpose = "stock_amount";
      else if (pouring && DRINK_DESTINATION.test(suffix)) purpose = "transferred_amount";
      else if (pouring) purpose = "unknown";
      else if (consumedHere || CONSUMED_MARKER.test(suffix.slice(0, 16))) purpose = "row_personal_estimate";
      else if (AGGREGATE_MARKER.test(`${prefix}${suffix}`)) purpose = "aggregate_consumed";
      else purpose = "row_personal_estimate";
      found.push({ ml, purpose });
    });
  }
  return found;
}

function interpretRow(sink: ClaimSink, row: ObservedFoodRow) {
  const state: RowState = {
    ownVessels: new Set(), countSeen: false, aggregateSeen: false, hasDrinkWitnessText: false, capacityAmounts: [],
  };
  interpretLabel(sink, row, state);
  interpretPreparation(sink, row, state);
  if (row.raw.notes) {
    for (const clause of splitClauses(row.raw.notes)) interpretOwnClause(sink, row, state, clause, "notes");
  }
  interpretAnchors(sink, row);
  for (const entry of row.raw.visibleIngredients ?? []) {
    const family = familyOf(normalizeEvidenceText(entry));
    if (family) {
      sink.add({ rowId: row.rowId, field: "visibleIngredients", entryText: entry, span: [0, entry.length], rule: "ingredient_family" },
        { predicate: "family", subject: own(row.rowId), ...family }, "affirmative", ["family"]);
    }
  }
  for (const reason of row.raw.uncertaintyReasons) interpretUncertainField(sink, reason, "uncertaintyReasons", row.rowId);

  const { portionMin, portionMax, unit } = row.raw;
  const matchesCapacity = portionMin !== null && portionMax !== null && portionMin === portionMax
    && unit === "ml" && state.capacityAmounts.some(ml => ml === portionMin);
  const purpose: QuantityPurpose = matchesCapacity
    ? "package_capacity"
    : state.countSeen ? (state.aggregateSeen ? "aggregate_consumed" : "unknown") : "row_personal_estimate";
  const known = portionMin !== null && portionMax !== null;
  const usable = known && (purpose === "row_personal_estimate" || purpose === "aggregate_consumed");
  sink.add({ rowId: row.rowId, field: "portion", span: [0, 0], rule: "structured_portion" }, {
    predicate: "quantity",
    proposal: { proposalId: "", target: own(row.rowId), min: portionMin, max: portionMax, unit: unit as PortionUnit, purpose, claimIds: [] },
  }, "affirmative", usable ? ["portion"] : [], usable ? [] : [known ? "quantity_basis_unknown" : "portion_not_estimated"]);
}

// ---------------------------------------------------------------------------
// Meal-level interpretation
// ---------------------------------------------------------------------------

const PAIR_SUBJECT = /兩杯|两杯|這兩杯|这两杯|兩隻杯|两只杯|\bthe two (?:drink |milk )?(?:glasses|cups)\b|\bboth (?:glasses|cups)\b/;
const PAIR_DISTINCT = /(?:不是|並非|并非|唔係)同一(?:隻|只|個|个)?(?:玻璃)?杯|不同(?:的)?(?:玻璃)?杯|\bnot the same (?:glass|cup)\b|\bdifferent (?:glasses|cups)\b/;

function ownGlassWitnesses(claims: EvidenceClaim[], rows: ObservedFoodRow[]): string[] {
  return rows.filter(row => {
    if (!row.subject.milkCandidate) return false;
    const subject = rowEntityId(row.rowId);
    const about = claims.filter(claim => claim.source.rowId === row.rowId && claim.polarity === "affirmative");
    const isSubject = (referent: Referent) => referent.kind === "entity" && referent.entityId === subject;
    const glass = about.some(claim => claim.body.predicate === "vessel" && isSubject(claim.body.subject) &&
      vesselClass(claim.body.vessel) === "open" && claim.usableFor.includes("existence"));
    const blocked = about.some(claim => claim.body.predicate === "presence" && isSubject(claim.body.subject) &&
      (claim.body.content === "non_drink" || claim.body.content === "empty"));
    const otherVessel = about.some(claim => claim.body.predicate === "vessel" && isSubject(claim.body.subject) &&
      claim.usableFor.includes("existence") && vesselClass(claim.body.vessel) !== "open");
    return glass && !blocked && !otherVessel;
  }).map(row => row.rowId).sort();
}

function interpretMealClause(sink: ClaimSink, text: string, clause: Clause, field: ClaimField, glassWitnesses: string[]) {
  const source = (rule: string): SourceSpec => ({ field, entryText: text, span: [clause.start, clause.end], rule });
  const normalized = clause.text;

  if (PAIR_SUBJECT.test(normalized) && PAIR_DISTINCT.test(normalized)) {
    const rest = normalized.replace(PAIR_DISTINCT, " ").replace(PAIR_SUBJECT, " ").replace(/\b(?:drink|are|is)\b/g, " ");
    const { polarity } = polarityOf(rest);
    if (polarity === "affirmative" && glassWitnesses.length === 2) {
      sink.add(source("pair_not_same"), {
        predicate: "different_vessel", left: own(glassWitnesses[0]), right: own(glassWitnesses[1]),
      }, polarity, ["separate_identity"]);
    } else {
      sink.add(source("pair_not_same"), { predicate: "different_vessel", left: UNBOUND, right: UNBOUND }, polarity, [],
        [polarity === "affirmative" ? "ambiguous_antecedent" : "pair_not_affirmed"]);
    }
    return;
  }

  const reading = interpretCountStatement(clause.raw);
  const count = findCount(normalized, false);
  if (count && count.count >= 2) {
    sink.add(source(reading.quoted ? "quoted_count" : "scene_count"), {
      predicate: "cardinality", population: population(count.family, count.vessel), relation: "exact", count: count.count,
    }, reading.polarity, reading.admitted ? ["count"] : [], reading.admitted ? [] : reading.refusalReasons.filter(item => !item.endsWith("_scope")));
    return;
  }

  // Unbound identity statements are recorded for audit; they bind nothing.
  const notAnother = NOT_ANOTHER.test(normalized);
  const notSame = NOT_SAME.test(normalized);
  if (notAnother || notSame || SAME.test(normalized) || DIFFERENT.test(normalized)) {
    const { polarity } = polarityOf(normalized.replace(NOT_SAME, " ").replace(NOT_ANOTHER, " ").replace(SAME, " ").replace(DIFFERENT, " "));
    if (!vesselOf(normalized)) return;
    const predicate = notSame || SAME.test(normalized) ? "same_vessel" : "different_vessel";
    const finalPolarity: Polarity = notSame || notAnother ? (polarity === "affirmative" ? "negative" : polarity) : polarity;
    sink.add(source("scene_identity_statement"), { predicate, left: UNBOUND, right: UNBOUND }, finalPolarity, [], ["unbound_referent"]);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function interpretServingEvidence(input: ServingSceneInput): InterpretedServingEvidence {
  if (typeof input.sceneId !== "string" || input.sceneId.trim() === "" || input.sceneId.length > 200) {
    throw new ServingContractError("sceneId must be a non-empty string of at most 200 characters");
  }
  const parsed = foodAnalysisSchema.safeParse(input.analysis);
  if (!parsed.success) {
    throw new ServingContractError("analysis does not satisfy the food analysis schema",
      parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  }
  const analysis = parsed.data;
  if (analysis.foods.length > MAX_OBSERVED_ROWS) throw new ServingContractError(`at most ${MAX_OBSERVED_ROWS} observed rows`);

  const rows = buildRows(input.sceneId, analysis.foods);
  const sink = new ClaimSink(input.sceneId);
  for (const row of rows) {
    if (row.subject.milkCandidate) interpretRow(sink, row);
  }

  const rowClaims = sink.list();
  const glassWitnesses = ownGlassWitnesses(rowClaims, rows);
  for (const entry of [...new Set(analysis.visibleEvidence)].sort()) {
    for (const clause of splitClauses(entry)) interpretMealClause(sink, entry, clause, "visibleEvidence", glassWitnesses);
  }
  for (const field of ["uncertaintyReasons", "unknownInformation", "estimatedInformation"] as const) {
    for (const entry of [...new Set(analysis[field])].sort()) interpretUncertainField(sink, entry, field, undefined);
  }

  return { sceneId: input.sceneId, rows: rows.sort((a, b) => (a.rowId < b.rowId ? -1 : 1)), claims: sink.list() };
}
