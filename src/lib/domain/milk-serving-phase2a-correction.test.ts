import { describe, expect, it } from "vitest";
import {
  confirmedPortionPlan,
  servingReconciliationSchema,
  validateServingReconciliation,
  type ServingReconciliation,
  type UserServingDecision,
} from "@/lib/domain/milk-serving-contract";
import { reconcileMilkServingScene } from "@/lib/domain/milk-serving-reconciliation";
import { analysis, decisions, milkRow, referenceTotals, wholeRow } from "@/lib/domain/milk-serving.fixture";
import { preparePhotoMilkAnalysis } from "@/lib/domain/photo-milk-analysis";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { NutritionService } from "@/lib/nutrition/service";

// Synthetic domain tests only. No Shadow runtime, persistence or external calls.
const single = () => reconcileMilkServingScene({
  sceneId: "phase2a-single", analysis: analysis([wholeRow("玻璃杯裝全脂牛奶", 250)]),
});
const aggregate = () => reconcileMilkServingScene({
  sceneId: "phase2a-aggregate",
  analysis: analysis([wholeRow("三杯合共飲用了600ml", 600, { preparationMethod: undefined })]),
});
const distinct = () => reconcileMilkServingScene({
  sceneId: "phase2a-distinct",
  analysis: analysis([wholeRow("左邊藍色圓點玻璃杯裝全脂牛奶", 250), wholeRow("右邊星形貼紙玻璃杯裝全脂牛奶", 400)]),
});
const clone = (value: ServingReconciliation) => structuredClone(value);

describe("Phase 2A confirmed-slot ownership boundary", () => {
  it("rejects independent confirmed units consuming one slot even with adjusted summary", () => {
    const base = single();
    expect(validateServingReconciliation(base).confirmed).toHaveLength(1);
    expect(referenceTotals(confirmedPortionPlan(base)).max.kcal).toBeCloseTo(157.075, 8);
    const forged = { ...base,
      confirmed: [...base.confirmed, { ...base.confirmed[0], unitId: "forged-new-unit" }],
      summary: { ...base.summary, confirmedServingCount: 2 },
    };
    expect(servingReconciliationSchema.safeParse(forged).success).toBe(false);
  });

  it("refuses invalid ownership at the portion-plan boundary instead of deduplicating", () => {
    const base = single();
    const forged = { ...base,
      confirmed: [...base.confirmed, { ...base.confirmed[0], unitId: "forged-new-unit" }],
      summary: { ...base.summary, confirmedServingCount: 2 },
    };
    expect(() => confirmedPortionPlan(forged)).toThrow();
  });

  it("rejects repeated slot IDs within one confirmed unit", () => {
    const base = single();
    const forged = { ...base, confirmed: [{ ...base.confirmed[0], slotIds: [base.supportedSlots[0].slotId, base.supportedSlots[0].slotId] }] };
    expect(servingReconciliationSchema.safeParse(forged).success).toBe(false);
  });

  it("rejects a single unit silently covering two separately measured slots", () => {
    const base = distinct();
    expect(base.confirmed).toHaveLength(2);
    // Equalise the portion so pre-existing portion-drift validation cannot mask ownership.
    const second = { ...base.supportedSlots[1], portion: base.supportedSlots[0].portion };
    const forged = { ...base, supportedSlots: [base.supportedSlots[0], second],
      confirmed: [{ ...base.confirmed[0], slotIds: base.supportedSlots.map(slot => slot.slotId) }],
      summary: { ...base.summary, confirmedServingCount: 1 },
    };
    expect(servingReconciliationSchema.safeParse(forged).success).toBe(false);
  });

  it.each(["row", "claim", "candidate", "slot", "group", "unit", "accepted decision"])("rejects duplicate %s identifiers", kind => {
    const base = single();
    const group = {
      groupId: "group-test", kind: "possible_excess", candidateIds: [], slotIds: [], possibleTargetSlotIds: [],
      amountAlternatives: [], excludedProposalIds: [], supportedCount: 0, possibleExtraSlots: 1,
      selectedCandidateId: null, reasonCodes: ["test"],
    } as const;
    const decision: UserServingDecision = { decisionId: "decision-test", sourceDigest: base.sourceDigest,
      expectedDecisionRevision: 0, command: { kind: "set_type", targetId: base.supportedSlots[0].slotId, choice: "whole" } };
    const forged = {
      ...base,
      ...(kind === "row" ? { rows: [...base.rows, base.rows[0]] } : {}),
      ...(kind === "claim" ? { claims: [...base.claims, base.claims[0]] } : {}),
      ...(kind === "candidate" ? { candidates: [...base.candidates, base.candidates[0]] } : {}),
      ...(kind === "slot" ? { supportedSlots: [...base.supportedSlots, base.supportedSlots[0]], summary: { ...base.summary, supportedServingCount: 2 } } : {}),
      ...(kind === "group" ? { unresolved: [group, group], summary: { ...base.summary, unresolvedGroupCount: 2 } } : {}),
      ...(kind === "unit" ? { confirmed: [...base.confirmed, base.confirmed[0]], summary: { ...base.summary, confirmedServingCount: 2 } } : {}),
      ...(kind === "accepted decision" ? { acceptedDecisions: [decision, { ...decision, expectedDecisionRevision: 1 }], decisionRevision: 2 } : {}),
    };
    const parsed = servingReconciliationSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some(issue => issue.message.includes(`duplicate ${kind} id`))).toBe(true);
  });

  it.each(["unit multiplicity", "slot multiplicity", "summary confirmed", "summary supported", "summary pending", "summary unresolved", "orphan confirmed slot", "pending owner", "dismissed owner", "missing owner"])("rejects %s inconsistency", kind => {
    const base = single();
    const forged = clone(base);
    if (kind === "unit multiplicity") forged.confirmed[0].multiplicity = 2;
    if (kind === "slot multiplicity") forged.supportedSlots[0].multiplicity = 2;
    if (kind === "summary confirmed") forged.summary.confirmedServingCount = 2;
    if (kind === "summary supported") forged.summary.supportedServingCount = 2;
    if (kind === "summary pending") forged.summary.pendingSlotCount = 1;
    if (kind === "summary unresolved") forged.summary.unresolvedGroupCount = 1;
    if (kind === "orphan confirmed slot") {
      expect(servingReconciliationSchema.safeParse({ ...base, confirmed: [], summary: { ...base.summary, confirmedServingCount: 0 } }).success).toBe(false);
      return;
    }
    if (kind === "pending owner") {
      forged.supportedSlots[0].status = "pending";
      forged.supportedSlots[0].pendingReasons = ["test"];
      forged.summary.pendingSlotCount = 1;
    }
    if (kind === "dismissed owner") { forged.supportedSlots[0].status = "dismissed"; forged.summary.supportedServingCount = 0; }
    if (kind === "missing owner") forged.confirmed[0].slotIds = ["slot:missing"];
    expect(servingReconciliationSchema.safeParse(forged).success).toBe(false);
  });

  it("preserves aggregate-consumed 600 ml as one unit owning one slot with multiplicity three", () => {
    const base = validateServingReconciliation(aggregate());
    expect(base.supportedSlots).toHaveLength(1);
    expect(base.summary.supportedServingCount).toBe(3);
    expect(base.summary.confirmedServingCount).toBe(1); // V1 field counts accounting units.
    expect(confirmedPortionPlan(base)).toEqual([
      { profileId: "whole", min: 600, max: 600, unit: "ml", purpose: "aggregate_consumed", multiplicity: 3 },
    ]);
    expect(referenceTotals(confirmedPortionPlan(base)).max).toEqual({ kcal: 376.98, protein: 19.776, carbs: 29.664, fat: 20.394 });
    const forged = { ...base, confirmed: [...base.confirmed, { ...base.confirmed[0], unitId: "aggregate-copy" }], summary: { ...base.summary, confirmedServingCount: 2 } };
    expect(servingReconciliationSchema.safeParse(forged).success).toBe(false);
  });

  it("preserves two distinct physical slots and their different portions", () => {
    const base = validateServingReconciliation(distinct());
    expect(base.confirmed).toHaveLength(2);
    expect(new Set(base.confirmed.flatMap(unit => unit.slotIds)).size).toBe(2);
    expect(referenceTotals(confirmedPortionPlan(base)).max.kcal).toBeCloseTo(408.395, 8);
  });
});

describe("Phase 2A semantic-comparison witnesses (no comparator implementation)", () => {
  it("equal physical counts do not establish equivalent kcal or macros: packaging 1 L vs consumed 250 ml", () => {
    const raw = analysis([wholeRow("飲了250ml（包裝標示容量1L）", 1000, { preparationMethod: "紙盒" })]);
    const result = reconcileMilkServingScene({ sceneId: "phase2a-capacity", analysis: raw });
    expect(confirmedPortionPlan(result)).toEqual([
      { profileId: "whole", min: 250, max: 250, unit: "ml", purpose: "personal", multiplicity: 1 },
    ]);
    const legacy = new NutritionService(new LocalNutritionProvider()).calculateMeal(
      createEditableFoodItems(preparePhotoMilkAnalysis(raw).foods)
        .map(item => ({ ...item, entrySource: "photo" as const, userMilkTypeChoice: "whole" as const })),
    );
    expect(legacy.includedCount).toBe(1);
    expect(result.confirmed.reduce((n, unit) => n + unit.multiplicity, 0)).toBe(1);
    expect(legacy.coverage).toBe("complete");
    const expectedLegacy = { calories: 628.3, protein: 32.96, carbs: 49.44, fat: 33.99 };
    for (const key of ["calories", "protein", "carbs", "fat"] as const) expect(legacy.totals[key].max).toBeCloseTo(expectedLegacy[key], 8);
    expect(referenceTotals(confirmedPortionPlan(result)).max).toEqual({ kcal: 157.075, protein: 8.24, carbs: 12.36, fat: 8.4975 });
  });

  it("unresolved exclusive quantities contribute zero to all confirmed nutrients", () => {
    const result = reconcileMilkServingScene({ sceneId: "phase2a-exclusive", analysis: analysis([
      milkRow("前方", 250), milkRow("後方", 400),
    ]) });
    expect(result.unresolved.some(group => group.kind === "exclusive_candidates")).toBe(true);
    expect(result.supportedSlots.some(slot => slot.status === "pending")).toBe(true);
    expect(confirmedPortionPlan(result)).toEqual([]);
    expect(referenceTotals(confirmedPortionPlan(result))).toEqual({
      min: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, max: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    }); // A known empty confirmed subtotal, never the unknown full meal total.
  });
});

describe("Phase 2A accepted-history decision ID policy", () => {
  const sceneId = "phase2a-decisions";
  const raw = analysis([milkRow("前方", 250), milkRow("後方", 400)]);
  const base = () => reconcileMilkServingScene({ sceneId, analysis: raw });
  const resolve = () => {
    const initial = base();
    return decisions(initial, [{ kind: "one_serving", groupId: initial.unresolved.find(group => group.kind === "exclusive_candidates")!.groupId,
      portion: { min: 250, max: 250, unit: "ml" } }], "accepted")[0];
  };

  it("rejected ID reuse with a corrected body is allowed, with no revision consumed by rejection", () => {
    const corrected = resolve();
    const rejected = { ...corrected, sourceDigest: "stale", command: { kind: "dismiss_group" as const, groupId: "missing" } };
    const result = reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [rejected, corrected] });
    expect(result.rejectedDecisions).toEqual([{ decisionId: corrected.decisionId, reason: "stale_source_digest" }]);
    expect(result.acceptedDecisions).toEqual([corrected]);
    expect(result.decisionRevision).toBe(1);
    expect(validateServingReconciliation(result)).toEqual(result);
  });

  it("accepted identical replay is a no-op; changed body, digest or revision is a conflict", () => {
    const accepted = resolve();
    const same = reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [accepted, accepted] });
    expect(same.acceptedDecisions).toEqual([accepted]);
    expect(same.rejectedDecisions).toEqual([]);
    for (const changed of [
      { ...accepted, expectedDecisionRevision: 1 },
      { ...accepted, sourceDigest: "changed" },
      { ...accepted, command: { kind: "dismiss_group" as const, groupId: "changed" } },
    ]) {
      const result = reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [accepted, changed] });
      expect(result.decisionRevision).toBe(1);
      expect(result.rejectedDecisions).toEqual([{ decisionId: accepted.decisionId, reason: "decision_id_conflict" }]);
    }
  });

  it("a new call reconstructs from the full accepted history; it is not a durable revision store", () => {
    const accepted = resolve();
    const once = reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [accepted] });
    const missingHistory = reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [{ ...accepted, decisionId: "new", expectedDecisionRevision: 1 }] });
    expect(missingHistory.decisionRevision).toBe(0);
    expect(missingHistory.rejectedDecisions[0].reason).toBe("stale_decision_revision");
    expect(reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [accepted] })).toEqual(once);
  });

  it("rejects stale source, changed scene and unsupported undo without changing nutrition", () => {
    const accepted = resolve();
    const changedScene = reconcileMilkServingScene({ sceneId: "other-meal", analysis: raw, decisions: [accepted] });
    expect(changedScene.acceptedDecisions).toEqual([]);
    expect(changedScene.rejectedDecisions[0].reason).toBe("stale_source_digest");
    const undo = { ...accepted, command: { kind: "undo" as const, decisionId: "old" } };
    const result = reconcileMilkServingScene({ sceneId, analysis: raw, decisions: [undo] });
    expect(result.decisionRevision).toBe(0);
    expect(result.rejectedDecisions[0].reason).toBe("undo_not_supported");
    expect(confirmedPortionPlan(result)).toEqual(confirmedPortionPlan(base()));
    // Account ownership is deliberately absent from the pure engine: host authorization is a future gate.
  });
});
