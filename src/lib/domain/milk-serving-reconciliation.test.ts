import { describe, expect, it } from "vitest";
import {
  confirmedPortionPlan,
  rowEntityId,
  semanticDecisionView,
  ServingContractError,
  validateServingReconciliation,
  type ClaimBody,
  type ClaimUse,
  type EvidenceClaim,
  type ObservedFoodRow,
  type Polarity,
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
  slotForRow,
  wholeRow,
} from "@/lib/domain/milk-serving.fixture";

// ---------------------------------------------------------------------------
// Layer 2a: typed evidence -> physical serving. Claims are hand-built here so
// this layer never shares an oracle with the language extractor.
// ---------------------------------------------------------------------------

const SCENE = "typed-scene";

function typedRow(rowId: string, milkCandidate = true): ObservedFoodRow {
  return {
    rowId,
    sceneId: SCENE,
    originalIndex: 0,
    semanticKey: `key-${rowId}`,
    raw: milkRow(undefined),
    subject: { milkCandidate, exclusionReason: milkCandidate ? null : "non_milk_subject" },
  };
}

const ent = (rowId: string) => ({ kind: "entity" as const, entityId: rowEntityId(rowId) });
const pop = (family: "oat" | "generic_milk" | "dairy" | "soy", vessel: "carton" | "glass" | "unknown") =>
  ({ kind: "population" as const, scopeId: `pop:${family}:${vessel}`, family, vessel });

let claimSeq = 0;
function claim(body: ClaimBody, uses: ClaimUse[], options: { row?: string; polarity?: Polarity; refusal?: string[] } = {}): EvidenceClaim {
  claimSeq += 1;
  const polarity = options.polarity ?? "affirmative";
  const usable = polarity === "affirmative" ? uses : uses.filter(use => use !== "count" && use !== "existence");
  return {
    claimId: `c-${String(claimSeq).padStart(4, "0")}`,
    source: {
      sceneId: SCENE,
      ...(options.row ? { rowId: options.row } : {}),
      field: options.row ? "notes" : "visibleEvidence",
      span: [0, 1],
      origin: "model_reported",
      grammarRule: "typed_fixture",
      grammarVersion: "typed",
    },
    body,
    polarity,
    scopeId: "scene",
    usableFor: usable,
    refusalReasons: usable.length === 0 ? options.refusal ?? [`${polarity}_not_admissible`] : options.refusal ?? [],
    contradictsClaimIds: [],
  };
}

/** Label presence + family + optional vessel + optional personal quantity, all own-subject. */
function witness(rowId: string, spec: {
  family?: "generic_milk" | "dairy" | "soy" | "oat" | "blend";
  qualifier?: "whole" | null;
  vessel?: "glass" | "carton" | "bottle" | "container";
  ml?: number | null;
  range?: [number, number];
  unit?: "ml" | "cup";
  side?: "front" | "back" | "left" | "right";
} = {}): EvidenceClaim[] {
  const claims = [
    claim({ predicate: "presence", subject: ent(rowId), content: "milk" }, ["existence"], { row: rowId }),
    claim({ predicate: "family", subject: ent(rowId), family: spec.family ?? "generic_milk", qualifier: spec.qualifier ?? null }, ["family"], { row: rowId }),
  ];
  if (spec.vessel) claims.push(claim({ predicate: "vessel", subject: ent(rowId), vessel: spec.vessel }, ["existence"], { row: rowId }));
  if (spec.side) claims.push(claim({ predicate: "spatial", subject: ent(rowId), relativeTo: "scene", relation: spec.side }, ["separate_identity"], { row: rowId }));
  const amount = spec.range ?? (spec.ml === undefined ? [250, 250] : spec.ml === null ? null : [spec.ml, spec.ml]);
  claims.push(quantity(rowId, amount, "row_personal_estimate", spec.unit ?? "ml"));
  return claims;
}

function quantity(rowId: string, amount: [number, number] | null, purpose: "row_personal_estimate" | "aggregate_consumed" | "unknown" | "package_capacity", unit: "ml" | "cup" = "ml"): EvidenceClaim {
  claimSeq += 1;
  const id = `q-${String(claimSeq).padStart(4, "0")}`;
  return claim({
    predicate: "quantity",
    proposal: {
      proposalId: `p-${id}`,
      target: ent(rowId),
      min: amount ? amount[0] : null,
      max: amount ? amount[1] : null,
      unit,
      purpose,
      claimIds: [],
    },
  }, purpose === "row_personal_estimate" || purpose === "aggregate_consumed" ? ["portion"] : [], {
    row: rowId,
    refusal: purpose === "row_personal_estimate" || purpose === "aggregate_consumed" ? [] : [`quantity_${purpose}`],
  });
}

function run(rows: ObservedFoodRow[], claims: EvidenceClaim[]): ServingReconciliation {
  return validateServingReconciliation(reconcileServingEvidence({ sceneId: SCENE, rows, claims }));
}

const disposition = (result: ServingReconciliation, rowId: string) =>
  result.dispositions.find(item => item.rowId === rowId)!;

describe("typed reconciliation: identity relations", () => {
  it("compatible family/vessel alone is neither same nor separate: one slot, the other is possible excess", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass" }), ...witness("b", { vessel: "glass" }),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(disposition(result, "a").disposition).toBe("alternative");
    expect(disposition(result, "b").disposition).toBe("alternative");
    expect(result.unresolved.some(group => group.kind === "possible_excess" && group.possibleExtraSlots === 1)).toBe(true);
  });

  it("a bound affirmative different_vessel between two witnesses yields two direct slots", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass" }), ...witness("b", { vessel: "glass" }),
      claim({ predicate: "different_vessel", left: ent("a"), right: ent("b") }, ["separate_identity"]),
    ]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(disposition(result, "a").disposition).toBe("used_as_evidence");
    expect(disposition(result, "b").disposition).toBe("used_as_evidence");
  });

  it("an unbound different_vessel never certifies separation", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass" }), ...witness("b", { vessel: "glass" }),
      claim({ predicate: "different_vessel", left: ent("a"), right: { kind: "unbound", possibleEntityIds: [] } }, ["separate_identity"]),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("same and different bound to one pair is a relation conflict, not a union", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass" }), ...witness("b", { vessel: "glass" }),
      claim({ predicate: "different_vessel", left: ent("a"), right: ent("b") }, ["separate_identity"]),
      claim({ predicate: "same_vessel", left: ent("a"), right: ent("b") }, ["same_identity"]),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.unresolved.some(group => group.kind === "relation_conflict")).toBe(true);
  });

  it("#27 same(a,b), same(b,c), different(a,c) stays a conflict cluster while independent d survives", () => {
    const result = run(["a", "b", "c", "d"].map(id => typedRow(id)), [
      ...witness("a", { vessel: "glass" }), ...witness("b", { vessel: "glass" }), ...witness("c", { vessel: "glass" }),
      ...witness("d", { vessel: "carton", family: "oat" }),
      claim({ predicate: "same_vessel", left: ent("a"), right: ent("b") }, ["same_identity"]),
      claim({ predicate: "same_vessel", left: ent("b"), right: ent("c") }, ["same_identity"]),
      claim({ predicate: "different_vessel", left: ent("a"), right: ent("c") }, ["separate_identity"]),
    ]);
    expect(disposition(result, "d").disposition).toBe("used_as_evidence");
    expect(result.summary.supportedServingCount).toBe(2);
    const conflict = result.unresolved.find(group => group.kind === "relation_conflict");
    expect(conflict?.candidateIds.length).toBe(3);
  });

  it("#28 an unknown row compatible with two proven glasses does not merge or displace them", () => {
    const result = run([typedRow("soy"), typedRow("whole"), typedRow("u")], [
      ...witness("soy", { vessel: "glass", family: "soy", side: "left" }),
      ...witness("whole", { vessel: "glass", family: "dairy", qualifier: "whole", side: "right" }),
      ...witness("u"),
    ]);
    expect(disposition(result, "soy").disposition).toBe("used_as_evidence");
    expect(disposition(result, "whole").disposition).toBe("used_as_evidence");
    expect(disposition(result, "u").disposition).toBe("possible_excess");
    const excess = result.unresolved.find(group => group.kind === "possible_excess")!;
    expect(excess.possibleTargetSlotIds).toHaveLength(2);
    expect(result.summary.supportedServingCount).toBe(2);
  });

  it("spatial words without own vessel witnesses do not prove multiple servings", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { side: "front" }), ...witness("b", { side: "back" }),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("view/part spatial relations never act as opposite anchors", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass" }), ...witness("b", { vessel: "glass" }),
      claim({ predicate: "spatial", subject: ent("a"), relativeTo: "scene", relation: "view" }, ["separate_identity"], { row: "a" }),
      claim({ predicate: "spatial", subject: ent("b"), relativeTo: "scene", relation: "part" }, ["separate_identity"], { row: "b" }),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
  });
});

describe("typed reconciliation: contents, family, stock", () => {
  it("a row whose own object holds non-drink content is a conflict with zero contribution (#25 / P1-B)", () => {
    for (const content of ["non_drink", "empty"] as const) {
      const result = run([typedRow("glass"), typedRow("other")], [
        ...witness("glass", { vessel: "glass" }),
        ...witness("other", { vessel: "container" }),
        claim({ predicate: "presence", subject: ent("other"), content }, ["existence"], { row: "other" }),
      ]);
      expect(disposition(result, "other").disposition).toBe("conflict");
      expect(result.summary.supportedServingCount).toBe(1);
      expect(result.unresolved.some(group => group.kind === "unbound_object")).toBe(true);
    }
  });

  it("#2 soy and whole on the same referent is a family conflict, not two servings", () => {
    const result = run([typedRow("a")], [
      ...witness("a", { vessel: "glass", family: "soy" }),
      claim({ predicate: "family", subject: ent("a"), family: "dairy", qualifier: "whole" }, ["family"], { row: "a" }),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.confirmed).toHaveLength(0);
    expect(result.supportedSlots[0].family.state).toBe("conflict");
  });

  it("generic + specific own family refines; it is never absorbed by another row's family", () => {
    const result = run([typedRow("g"), typedRow("w")], [
      ...witness("g", { vessel: "glass", side: "left" }),
      claim({ predicate: "family", subject: ent("g"), family: "soy", qualifier: null }, ["family"], { row: "g" }),
      ...witness("w", { vessel: "glass", family: "dairy", qualifier: "whole", side: "right" }),
    ]);
    const slot = result.supportedSlots.find(item => item.sourceCandidateIds.some(id => id.includes("g")) && item.family.state === "resolved"
      && item.family.value.family === "soy");
    expect(slot).toBeDefined();
    expect(result.summary.supportedServingCount).toBe(2);
  });

  it("#33 a declared blend stays one serving with no averaged profile", () => {
    const result = run([typedRow("a")], [...witness("a", { vessel: "glass", family: "blend" })]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.confirmed).toHaveLength(0);
    expect(result.supportedSlots[0].pendingReasons).toContain("profile_unavailable");
  });

  it("#24 a stock carton poured into a glass is not a second intake", () => {
    const result = run([typedRow("stock"), typedRow("glass")], [
      ...witness("stock", { vessel: "carton", family: "oat", ml: null }),
      quantity("stock", [1000, 1000], "package_capacity"),
      ...witness("glass", { vessel: "glass", family: "oat", ml: 180 }),
      claim({ predicate: "stock_transfer", from: ent("stock"), into: ent("glass") }, ["separate_identity"], { row: "stock" }),
    ]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(disposition(result, "glass").disposition).toBe("used_as_evidence");
    expect(confirmedPortionPlan(result)).toEqual([{ profileId: "oat", min: 180, max: 180, unit: "ml", purpose: "personal", multiplicity: 1 }]);
  });
});

describe("typed reconciliation: quantities", () => {
  it("#17 two personal amounts for one target are a quantity conflict, never chosen by confidence", () => {
    const result = run([typedRow("a")], [
      ...witness("a", { vessel: "glass", family: "dairy", qualifier: "whole", ml: 200 }),
      quantity("a", [400, 400], "row_personal_estimate"),
    ]);
    expect(result.confirmed).toHaveLength(0);
    const group = result.unresolved.find(item => item.kind === "exclusive_candidates")!;
    expect(group.amountAlternatives.map(item => item.max).sort()).toEqual([200, 400]);
  });

  it("#15 overlapping range alternatives are neither intersected nor hulled", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass", range: [180, 220] }), ...witness("b", { vessel: "glass", range: [200, 240] }),
    ]);
    expect(result.confirmed).toHaveLength(0);
    const group = result.unresolved.find(item => item.kind === "exclusive_candidates")!;
    expect(group.amountAlternatives.map(item => [item.min, item.max]).sort()).toEqual([[180, 220], [200, 240]]);
    expect(result.supportedSlots.every(slot => slot.portion.state !== "resolved")).toBe(true);
  });

  it("#32 a cup proposal and a 250 ml proposal are different alternatives", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { family: "dairy", qualifier: "whole", ml: 1, unit: "cup" }),
      ...witness("b", { family: "dairy", qualifier: "whole", ml: 250 }),
    ]);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#19 count 2 with three unbound amounts leaves the assignment pending", () => {
    const rows = ["x", "y", "z"].map(id => typedRow(id));
    const result = run(rows, [
      ...witness("x", { family: "soy", ml: 200 }), ...witness("y", { family: "soy", ml: 350 }), ...witness("z", { family: "soy", ml: 500 }),
      claim({ predicate: "cardinality", population: pop("soy", "carton"), relation: "exact", count: 2 }, ["count"]),
    ]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.find(group => group.kind === "exclusive_candidates")?.amountAlternatives).toHaveLength(3);
  });

  it("#20 an aggregate consumed amount is one accounting unit with multiplicity, not invented per-serving amounts", () => {
    const result = run([typedRow("a")], [
      ...witness("a", { family: "dairy", qualifier: "whole", ml: null }),
      quantity("a", [600, 600], "aggregate_consumed"),
      claim({ predicate: "cardinality", population: ent("a"), relation: "exact", count: 3 }, ["count"], { row: "a" }),
    ]);
    expect(confirmedPortionPlan(result)).toEqual([{ profileId: "whole", min: 600, max: 600, unit: "ml", purpose: "aggregate_consumed", multiplicity: 3 }]);
  });

  it("#21 count 3 with an amount of unknown basis supports three slots but no portion", () => {
    const result = run([typedRow("a")], [
      ...witness("a", { family: "dairy", qualifier: "whole", ml: null }),
      quantity("a", [600, 600], "unknown"),
      claim({ predicate: "cardinality", population: pop("dairy", "glass"), relation: "exact", count: 3 }, ["count"]),
    ]);
    expect(result.summary.supportedServingCount).toBe(3);
    expect(result.confirmed).toHaveLength(0);
  });

  it("#26 two proven glasses with null portions stay visible with zero confirmed nutrition", () => {
    const result = run([typedRow("a"), typedRow("b")], [
      ...witness("a", { vessel: "glass", ml: null, side: "left" }), ...witness("b", { vessel: "glass", ml: null, side: "right" }),
    ]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(result.confirmed).toHaveLength(0);
    expect(result.supportedSlots.every(slot => slot.pendingReasons.includes("portion_required"))).toBe(true);
  });
});

describe("typed reconciliation: cardinality polarity and barriers", () => {
  const threeOat = () => ["o1", "o2", "o3"].map(id => typedRow(id));
  const oatWitnesses = () => ["o1", "o2", "o3"].flatMap(id => witness(id, { vessel: "carton", family: "oat" }));

  it("an admitted exact count expands interchangeable witnesses into that many slots", () => {
    const result = run(threeOat(), [...oatWitnesses(),
      claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 3 }, ["count"])]);
    expect(result.summary.supportedServingCount).toBe(3);
    expect(confirmedPortionPlan(result)).toHaveLength(3);
  });

  for (const polarity of ["negative", "questioned", "uncertain", "contradictory"] as const) {
    it(`a ${polarity} count adds no support`, () => {
      const result = run(threeOat(), [...oatWitnesses(),
        claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 3 }, ["count"], { polarity })]);
      expect(result.summary.supportedServingCount).toBe(1);
    });
  }

  it("#23 exact 2 vs exact 4 revokes surplus and requires review", () => {
    const result = run(threeOat(), [...oatWitnesses(),
      claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 2 }, ["count"]),
      claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 4 }, ["count"])]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(result.summary.cardinalityReviewRequired).toBe(true);
  });

  for (const polarity of ["negative", "questioned", "uncertain"] as const) {
    it(`weakening one side of a 2/4 conflict to ${polarity} cannot unlock the other count`, () => {
      const result = run(threeOat(), [...oatWitnesses(),
        claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 2 }, ["count"], { polarity }),
        claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 4 }, ["count"])]);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(result.summary.cardinalityReviewRequired).toBe(true);
    });
  }

  it("an oat-carton barrier does not block an independently proven dairy glass", () => {
    const rows = [...threeOat(), typedRow("w")];
    const result = run(rows, [...oatWitnesses(),
      ...witness("w", { vessel: "glass", family: "dairy", qualifier: "whole" }),
      claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 3 }, ["count"], { polarity: "questioned" })]);
    expect(disposition(result, "w").disposition).toBe("used_as_evidence");
    expect(result.summary.supportedServingCount).toBe(2);
  });

  it("quoted marketing counts are neither support nor a barrier", () => {
    const result = run(threeOat(), [...oatWitnesses(),
      claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 2 }, ["count"]),
      claim({ predicate: "cardinality", population: pop("oat", "carton"), relation: "exact", count: 4 }, [], { refusal: ["quoted_text"] })]);
    expect(result.summary.supportedServingCount).toBe(2);
    expect(result.summary.cardinalityReviewRequired).toBe(false);
  });
});

describe("typed reconciliation: input validation fails loudly", () => {
  it("rejects more than 12 observed rows", () => {
    const rows = Array.from({ length: 13 }, (_, index) => typedRow(`r${index}`));
    expect(() => reconcileServingEvidence({ sceneId: SCENE, rows, claims: [] })).toThrow(ServingContractError);
  });

  it("rejects duplicate row ids and claims about unknown entities", () => {
    expect(() => reconcileServingEvidence({ sceneId: SCENE, rows: [typedRow("a"), typedRow("a")], claims: [] }))
      .toThrow(ServingContractError);
    expect(() => reconcileServingEvidence({ sceneId: SCENE, rows: [typedRow("a")], claims: witness("ghost") }))
      .toThrow(ServingContractError);
  });

  it("rejects rows from another scene", () => {
    expect(() => reconcileServingEvidence({ sceneId: "other", rows: [typedRow("a")], claims: [] })).toThrow(ServingContractError);
  });

  it("handles zero rows with an empty, valid decision", () => {
    const result = run([], []);
    expect(result.summary.supportedServingCount).toBe(0);
    expect(result.dispositions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2b: the five P1 findings, reproduced at the contract level from raw
// model payloads. Expected nutrition comes from fixed reference vectors.
// ---------------------------------------------------------------------------

const scene = (sceneId: string, rows: Parameters<typeof analysis>[0], evidence: string[] = []) =>
  validateServingReconciliation(reconcileMilkServingScene({ sceneId, analysis: analysis(rows, evidence) }));

function decide(sceneId: string, rows: Parameters<typeof analysis>[0], base: ServingReconciliation,
  commands: Parameters<typeof decisions>[1], evidence: string[] = []) {
  return validateServingReconciliation(reconcileMilkServingScene({
    sceneId, analysis: analysis(rows, evidence), decisions: decisions(base, commands),
  }));
}

function expectTotals(result: ServingReconciliation, expected: { kcal: number; protein?: number; carbs?: number; fat?: number }) {
  const totals = referenceTotals(confirmedPortionPlan(result)).max;
  expect(totals.kcal).toBeCloseTo(expected.kcal, 8);
  if (expected.protein !== undefined) expect(totals.protein).toBeCloseTo(expected.protein, 8);
  if (expected.carbs !== undefined) expect(totals.carbs).toBeCloseTo(expected.carbs, 8);
  if (expected.fat !== undefined) expect(totals.fat).toBeCloseTo(expected.fat, 8);
}

describe("P1-A family attribution: generic soy glass + whole glass + oat carton", () => {
  const left = milkRow("左邊玻璃杯裝豆漿", 250, { preparationMethod: "玻璃杯" });
  const right = wholeRow("右邊玻璃杯裝全脂牛奶", 400);
  const carton = oatRow("燕麥奶紙盒", 250);
  const orders = permutations([left, right, carton]);

  for (const [index, order] of orders.entries()) {
    it(`preserves three independently supported servings (permutation ${index})`, () => {
      const result = scene("p1-a", order);
      expect(result.summary.supportedServingCount).toBe(3);
      for (const notes of [left.notes!, right.notes!, carton.notes!]) {
        expect(dispositionOf(result, rowIdByNotes(result, notes)).disposition).toBe("used_as_evidence");
      }
      const leftSlot = result.supportedSlots.find(slot => slot.slotId === slotForRow(result, left.notes!))!;
      expect(leftSlot.family).toMatchObject({ state: "resolved", value: { family: "soy" } });
      expect(leftSlot.pendingReasons).toEqual(["type_confirmation_required"]);
      expect(result.unresolved.some(group => group.candidateIds.some(id => id.includes(rowIdByNotes(result, left.notes!))))).toBe(false);

      const typed = decide("p1-a", order, result, [
        { kind: "set_type", targetId: slotForRow(result, left.notes!), choice: "soy" },
        { kind: "set_type", targetId: slotForRow(result, right.notes!), choice: "whole" },
        { kind: "set_type", targetId: slotForRow(result, carton.notes!), choice: "oat" },
      ]);
      expect(typed.confirmed).toHaveLength(3);
      expectTotals(typed, { kcal: 452.0801929101, protein: 22.2294624104, carbs: 38.0894633577, fat: 23.73756509 });
    });
  }

  it("produces the same semantic decision for every row order", () => {
    const views = orders.map(order => semanticDecisionView(scene("p1-a", order)));
    for (const view of views) expect(view).toEqual(views[0]);
  });
});

describe("P1-B unrelated container: spoon container does not confirm another milk serving", () => {
  const front = milkRow("前方透明玻璃杯內可見牛奶");
  const spoon = milkRow("後方另一個白色容器，內有湯匙");

  for (const [index, order] of permutations([front, spoon]).entries()) {
    it(`supports one 250 ml milk serving only (order ${index})`, () => {
      const result = scene("p1-b", order);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(dispositionOf(result, rowIdByNotes(result, front.notes!)).disposition).toBe("used_as_evidence");
      expect(dispositionOf(result, rowIdByNotes(result, spoon.notes!)).disposition).toBe("conflict");
      expect(result.confirmed).toHaveLength(0);

      const typed = decide("p1-b", order, result, [
        { kind: "set_type", targetId: slotForRow(result, front.notes!), choice: "whole" },
      ]);
      expect(confirmedPortionPlan(typed)).toEqual([{ profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 }]);
      expectTotals(typed, { kcal: 157.075, protein: 8.24, carbs: 12.36, fat: 8.4975 });
    });
  }

  it("a meal-level spoon container never strengthens two generic rows", () => {
    const result = scene("p1-b-meal", [milkRow("白色飲品"), milkRow("白色飲品")], ["另一個白色容器內有湯匙"]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("genuine C4 drink contents stay two servings (282.735–471.225 kcal after whole)", () => {
    const glass = milkRow("前方透明玻璃杯內可見白色飲品；沒有品牌或包裝文字可供確認。", null, { portionMin: 250, portionMax: 400 });
    const back = milkRow("後方可見另一個白色容器，內有相似的白色飲品；容器邊界及液面部分被遮擋，沒有品牌或包裝文字。", null, { portionMin: 200, portionMax: 350 });
    const result = scene("c4", [glass, back]);
    expect(result.summary.supportedServingCount).toBe(2);
    const typed = decide("c4", [glass, back], result, [
      { kind: "set_type", targetId: slotForRow(result, glass.notes!), choice: "whole" },
      { kind: "set_type", targetId: slotForRow(result, back.notes!), choice: "whole" },
    ]);
    const totals = referenceTotals(confirmedPortionPlan(typed));
    expect(totals.min.kcal).toBeCloseTo(282.735, 8);
    expect(totals.max.kcal).toBeCloseTo(471.225, 8);
  });
});

describe("P1-C conflicting 250/400 ml amounts form an order-independent exclusive group", () => {
  const a = milkRow("前方", 250);
  const b = milkRow("後方", 400);
  const orders = [[a, b], [b, a]];

  for (const [index, order] of orders.entries()) {
    it(`no precise confirmed contribution before portion resolution (order ${index})`, () => {
      const result = scene("p1-c", order);
      expect(result.summary.supportedServingCount).toBe(1);
      expect(result.confirmed).toHaveLength(0);
      const group = result.unresolved.find(item => item.kind === "exclusive_candidates")!;
      expect(group.reasonCodes).toContain("portion_identity_conflict");
      expect(group.selectedCandidateId).toBeNull();
      expect(group.amountAlternatives.map(item => item.max).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([250, 400]);
      for (const row of result.rows) expect(dispositionOf(result, row.rowId).disposition).toBe("alternative");

      // Type choice alone never resolves the portion conflict (#29).
      const typed = decide("p1-c", order, result, [
        { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
      ]);
      expect(typed.confirmed).toHaveLength(0);
      expect(typed.unresolved.some(item => item.kind === "exclusive_candidates")).toBe(true);
    });
  }

  it("both orders produce the same group identity and semantic decision", () => {
    const [first, second] = orders.map(order => scene("p1-c", order));
    expect(semanticDecisionView(first)).toEqual(semanticDecisionView(second));
  });

  it("whole-milk rows of equal specificity behave the same", () => {
    const w250 = wholeRow("白色飲品", 250, { preparationMethod: undefined });
    const w400 = wholeRow("白色飲品", 400, { preparationMethod: undefined });
    const [first, second] = [[w250, w400], [w400, w250]].map(order => scene("p1-c-whole", order));
    expect(first.confirmed).toHaveLength(0);
    expect(semanticDecisionView(first)).toEqual(semanticDecisionView(second));
  });

  it("explicit one-serving decisions resolve to 157.075 or 251.32 kcal irrespective of row order", () => {
    for (const order of orders) {
      const base = scene("p1-c", order);
      const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
      for (const [ml, kcal] of [[250, 157.075], [400, 251.32]] as const) {
        const result = decide("p1-c", order, base, [
          { kind: "one_serving", groupId: group.groupId, portion: { min: ml, max: ml, unit: "ml" } },
          { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
        ]);
        expect(result.rejectedDecisions).toEqual([]);
        expect(result.confirmed).toHaveLength(1);
        expect(result.confirmed[0].confirmation).toBe("user_declared");
        expectTotals(result, { kcal });
      }
    }
  });

  it("explicit separate servings require per-slot portions, then total 408.395 kcal", () => {
    const base = scene("p1-c", [a, b]);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const separated = decide("p1-c", [a, b], base, [
      { kind: "separate_servings", groupId: group.groupId, unitIds: group.candidateIds },
    ]);
    expect(separated.rejectedDecisions).toEqual([]);
    expect(separated.confirmed).toHaveLength(0);
    const slots = separated.supportedSlots.filter(slot => slot.basis === "user_declared" && slot.status === "pending");
    expect(slots).toHaveLength(2);
    const amounts = [250, 400];
    const finished = decide("p1-c", [a, b], base, [
      { kind: "separate_servings", groupId: group.groupId, unitIds: group.candidateIds },
      ...slots.flatMap((slot, index) => [
        { kind: "set_portion" as const, unitId: slot.slotId, portion: { min: amounts[index], max: amounts[index], unit: "ml" as const } },
        { kind: "set_type" as const, targetId: slot.slotId, choice: "whole" as const },
      ]),
    ]);
    expect(finished.confirmed).toHaveLength(2);
    expectTotals(finished, { kcal: 408.395, protein: 21.424, carbs: 32.136, fat: 22.0935 });
  });

  it("#30 excluding one option does not confirm the remaining option", () => {
    const base = scene("p1-c", [a, b]);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const option = group.amountAlternatives.find(item => item.max === 250)!;
    const result = decide("p1-c", [a, b], base, [
      { kind: "exclude_option", groupId: group.groupId, proposalId: option.proposalId },
      { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
    ]);
    expect(result.confirmed).toHaveLength(0);
    const after = result.unresolved.find(item => item.groupId === group.groupId)!;
    expect(after.excludedProposalIds).toEqual([option.proposalId]);
    expect(after.reasonCodes).toContain("remaining_option_requires_explicit_acceptance");
  });

  it("#16 a user-declared single range becomes a user amount", () => {
    const base = scene("p1-c", [a, b]);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const result = decide("p1-c", [a, b], base, [
      { kind: "one_serving", groupId: group.groupId, portion: { min: 180, max: 240, unit: "ml" } },
      { kind: "set_type", targetId: group.slotIds[0], choice: "whole" },
    ]);
    expect(result.confirmed[0].portion).toMatchObject({ min: 180, max: 240, origin: "user_amount" });
  });

  it("dismissing the group records nothing and supersedes its rows", () => {
    const base = scene("p1-c", [a, b]);
    const group = base.unresolved.find(item => item.kind === "exclusive_candidates")!;
    const result = decide("p1-c", [a, b], base, [{ kind: "dismiss_group", groupId: group.groupId }]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.some(item => item.groupId === group.groupId)).toBe(false);
    for (const row of result.rows) expect(dispositionOf(result, row.rowId).disposition).toBe("superseded");
    expect(result.summary.supportedServingCount).toBe(0);
  });
});

describe("P1-D unknown subgroup: a genuine oat glass does not release an ambiguous unknown-vessel row", () => {
  const carton = oatRow("燕麥奶紙盒");
  const unknown = oatRow("白色飲品", 250, { preparationMethod: undefined });
  const glass = oatRow("獨立玻璃杯燕麥奶", 250, { preparationMethod: "玻璃杯" });

  it("before: one supported carton serving, unknown row possible excess (116.0243653957 kcal)", () => {
    const result = scene("p1-d-before", [carton, unknown]);
    expect(result.summary.supportedServingCount).toBe(1);
    expect(dispositionOf(result, rowIdByNotes(result, unknown.notes!)).disposition).toBe("possible_excess");
    expectTotals(result, { kcal: 116.0243653957 });
  });

  for (const [index, order] of permutations([carton, unknown, glass]).entries()) {
    it(`after: two genuine servings, unknown still pending (permutation ${index})`, () => {
      const result = scene("p1-d-after", order);
      expect(result.summary.supportedServingCount).toBe(2);
      const unknownDisposition = dispositionOf(result, rowIdByNotes(result, unknown.notes!));
      expect(unknownDisposition.disposition).toBe("possible_excess");
      const excess = result.unresolved.find(group => unknownDisposition.groupIds.includes(group.groupId))!;
      expect(excess.kind).toBe("possible_excess");
      expect(excess.possibleTargetSlotIds).toHaveLength(2);
      const typed = decide("p1-d-after", order, result, [
        { kind: "set_type", targetId: slotForRow(result, carton.notes!), choice: "oat" },
        { kind: "set_type", targetId: slotForRow(result, glass.notes!), choice: "oat" },
      ]);
      expectTotals(typed, { kcal: 232.0487307914, protein: 3.4033813849, carbs: 27.6911485411, fat: 12.0149676165 });
    });
  }

  it("the same architecture holds for whole milk (314.15 kcal, not 471.225)", () => {
    const wCarton = wholeRow("全脂牛奶紙盒", 250, { preparationMethod: "紙盒" });
    const wUnknown = wholeRow("白色飲品", 250, { preparationMethod: undefined });
    const wGlass = wholeRow("獨立玻璃杯全脂牛奶", 250);
    const result = scene("p1-d-whole", [wCarton, wUnknown, wGlass]);
    expect(result.summary.supportedServingCount).toBe(2);
    expectTotals(result, { kcal: 314.15 });
  });
});

describe("P1-E unmarked questions and negation never confirm three servings", () => {
  const rows = [oatRow(), oatRow(), oatRow()];
  for (const phrase of [
    "三盒燕麥奶嗎", "三盒燕麦奶吗", "係咪三盒燕麥奶", "Are there three oat milk cartons",
    "can't see three oat milk cartons", "未證實有三盒燕麥奶",
  ]) {
    it(`one anonymous slot and two possible excess: ${phrase}`, () => {
      const result = scene("p1-e", rows, [phrase]);
      expect(result.summary.supportedServingCount).toBe(1);
      for (const row of result.rows) expect(dispositionOf(result, row.rowId).disposition).toBe("alternative");
      expect(result.unresolved.find(group => group.kind === "possible_excess")?.possibleExtraSlots).toBe(2);
      expectTotals(result, { kcal: 116.0243653957, protein: 1.7016906925, carbs: 13.8455742706, fat: 6.0074838083 });
    });
  }

  for (const [phrase, count] of [
    ["兩盒燕麥奶", 2], ["三盒燕麥奶", 3], ["無糖燕麥奶兩盒", 2], ["two oat milk cartons", 2], ["three oat milk cartons", 3],
  ] as const) {
    it(`preserves the positive count ${phrase} -> ${count}`, () => {
      const result = scene("p1-e-pos", rows, [phrase]);
      expect(result.summary.supportedServingCount).toBe(count);
      expect(result.confirmed).toHaveLength(count);
    });
  }

  it("unequal proposals do not use the common-250 shortcut", () => {
    const result = scene("p1-e-uneq", [oatRow("燕麥奶紙盒", 250), oatRow("燕麥奶紙盒", 300), oatRow("燕麥奶紙盒", 250)], ["三盒燕麥奶嗎"]);
    expect(result.confirmed).toHaveLength(0);
    expect(result.unresolved.some(group => group.kind === "exclusive_candidates")).toBe(true);
  });
});

describe("decision commands: binding, staleness and idempotence", () => {
  const rows = [milkRow("前方", 250), milkRow("後方", 400)];
  const base = () => scene("cmd", rows);

  it("rejects a decision bound to another source digest", () => {
    const current = base();
    const group = current.unresolved[0];
    const result = validateServingReconciliation(reconcileMilkServingScene({
      sceneId: "cmd", analysis: analysis(rows),
      decisions: [{ decisionId: "x", sourceDigest: "stale", expectedDecisionRevision: 0,
        command: { kind: "dismiss_group", groupId: group.groupId } }],
    }));
    expect(result.rejectedDecisions).toEqual([{ decisionId: "x", reason: "stale_source_digest" }]);
    expect(result.decisionRevision).toBe(0);
  });

  it("rejects a revision mismatch and unknown targets", () => {
    const current = base();
    const result = validateServingReconciliation(reconcileMilkServingScene({
      sceneId: "cmd", analysis: analysis(rows),
      decisions: [
        { decisionId: "r", sourceDigest: current.sourceDigest, expectedDecisionRevision: 3, command: { kind: "dismiss_group", groupId: current.unresolved[0].groupId } },
        { decisionId: "t", sourceDigest: current.sourceDigest, expectedDecisionRevision: 0, command: { kind: "set_type", targetId: "slot:missing", choice: "whole" } },
      ],
    }));
    expect(result.rejectedDecisions.map(item => item.reason)).toEqual(["stale_decision_revision", "unknown_target"]);
  });

  it("replaying an identical decision id is a no-op; a different payload is a conflict", () => {
    const current = base();
    const group = current.unresolved[0];
    const one = { kind: "one_serving" as const, groupId: group.groupId, portion: { min: 250, max: 250, unit: "ml" as const } };
    const list = decisions(current, [one]);
    const replay = validateServingReconciliation(reconcileMilkServingScene({
      sceneId: "cmd", analysis: analysis(rows), decisions: [...list, { ...list[0] }],
    }));
    expect(replay.decisionRevision).toBe(1);
    expect(replay.rejectedDecisions).toEqual([]);
    const conflicting = validateServingReconciliation(reconcileMilkServingScene({
      sceneId: "cmd", analysis: analysis(rows),
      decisions: [...list, { ...list[0], command: { ...one, portion: { min: 400, max: 400, unit: "ml" } } }],
    }));
    expect(conflicting.rejectedDecisions).toEqual([{ decisionId: list[0].decisionId, reason: "decision_id_conflict" }]);
  });

  it("rejects undo (unsupported in Phase 1) and mismatched separate-serving targets", () => {
    const current = base();
    const group = current.unresolved[0];
    const result = validateServingReconciliation(reconcileMilkServingScene({
      sceneId: "cmd", analysis: analysis(rows),
      decisions: [
        { decisionId: "u", sourceDigest: current.sourceDigest, expectedDecisionRevision: 0, command: { kind: "undo", decisionId: "anything" } },
        { decisionId: "s", sourceDigest: current.sourceDigest, expectedDecisionRevision: 0,
          command: { kind: "separate_servings", groupId: group.groupId, unitIds: ["cand:wrong"] } },
      ],
    }));
    expect(result.rejectedDecisions.map(item => item.reason)).toEqual(["undo_not_supported", "target_mismatch"]);
  });

  it("a type choice on a possible-excess row target is rejected; it cannot promote the row", () => {
    const carton = oatRow("燕麥奶紙盒");
    const unknown = oatRow("白色飲品", 250, { preparationMethod: undefined });
    const current = scene("cmd-d", [carton, unknown]);
    const excess = current.unresolved.find(group => group.kind === "possible_excess")!;
    const result = decide("cmd-d", [carton, unknown], current, [
      { kind: "set_type", targetId: excess.groupId, choice: "oat" },
    ]);
    expect(result.rejectedDecisions.map(item => item.reason)).toEqual(["unknown_target"]);
    expect(result.summary.supportedServingCount).toBe(1);
  });

  it("separating a single-row possible excess with an explicit own amount admits only that row", () => {
    const carton = oatRow("燕麥奶紙盒");
    const unknown = oatRow("白色飲品", 250, { preparationMethod: undefined });
    const current = scene("cmd-d", [carton, unknown]);
    const excess = current.unresolved.find(group => group.kind === "possible_excess")!;
    const result = decide("cmd-d", [carton, unknown], current, [
      { kind: "separate_servings", groupId: excess.groupId, unitIds: excess.candidateIds },
    ]);
    expect(result.summary.supportedServingCount).toBe(2);
    expectTotals(result, { kcal: 232.0487307914 });
  });
});
