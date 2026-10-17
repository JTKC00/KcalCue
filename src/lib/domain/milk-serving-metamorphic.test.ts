import { describe, expect, it } from "vitest";
import type { ObservedFood } from "@/lib/domain/food-analysis";
import {
  canonicalJson,
  confirmedPortionPlan,
  semanticDecisionView,
  validateServingReconciliation,
  type ServingReconciliation,
} from "@/lib/domain/milk-serving-contract";
import { reconcileMilkServingScene } from "@/lib/domain/milk-serving-reconciliation";
import {
  analysis,
  decisions,
  dispositionOf,
  milkRow,
  nonMilkRow,
  oatRow,
  permutations,
  referenceTotals,
  rowIdByNotes,
  sandwichRow,
  soyRow,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";

/**
 * Layer 4: metamorphic invariants and the approved 34 design-challenge cases.
 *
 * Generated scenes start from a typed truth (anchored servings, weak
 * duplicates, exact copies, noise) and only then render surface text. The
 * oracle reads the typed truth, never the extractor or the engine.
 */

// ---------------------------------------------------------------------------
// Deterministic generator
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T,>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

type Family = "whole" | "oat" | "soy";
type AnchorKind = "glassA" | "glassB" | "carton" | "bottle";
interface Anchor { kind: AnchorKind; family: Family; ml: number }
interface TruthCase {
  seed: number;
  axis: "lr" | "fb";
  anchors: Anchor[];
  copies: number[];        // indices of anchors rendered twice, byte-identical
  weak: Array<{ family: Family; ml: number; note: string | undefined }>;
  noise: ObservedFood[];
}

const FAMILY_TEXT: Record<Family, { display: string; normalized: string; zh: string; en: string }> = {
  whole: { display: "全脂牛奶", normalized: "whole milk", zh: "全脂牛奶", en: "whole milk" },
  oat: { display: "燕麥奶", normalized: "oat milk", zh: "燕麥奶", en: "oat milk" },
  soy: { display: "豆漿", normalized: "soy milk", zh: "豆漿", en: "soy milk" },
};
const SIDES = { lr: [["左邊", "left"], ["右邊", "right"]], fb: [["前方", "front"], ["後方", "back"]] } as const;
const NOISE: ObservedFood[] = [
  sandwichRow,
  nonMilkRow("蘋果", "apple", "旁邊有一杯牛奶"),
  nonMilkRow("橙汁", "orange juice", "另一杯飲品，玻璃杯裝"),
  nonMilkRow("湯匙", "spoon", "白色容器內有湯匙"),
  nonMilkRow("牛奶布甸", "milk pudding", "三盒燕麥奶"),
];

function renderAnchor(anchor: Anchor, axis: "lr" | "fb", english: boolean): ObservedFood {
  const text = FAMILY_TEXT[anchor.family];
  const base = { displayName: text.display, normalizedName: text.normalized };
  if (anchor.kind === "glassA" || anchor.kind === "glassB") {
    const [zh, en] = SIDES[axis][anchor.kind === "glassA" ? 0 : 1];
    const notes = english ? `${en} glass contains ${text.en}` : `${zh}玻璃杯裝${text.zh}`;
    return milkRow(notes, anchor.ml, { ...base, preparationMethod: "玻璃杯" });
  }
  if (anchor.kind === "carton") return milkRow(`${text.zh}紙盒`, anchor.ml, { ...base, preparationMethod: "紙盒" });
  return milkRow(`${text.zh}瓶`, anchor.ml, { ...base, preparationMethod: "瓶裝" });
}

function renderWeak(weak: TruthCase["weak"][number]): ObservedFood {
  const text = FAMILY_TEXT[weak.family];
  const row = milkRow(weak.note, weak.ml, { displayName: text.display, normalizedName: text.normalized });
  return row;
}

function generate(seed: number): TruthCase {
  const rng = mulberry32(seed);
  const kinds = shuffle(rng, ["glassA", "glassB", "carton", "bottle"] as const).slice(0, 1 + Math.floor(rng() * 4));
  const anchors = kinds.map(kind => ({ kind, family: pick(rng, ["whole", "oat", "soy"] as const), ml: pick(rng, [200, 250, 300, 400]) }));
  const copies = anchors.map((_, index) => index).filter(() => rng() < 0.2);
  const weakCount = Math.floor(rng() * 3);
  const weak = Array.from({ length: weakCount }, () => ({
    family: pick(rng, ["whole", "oat", "soy"] as const),
    ml: pick(rng, [180, 250, 330, 500]),
    note: pick(rng, ["白色飲品", "前方", "後方", undefined, "手上的飲品"]),
  }));
  const noise = shuffle(rng, NOISE).slice(0, Math.floor(rng() * 3));
  return { seed, axis: rng() < 0.5 ? "lr" : "fb", anchors, copies, weak, noise };
}

function rowsOf(truth: TruthCase, english = false): ObservedFood[] {
  const rng = mulberry32(truth.seed ^ 0x9e3779b9);
  const anchorRows = truth.anchors.map(anchor => renderAnchor(anchor, truth.axis, english));
  const rows = [
    ...anchorRows,
    ...truth.copies.map(index => ({ ...anchorRows[index] })),
    ...truth.weak.map(renderWeak),
    ...truth.noise,
  ];
  return shuffle(rng, rows);
}

/** Oracle from the typed truth only. */
function expectedPlan(truth: TruthCase) {
  const profile = (family: Family) => family;
  return truth.anchors
    .map(anchor => ({ profileId: profile(anchor.family), min: anchor.ml, max: anchor.ml, unit: "ml" as const, purpose: "personal" as const, multiplicity: 1 }))
    .sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
}

const solve = (sceneId: string, rows: ObservedFood[], evidence: string[] = []) =>
  validateServingReconciliation(reconcileMilkServingScene({ sceneId, analysis: analysis(rows, evidence) }));

/** Milk-only projection used for unrelated-row insertion comparisons. */
function milkProjection(result: ServingReconciliation) {
  const milkRows = new Set(result.rows.filter(row => row.subject.milkCandidate).map(row => row.rowId));
  return JSON.parse(canonicalJson({
    supportedSlots: result.supportedSlots,
    confirmed: result.confirmed,
    unresolved: result.unresolved,
    dispositions: result.dispositions.filter(item => milkRows.has(item.rowId)),
    candidates: result.candidates.filter(candidate => candidate.rowIds.every(id => milkRows.has(id))),
    summary: result.summary,
  }));
}

const kcalMax = (result: ServingReconciliation) => referenceTotals(confirmedPortionPlan(result)).max.kcal;

function samplePermutations<T>(rng: Rng, rows: readonly T[], limit: number): T[][] {
  if (rows.length <= 5) return permutations(rows);
  return Array.from({ length: limit }, () => shuffle(rng, rows));
}

/** Greedy row-removal shrinker. Returns the smallest failing row list. */
function shrink(rows: ObservedFood[], fails: (rows: ObservedFood[]) => boolean): ObservedFood[] {
  let current = rows;
  let progress = true;
  while (progress) {
    progress = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = current.filter((_, other) => other !== index);
      if (candidate.length > 0 && fails(candidate)) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return current;
}

function assertProperty(label: string, seed: number, rows: ObservedFood[], fails: (rows: ObservedFood[]) => boolean) {
  if (!fails(rows)) return;
  const minimal = shrink(rows, fails);
  throw new Error(`${label} failed for seed ${seed}; minimal counterexample:\n${JSON.stringify(minimal, null, 1)}`);
}

const SEEDS = Array.from({ length: 48 }, (_, index) => 0xC0FFEE + index * 7919);

describe("generated scenes: oracle agreement (fixed seeds)", { timeout: 60_000 }, () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: anchored servings preserved, weak rows unresolved, noise unrelated`, () => {
      const truth = generate(seed);
      const english = seed % 3 === 0;
      const rows = rowsOf(truth, english);
      const result = solve(`gen-${seed}`, rows);
      expect(result.summary.supportedServingCount).toBe(truth.anchors.length);
      expect(confirmedPortionPlan(result)).toEqual(expectedPlan(truth));
      for (const weak of truth.weak.map(renderWeak)) {
        const ids = result.rows.filter(row => canonicalJson(row.raw) === canonicalJson(weak)).map(row => row.rowId);
        for (const id of ids) expect(["possible_excess", "conflict"]).toContain(dispositionOf(result, id).disposition);
      }
      for (const row of result.rows.filter(item => !item.subject.milkCandidate)) {
        expect(dispositionOf(result, row.rowId).disposition).toBe("unrelated");
      }
    });
  }
});

describe("recorded minimal counterexamples", { timeout: 60_000 }, () => {
  // Found by seed 12703863 during implementation: two byte-identical copies of
  // each of two certified-distinct anchors collapsed into one 4-row ambiguous
  // pool, so pure duplication erased both confirmed servings. Fixed by
  // computing cliques over false-twin witness classes.
  it("seed 12703863 shrink: [X, X, Y, Y] keeps both anchored servings", () => {
    const x = wholeRow("left glass contains whole milk", 300);
    const y = oatRow("right glass contains oat milk", 200, { preparationMethod: "玻璃杯" });
    const result = solve("cx-12703863", [x, { ...x }, y, { ...y }]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "oat", min: 200, max: 200, unit: "ml", purpose: "personal", multiplicity: 1 },
      { profileId: "whole", min: 300, max: 300, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(permutations([x, { ...x }, y, { ...y }]).every(order =>
      canonicalJson(semanticDecisionView(solve("cx-12703863", order))) === canonicalJson(semanticDecisionView(result)))).toBe(true);
  });
});

describe("independent review fixture shapes under the new contract", { timeout: 60_000 }, () => {
  for (const [x, y] of [["前方", "後方"], ["左邊", "右邊"], ["這杯牛奶的前方", "這杯牛奶的後方"], ["前方玻璃杯", "後方同一杯"],
    ["front of the glass", "back of the same glass"], ["前方蘋果", "後方三明治"], ["左邊蘋果", "右邊三明治"]]) {
    it(`spatial-only generic pair ${x}/${y} supports one serving`, () => {
      const result = solve("rv-g1", [milkRow(x), milkRow(y)]);
      expect(result.summary.supportedServingCount).toBe(1);
    });
  }

  it("generic front/back + genuine whole glass: whole preserved at 251.32 kcal, generics pending (design §8 tightening)", () => {
    for (const order of permutations([milkRow("前方"), milkRow("後方"), wholeRow()])) {
      for (let position = 0; position <= order.length; position += 1) {
        const rows = [...order.slice(0, position), sandwichRow, ...order.slice(position)];
        const result = solve("rv-g2", rows);
        expect(dispositionOf(result, rowIdByNotes(result, "獨立玻璃杯")).disposition).toBe("used_as_evidence");
        expect(kcalMax(result)).toBeCloseTo(251.32, 8);
        expect(dispositionOf(result, rowIdByNotes(result, "前方")).disposition).toBe("possible_excess");
      }
    }
  });

  for (const text of ["沒三盒燕麥奶", "看不到三盒燕麥奶", "沒有三盒燕麥奶", "唔係三盒燕麥奶", "no three oat milk cartons", "cannot see three oat milk cartons", "未确认三盒燕麦奶"]) {
    it(`negated count ${text} keeps one oat slot (116.0243653957 kcal)`, () => {
      const result = solve("rv-g3", [oatRow(), oatRow(), oatRow()], [text]);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(kcalMax(result)).toBeCloseTo(116.0243653957, 8);
    });
  }

  for (const note of ["燕麥奶紙盒，旁邊另一杯", "燕麥奶紙盒，旁邊另一盒", "前方玻璃杯，後方另一杯", "紙盒燕麥奶 not the same glass"]) {
    it(`review thread 1 variant ${note}: unrelated nearby text does not count a second oat carton`, () => {
      const result = solve("rv-t1", [oatRow(note), oatRow("燕麥奶紙盒，旁邊玻璃杯")]);
      expect(result.summary.supportedServingCount).toBe(1);
    });
  }

  it("review thread 2: carton 'not the same glass' does not bind; oat + whole glass = 273.0993653957 kcal", () => {
    const result = solve("rv-t2", [oatRow("紙盒燕麥奶 not the same glass"), oatRow("紙盒燕麥奶"), wholeRow("獨立全脂牛奶玻璃杯", 250)]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(kcalMax(result)).toBeCloseTo(273.0993653957, 8);
  });

  it("physical glass evidence outranks an ambiguous same-family row: whole400 + oat250 = 367.3443653957 kcal", () => {
    const rows = [wholeRow("白色飲品", 250, { preparationMethod: undefined }), wholeRow("玻璃杯邊緣有藍色圓點，確認400ml", 400), oatRow()];
    for (const order of permutations(rows)) {
      const result = solve("rv-c2", order);
      expect(kcalMax(result)).toBeCloseTo(367.3443653957, 8);
      expect(dispositionOf(result, rowIdByNotes(result, "白色飲品")).disposition).toBe("possible_excess");
    }
  });

  it("front glass + back carton with milk contents stay two servings", () => {
    const result = solve("rv-b4", [milkRow("前方玻璃杯內牛奶"), milkRow("後方紙盒內牛奶")]);
    expect(result.summary.supportedServingCount).toBe(2);
  });

  it("conservative: a vague back container and an oat carton without anchors stay ambiguous", () => {
    const glass = milkRow("前方透明玻璃杯內可見牛奶");
    const back = milkRow("後方另一個白色容器內有白色飲品");
    const result = solve("rv-c4-oat", [glass, back, oatRow()]);
    expect(dispositionOf(result, rowIdByNotes(result, glass.notes!)).disposition).toBe("used_as_evidence");
    expect(result.summary.supportedServingCount).toBe(2);
    expect(dispositionOf(result, rowIdByNotes(result, back.notes!)).disposition).toBe("alternative");
  });

  it("exhaustive 7-row permutation invariance on a mixed scene (5040 orders)", () => {
    const rows = [milkRow("左邊玻璃杯裝豆漿", 250, { preparationMethod: "玻璃杯" }), wholeRow("右邊玻璃杯裝全脂牛奶", 400), oatRow(), oatRow(),
      milkRow("白色飲品", 300), milkRow("後方另一個白色容器，內有湯匙"), sandwichRow];
    const baseline = canonicalJson(semanticDecisionView(solve("rv-perm7", rows, ["三盒燕麥奶嗎"])));
    for (const order of permutations(rows)) {
      expect(canonicalJson(semanticDecisionView(solve("rv-perm7", order, ["三盒燕麥奶嗎"])))).toBe(baseline);
    }
  }, 120_000);
});

describe("metamorphic invariants (fixed seeds)", { timeout: 60_000 }, () => {
  it("row permutation invariance (exhaustive for n<=5, 16 samples otherwise)", () => {
    for (const seed of SEEDS.slice(0, 24)) {
      const rng = mulberry32(seed);
      const rows = rowsOf(generate(seed));
      const baseline = canonicalJson(semanticDecisionView(solve(`perm-${seed}`, rows)));
      for (const order of samplePermutations(rng, rows, 16)) {
        if (canonicalJson(semanticDecisionView(solve(`perm-${seed}`, order))) === baseline) continue;
        assertProperty("permutation", seed, order, candidate =>
          canonicalJson(semanticDecisionView(solve(`perm-${seed}`, candidate))) !==
          canonicalJson(semanticDecisionView(solve(`perm-${seed}`, [...candidate].reverse()))));
        throw new Error(`permutation changed the decision for seed ${seed}:\n${JSON.stringify(order, null, 1)}`);
      }
    }
  }, 60_000);

  it("unrelated-row insertion invariance at every position", () => {
    for (const seed of SEEDS.slice(0, 24)) {
      const truth = generate(seed);
      const rows = rowsOf({ ...truth, noise: [] });
      const baseline = milkProjection(solve(`ins-${seed}`, rows));
      for (const noise of NOISE) {
        if (rows.length >= 12) continue;
        for (let position = 0; position <= rows.length; position += 1) {
          const inserted = [...rows.slice(0, position), noise, ...rows.slice(position)];
          expect(milkProjection(solve(`ins-${seed}`, inserted))).toEqual(baseline);
        }
      }
    }
  });

  it("vessel weakening never creates support or confirmed contribution", () => {
    for (const seed of SEEDS) {
      const truth = generate(seed);
      const rows = rowsOf(truth);
      const base = solve(`weak-${seed}`, rows);
      truth.anchors.forEach((anchor, index) => {
        const target = renderAnchor(anchor, truth.axis, false);
        const weakened = rows.map(row => canonicalJson(row) === canonicalJson(target)
          ? { ...row, preparationMethod: undefined, notes: "白色飲品" }
          : row);
        const result = solve(`weak-${seed}`, weakened);
        expect(result.summary.supportedServingCount, `seed ${seed} anchor ${index}`).toBeLessThanOrEqual(base.summary.supportedServingCount);
        expect(kcalMax(result)).toBeLessThanOrEqual(kcalMax(base) + 1e-9);
      });
    }
  });

  it("exact duplication never increases support or confirmed nutrition", () => {
    for (const seed of SEEDS) {
      const rows = rowsOf(generate(seed));
      if (rows.length >= 12) continue;
      const base = solve(`dup-${seed}`, rows);
      for (const row of rows.filter(item => item.normalizedName.includes("milk"))) {
        const result = solve(`dup-${seed}`, [...rows, { ...row }]);
        expect(result.summary.supportedServingCount).toBeLessThanOrEqual(base.summary.supportedServingCount);
        expect(kcalMax(result)).toBeLessThanOrEqual(kcalMax(base) + 1e-9);
      }
    }
  });

  it("a genuine new serving adds only its own contribution and promotes nothing", () => {
    for (const seed of SEEDS) {
      const truth = generate(seed);
      const missing = (["glassA", "glassB", "carton", "bottle"] as const).find(kind => !truth.anchors.some(anchor => anchor.kind === kind));
      if (!missing) continue;
      const rows = rowsOf(truth);
      if (rows.length >= 12) continue;
      const base = solve(`new-${seed}`, rows);
      const added: Anchor = { kind: missing, family: "whole", ml: 250 };
      const result = solve(`new-${seed}`, [...rows, renderAnchor(added, truth.axis, false)]);
      expect(result.summary.supportedServingCount).toBe(base.summary.supportedServingCount + 1);
      expect(kcalMax(result)).toBeCloseTo(kcalMax(base) + 157.075, 8);
      for (const disposition of base.dispositions) {
        const after = dispositionOf(result, disposition.rowId);
        if (disposition.disposition !== "used_as_evidence") expect(after.disposition).not.toBe("used_as_evidence");
        if (disposition.disposition === "used_as_evidence") expect(after.disposition).toBe("used_as_evidence");
      }
    }
  });

  it("count polarity weakening never increases admitted support", () => {
    const templates: Array<(n: number, zh: string, en: string) => string> = [
      (n, zh) => `${"一兩三四五"[n - 1]}盒${zh}嗎`,
      (n, zh) => `係咪${"一兩三四五"[n - 1]}盒${zh}`,
      (n, _, en) => `Are there ${["one", "two", "three", "four", "five"][n - 1]} ${en} cartons`,
      (n, _, en) => `can't see ${["one", "two", "three", "four", "five"][n - 1]} ${en} cartons`,
      (n, zh) => `未證實有${"一兩三四五"[n - 1]}盒${zh}`,
      (n, _, en) => `maybe ${["one", "two", "three", "four", "five"][n - 1]} ${en} cartons`,
      (n, zh) => `${"一兩三四五"[n - 1]}盒${zh}？`,
    ];
    for (const seed of SEEDS.slice(0, 24)) {
      const rng = mulberry32(seed);
      const family = pick(rng, ["oat", "soy", "whole"] as const);
      const text = FAMILY_TEXT[family];
      const k = 1 + Math.floor(rng() * 4);
      const n = 2 + Math.floor(rng() * 4);
      const rows = Array.from({ length: k }, () => milkRow(`${text.zh}紙盒`, 250, { displayName: text.display, normalizedName: text.normalized, preparationMethod: "紙盒" }));
      const none = solve(`pol-${seed}`, rows);
      const affirmative = solve(`pol-${seed}`, rows, [`${"一兩三四五"[n - 1]}盒${text.zh}`]);
      expect(affirmative.summary.supportedServingCount).toBe(Math.max(n, none.summary.supportedServingCount));
      for (const template of templates) {
        const weakened = solve(`pol-${seed}`, rows, [template(n, text.zh, text.en)]);
        expect(weakened.summary.supportedServingCount).toBe(none.summary.supportedServingCount);
        expect(kcalMax(weakened)).toBeLessThanOrEqual(kcalMax(affirmative) + 1e-9);
      }
    }
  });

  it("indirect upgrade is forbidden: weakening one side of a 2/4 conflict keeps the barrier", () => {
    const rows = [oatRow(), oatRow(), oatRow()];
    const conflict = solve("ind", rows, ["兩盒燕麥奶", "四盒燕麥奶"]);
    expect(conflict.summary.supportedServingCount).toBe(1);
    for (const weakened of ["兩盒燕麥奶嗎", "沒有兩盒燕麥奶", "未證實有兩盒燕麥奶", "係咪兩盒燕麥奶"]) {
      const result = solve("ind", rows, [weakened, "四盒燕麥奶"]);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(result.summary.cardinalityReviewRequired).toBe(true);
    }
  });

  it("idempotence: rerun, JSON round-trip and legacy annotations are equivalent", () => {
    for (const seed of SEEDS.slice(0, 16)) {
      const rows = rowsOf(generate(seed));
      const first = solve(`idem-${seed}`, rows);
      const second = solve(`idem-${seed}`, rows);
      expect(second).toEqual(first);
      expect(validateServingReconciliation(JSON.parse(JSON.stringify(first)))).toEqual(first);
      const annotated = rows.map(row => ({ ...row, suspectedDuplicateMilk: true as const, duplicateMilkNotice: "已合併", otherMilkNotice: "植物奶" }));
      expect(semanticDecisionView(solve(`idem-${seed}`, annotated))).toEqual(semanticDecisionView(first));
    }
  });

  it("stable identities: slot and group ids do not depend on array index", () => {
    for (const seed of SEEDS.slice(0, 16)) {
      const rows = rowsOf(generate(seed));
      const a = solve(`ids-${seed}`, rows);
      const b = solve(`ids-${seed}`, [...rows].reverse());
      expect(b.supportedSlots.map(slot => slot.slotId)).toEqual(a.supportedSlots.map(slot => slot.slotId));
      expect(b.unresolved.map(group => group.groupId)).toEqual(a.unresolved.map(group => group.groupId));
      expect(b.sourceDigest).toBe(a.sourceDigest);
    }
  });

  it("decisions bound to semantic ids survive row reordering", () => {
    const rows = [milkRow("前方", 250), milkRow("後方", 400), sandwichRow];
    const base = solve("dec-perm", rows);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const list = decisions(base, [
      { kind: "one_serving", groupId: group.groupId, portion: { min: 400, max: 400, unit: "ml" } },
      { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
    ]);
    const outcomes = permutations(rows).map(order =>
      validateServingReconciliation(reconcileMilkServingScene({ sceneId: "dec-perm", analysis: analysis(order), decisions: list })));
    for (const outcome of outcomes) {
      expect(semanticDecisionView(outcome)).toEqual(semanticDecisionView(outcomes[0]));
      expect(kcalMax(outcome)).toBeCloseTo(251.32, 8);
    }
  });

  it("bounded worst case: 12 rows with every relation shape completes deterministically", () => {
    const rows = [
      ...["左邊", "右邊"].map(side => wholeRow(`${side}玻璃杯裝全脂牛奶`, 250)),
      oatRow(), oatRow(), oatRow(),
      soyRow("豆漿瓶", 250, { preparationMethod: "瓶裝" }),
      milkRow("前方", 180), milkRow("後方", 360), milkRow("白色飲品", 500),
      milkRow("後方另一個白色容器，內有湯匙"), milkRow("旁邊另一杯椰奶", 250, { preparationMethod: "玻璃杯" }),
      wholeRow("同一杯", 300),
    ];
    const started = performance.now();
    const first = solve("worst", rows, ["三盒燕麥奶嗎", "兩盒燕麥奶"]);
    const elapsed = performance.now() - started;
    expect(rows).toHaveLength(12);
    expect(elapsed).toBeLessThan(2000);
    expect(semanticDecisionView(solve("worst", [...rows].reverse(), ["兩盒燕麥奶", "三盒燕麥奶嗎"]))).toEqual(semanticDecisionView(first));
  });
});

// ---------------------------------------------------------------------------
// Approved design challenge (#1-#34), scene level where Phase 1 applies.
// Every case also checks permutation and sandwich insertion stability.
// ---------------------------------------------------------------------------

function stable(sceneId: string, rows: ObservedFood[], evidence: string[] = []): ServingReconciliation {
  const base = solve(sceneId, rows, evidence);
  for (const order of permutations(rows)) {
    expect(semanticDecisionView(solve(sceneId, order, evidence))).toEqual(semanticDecisionView(base));
  }
  if (rows.length < 12) {
    for (let position = 0; position <= rows.length; position += 1) {
      const inserted = [...rows.slice(0, position), sandwichRow, ...rows.slice(position)];
      expect(milkProjection(solve(sceneId, inserted, evidence))).toEqual(milkProjection(base));
    }
  }
  return base;
}

describe("design challenge cases", { timeout: 60_000 }, () => {
  it("#1 almond left glass + explicit whole right glass: two slots, almond never priced as whole", () => {
    const left = milkRow("左邊玻璃杯裝杏仁奶", 250, { preparationMethod: "玻璃杯" });
    const right = wholeRow("右邊玻璃杯裝全脂牛奶", 250);
    const result = stable("ch1", [left, right]);
    expect(result.summary.supportedServingCount).toBe(2);
    const leftSlot = result.supportedSlots.find(slot => slot.sourceCandidateIds.includes(`cand:${rowIdByNotes(result, left.notes!)}`))!;
    expect(leftSlot.family).toMatchObject({ state: "resolved", value: { family: "almond" } });
    expect(leftSlot.status).toBe("pending");
    expect(kcalMax(result)).toBeCloseTo(157.075, 8);
  });

  it("#2 one sticker cup called soy and whole: one serving, no milk nutrition", () => {
    const result = stable("ch2", [soyRow("有星形貼紙的杯"), wholeRow("有星形貼紙的同一杯", 250)]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.some(group => group.kind === "family_conflict" || group.kind === "exclusive_candidates")).toBe(true);
  });

  it("#3 a cookie count in an oat note is not oat cardinality", () => {
    const result = stable("ch3", [oatRow("燕麥奶紙盒，旁邊兩包曲奇")]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.claims.some(claim => claim.body.predicate === "cardinality")).toBe(false);
  });

  it("#4 a nearby coconut cup is an unbound candidate, not a second established serving", () => {
    const result = stable("ch4", [milkRow("旁邊另一杯椰奶", 250, { preparationMethod: "玻璃杯" })]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.unresolved.some(group => group.kind === "unbound_object")).toBe(true);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#5 'not another glass, the same glass turned around' does not add a serving", () => {
    const result = stable("ch5", [milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" }),
      milkRow("這不是另一杯，只是同一杯轉到另一面", 250, { preparationMethod: "玻璃杯" })]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("#6 unbound 'not different cartons' neither adds nor merges", () => {
    const result = stable("ch6", [oatRow(), oatRow()], ["These are not different cartons"]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("#7 'the two drink glasses are not the same glass' with both drinks bound: two servings", () => {
    const result = stable("ch7", [milkRow("玻璃杯內有牛奶", 250, { preparationMethod: "玻璃杯" }),
      milkRow("玻璃杯內有白色飲品", 300, { preparationMethod: "玻璃杯" })], ["The two drink glasses are not the same glass"]);
    expect(result.summary.supportedServingCount).toBe(2);
  });

  for (const [id, phrase, rows] of [
    ["#8", "會唔會其實有四樽豆奶", [soyRow("豆漿瓶", 250, { preparationMethod: "瓶裝" }), soyRow("豆漿瓶", 250, { preparationMethod: "瓶裝" })]],
    ["#9", "尚未證明畫面有四盒杏仁奶", [milkRow("杏仁奶紙盒", 250, { displayName: "杏仁奶", normalizedName: "almond milk", preparationMethod: "紙盒" })]],
    ["#10", "Does the photograph show two soy bottles", [soyRow("豆漿瓶", 250, { preparationMethod: "瓶裝" }), soyRow("豆漿瓶", 250, { preparationMethod: "瓶裝" })]],
    ["#11", "不是沒有四盒牛奶", [milkRow("牛奶紙盒", 250, { preparationMethod: "紙盒" }), milkRow("牛奶紙盒", 250, { preparationMethod: "紙盒" })]],
    ["#12", "請核對兩杯是否同一杯", [milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" }), milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" })]],
    ["#13", "「兩盒優惠」", [oatRow("玻璃杯燕麥奶", 250, { preparationMethod: "玻璃杯" })]],
  ] as const) {
    it(`${id} ${phrase}: no count support`, () => {
      const result = stable(`ch${id}`, [...rows], [phrase]);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(result.summary.cardinalityReviewRequired).toBe(false);
    });
  }

  it("#9 almond does not inherit an oat profile", () => {
    const result = solve("ch9b", [milkRow("杏仁奶紙盒", 250, { displayName: "杏仁奶", normalizedName: "almond milk", preparationMethod: "紙盒" })]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.supportedSlots[0].pendingReasons).toContain("profile_unavailable");
  });

  it("#14 same names with 180/360 ml form the C group for both orders", () => {
    const result = stable("ch14", [milkRow("白色飲品", 180), milkRow("白色飲品", 360)]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.find(group => group.kind === "exclusive_candidates")?.amountAlternatives).toHaveLength(2);
  });

  it("#15 same round-handled cup, 180–220 vs 200–240: both ranges kept", () => {
    const result = stable("ch15", [
      milkRow("圓柄杯", null, { portionMin: 180, portionMax: 220, preparationMethod: "杯裝" }),
      milkRow("同一圓柄杯", null, { portionMin: 200, portionMax: 240, preparationMethod: "杯裝" }),
    ]);
    const group = result.unresolved.find(item => item.kind === "exclusive_candidates")!;
    expect(group.amountAlternatives.map(item => [item.min, item.max]).sort()).toEqual([[180, 220], [200, 240]]);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#17 a 200 ml mark against a 400 ml proposal on one cup is a same-target conflict", () => {
    const result = stable("ch17", [wholeRow("量杯刻度顯示200ml", 400, { preparationMethod: "量杯" })]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.some(group => group.kind === "exclusive_candidates")).toBe(true);
  });

  it("#18 carton250 + glass250 + unbound 900 ml row: two units, 900 pending", () => {
    const rows = [oatRow("燕麥奶紙盒"), oatRow("獨立玻璃杯燕麥奶", 250, { preparationMethod: "玻璃杯" }), oatRow("白色飲品", 900, { preparationMethod: undefined })];
    const result = stable("ch18", rows);
    expect(confirmedPortionPlan(result).map(line => line.max)).toEqual([250, 250]);
    expect(dispositionOf(result, rowIdByNotes(result, "白色飲品")).disposition).toBe("possible_excess");
  });

  it("#19 two soy cartons with three unbound amounts: count 2, assignment pending", () => {
    const rows = [200, 350, 500].map(ml => soyRow("豆漿", ml, { preparationMethod: undefined }));
    const result = stable("ch19", rows, ["兩盒豆漿"]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#20 three glasses with 600 ml consumed in total: aggregate counted once", () => {
    const result = stable("ch20", [wholeRow("三杯合共飲用了600ml", 600, { preparationMethod: undefined })]);
    expect(confirmedPortionPlan(result)).toEqual([{ profileId: "whole", min: 600, max: 600, unit: "ml", purpose: "aggregate_consumed", multiplicity: 3 }]);
    expect(kcalMax(result)).toBeCloseTo(157.075 * 600 / 250, 8);
  });

  it("#21 three glasses with 600 ml of unknown basis: count 3, portion pending", () => {
    const result = stable("ch21", [wholeRow("三杯", 600, { preparationMethod: undefined })]);
    expect(result.summary.supportedServingCount).toBe(3);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#22 one count repeated across evidence fields counts once", () => {
    const repeated = "兩盒燕麥奶";
    const result = stable("ch22", [oatRow(`燕麥奶紙盒`), oatRow(), oatRow()], [repeated, repeated, repeated, repeated, repeated]);
    expect(result.summary.supportedServingCount).toBe(2);
  });

  it("#23 exact two vs exact four: surplus revoked, review required", () => {
    const result = stable("ch23", [oatRow(), oatRow(), oatRow()], ["兩盒燕麥奶", "四盒燕麥奶"]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.summary.cardinalityReviewRequired).toBe(true);
  });

  it("#24 1 L stock poured into a glass: only the glass portion counts", () => {
    const result = stable("ch24", [oatRow("1L燕麥奶紙盒，倒了180ml到玻璃杯", null), oatRow("玻璃杯燕麥奶", 180, { preparationMethod: "玻璃杯" })]);
    expect(confirmedPortionPlan(result)).toEqual([{ profileId: "oat", min: 180, max: 180, unit: "ml", purpose: "personal", multiplicity: 1 }]);
  });

  it("#25 an empty milk carton is not another serving witness", () => {
    const result = stable("ch25", [milkRow("空的牛奶紙盒", null, { preparationMethod: "紙盒" }), wholeRow("玻璃杯裝全脂牛奶", 250)]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(kcalMax(result)).toBeCloseTo(157.075, 8);
  });

  it("#26 two real glasses with null portions: count 2 visible, zero confirmed", () => {
    const result = stable("ch26", [wholeRow("左邊玻璃杯裝全脂牛奶", null), wholeRow("右邊玻璃杯裝全脂牛奶", null)]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#28 an unknown row compatible with soy and whole glasses does not displace them", () => {
    const result = stable("ch28", [
      milkRow("左邊玻璃杯裝豆漿", 250, { preparationMethod: "玻璃杯" }),
      wholeRow("右邊玻璃杯裝全脂牛奶", 400),
      milkRow("白色飲品", 300),
    ]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(dispositionOf(result, rowIdByNotes(result, "白色飲品")).disposition).toBe("possible_excess");
  });

  it("#31 a bottle and its mirror reflection are not two servings", () => {
    const result = stable("ch31", [milkRow("桌面右邊的瓶", 250, { preparationMethod: "瓶裝" }), milkRow("鏡子左邊的倒影瓶", 250, { preparationMethod: "瓶裝" })]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("#32 1 cup vs 250 ml for the same glass stays a conflict", () => {
    const result = stable("ch32", [wholeRow("玻璃杯", 1, { unit: "cup" }), wholeRow("同一玻璃杯", 250)]);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#33 a soy/oat blend in one cup: one serving, no averaged profile", () => {
    const result = stable("ch33", [milkRow("一杯豆漿和燕麥奶混合", 250, { preparationMethod: "玻璃杯" })]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#34 (Phase 1 analogue) a stale decision basis is refused and keeps state", () => {
    const rows = [milkRow("前方", 250), milkRow("後方", 400)];
    const base = solve("ch34", rows);
    const result = validateServingReconciliation(reconcileMilkServingScene({
      sceneId: "ch34", analysis: analysis(rows),
      decisions: [{ decisionId: "old", sourceDigest: "older-basis", expectedDecisionRevision: 0,
        command: { kind: "one_serving", groupId: base.unresolved[0].groupId, portion: { min: 250, max: 250, unit: "ml" } } }],
    }));
    expect(result.rejectedDecisions).toEqual([{ decisionId: "old", reason: "stale_source_digest" }]);
    expect(semanticDecisionView({ ...result, rejectedDecisions: [] })).toEqual(semanticDecisionView(base));
  });
});
