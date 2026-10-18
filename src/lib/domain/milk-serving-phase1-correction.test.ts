import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  confirmedPortionPlan,
  semanticDecisionView,
  servingReconciliationSchema,
  type EvidenceClaim,
  type ObservedFoodRow,
  type QuantityProposal,
  type ServingReconciliation,
} from "@/lib/domain/milk-serving-contract";
import { reconcileMilkServingScene, reconcileServingEvidence } from "@/lib/domain/milk-serving-reconciliation";
import {
  REFERENCE_250ML,
  analysis,
  decisions,
  dispositionOf,
  milkRow,
  oatRow,
  permutations,
  referenceTotals,
  rowIdByNotes,
  soyRow,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";

/**
 * Permanent regressions for the independent Gemini re-review of Phase 1.
 * Expected counts, purposes and kcal are written from the approved reference
 * vectors and the DESIGN_PASS decision rules. They are not copied from the
 * engine output under test.
 */

const WHOLE_250 = 157.075;
const WHOLE_400 = 251.32;
const WHOLE_180 = 113.094;
const TWO_WHOLE_250 = 314.15;
const WHOLE_250_AND_400 = 408.395;
const SOY_250 = REFERENCE_250ML.soy!.kcal;

const scene = (sceneId: string, rows: Parameters<typeof analysis>[0], evidence: string[] = []) =>
  reconcileMilkServingScene({ sceneId, analysis: analysis(rows, evidence) });

function kcal(result: ServingReconciliation): number {
  return referenceTotals(confirmedPortionPlan(result)).max.kcal;
}

function proposalsFor(result: ServingReconciliation, notes: string): Array<Pick<QuantityProposal, "min" | "max" | "purpose">> {
  const id = rowIdByNotes(result, notes);
  const candidate = result.candidates.find(item => item.candidateId === `cand:${id}`);
  return (candidate?.quantityProposals ?? []).map(item => ({ min: item.min, max: item.max, purpose: item.purpose }));
}

function liveSlotsFor(result: ServingReconciliation, notes: string) {
  const id = rowIdByNotes(result, notes);
  return result.supportedSlots.filter(slot =>
    slot.status !== "dismissed" && slot.sourceCandidateIds.includes(`cand:${id}`));
}

describe("P1-1 witness outside the maximum clique stays unresolved", () => {
  const left = milkRow("左邊玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
  const right = milkRow("右邊玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
  const blue = wholeRow("藍色圓點玻璃杯裝全脂牛奶", 400);

  it("keeps the blue-dot 400 ml witness without creating a third supported serving", () => {
    const orders = permutations([left, right, blue]);
    const views = orders.map(order => semanticDecisionView(scene("p1-witness", order)));
    for (const view of views) expect(view).toEqual(views[0]);

    const result = scene("p1-witness", [left, right, blue]);
    const blueId = rowIdByNotes(result, blue.notes!);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(result.summary.confirmedServingCount).toBe(0);
    expect(kcal(result)).toBe(0);
    expect(liveSlotsFor(result, blue.notes!)).toEqual([]);
    expect(liveSlotsFor(result, left.notes!)[0].portion).toMatchObject({ state: "resolved", value: { min: 250, max: 250 } });
    expect(liveSlotsFor(result, right.notes!)[0].portion).toMatchObject({ state: "resolved", value: { min: 250, max: 250 } });

    const blueDisposition = dispositionOf(result, blueId);
    expect(blueDisposition.disposition).toBe("possible_excess");
    expect(blueDisposition.slotIds).toEqual([]);
    expect(blueDisposition.reasonCodes).toContain("distinctness_unresolved");
    const group = result.unresolved.find(item => item.candidateIds.includes(`cand:${blueId}`))!;
    expect(group.kind).toBe("possible_excess");
    expect(group.possibleExtraSlots).toBe(1);
    expect(group.possibleTargetSlotIds.length).toBeGreaterThanOrEqual(2);
    expect(group.amountAlternatives.some(item => item.max === 400 && item.purpose === "row_personal_estimate")).toBe(true);
    expect(proposalsFor(result, blue.notes!).some(item => item.max === 250)).toBe(false);
    expect(result.confirmed.some(unit => unit.portion.max === 400)).toBe(false);
  });

  it("types the two anchored glasses without admitting the unresolved blue-dot witness", () => {
    const base = scene("p1-witness-type", [left, right, blue]);
    const blueId = rowIdByNotes(base, blue.notes!);
    const typed = reconcileMilkServingScene({
      sceneId: "p1-witness-type",
      analysis: analysis([left, right, blue]),
      decisions: decisions(base, [
        { kind: "set_type", targetId: liveSlotsFor(base, left.notes!)[0].slotId, choice: "whole" },
        { kind: "set_type", targetId: liveSlotsFor(base, right.notes!)[0].slotId, choice: "whole" },
      ]),
    });
    expect(typed.rejectedDecisions).toEqual([]);
    expect(typed.summary.supportedServingCount).toBe(2);
    expect(confirmedPortionPlan(typed)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(typed)).toBeCloseTo(TWO_WHOLE_250, 8);
    expect(dispositionOf(typed, blueId).disposition).toBe("possible_excess");
    expect(typed.confirmed.some(unit => unit.portion.max === 400)).toBe(false);
  });

  it("admits the blue-dot witness only after an explicit separate-serving decision", () => {
    const base = scene("p1-witness-resolve", [left, right, blue]);
    const blueId = rowIdByNotes(base, blue.notes!);
    const group = base.unresolved.find(item => item.candidateIds.includes(`cand:${blueId}`))!;
    const resolved = reconcileMilkServingScene({
      sceneId: "p1-witness-resolve",
      analysis: analysis([left, right, blue]),
      decisions: decisions(base, [
        { kind: "separate_servings", groupId: group.groupId, unitIds: group.candidateIds },
      ]),
    });
    expect(resolved.rejectedDecisions).toEqual([]);
    expect(resolved.summary.supportedServingCount).toBe(3);
    expect(confirmedPortionPlan(resolved)).toEqual([
      { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(resolved)).toBeCloseTo(WHOLE_400, 8);
    expect(dispositionOf(resolved, blueId).disposition).toBe("used_as_evidence");
  });
});

describe("P1-1 competing maximum cliques stay unresolved", () => {
  const left = milkRow("左邊玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
  const right = milkRow("右邊玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
  const front = wholeRow("前方藍色圓點玻璃杯裝全脂牛奶", 400);
  const back = milkRow("後方玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });

  it("does not confirm the 400 ml whole glass from one of two size-2 cliques", () => {
    const orders = permutations([left, right, front, back]);
    const views = orders.map(order => semanticDecisionView(scene("p1-cliques", order)));
    for (const view of views) expect(view).toEqual(views[0]);

    const result = scene("p1-cliques", [left, right, front, back]);
    expect(result.summary.confirmedServingCount).toBe(0);
    expect(kcal(result)).toBe(0);
    expect(result.confirmed.some(unit => unit.portion.max === 400)).toBe(false);
    expect(result.summary.reasonCodes).toContain("competing_maximum_cliques");
    const competing = result.unresolved.find(group => group.reasonCodes.includes("competing_maximum_cliques"))!;
    expect(competing.candidateIds).toHaveLength(4);
    const amounts = competing.amountAlternatives.map(item => item.max).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(amounts).toEqual([250, 400]);
    for (const row of [left, right, front, back]) {
      const disposition = dispositionOf(result, rowIdByNotes(result, row.notes!));
      expect(["alternative", "possible_excess"]).toContain(disposition.disposition);
      expect(proposalsFor(result, row.notes!).some(item => item.max === (row.portionMax ?? 0))).toBe(true);
    }
  });

  it("keeps an English left/right versus front/back scene unresolved too", () => {
    const rows = [
      milkRow("left glass of milk", 250, { preparationMethod: "玻璃杯" }),
      milkRow("right glass of milk", 250, { preparationMethod: "玻璃杯" }),
      wholeRow("front blue-dot glass of whole milk", 400),
      milkRow("back glass of milk", 250, { preparationMethod: "玻璃杯" }),
    ];
    const result = scene("p1-cliques-en", rows);
    expect(result.summary.confirmedServingCount).toBe(0);
    expect(kcal(result)).toBe(0);
    expect(result.summary.reasonCodes).toContain("competing_maximum_cliques");
  });
});

describe("P1-1 an unknown candidate is not promoted when the neighbourhood changes", () => {
  it("left whole 400 plus unbound 250 stays one serving after a distinct right glass arrives", () => {
    const left = wholeRow("左邊藍色圓點玻璃杯裝全脂牛奶", 400);
    const unbound = milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" });
    const right = wholeRow("右邊玻璃杯裝全脂牛奶", 250);
    const before = scene("p1-promote-a", [left, unbound]);
    const after = scene("p1-promote-a", [left, unbound, right]);
    expect(before.summary.supportedServingCount).toBe(1);
    expect(confirmedPortionPlan(before)).toEqual([
      { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(dispositionOf(before, rowIdByNotes(before, unbound.notes!)).disposition).toBe("possible_excess");

    expect(after.summary.supportedServingCount).toBe(2);
    expect(after.summary.confirmedServingCount).toBe(2);
    expect(kcal(after)).toBeCloseTo(WHOLE_250_AND_400, 8);
    const unboundAfter = dispositionOf(after, rowIdByNotes(after, unbound.notes!));
    expect(unboundAfter.disposition).toBe("possible_excess");
    expect(unboundAfter.slotIds).toEqual([]);
  });

  it("left whole 250 keeps its portion; the unanchored 400 is not confirmed when the right glass arrives", () => {
    const left = wholeRow("左邊玻璃杯裝全脂牛奶", 250);
    const unanchored = wholeRow("玻璃杯", 400);
    const right = wholeRow("右邊玻璃杯裝全脂牛奶", 250);
    const before = scene("p1-promote-b", [left, unanchored]);
    const after = scene("p1-promote-b", [left, unanchored, right]);
    expect(before.summary.supportedServingCount).toBe(1);
    expect(confirmedPortionPlan(before)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(before)).toBeCloseTo(WHOLE_250, 8);
    expect(before.unresolved.some(group =>
      group.kind === "exclusive_candidates"
      && group.amountAlternatives.some(item => item.max === 250)
      && group.amountAlternatives.some(item => item.max === 400))).toBe(false);
    expect(dispositionOf(before, rowIdByNotes(before, unanchored.notes!)).disposition).toBe("possible_excess");

    expect(after.summary.supportedServingCount).toBe(2);
    expect(kcal(after)).toBeCloseTo(TWO_WHOLE_250, 8);
    const unanchoredAfter = dispositionOf(after, rowIdByNotes(after, unanchored.notes!));
    expect(unanchoredAfter.disposition).toBe("possible_excess");
    expect(unanchoredAfter.slotIds).toEqual([]);
    expect(after.confirmed.some(unit => unit.portion.max === 400)).toBe(false);
  });

  it("an oat glass with no amount stays unresolved after a distinct oat carton is added", () => {
    const glass = oatRow("燕麥奶玻璃杯", 250, { preparationMethod: "玻璃杯" });
    const unknown = oatRow("燕麥奶玻璃杯", null, { preparationMethod: "玻璃杯" });
    const carton = oatRow("燕麥奶紙盒", 250);
    const before = scene("p1-promote-c", [glass, unknown]);
    const after = scene("p1-promote-c", [glass, unknown, carton]);
    const unknownBefore = before.rows.find(row => row.raw.portionMin === null)!;
    const unknownAfter = after.rows.find(row => row.raw.portionMin === null)!;
    expect(before.summary.supportedServingCount).toBe(1);
    expect(dispositionOf(before, unknownBefore.rowId).disposition).not.toBe("used_as_evidence");
    expect(after.summary.supportedServingCount).toBe(2);
    const afterDisposition = dispositionOf(after, unknownAfter.rowId);
    expect(afterDisposition.disposition).toBe("possible_excess");
    expect(afterDisposition.slotIds).toEqual([]);
    expect(after.summary.confirmedServingCount).toBe(0);
  });

  it("distinguishes a duplicate row from a count certificate", () => {
    const single = scene("p1-count-floor", [oatRow("燕麥奶紙盒", 250)]);
    const duplicate = scene("p1-count-floor", [oatRow("燕麥奶紙盒", 250), oatRow("燕麥奶紙盒", 250)]);
    const threeRows = [oatRow(), oatRow(), oatRow()];
    const ordinary = scene("p1-count-floor", threeRows);
    const certified = scene("p1-count-floor", threeRows, ["三盒燕麥奶"]);
    expect(single.summary.supportedServingCount).toBe(1);
    expect(duplicate.summary.supportedServingCount).toBe(1);
    expect(ordinary.summary.supportedServingCount).toBe(1);
    expect(certified.summary.supportedServingCount).toBe(3);
    expect(ordinary.summary.confirmedServingCount).toBe(0);
    expect(certified.summary.confirmedServingCount).toBe(0);
  });
});

describe("P1-2 physical anchors are not milk-family names", () => {
  it("same blue-dot cup 250 ml generic versus 400 ml whole stays an exclusive quantity conflict", () => {
    const generic = milkRow("藍色圓點玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
    const whole = wholeRow("同一藍色圓點玻璃杯裝全脂牛奶", 400);
    for (const order of [[generic, whole], [whole, generic]]) {
      const result = scene("p1-same-cup", order);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(result.summary.confirmedServingCount).toBe(0);
      expect(kcal(result)).toBe(0);
      const group = result.unresolved.find(item => item.kind === "exclusive_candidates")!;
      expect(group.reasonCodes).toContain("portion_identity_conflict");
      expect(group.amountAlternatives.map(item => item.max).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([250, 400]);
      expect(group.candidateIds).toHaveLength(2);
      expect(result.confirmed.some(unit => unit.portion.min === 250 && unit.portion.max === 400)).toBe(false);
      for (const row of result.rows) expect(dispositionOf(result, row.rowId).disposition).toBe("alternative");
    }
  });

  it("an anchored generic 400 ml glass is not replaced by an unbound whole 250 ml row", () => {
    const anchored = milkRow("左邊藍色圓點玻璃杯裝牛奶", 400, { preparationMethod: "玻璃杯" });
    const unbound = wholeRow("玻璃杯", 250);
    for (const order of [[anchored, unbound], [unbound, anchored]]) {
      const result = scene("p1-anchor-generic", order);
      const allocation = liveSlotsFor(result, anchored.notes!);
      expect(allocation).toHaveLength(1);
      expect(allocation[0].portion).toMatchObject({ state: "resolved", value: { min: 400, max: 400, unit: "ml" } });
      expect(allocation[0].family).toMatchObject({ state: "resolved", value: { family: "generic_milk" } });
      expect(result.summary.confirmedServingCount).toBe(0);
      expect(kcal(result)).toBe(0);
      expect(dispositionOf(result, rowIdByNotes(result, unbound.notes!)).disposition).toBe("possible_excess");
      const typed = reconcileMilkServingScene({
        sceneId: "p1-anchor-generic",
        analysis: analysis(order),
        decisions: decisions(result, [{ kind: "set_type", targetId: allocation[0].slotId, choice: "whole" }]),
      });
      expect(confirmedPortionPlan(typed)).toEqual([
        { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
      ]);
      expect(kcal(typed)).toBeCloseTo(WHOLE_400, 8);
    }
  });

  it("an anchored whole 400 ml glass is not blocked by an unbound soy 250 ml row", () => {
    const anchored = wholeRow("藍色圓點玻璃杯裝全脂牛奶", 400);
    const unbound = soyRow("玻璃杯", 250);
    const result = scene("p1-anchor-soy", [anchored, unbound]);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_400, 8);
    expect(dispositionOf(result, rowIdByNotes(result, unbound.notes!)).disposition).toBe("possible_excess");
    expect(result.unresolved.some(group =>
      group.kind === "exclusive_candidates" && group.reasonCodes.includes("family_ambiguity"))).toBe(false);
  });

  it("an anchored soy glass keeps 250 ml when an unbound whole row names a different family", () => {
    const anchored = soyRow("右邊星形貼紙杯裝豆漿", 250);
    const unbound = wholeRow("玻璃杯", 400);
    const result = scene("p1-anchor-soy-right", [unbound, anchored]);
    const allocation = liveSlotsFor(result, anchored.notes!);
    expect(allocation).toHaveLength(1);
    expect(allocation[0].portion).toMatchObject({ state: "resolved", value: { min: 250, max: 250 } });
    expect(allocation[0].family).toMatchObject({ state: "resolved", value: { family: "soy" } });
    expect(result.summary.confirmedServingCount).toBe(0);
    expect(dispositionOf(result, rowIdByNotes(result, unbound.notes!)).disposition).toBe("possible_excess");
    expect(kcal(result)).toBe(0);
  });

  it("several unbound generic rows do not move an anchored whole 400 ml serving", () => {
    const anchored = wholeRow("藍色圓點玻璃杯裝全脂牛奶", 400);
    const first = milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" });
    const second = milkRow("牛奶", 180);
    const result = scene("p1-anchor-generics", [second, anchored, first]);
    expect(result.summary.confirmedServingCount).toBe(1);
    expect(kcal(result)).toBeCloseTo(WHOLE_400, 8);
    expect(dispositionOf(result, rowIdByNotes(result, first.notes!)).disposition).toBe("possible_excess");
    expect(dispositionOf(result, rowIdByNotes(result, second.notes!)).disposition).toBe("possible_excess");
  });

  it("an unbound oat amount does not erase an anchored whole 400 ml serving", () => {
    const anchored = wholeRow("藍色圓點玻璃杯裝全脂牛奶", 400);
    const generic = milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" });
    const oat = oatRow("燕麥奶玻璃杯", 200, { preparationMethod: "玻璃杯" });
    const result = scene("p1-anchor-oat", [oat, generic, anchored]);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_400, 8);
    expect(dispositionOf(result, rowIdByNotes(result, oat.notes!)).disposition).toBe("possible_excess");
    expect(result.unresolved.some(group => group.reasonCodes.includes("family_ambiguity") && group.amountAlternatives.some(item => item.max === 200))).toBe(false);
  });
});

describe("P1-3 each amount keeps its own role inside one clause", () => {
  function run(notes: string, portion: number | null) {
    const row = wholeRow(notes, portion, { preparationMethod: "紙盒" });
    const result = scene(`p1-amount-${notes.length}`, [row]);
    return { row, result };
  }

  it("counts 250 ml drunk from a carton whose label says 1 L", () => {
    for (const notes of ["飲了250ml（包裝標示容量1L）", "飲咗250ml（包裝標示容量1L）", "250ml consumed from a carton labelled 1L"]) {
      const { row, result } = run(notes, 250);
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "package_capacity" && item.max === 1000)).toBe(true);
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "row_personal_estimate" && item.max === 250)).toBe(true);
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "package_capacity" && item.max === 250)).toBe(false);
      expect(confirmedPortionPlan(result)).toEqual([
        { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
      ]);
      expect(kcal(result)).toBeCloseTo(WHOLE_250, 8);
    }
  });

  it("reads 250 ml after the capacity phrase when the structured portion is absent", () => {
    const { row, result } = run("包裝標示容量1L的紙盒飲了250ml", null);
    expect(proposalsFor(result, row.notes!).some(item => item.purpose === "package_capacity" && item.max === 1000)).toBe(true);
    expect(proposalsFor(result, row.notes!).some(item => item.purpose === "row_personal_estimate" && item.max === 250)).toBe(true);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_250, 8);
  });

  it("keeps 180 ml poured into a drinking glass and drops the carton volume", () => {
    const cases: Array<[string, number | null]> = [
      ["容量1L紙盒倒了180ml到玻璃杯", null],
      ["包裝1L紙盒倒了180ml到玻璃杯", 180],
      ["1L紙盒倒咗180ml落玻璃杯", null],
      ["1L紙盒倒180ml到玻璃杯", null],
      ["1000ml紙盒倒了180ml到玻璃杯", null],
      ["包裝容量1000ml，實際飲用180ml", null],
    ];
    for (const [notes, portion] of cases) {
      const { row, result } = run(notes, portion);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "package_capacity" && item.max === 1000)).toBe(true);
      expect(proposalsFor(result, row.notes!).some(item =>
        (item.purpose === "transferred_amount" || item.purpose === "row_personal_estimate") && item.max === 180)).toBe(true);
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "row_personal_estimate" && item.max === 1000)).toBe(false);
      expect(confirmedPortionPlan(result)).toEqual([
        { profileId: "whole", min: 180, max: 180, unit: "ml", purpose: "personal", multiplicity: 1 },
      ]);
      expect(kcal(result)).toBeCloseTo(WHOLE_180, 8);
      expect(result.dispositions[0].disposition).not.toBe("unrelated");
    }
  });

  it("does not confirm milk poured into storage", () => {
    for (const notes of ["將250ml牛奶倒入空瓶儲存", "poured 250ml into an empty bottle for storage"]) {
      const { row, result } = run(notes, null);
      expect(result.summary.confirmedServingCount).toBe(0);
      expect(result.summary.supportedServingCount).toBe(0);
      expect(kcal(result)).toBe(0);
      expect(result.dispositions[0].disposition).toBe("unrelated");
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "stock_amount" && item.max === 250)).toBe(true);
      expect(proposalsFor(result, row.notes!).some(item => item.purpose === "row_personal_estimate" && item.max === 250)).toBe(false);
    }
  });

  it("leaves an uncertain pour destination pending", () => {
    const { row, result } = run("1L紙盒倒了180ml", null);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.summary.confirmedServingCount).toBe(0);
    expect(kcal(result)).toBe(0);
    expect(result.supportedSlots[0].status).toBe("pending");
    expect(result.dispositions[0].disposition).not.toBe("unrelated");
    expect(proposalsFor(result, row.notes!).some(item => item.purpose === "unknown" && item.max === 180)).toBe(true);
    expect(proposalsFor(result, row.notes!).some(item => item.purpose === "package_capacity" && item.max === 1000)).toBe(true);
  });

  it("still confirms a plain structured 250 ml whole-milk glass", () => {
    const row = wholeRow("玻璃杯裝全脂牛奶", 250);
    const result = scene("p1-amount-plain", [row]);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_250, 8);
  });
});

describe("P1-4 exclusive groups and family conflicts have one decision boundary", () => {
  const rows = [
    wholeRow("白色飲品", 250, { preparationMethod: undefined }),
    wholeRow("白色飲品", 400, { preparationMethod: undefined }),
  ];

  function boundary() {
    const base = scene("p1-boundary", rows);
    const exclusive = base.unresolved.find(group => group.kind === "exclusive_candidates")!;
    const overflow = base.unresolved.find(group => group.kind === "possible_excess")!;
    return { base, exclusive, overflow };
  }

  it("rejects set_type and set_portion as ways to close a 250/400 exclusive group", () => {
    const { base, exclusive } = boundary();
    const typed = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: decisions(base, [{ kind: "set_type", targetId: exclusive.slotIds[0], choice: "whole" }]),
    });
    expect(typed.summary.confirmedServingCount).toBe(0);
    expect(typed.unresolved.some(group => group.kind === "exclusive_candidates")).toBe(true);
    expect(kcal(typed)).toBe(0);

    const portioned = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: decisions(base, [
        { kind: "set_portion", unitId: exclusive.slotIds[0], portion: { min: 250, max: 250, unit: "ml" } },
      ]),
    });
    expect(portioned.rejectedDecisions.map(item => item.reason)).toEqual(["exclusive_group_requires_explicit_resolution"]);
    expect(portioned.summary.confirmedServingCount).toBe(0);
    expect(portioned.unresolved.some(group => group.groupId === exclusive.groupId)).toBe(true);
  });

  it("does not admit 650 ml when separate_servings targets the overflow alias", () => {
    const { base, exclusive, overflow } = boundary();
    expect(overflow.candidateIds).toEqual(exclusive.candidateIds);
    const viaOverflow = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: decisions(base, [
        { kind: "separate_servings", groupId: overflow.groupId, unitIds: overflow.candidateIds },
      ]),
    });
    expect(viaOverflow.rejectedDecisions).toEqual([]);
    expect(viaOverflow.summary.confirmedServingCount).toBe(0);
    expect(kcal(viaOverflow)).toBe(0);
    expect(viaOverflow.confirmed).toEqual([]);
    const pending = viaOverflow.supportedSlots.filter(slot => slot.status === "pending" && slot.basis === "user_declared");
    expect(pending).toHaveLength(2);
    expect(pending.every(slot => slot.pendingReasons.includes("user_portion_confirmation_required"))).toBe(true);

    const finished = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: decisions(base, [
        { kind: "separate_servings", groupId: overflow.groupId, unitIds: overflow.candidateIds },
        ...pending.map(slot => {
          const rowId = slot.sourceCandidateIds[0].slice("cand:".length);
          const amount = viaOverflow.rows.find(row => row.rowId === rowId)!.raw.portionMin!;
          return { kind: "set_portion" as const, unitId: slot.slotId, portion: { min: amount, max: amount, unit: "ml" as const } };
        }),
      ]),
    });
    expect(finished.rejectedDecisions).toEqual([]);
    expect(finished.summary.confirmedServingCount).toBe(2);
    expect(kcal(finished)).toBeCloseTo(WHOLE_250_AND_400, 8);
  });

  it("treats a replay of the overflow command as a no-op and a changed payload as a conflict", () => {
    const { base, overflow } = boundary();
    const once = decisions(base, [
      { kind: "separate_servings", groupId: overflow.groupId, unitIds: overflow.candidateIds },
    ]);
    const replay = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: [...once, once[0]],
    });
    expect(replay.rejectedDecisions).toEqual([]);
    expect(replay.decisionRevision).toBe(1);
    expect(kcal(replay)).toBe(0);

    const conflict = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: [...once, { ...once[0], command: { kind: "dismiss_group", groupId: overflow.groupId } }],
    });
    expect(conflict.rejectedDecisions).toEqual([{ decisionId: once[0].decisionId, reason: "decision_id_conflict" }]);
    expect(conflict.decisionRevision).toBe(1);
    expect(kcal(conflict)).toBe(0);
  });

  it("rejects a mismatched overflow target without changing the exclusive group", () => {
    const { base, exclusive, overflow } = boundary();
    const rejected = reconcileMilkServingScene({
      sceneId: "p1-boundary",
      analysis: analysis(rows),
      decisions: decisions(base, [
        { kind: "separate_servings", groupId: overflow.groupId, unitIds: ["cand:wrong"] },
      ]),
    });
    expect(rejected.rejectedDecisions).toEqual([{ decisionId: "d-0", reason: "target_mismatch" }]);
    expect(rejected.decisionRevision).toBe(0);
    expect(rejected.unresolved.some(group => group.groupId === exclusive.groupId)).toBe(true);
    expect(kcal(rejected)).toBe(0);
  });

  it("completes a family conflict when one_serving is followed by the chosen type", () => {
    const familyRows = [
      milkRow("有星形貼紙的杯", 250, { displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "玻璃杯" }),
      wholeRow("有星形貼紙的同一杯", 250),
    ];
    const base = scene("p1-family", familyRows);
    const group = base.unresolved.find(item => item.kind === "family_conflict")!;
    const slot = base.supportedSlots.find(item => item.status !== "dismissed")!;
    expect(base.summary.supportedServingCount).toBe(1);
    expect(base.summary.confirmedServingCount).toBe(0);
    expect(slot.family.state).toBe("conflict");

    const typeOnly = reconcileMilkServingScene({
      sceneId: "p1-family",
      analysis: analysis(familyRows),
      decisions: decisions(base, [{ kind: "set_type", targetId: slot.slotId, choice: "soy" }]),
    });
    expect(typeOnly.rejectedDecisions).toEqual([{ decisionId: "d-0", reason: "family_conflict_unresolved" }]);
    expect(typeOnly.summary.confirmedServingCount).toBe(0);
    expect(typeOnly.supportedSlots.find(item => item.slotId === slot.slotId)?.family.state).toBe("conflict");

    const resolved = reconcileMilkServingScene({
      sceneId: "p1-family",
      analysis: analysis(familyRows),
      decisions: decisions(base, [
        { kind: "one_serving", groupId: group.groupId, portion: { min: 250, max: 250, unit: "ml" } },
        { kind: "set_type", targetId: slot.slotId, choice: "soy" },
      ]),
    });
    expect(resolved.rejectedDecisions).toEqual([]);
    expect(resolved.acceptedDecisions.map(item => item.command.kind)).toEqual(["one_serving", "set_type"]);
    expect(resolved.summary.confirmedServingCount).toBe(1);
    expect(resolved.summary.unresolvedGroupCount).toBe(0);
    expect(confirmedPortionPlan(resolved)).toEqual([
      { profileId: "soy", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(resolved)).toBeCloseTo(SOY_250, 8);
    const slotAfter = resolved.supportedSlots.find(item => item.slotId === slot.slotId)!;
    expect(slotAfter.status).toBe("confirmed");
    expect(slotAfter.pendingReasons).not.toContain("family_conflict");

    const reversed = reconcileMilkServingScene({
      sceneId: "p1-family",
      analysis: analysis(familyRows),
      decisions: decisions(base, [
        { kind: "set_type", targetId: slot.slotId, choice: "soy" },
        { kind: "one_serving", groupId: group.groupId, portion: { min: 250, max: 250, unit: "ml" } },
      ]),
    });
    expect(reversed.rejectedDecisions.map(item => item.reason)).toEqual([
      "family_conflict_unresolved",
      "stale_decision_revision",
    ]);
    expect(reversed.summary.confirmedServingCount).toBe(0);
    expect(reversed.supportedSlots.find(item => item.slotId === slot.slotId)?.pendingReasons).toContain("family_conflict");
  });
});

describe("P2-1 source digest includes decision-relevant claim semantics", () => {
  function observed(id: string): ObservedFoodRow {
    return {
      rowId: id,
      sceneId: "digest",
      originalIndex: id === "o1" ? 0 : 1,
      semanticKey: "k-oat",
      raw: oatRow("燕麥奶紙盒", 250),
      subject: { milkCandidate: true, exclusionReason: null },
    };
  }

  function claims(refusal: string, contradicts: string[] = []): EvidenceClaim[] {
    const rowClaims = ["o1", "o2"].flatMap(id => ([
      {
        claimId: `pres-${id}`,
        source: { sceneId: "digest", rowId: id, field: "displayName" as const, span: [0, 1] as const, origin: "model_reported" as const, grammarRule: "r", grammarVersion: "milk-serving-grammar-1" },
        body: { predicate: "presence" as const, subject: { kind: "entity" as const, entityId: `ent:${id}` }, content: "milk" as const },
        polarity: "affirmative" as const, scopeId: "scene", usableFor: ["existence" as const], refusalReasons: [], contradictsClaimIds: [],
      },
      {
        claimId: `ves-${id}`,
        source: { sceneId: "digest", rowId: id, field: "preparationMethod" as const, span: [0, 1] as const, origin: "model_reported" as const, grammarRule: "r", grammarVersion: "milk-serving-grammar-1" },
        body: { predicate: "vessel" as const, subject: { kind: "entity" as const, entityId: `ent:${id}` }, vessel: "carton" as const },
        polarity: "affirmative" as const, scopeId: "scene", usableFor: ["existence" as const], refusalReasons: [], contradictsClaimIds: [],
      },
      {
        claimId: `fam-${id}`,
        source: { sceneId: "digest", rowId: id, field: "displayName" as const, span: [0, 1] as const, origin: "model_reported" as const, grammarRule: "r", grammarVersion: "milk-serving-grammar-1" },
        body: { predicate: "family" as const, subject: { kind: "entity" as const, entityId: `ent:${id}` }, family: "oat" as const, qualifier: null },
        polarity: "affirmative" as const, scopeId: "scene", usableFor: ["family" as const], refusalReasons: [], contradictsClaimIds: [],
      },
    ]));
    return [
      ...rowClaims,
      {
        claimId: "cnt-2",
        source: { sceneId: "digest", field: "visibleEvidence" as const, span: [0, 1] as const, origin: "model_reported" as const, grammarRule: "r", grammarVersion: "milk-serving-grammar-1" },
        body: { predicate: "cardinality" as const, population: { kind: "population" as const, scopeId: "pop:oat:carton", family: "oat" as const, vessel: "carton" as const }, relation: "exact" as const, count: 2 },
        polarity: "affirmative" as const, scopeId: "scene", usableFor: ["count" as const], refusalReasons: [], contradictsClaimIds: [],
      },
      {
        claimId: "cnt-4-refused",
        source: { sceneId: "digest", field: "visibleEvidence" as const, span: [0, 1] as const, origin: "model_reported" as const, grammarRule: "r", grammarVersion: "milk-serving-grammar-1" },
        body: { predicate: "cardinality" as const, population: { kind: "population" as const, scopeId: "pop:oat:carton", family: "oat" as const, vessel: "carton" as const }, relation: "exact" as const, count: 4 },
        polarity: "questioned" as const, scopeId: "scene", usableFor: [], refusalReasons: [refusal], contradictsClaimIds: contradicts,
      },
    ];
  }

  it("changes the digest when a refusal reason changes the cardinality decision", () => {
    const rows = [observed("o1"), observed("o2")];
    const quoted = reconcileServingEvidence({ sceneId: "digest", rows, claims: claims("quoted_text") });
    const barrier = reconcileServingEvidence({ sceneId: "digest", rows, claims: claims("questioned_scope") });
    expect(quoted.summary.supportedServingCount).toBe(2);
    expect(quoted.summary.cardinalityReviewRequired).toBe(false);
    expect(barrier.summary.supportedServingCount).toBe(1);
    expect(barrier.summary.cardinalityReviewRequired).toBe(true);
    expect(quoted.sourceDigest).not.toBe(barrier.sourceDigest);
  });

  it("keeps the digest stable across claim, row and reason permutations", () => {
    const forward = reconcileServingEvidence({
      sceneId: "digest",
      rows: [observed("o1"), observed("o2")],
      claims: claims("quoted_text", ["cnt-2"]),
    });
    const reversed = reconcileServingEvidence({
      sceneId: "digest",
      rows: [observed("o2"), observed("o1")].map((row, index) => ({ ...row, originalIndex: index })),
      claims: [...claims("quoted_text", ["cnt-2"])].reverse().map(claim => ({
        ...claim,
        refusalReasons: [...claim.refusalReasons].reverse(),
        contradictsClaimIds: [...claim.contradictsClaimIds].reverse(),
        usableFor: [...claim.usableFor].reverse(),
      })),
    });
    expect(reversed.sourceDigest).toBe(forward.sourceDigest);
    expect(canonicalJson(semanticDecisionView(reversed))).toBe(canonicalJson(semanticDecisionView(forward)));
  });

  it("changes the digest when contradictsClaimIds changes and the decision does not", () => {
    const rows = [observed("o1"), observed("o2")];
    const plain = reconcileServingEvidence({ sceneId: "digest", rows, claims: claims("quoted_text") });
    const linked = reconcileServingEvidence({ sceneId: "digest", rows, claims: claims("quoted_text", ["cnt-2"]) });
    expect(plain.summary.supportedServingCount).toBe(linked.summary.supportedServingCount);
    expect(plain.sourceDigest).not.toBe(linked.sourceDigest);
  });
});

describe("P2-2 strict reconciliation schema", () => {
  function valid(): ServingReconciliation {
    return scene("p2-schema", [wholeRow("玻璃杯裝全脂牛奶", 250)]);
  }

  it("accepts a live engine result and rejects corrupted relationships", () => {
    const base = valid();
    expect(servingReconciliationSchema.safeParse(base).success).toBe(true);

    const profileMismatch = structuredClone(base);
    profileMismatch.supportedSlots[0].profile = { state: "resolved", value: "soy", proofIds: [] };
    profileMismatch.confirmed[0].profileId = "low-fat";
    profileMismatch.confirmed[0].milkTypeChoice = "other";
    expect(servingReconciliationSchema.safeParse(profileMismatch).success).toBe(false);

    const familyConflict = structuredClone(base);
    familyConflict.supportedSlots[0].family = {
      state: "conflict",
      alternatives: [{ family: "soy", qualifier: null }, { family: "dairy", qualifier: "whole" }],
      claimIds: [base.claims[0].claimId],
    };
    expect(servingReconciliationSchema.safeParse(familyConflict).success).toBe(false);

    const dangling = structuredClone(base);
    dangling.candidates[0].possibleSameAs = ["cand:nonexistent"];
    dangling.supportedSlots[0].proofIds = ["clm:nonexistent"];
    dangling.confirmed[0].proofIds = ["clm:nonexistent"];
    expect(servingReconciliationSchema.safeParse(dangling).success).toBe(false);

    const stale = structuredClone(base);
    stale.decisionRevision = 1;
    stale.acceptedDecisions = [{
      decisionId: "d-stale",
      sourceDigest: "stale-other-digest",
      expectedDecisionRevision: 0,
      command: { kind: "set_type", targetId: base.supportedSlots[0].slotId, choice: "whole" },
    }];
    expect(servingReconciliationSchema.safeParse(stale).success).toBe(false);

    const portionDrift = structuredClone(base);
    portionDrift.confirmed[0].portion = { ...portionDrift.confirmed[0].portion, min: 400, max: 400 };
    expect(servingReconciliationSchema.safeParse(portionDrift).success).toBe(false);

    const multiplicityDrift = structuredClone(base);
    multiplicityDrift.confirmed[0].multiplicity = 2;
    expect(servingReconciliationSchema.safeParse(multiplicityDrift).success).toBe(false);

    const summaryDrift = structuredClone(base);
    summaryDrift.summary = { ...summaryDrift.summary, confirmedServingCount: 4, pendingSlotCount: 3 };
    expect(servingReconciliationSchema.safeParse(summaryDrift).success).toBe(false);

    const danglingGroup = structuredClone(base);
    danglingGroup.unresolved = [{
      groupId: "grp:possible_excess:missing",
      kind: "possible_excess",
      candidateIds: ["cand:missing"],
      slotIds: ["slot:missing"],
      possibleTargetSlotIds: [],
      amountAlternatives: [],
      excludedProposalIds: ["qty:missing"],
      supportedCount: 0,
      possibleExtraSlots: 1,
      selectedCandidateId: null,
      reasonCodes: ["unknown_possible_reference"],
    }];
    danglingGroup.summary = { ...danglingGroup.summary, unresolvedGroupCount: 1 };
    expect(servingReconciliationSchema.safeParse(danglingGroup).success).toBe(false);
  });
});
