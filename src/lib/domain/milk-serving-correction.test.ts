import { describe, expect, it } from "vitest";
import {
  confirmedPortionPlan,
  rowEntityId,
  servingReconciliationSchema,
  type EvidenceClaim,
  type ObservedFoodRow,
  type ServingReconciliation,
} from "@/lib/domain/milk-serving-contract";
import { reconcileMilkServingScene, reconcileServingEvidence } from "@/lib/domain/milk-serving-reconciliation";
import {
  analysis,
  decisions,
  dispositionOf,
  milkRow,
  oatRow,
  permutations,
  referenceTotals,
  rowIdByNotes,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";

/**
 * Permanent regressions for the independent Phase 1 contract review.
 * Expected portions and kcal are hand-written from the approved reference
 * vectors. They are not copied from the engine output.
 */

const scene = (sceneId: string, rows: Parameters<typeof analysis>[0], evidence: string[] = []) =>
  reconcileMilkServingScene({ sceneId, analysis: analysis(rows, evidence) });

function slotsFor(result: ServingReconciliation, notes: string) {
  const id = rowIdByNotes(result, notes);
  return result.supportedSlots.filter(slot =>
    slot.status !== "dismissed" && slot.sourceCandidateIds.includes(`cand:${id}`));
}

function proposalsFor(result: ServingReconciliation, notes: string) {
  const id = rowIdByNotes(result, notes);
  const candidate = result.candidates.find(item => item.candidateId === `cand:${id}`);
  return (candidate?.quantityProposals ?? []).map(item => ({
    min: item.min, max: item.max, unit: item.unit, purpose: item.purpose,
  }));
}

function kcal(result: ServingReconciliation): number {
  return referenceTotals(confirmedPortionPlan(result)).max.kcal;
}

const WHOLE_250 = 157.075;
const WHOLE_400 = 251.32;
const WHOLE_180 = 113.094;

describe("A1 direct witnesses survive maximum-clique selection", () => {
  const left = milkRow("左邊玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
  const right = milkRow("右邊玻璃杯裝牛奶", 250, { preparationMethod: "玻璃杯" });
  const blue = wholeRow("藍色圓點玻璃杯裝全脂牛奶", 400);

  it("keeps the 400 ml blue-dot allocation and does not rewrite it as 250 ml", () => {
    for (const order of permutations([left, right, blue])) {
      const result = scene("a1", order);
      const allocation = slotsFor(result, blue.notes!);
      expect(allocation).toHaveLength(1);
      expect(allocation[0].portion).toMatchObject({ state: "resolved", value: { min: 400, max: 400, unit: "ml", purpose: "personal" } });
      expect(allocation[0].pendingReasons).toContain("distinctness_unresolved");
      expect(allocation[0].status).toBe("pending");
      expect(dispositionOf(result, rowIdByNotes(result, blue.notes!)).disposition).toBe("used_as_evidence");
      expect(proposalsFor(result, blue.notes!).some(item => item.purpose === "row_personal_estimate" && item.max === 400)).toBe(true);
      expect(proposalsFor(result, blue.notes!).some(item => item.max === 250)).toBe(false);
      expect(result.confirmed.some(unit => unit.portion.max === 250 && unit.slotIds.includes(allocation[0].slotId))).toBe(false);
      expect(result.confirmed).toHaveLength(0);
      expect(slotsFor(result, left.notes!)[0].portion).toMatchObject({ state: "resolved", value: { min: 250, max: 250 } });
      expect(slotsFor(result, right.notes!)[0].portion).toMatchObject({ state: "resolved", value: { min: 250, max: 250 } });
    }
  });
});

describe("A2 unbound generic glass does not contaminate an anchored portion", () => {
  const anchored = wholeRow("藍色圓點玻璃杯裝全脂牛奶", 400);
  const unbound = milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" });

  it("keeps 400 ml resolved and records an explicit unknown reference for 250 ml", () => {
    for (const order of [ [anchored, unbound], [unbound, anchored] ]) {
      const result = scene("a2", order);
      const allocation = slotsFor(result, anchored.notes!);
      expect(allocation).toHaveLength(1);
      expect(allocation[0].portion).toMatchObject({ state: "resolved", value: { min: 400, max: 400, unit: "ml" } });
      expect(allocation[0].status).toBe("confirmed");
      expect(confirmedPortionPlan(result)).toEqual([
        { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
      ]);
      expect(kcal(result)).toBeCloseTo(WHOLE_400, 8);
      expect(result.unresolved.some(group =>
        group.kind === "exclusive_candidates"
        && group.amountAlternatives.some(item => item.max === 250)
        && group.amountAlternatives.some(item => item.max === 400))).toBe(false);
      const unboundDisposition = dispositionOf(result, rowIdByNotes(result, unbound.notes!));
      expect(unboundDisposition.disposition).toBe("possible_excess");
      expect(unboundDisposition.reasonCodes).toContain("unknown_possible_reference");
      expect(proposalsFor(result, unbound.notes!).some(item => item.max === 250)).toBe(true);
      expect(result.confirmed).toHaveLength(1);
    }
  });
});

describe("A3 a rejected nearby count does not change the row portion basis", () => {
  it("燕麥奶紙盒，旁邊兩杯椰奶 keeps the structured 250 ml personal portion", () => {
    const carton = oatRow("燕麥奶紙盒，旁邊兩杯椰奶", 250);
    const result = scene("a3", [carton]);
    const allocation = slotsFor(result, carton.notes!);
    expect(allocation).toHaveLength(1);
    expect(allocation[0].portion).toMatchObject({
      state: "resolved", value: { min: 250, max: 250, unit: "ml", purpose: "personal" },
    });
    expect(allocation[0].pendingReasons).not.toContain("quantity_basis_unknown");
    expect(allocation[0].pendingReasons).toContain("type_confirmation_required");
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.some(group => group.kind === "unbound_object" && group.reasonCodes.includes("nearby_object_without_binding"))).toBe(true);
    expect(result.summary.confirmedServingCount).toBe(0);
  });
});

describe("A4 an added distinct serving does not confirm an ambiguous candidate", () => {
  const unknown = oatRow("白色飲品", 250, { preparationMethod: undefined });

  it("carton + unknown + glass, every order and both families", () => {
    const scenes = [
      [oatRow("燕麥奶紙盒"), unknown, oatRow("獨立玻璃杯燕麥奶", 250, { preparationMethod: "玻璃杯" })],
      [wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" }), wholeRow("白色飲品", 250, { preparationMethod: undefined }), wholeRow("獨立玻璃杯全脂牛奶", 250)],
    ] as const;
    for (const rows of scenes) {
      for (const order of permutations([...rows])) {
        const result = scene("a4", order);
        const unknownDisposition = dispositionOf(result, rowIdByNotes(result, "白色飲品"));
        expect(unknownDisposition.disposition).toBe("possible_excess");
        expect(result.confirmed.some(unit => unit.slotIds.some(slotId => unknownDisposition.slotIds.includes(slotId)))).toBe(false);
        expect(unknownDisposition.slotIds).toEqual([]);
      }
    }
  });

  it("identical-vessel observations stay one existence allocation when distinctness is absent", () => {
    const rows = [
      oatRow("燕麥奶玻璃杯", 200, { preparationMethod: "玻璃杯" }),
      oatRow("燕麥奶玻璃杯", 500, { preparationMethod: "玻璃杯" }),
      oatRow("白色飲品", 900, { preparationMethod: undefined }),
    ];
    const result = scene("a4-same-vessel", rows);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.confirmed).toHaveLength(0);
    expect(dispositionOf(result, rowIdByNotes(result, "白色飲品")).disposition).toBe("possible_excess");
    const amounts = result.unresolved.flatMap(group => group.amountAlternatives.map(item => item.max)).sort();
    expect(amounts).toEqual([200, 500]);
    expect(result.confirmed.some(unit => unit.portion.min === 350)).toBe(false);
  });
});

describe("B1 package capacity is not consumed quantity", () => {
  it("structured 1000 ml copied from a 1 L capacity statement is not confirmed", () => {
    const row = wholeRow("包裝標示容量1L", 1000, { preparationMethod: "紙盒" });
    const result = scene("b1", [row]);
    expect(result.confirmed).toHaveLength(0);
    expect(proposalsFor(result, row.notes!).some(item => item.purpose === "package_capacity" && item.max === 1000)).toBe(true);
    expect(proposalsFor(result, row.notes!).some(item => item.purpose === "row_personal_estimate" && item.max === 1000)).toBe(false);
    expect(kcal(result)).toBe(0);
  });

  it("a different personal amount still counts when the package is 1 L", () => {
    const row = wholeRow("包裝標示容量1L，杯中約250ml", 250, { preparationMethod: "紙盒" });
    const result = scene("b1-personal", [row]);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_250, 8);
  });

  it("a user-declared 1000 ml intake is accepted even though it matches package capacity", () => {
    const row = wholeRow("包裝標示容量1L", null, { preparationMethod: "紙盒" });
    const base = scene("b1-user", [row]);
    const slot = slotsFor(base, row.notes!)[0];
    const result = reconcileMilkServingScene({
      sceneId: "b1-user",
      analysis: analysis([row]),
      decisions: decisions(base, [
        { kind: "set_portion", unitId: slot.slotId, portion: { min: 1000, max: 1000, unit: "ml" } },
      ]),
    });
    expect(result.rejectedDecisions).toEqual([]);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 1000, max: 1000, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(result.confirmed[0].portion.origin).toBe("user_amount");
    expect(result.confirmed[0].confirmation).toBe("user_declared");
  });
});

describe("B2 one row can describe a pour without counting the stock carton", () => {
  const poured = milkRow("1L紙盒倒了180ml到玻璃杯", null, {
    displayName: "全脂牛奶",
    normalizedName: "whole milk",
    preparationMethod: "紙盒",
  });

  it("extracts 180 ml and does not confirm 1000 ml or two servings", () => {
    const result = scene("b2", [poured]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 180, max: 180, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_180, 8);
    expect(result.confirmed.some(unit => unit.portion.max === 1000)).toBe(false);
    expect(proposalsFor(result, poured.notes!).some(item => item.purpose === "package_capacity" && item.max === 1000)).toBe(true);
  });
});

describe("B3 model plant-milk and low-fat names require the existing type gate", () => {
  it("oat, soy and low-fat are not evidence-admitted from the model name", () => {
    const oat = scene("b3-oat", [oatRow("燕麥奶紙盒", 250)]);
    const soy = scene("b3-soy", [milkRow("豆漿玻璃杯", 250, { displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "玻璃杯" })]);
    const low = scene("b3-low", [milkRow("低脂牛奶玻璃杯", 250, { displayName: "低脂牛奶", normalizedName: "low-fat milk", preparationMethod: "玻璃杯" })]);
    const whole = scene("b3-whole", [wholeRow("玻璃杯裝全脂牛奶", 250)]);
    expect(oat.confirmed).toHaveLength(0);
    expect(slotsFor(oat, "燕麥奶紙盒")[0].pendingReasons).toContain("type_confirmation_required");
    expect(soy.confirmed).toHaveLength(0);
    expect(slotsFor(soy, "豆漿玻璃杯")[0].pendingReasons).toContain("type_confirmation_required");
    expect(low.confirmed).toHaveLength(0);
    expect(slotsFor(low, "低脂牛奶玻璃杯")[0].pendingReasons).toContain("profile_unavailable");
    expect(confirmedPortionPlan(whole)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(whole)).toBeCloseTo(WHOLE_250, 8);
  });

  it("set_type oat confirms the portion without resolving a second ambiguous row", () => {
    const carton = oatRow("燕麥奶紙盒");
    const unknown = oatRow("白色飲品", 250, { preparationMethod: undefined });
    const base = scene("b3-choice", [carton, unknown]);
    expect(base.confirmed).toHaveLength(0);
    expect(dispositionOf(base, rowIdByNotes(base, unknown.notes!)).disposition).toBe("possible_excess");
    const chosen = reconcileMilkServingScene({
      sceneId: "b3-choice",
      analysis: analysis([carton, unknown]),
      decisions: decisions(base, [{ kind: "set_type", targetId: slotsFor(base, carton.notes!)[0].slotId, choice: "oat" }]),
    });
    expect(confirmedPortionPlan(chosen)).toEqual([
      { profileId: "oat", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(dispositionOf(chosen, rowIdByNotes(chosen, unknown.notes!)).disposition).toBe("possible_excess");
    expect(chosen.summary.supportedServingCount).toBe(1);
  });

  it("low-fat remains unavailable after an explicit user choice", () => {
    const row = milkRow("低脂牛奶", 250, { displayName: "低脂牛奶", normalizedName: "low-fat milk", preparationMethod: "玻璃杯" });
    const base = scene("b3-low-user", [row]);
    const result = reconcileMilkServingScene({
      sceneId: "b3-low-user",
      analysis: analysis([row]),
      decisions: decisions(base, [{ kind: "set_type", targetId: slotsFor(base, row.notes!)[0].slotId, choice: "low-fat" }]),
    });
    expect(result.rejectedDecisions).toEqual([]);
    expect(result.confirmed).toHaveLength(0);
    expect(slotsFor(result, row.notes!)[0].pendingReasons).toContain("profile_unavailable");
  });
});

describe("B4 source digest covers claim semantics", () => {
  const typedRow = (): ObservedFoodRow => ({
    rowId: "r1",
    sceneId: "typed",
    originalIndex: 0,
    semanticKey: "k",
    raw: milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" }),
    subject: { milkCandidate: true, exclusionReason: null },
  });

  function claim(ml: number): EvidenceClaim {
    return {
      claimId: "c-fixed",
      source: {
        sceneId: "typed", rowId: "r1", field: "portion", span: [0, 1], origin: "model_reported",
        grammarRule: "typed", grammarVersion: "milk-serving-grammar-1",
      },
      body: {
        predicate: "quantity",
        proposal: {
          proposalId: "p1", target: { kind: "entity", entityId: rowEntityId("r1") },
          min: ml, max: ml, unit: "ml", purpose: "row_personal_estimate", claimIds: ["c-fixed"],
        },
      },
      polarity: "affirmative",
      scopeId: "scene",
      usableFor: ["portion"],
      refusalReasons: [],
      contradictsClaimIds: [],
    };
  }

  const presence = (): EvidenceClaim => ({
    claimId: "c-pres",
    source: { sceneId: "typed", rowId: "r1", field: "displayName", span: [0, 1], origin: "model_reported", grammarRule: "typed", grammarVersion: "milk-serving-grammar-1" },
    body: { predicate: "presence", subject: { kind: "entity", entityId: rowEntityId("r1") }, content: "milk" },
    polarity: "affirmative", scopeId: "scene", usableFor: ["existence"], refusalReasons: [], contradictsClaimIds: [],
  });
  const vessel = (): EvidenceClaim => ({
    claimId: "c-ves",
    source: { sceneId: "typed", rowId: "r1", field: "preparationMethod", span: [0, 1], origin: "model_reported", grammarRule: "typed", grammarVersion: "milk-serving-grammar-1" },
    body: { predicate: "vessel", subject: { kind: "entity", entityId: rowEntityId("r1") }, vessel: "glass" },
    polarity: "affirmative", scopeId: "scene", usableFor: ["existence"], refusalReasons: [], contradictsClaimIds: [],
  });
  const family = (): EvidenceClaim => ({
    claimId: "c-fam",
    source: { sceneId: "typed", rowId: "r1", field: "displayName", span: [0, 1], origin: "model_reported", grammarRule: "typed", grammarVersion: "milk-serving-grammar-1" },
    body: { predicate: "family", subject: { kind: "entity", entityId: rowEntityId("r1") }, family: "dairy", qualifier: "whole" },
    polarity: "affirmative", scopeId: "scene", usableFor: ["family"], refusalReasons: [], contradictsClaimIds: [],
  });

  it("reusing a claim id with 400 ml instead of 250 ml changes the digest and rejects the old decision", () => {
    const row250 = typedRow();
    const first = reconcileServingEvidence({ sceneId: "typed", rows: [row250], claims: [presence(), vessel(), family(), claim(250)] });
    const second = reconcileServingEvidence({ sceneId: "typed", rows: [typedRow()], claims: [presence(), vessel(), family(), claim(400)] });
    expect(first.sourceDigest).not.toBe(second.sourceDigest);
    expect(confirmedPortionPlan(first)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(confirmedPortionPlan(second)).toEqual([
      { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    const stale = reconcileServingEvidence({
      sceneId: "typed",
      rows: [typedRow()],
      claims: [presence(), vessel(), family(), claim(400)],
      decisions: [{
        decisionId: "old",
        sourceDigest: first.sourceDigest,
        expectedDecisionRevision: 0,
        command: { kind: "dismiss_group", groupId: "grp:missing" },
      }],
    });
    expect(stale.rejectedDecisions).toEqual([{ decisionId: "old", reason: "stale_source_digest" }]);
    expect(confirmedPortionPlan(stale)).toEqual(confirmedPortionPlan(second));
  });
});

describe("B5 exported schema rejects broken confirmed projections", () => {
  function valid(): ServingReconciliation {
    const portion = { min: 250, max: 250, unit: "ml" as const, origin: "single_anchored_estimate" as const, purpose: "personal" as const, proofIds: ["c1"] };
    return {
      contractVersion: 1,
      engineVersion: "milk-serving-engine-1",
      grammarVersion: "milk-serving-grammar-1",
      sceneId: "s",
      sourceDigest: "d",
      decisionRevision: 0,
      rows: [{ rowId: "r1", sceneId: "s", originalIndex: 0, semanticKey: "k1", raw: milkRow("a"), subject: { milkCandidate: true, exclusionReason: null } }],
      claims: [{
        claimId: "c1",
        source: { sceneId: "s", rowId: "r1", field: "notes", span: [0, 1], origin: "model_reported", grammarRule: "g", grammarVersion: "milk-serving-grammar-1" },
        body: { predicate: "presence", subject: { kind: "entity", entityId: rowEntityId("r1") }, content: "milk" },
        polarity: "affirmative", scopeId: "scene", usableFor: ["existence"], refusalReasons: [], contradictsClaimIds: [],
      }],
      candidates: [{
        candidateId: "cand:r1", referent: { kind: "entity", entityId: rowEntityId("r1") }, rowIds: ["r1"],
        existence: { state: "resolved", value: "present", proofIds: ["c1"] },
        family: { state: "unknown", claimIds: [] }, vessel: { state: "unknown", claimIds: [] },
        quantityProposals: [], possibleSameAs: [],
      }],
      supportedSlots: [{
        slotId: "slot1", scopeId: "scene", basis: "direct_witness", proofIds: ["c1"], sourceCandidateIds: ["cand:r1"],
        multiplicity: 1, family: { state: "resolved", value: { family: "dairy", qualifier: "whole" }, proofIds: ["c1"] },
        portion: { state: "resolved", value: portion, proofIds: ["c1"] },
        profile: { state: "resolved", value: "whole", proofIds: ["c1"] }, status: "confirmed", pendingReasons: [],
      }],
      confirmed: [{ unitId: "unit1", slotIds: ["slot1"], profileId: "whole", portion, multiplicity: 1, confirmation: "evidence_admitted", proofIds: ["c1"] }],
      unresolved: [],
      dispositions: [{ rowId: "r1", disposition: "used_as_evidence", slotIds: ["slot1"], groupIds: [], reasonCodes: [] }],
      acceptedDecisions: [],
      rejectedDecisions: [],
      summary: { supportedServingCount: 1, confirmedServingCount: 1, pendingSlotCount: 0, unresolvedGroupCount: 0, cardinalityReviewRequired: false, reasonCodes: [] },
    };
  }

  it("accepts a consistent projection and rejects dangling referents, portion drift and multiplicity drift", () => {
    const base = valid();
    expect(servingReconciliationSchema.safeParse(base).success).toBe(true);
    expect(servingReconciliationSchema.safeParse({
      ...base,
      claims: [{
        ...base.claims[0],
        body: { predicate: "presence", subject: { kind: "entity", entityId: "ent:missing" }, content: "milk" },
      }],
    }).success).toBe(false);
    expect(servingReconciliationSchema.safeParse({
      ...base,
      confirmed: [{ ...base.confirmed[0], portion: { ...base.confirmed[0].portion, min: 4000, max: 4000 }, multiplicity: 9 }],
    }).success).toBe(false);
    expect(servingReconciliationSchema.safeParse({
      ...base,
      supportedSlots: [{ ...base.supportedSlots[0], status: "pending", pendingReasons: ["portion_required"] }],
    }).success).toBe(false);
    const badDecision = structuredClone(valid());
    badDecision.decisionRevision = 1;
    badDecision.acceptedDecisions = [{
      decisionId: "d", sourceDigest: "d", expectedDecisionRevision: 0,
      command: { kind: "set_type", targetId: "slot:missing", choice: "whole" },
    }];
    expect(servingReconciliationSchema.safeParse(badDecision).success).toBe(false);
  });
});

describe("B6 decision commands do not close conflicts they do not name", () => {
  it("set_portion does not resolve an open 250/400 exclusive group", () => {
    const rows = [milkRow("前方", 250), milkRow("後方", 400)];
    const base = scene("b6", rows);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const rejected = reconcileMilkServingScene({
      sceneId: "b6",
      analysis: analysis(rows),
      decisions: decisions(base, [
        { kind: "set_portion", unitId: group.slotIds[0], portion: { min: 250, max: 250, unit: "ml" } },
        { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
      ]),
    });
    expect(rejected.rejectedDecisions.map(item => item.reason)).toContain("exclusive_group_requires_explicit_resolution");
    expect(rejected.confirmed).toHaveLength(0);
    expect(rejected.unresolved.some(item => item.kind === "exclusive_candidates")).toBe(true);

    const accepted = reconcileMilkServingScene({
      sceneId: "b6",
      analysis: analysis(rows),
      decisions: decisions(base, [
        { kind: "one_serving", groupId: group.groupId, portion: { min: 250, max: 250, unit: "ml" } },
        { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
      ]),
    });
    expect(accepted.rejectedDecisions).toEqual([]);
    expect(kcal(accepted)).toBeCloseTo(WHOLE_250, 8);
  });

  it("set_type does not confirm a slot that still has a family conflict", () => {
    const rows = [
      milkRow("有星形貼紙的杯", 250, { displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "玻璃杯" }),
      wholeRow("有星形貼紙的同一杯", 250),
    ];
    const base = scene("b6-family", rows);
    expect(base.summary.supportedServingCount).toBe(1);
    expect(base.confirmed).toHaveLength(0);
    const slot = base.supportedSlots.find(item => item.status !== "dismissed")!;
    expect(slot.family.state).toBe("conflict");
    const result = reconcileMilkServingScene({
      sceneId: "b6-family",
      analysis: analysis(rows),
      decisions: decisions(base, [{ kind: "set_type", targetId: slot.slotId, choice: "soy" }]),
    });
    expect(result.rejectedDecisions).toEqual([{ decisionId: "d-0", reason: "family_conflict_unresolved" }]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.supportedSlots.find(item => item.slotId === slot.slotId)?.family.state).toBe("conflict");
  });

  it("rejects stale digests, replay conflicts, bad revisions and unknown targets", () => {
    const rows = [milkRow("前方", 250), milkRow("後方", 400)];
    const base = scene("b6-bind", rows);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const result = reconcileMilkServingScene({
      sceneId: "b6-bind",
      analysis: analysis(rows),
      decisions: [
        { decisionId: "s", sourceDigest: "other", expectedDecisionRevision: 0, command: { kind: "dismiss_group", groupId: group.groupId } },
        { decisionId: "r", sourceDigest: base.sourceDigest, expectedDecisionRevision: 4, command: { kind: "dismiss_group", groupId: group.groupId } },
        { decisionId: "t", sourceDigest: base.sourceDigest, expectedDecisionRevision: 0, command: { kind: "set_type", targetId: "slot:missing", choice: "whole" } },
      ],
    });
    expect(result.rejectedDecisions.map(item => item.reason)).toEqual([
      "stale_source_digest", "stale_decision_revision", "unknown_target",
    ]);
    expect(result.decisionRevision).toBe(0);
    const once = decisions(base, [{ kind: "dismiss_group", groupId: group.groupId }]);
    const replay = reconcileMilkServingScene({
      sceneId: "b6-bind",
      analysis: analysis(rows),
      decisions: [...once, { ...once[0], command: { kind: "dismiss_group", groupId: "grp:other" } }],
    });
    expect(replay.rejectedDecisions).toEqual([{ decisionId: once[0].decisionId, reason: "decision_id_conflict" }]);
    expect(replay.decisionRevision).toBe(1);
  });
});

describe("independent witness and quantity invariants", () => {
  it("same-vessel duplicates do not double confirmed nutrition", () => {
    const glass = wholeRow("玻璃杯裝全脂牛奶", 250);
    const result = scene("inv-dup", [glass, { ...glass }]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    expect(kcal(result)).toBeCloseTo(WHOLE_250, 8);
  });

  it("left and right whole glasses with different amounts stay separate", () => {
    const rows = [wholeRow("左邊玻璃杯裝全脂牛奶", 250), wholeRow("右邊玻璃杯裝全脂牛奶", 400)];
    for (const order of permutations(rows)) {
      const result = scene("inv-sep", order);
      expect(result.summary.supportedServingCount).toBe(2);
      expect(confirmedPortionPlan(result)).toEqual([
        { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
        { profileId: "whole", min: 400, max: 400, unit: "ml", purpose: "personal", multiplicity: 1 },
      ]);
      expect(kcal(result)).toBeCloseTo(WHOLE_250 + WHOLE_400, 8);
    }
  });

  it("two unidentified whole amounts are not averaged or hulled", () => {
    const rows = [
      wholeRow("玻璃杯", 200, { preparationMethod: "玻璃杯" }),
      wholeRow("玻璃杯", 500, { preparationMethod: "玻璃杯" }),
    ];
    const result = scene("inv-ambig", rows);
    expect(result.confirmed).toHaveLength(0);
    const amounts = result.unresolved.flatMap(group => group.amountAlternatives.map(item => [item.min, item.max]));
    expect(amounts).toEqual(expect.arrayContaining([[200, 200], [500, 500]]));
    expect(result.confirmed.some(unit => unit.portion.min === 200 && unit.portion.max === 500)).toBe(false);
    expect(result.confirmed.some(unit => unit.portion.min === 350)).toBe(false);
  });
});
