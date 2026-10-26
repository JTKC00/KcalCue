import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  confirmedPortionPlan,
  evidenceClaimSchema,
  SERVING_CONTRACT_VERSION,
  SERVING_ENGINE_VERSION,
  SERVING_GRAMMAR_VERSION,
  semanticDecisionView,
  servingDecisionListSchema,
  servingReconciliationSchema,
  stableDigest,
  type ServingReconciliation,
} from "@/lib/domain/milk-serving-contract";
import { milkRow, REFERENCE_250ML } from "@/lib/domain/milk-serving.fixture";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { NutritionService } from "@/lib/nutrition/service";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";

describe("reference vector oracle (catalog cross-check, engine not involved)", () => {
  const service = new NutritionService(new LocalNutritionProvider());
  for (const [choice, display, normalized] of [["whole", "牛奶", "milk"], ["oat", "燕麥奶", "oat milk"], ["soy", "豆漿", "soy milk"]] as const) {
    it(`250 ml ${choice} matches the fixed reference vector`, () => {
      const items = createEditableFoodItems([milkRow(undefined, 250, { displayName: display, normalizedName: normalized })])
        .map(item => ({ ...item, entrySource: "photo" as const, userMilkTypeChoice: choice }));
      const totals = service.calculateMeal(items).totals;
      const expected = REFERENCE_250ML[choice]!;
      expect(totals.calories.max).toBeCloseTo(expected.kcal, 8);
      expect(totals.protein.max).toBeCloseTo(expected.protein, 8);
      expect(totals.carbs.max).toBeCloseTo(expected.carbs, 8);
      expect(totals.fat.max).toBeCloseTo(expected.fat, 8);
    });
  }
});

/**
 * Layer 3: domain state and validation. The valid fixture is hand-built so
 * schema rules are tested independently of the engine.
 */

function validState(): ServingReconciliation {
  const portion = { min: 250, max: 250, unit: "ml" as const, origin: "single_anchored_estimate" as const, purpose: "personal" as const, proofIds: ["c1"] };
  return {
    contractVersion: SERVING_CONTRACT_VERSION,
    engineVersion: SERVING_ENGINE_VERSION,
    grammarVersion: SERVING_GRAMMAR_VERSION,
    sceneId: "s",
    sourceDigest: "d",
    decisionRevision: 0,
    rows: [
      { rowId: "r1", sceneId: "s", originalIndex: 0, semanticKey: "k1", raw: milkRow("a"), subject: { milkCandidate: true, exclusionReason: null } },
      { rowId: "r2", sceneId: "s", originalIndex: 1, semanticKey: "k2", raw: milkRow("b"), subject: { milkCandidate: true, exclusionReason: null } },
    ],
    claims: [{
      claimId: "c1",
      source: { sceneId: "s", rowId: "r1", field: "notes", span: [0, 1], origin: "model_reported", grammarRule: "g", grammarVersion: SERVING_GRAMMAR_VERSION },
      body: { predicate: "presence", subject: { kind: "entity", entityId: "ent:r1" }, content: "milk" },
      polarity: "affirmative",
      scopeId: "scene",
      usableFor: ["existence"],
      refusalReasons: [],
      contradictsClaimIds: [],
    }],
    candidates: ["r1", "r2"].map(rowId => ({
      candidateId: `cand:${rowId}`,
      referent: { kind: "entity" as const, entityId: `ent:${rowId}` },
      rowIds: [rowId],
      existence: { state: "resolved" as const, value: "present" as const, proofIds: ["c1"] },
      family: { state: "unknown" as const, claimIds: [] },
      vessel: { state: "unknown" as const, claimIds: [] },
      quantityProposals: [],
      possibleSameAs: [],
    })),
    supportedSlots: [{
      slotId: "slot1",
      scopeId: "scene",
      basis: "direct_witness",
      proofIds: ["c1"],
      sourceCandidateIds: ["cand:r1"],
      multiplicity: 1,
      family: { state: "resolved", value: { family: "dairy", qualifier: "whole" }, proofIds: ["c1"] },
      portion: { state: "resolved", value: portion, proofIds: ["c1"] },
      profile: { state: "resolved", value: "whole", proofIds: ["c1"] },
      status: "confirmed",
      pendingReasons: [],
    }],
    confirmed: [{
      unitId: "unit1", slotIds: ["slot1"], profileId: "whole", portion, multiplicity: 1, confirmation: "evidence_admitted", proofIds: ["c1"],
    }],
    unresolved: [{
      groupId: "g1", kind: "possible_excess", candidateIds: ["cand:r2"], slotIds: [], possibleTargetSlotIds: ["slot1"],
      amountAlternatives: [], excludedProposalIds: [], supportedCount: 0, possibleExtraSlots: 1, selectedCandidateId: null,
      reasonCodes: ["no_independent_serving_proof"],
    }],
    dispositions: [
      { rowId: "r1", disposition: "used_as_evidence", slotIds: ["slot1"], groupIds: [], reasonCodes: [] },
      { rowId: "r2", disposition: "possible_excess", slotIds: [], groupIds: ["g1"], reasonCodes: [] },
    ],
    acceptedDecisions: [],
    rejectedDecisions: [],
    summary: { supportedServingCount: 1, confirmedServingCount: 1, pendingSlotCount: 0, unresolvedGroupCount: 1, cardinalityReviewRequired: false, reasonCodes: [] },
  };
}

function invalid(mutate: (state: ServingReconciliation & Record<string, unknown>) => void): boolean {
  const state = structuredClone(validState()) as ServingReconciliation & Record<string, unknown>;
  mutate(state);
  return !servingReconciliationSchema.safeParse(state).success;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };
const m = <T,>(value: T) => value as Mutable<T>;

describe("serving contract schema", () => {
  it("accepts the hand-built valid state", () => {
    expect(servingReconciliationSchema.safeParse(validState()).success).toBe(true);
  });

  it("requires exactly one explicit disposition per row", () => {
    expect(invalid(state => { m(state).dispositions = state.dispositions.slice(0, 1); })).toBe(true);
    expect(invalid(state => { m(state).dispositions = [...state.dispositions, state.dispositions[0]]; })).toBe(true);
  });

  it("rejects duplicate ids", () => {
    expect(invalid(state => { m(state).rows = [state.rows[0], { ...state.rows[1], rowId: "r1" }]; })).toBe(true);
    expect(invalid(state => { m(state).candidates = [state.candidates[0], state.candidates[0]]; })).toBe(true);
  });

  it("rejects an unresolved group with a selected candidate", () => {
    expect(invalid(state => { (state.unresolved[0] as unknown as Record<string, unknown>).selectedCandidateId = "cand:r2"; })).toBe(true);
  });

  it("rejects a confirmed slot without a resolved portion or profile", () => {
    expect(invalid(state => { m(state.supportedSlots[0]).portion = { state: "unknown", claimIds: [] }; })).toBe(true);
    expect(invalid(state => { m(state.supportedSlots[0]).profile = { state: "unknown", claimIds: [] }; })).toBe(true);
  });

  it("rejects a pending slot used by a confirmed unit", () => {
    expect(invalid(state => {
      m(state.supportedSlots[0]).status = "pending";
      m(state.supportedSlots[0]).pendingReasons = ["portion_required"];
    })).toBe(true);
  });

  it("rejects a pending slot without a reason", () => {
    expect(invalid(state => {
      m(state).confirmed = [];
      m(state.supportedSlots[0]).status = "pending";
      m(state.summary).confirmedServingCount = 0;
      m(state.summary).pendingSlotCount = 1;
    })).toBe(true);
  });

  it("rejects references to unknown slots, groups and candidates", () => {
    expect(invalid(state => { m(state.dispositions[0]).slotIds = ["nope"]; })).toBe(true);
    expect(invalid(state => { m(state.dispositions[1]).groupIds = ["nope"]; })).toBe(true);
    expect(invalid(state => { m(state.unresolved[0]).candidateIds = ["nope"]; })).toBe(true);
    expect(invalid(state => { m(state.unresolved[0]).possibleTargetSlotIds = ["nope"]; })).toBe(true);
  });

  it("rejects inconsistent summaries and revisions", () => {
    expect(invalid(state => { m(state.summary).supportedServingCount = 2; })).toBe(true);
    expect(invalid(state => { m(state.summary).confirmedServingCount = 0; })).toBe(true);
    expect(invalid(state => { m(state).decisionRevision = 1; })).toBe(true);
  });

  it("rejects unknown fields (no client-authored admission flags)", () => {
    expect(invalid(state => { state.includedInTotal = true; })).toBe(true);
    expect(invalid(state => { (state.supportedSlots[0] as unknown as Record<string, unknown>).admitted = true; })).toBe(true);
  });

  it("rejects portions with max below min and non-positive amounts", () => {
    expect(invalid(state => { m(state.confirmed[0]).portion = { ...state.confirmed[0].portion, min: 300, max: 200 }; })).toBe(true);
    expect(invalid(state => { m(state.confirmed[0]).portion = { ...state.confirmed[0].portion, min: 0, max: 0 }; })).toBe(true);
  });

  it("rejects cardinality outside 1..9 and non-integer counts", () => {
    const claim = validState().claims[0];
    for (const count of [0, 10, 2.5]) {
      expect(evidenceClaimSchema.safeParse({
        ...claim,
        body: { predicate: "cardinality", population: { kind: "unbound", possibleEntityIds: [] }, relation: "exact", count },
        usableFor: [],
        refusalReasons: ["x"],
      }).success).toBe(false);
    }
  });

  it("rejects non-affirmative claims usable for count or existence", () => {
    const claim = validState().claims[0];
    expect(evidenceClaimSchema.safeParse({ ...claim, polarity: "questioned" }).success).toBe(false);
    expect(evidenceClaimSchema.safeParse({ ...claim, usableFor: [], refusalReasons: [] }).success).toBe(false);
  });

  it("bounds the decision list and validates commands", () => {
    const decision = { decisionId: "d", sourceDigest: "x", expectedDecisionRevision: 0, command: { kind: "dismiss_group", groupId: "g" } };
    expect(servingDecisionListSchema.safeParse([decision]).success).toBe(true);
    expect(servingDecisionListSchema.safeParse(Array.from({ length: 65 }, () => decision)).success).toBe(false);
    expect(servingDecisionListSchema.safeParse([{ ...decision, command: { kind: "set_type", targetId: "s", choice: "almond" } }]).success).toBe(false);
    expect(servingDecisionListSchema.safeParse([{ ...decision, command: { kind: "one_serving", groupId: "g", portion: { min: 400, max: 250, unit: "ml" } } }]).success).toBe(false);
  });
});

describe("stable identity helpers", () => {
  it("canonical JSON sorts keys recursively and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"z":1}]},"b":1}');
  });

  it("digests are stable 32-hex identities and sensitive to content", () => {
    expect(stableDigest("牛奶")).toMatch(/^[0-9a-f]{32}$/);
    expect(stableDigest("牛奶")).toBe(stableDigest("牛奶"));
    expect(stableDigest("牛奶")).not.toBe(stableDigest("牛 奶"));
  });

  it("semantic view ignores audit-only row indices", () => {
    const a = validState();
    const b = structuredClone(a);
    m(b.rows[0]).originalIndex = 1;
    m(b.rows[1]).originalIndex = 0;
    expect(semanticDecisionView(b)).toEqual(semanticDecisionView(a));
  });

  it("confirmed portion plan lists only confirmed units, sorted", () => {
    expect(confirmedPortionPlan(validState())).toEqual([{ profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 }]);
  });
});
