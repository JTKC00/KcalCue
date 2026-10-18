import {
  canonicalJson,
  compareCanonical,
  evidenceClaimSchema,
  MAX_OBSERVED_ROWS,
  rowEntityId,
  SERVING_CONTRACT_VERSION,
  SERVING_ENGINE_VERSION,
  SERVING_GRAMMAR_VERSION,
  servingDecisionListSchema,
  ServingContractError,
  sortedUnique,
  stableDigest,
  validateServingReconciliation,
  type Assessment,
  type ConfirmedServing,
  type EvidenceClaim,
  type FamilyValue,
  type MilkFamily,
  type ObservedFoodRow,
  type PhysicalServingCandidate,
  type PortionInput,
  type QuantityProposal,
  type Referent,
  type ResolvedPortion,
  type RowDisposition,
  type RowDispositionKind,
  type ServingProfileId,
  type ServingReconciliation,
  type SlotBasis,
  type SupportedServingSlot,
  type UnresolvedKind,
  type UnresolvedServing,
  type UserServingDecision,
  type UserTypeChoice,
  type VesselKind,
} from "@/lib/domain/milk-serving-contract";
import { interpretServingEvidence, vesselClass, type ServingSceneInput } from "@/lib/domain/milk-serving-evidence";

/**
 * Pure physical-serving reconciliation (Phase 1 domain engine).
 *
 * Reads typed claims only; never raw text, row order or model confidence.
 * Serving count grows only through direct object witnesses with pairwise
 * distinct certificates, admitted affirmative cardinality, a single presence
 * floor, or explicit user commands. Possible-reference relations are never
 * unioned. Unknown rows never become confirmed by becoming singletons.
 */

export interface TypedServingInput {
  sceneId: string;
  rows: readonly ObservedFoodRow[];
  claims: readonly EvidenceClaim[];
  decisions?: readonly UserServingDecision[];
}

// ---------------------------------------------------------------------------
// Entity facts derived from admitted claims
// ---------------------------------------------------------------------------

type Side = "front" | "back" | "left" | "right";
const OPPOSITE: Record<Side, Side> = { front: "back", back: "front", left: "right", right: "left" };

interface EntityFacts {
  rowId: string;
  entityId: string;
  candidateId: string;
  presenceProofs: string[];
  blocking: { content: "non_drink" | "empty"; proofs: string[] } | null;
  vessels: Map<VesselKind, string[]>;
  families: Array<{ value: FamilyValue; claimId: string; label: boolean }>;
  sides: Map<Side, string[]>;
  viewOrPart: boolean;
  sameMarked: boolean;
  deniesDifferent: boolean;
  stockSource: boolean;
  personal: QuantityProposal[];
  aggregate: QuantityProposal[];
  allProposals: QuantityProposal[];
  entityCount: { count: number; claimId: string } | null;
}

const isEntity = (referent: Referent, entityId: string) => referent.kind === "entity" && referent.entityId === entityId;
const admitted = (claim: EvidenceClaim, use: EvidenceClaim["usableFor"][number]) =>
  claim.polarity === "affirmative" && claim.usableFor.includes(use);
const unboundCounterpart = (left: Referent, right: Referent, entityId: string) =>
  (isEntity(left, entityId) && right.kind !== "entity") || (isEntity(right, entityId) && left.kind !== "entity");

function buildFacts(row: ObservedFoodRow, claims: readonly EvidenceClaim[]): EntityFacts {
  const entityId = rowEntityId(row.rowId);
  const facts: EntityFacts = {
    rowId: row.rowId,
    entityId,
    candidateId: `cand:${row.rowId}`,
    presenceProofs: [],
    blocking: null,
    vessels: new Map(),
    families: [],
    sides: new Map(),
    viewOrPart: false,
    sameMarked: false,
    deniesDifferent: false,
    stockSource: false,
    personal: [],
    aggregate: [],
    allProposals: [],
    entityCount: null,
  };
  for (const claim of claims) {
    const body = claim.body;
    switch (body.predicate) {
      case "presence":
        if (!isEntity(body.subject, entityId) || !admitted(claim, "existence")) break;
        if (body.content === "milk" || body.content === "white_drink") facts.presenceProofs.push(claim.claimId);
        if (body.content === "non_drink" || body.content === "empty") {
          facts.blocking = { content: facts.blocking?.content ?? body.content, proofs: [...(facts.blocking?.proofs ?? []), claim.claimId] };
        }
        break;
      case "vessel":
        if (isEntity(body.subject, entityId) && admitted(claim, "existence") && body.vessel !== "unknown") {
          facts.vessels.set(body.vessel, [...(facts.vessels.get(body.vessel) ?? []), claim.claimId]);
        }
        break;
      case "family":
        if (isEntity(body.subject, entityId) && admitted(claim, "family")) {
          facts.families.push({
            value: { family: body.family, qualifier: body.qualifier },
            claimId: claim.claimId,
            label: claim.source.field === "displayName" || claim.source.field === "normalizedName",
          });
        }
        break;
      case "spatial":
        if (!isEntity(body.subject, entityId)) break;
        if (body.relation === "view" || body.relation === "part") {
          facts.viewOrPart = true;
        } else if (admitted(claim, "separate_identity") && body.relativeTo === "scene") {
          facts.sides.set(body.relation, [...(facts.sides.get(body.relation) ?? []), claim.claimId]);
        }
        break;
      case "same_vessel":
        // Restrictions may be read from refused claims; they never add support.
        // A bound pair only restricts that pair (see relationIndex).
        if (claim.polarity === "affirmative" && unboundCounterpart(body.left, body.right, entityId)) facts.sameMarked = true;
        break;
      case "different_vessel":
        if (claim.polarity === "negative" && unboundCounterpart(body.left, body.right, entityId)) facts.deniesDifferent = true;
        break;
      case "stock_transfer":
        if (claim.polarity === "affirmative" && isEntity(body.from, entityId)) facts.stockSource = true;
        break;
      case "quantity": {
        const proposal = body.proposal;
        if (!isEntity(proposal.target, entityId)) break;
        facts.allProposals.push(proposal);
        if (!admitted(claim, "portion") || proposal.min === null || proposal.max === null) break;
        if (proposal.purpose === "row_personal_estimate") facts.personal.push(proposal);
        if (proposal.purpose === "aggregate_consumed") facts.aggregate.push(proposal);
        break;
      }
      case "cardinality":
        if (isEntity(body.population, entityId) && admitted(claim, "count")) {
          facts.entityCount = { count: body.count, claimId: claim.claimId };
        }
        break;
      default:
        break;
    }
  }
  facts.allProposals.sort((a, b) => (a.proposalId < b.proposalId ? -1 : 1));
  return facts;
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

const familyKey = (value: FamilyValue) => `${value.family}:${value.qualifier ?? "-"}`;

function familyAssessment(facts: EntityFacts): { assessment: Assessment<FamilyValue>; refined: boolean } {
  if (facts.families.length === 0) return { assessment: { state: "unknown", claimIds: [] }, refined: false };
  const labelGeneric = facts.families.some(item => item.label && item.value.family === "generic_milk");
  const specific = facts.families.filter(item => item.value.family !== "generic_milk" && item.value.family !== "unknown");
  const blend = specific.filter(item => item.value.family === "blend");
  const pool = blend.length > 0 ? blend : specific;
  const distinct = new Map<string, { value: FamilyValue; proofs: string[] }>();
  for (const item of pool) {
    const key = familyKey(item.value);
    distinct.set(key, { value: item.value, proofs: [...(distinct.get(key)?.proofs ?? []), item.claimId] });
  }
  const allIds = sortedUnique(facts.families.map(item => item.claimId));
  if (distinct.size === 0) {
    return { assessment: { state: "resolved", value: { family: "generic_milk", qualifier: null }, proofIds: allIds }, refined: false };
  }
  if (distinct.size === 1) {
    const [only] = distinct.values();
    return { assessment: { state: "resolved", value: only.value, proofIds: sortedUnique(only.proofs) }, refined: labelGeneric };
  }
  const alternatives = [...distinct.values()].map(item => item.value).sort(compareCanonical);
  return { assessment: { state: "conflict", alternatives, claimIds: allIds }, refined: labelGeneric };
}

function vesselAssessment(facts: EntityFacts): Assessment<VesselKind> {
  const kinds = [...facts.vessels.keys()].sort();
  const proofs = sortedUnique([...facts.vessels.values()].flat());
  if (kinds.length === 0) return { state: "unknown", claimIds: [] };
  const concrete = kinds.filter(kind => kind !== "container");
  const classes = new Set(concrete.map(vesselClass));
  if (concrete.length === 0) return { state: "resolved", value: "container", proofIds: proofs };
  if (classes.size === 1) {
    const value = concrete.includes("glass") ? "glass" : concrete[0];
    return { state: "resolved", value, proofIds: proofs };
  }
  return { state: "conflict", alternatives: concrete, claimIds: proofs };
}

const amountKey = (proposal: QuantityProposal) => `${proposal.min}|${proposal.max}|${proposal.unit}|${proposal.purpose}`;

function distinctByAmount(proposals: readonly QuantityProposal[]): QuantityProposal[] {
  const byKey = new Map<string, QuantityProposal>();
  for (const proposal of [...proposals].sort((a, b) => (a.proposalId < b.proposalId ? -1 : 1))) {
    if (!byKey.has(amountKey(proposal))) byKey.set(amountKey(proposal), proposal);
  }
  return [...byKey.values()].sort(compareCanonical);
}

interface PortionReading {
  assessment: Assessment<ResolvedPortion>;
  alternatives: QuantityProposal[];
  reason: string | null;
}

function toPortion(proposal: QuantityProposal, origin: ResolvedPortion["origin"], proofs: string[]): ResolvedPortion {
  return {
    min: proposal.min!,
    max: proposal.max!,
    unit: proposal.unit,
    origin,
    purpose: proposal.purpose === "aggregate_consumed" ? "aggregate_consumed" : "personal",
    proofIds: sortedUnique(proofs),
  };
}

function portionReading(facts: EntityFacts): PortionReading {
  const candidates = facts.aggregate.length > 0 ? [...facts.aggregate, ...facts.personal] : facts.personal;
  const distinct = distinctByAmount(candidates);
  if (distinct.length === 0) {
    const basisUnknown = facts.allProposals.some(item => item.purpose === "unknown" && item.min !== null);
    return { assessment: { state: "unknown", claimIds: [] }, alternatives: [], reason: basisUnknown ? "quantity_basis_unknown" : "portion_required" };
  }
  if (distinct.length === 1) {
    const proofs = candidates.filter(item => amountKey(item) === amountKey(distinct[0])).flatMap(item => item.claimIds);
    return { assessment: { state: "resolved", value: toPortion(distinct[0], "single_anchored_estimate", proofs), proofIds: sortedUnique(proofs) }, alternatives: distinct, reason: null };
  }
  const alternatives = distinct.map(item => toPortion(item, "single_anchored_estimate", [...item.claimIds]));
  return {
    assessment: { state: "conflict", alternatives, claimIds: sortedUnique(candidates.flatMap(item => item.claimIds)) },
    alternatives: distinct,
    reason: "same_target_quantity_conflict",
  };
}

const PROFILE_BY_FAMILY: Record<string, ServingProfileId> = {
  "dairy:whole": "whole",
  "dairy:low_fat": "low-fat",
  "oat:-": "oat",
  "soy:-": "soy",
};

function familiesCompatible(a: MilkFamily, b: MilkFamily): boolean {
  return a === "generic_milk" || a === "unknown" || b === "generic_milk" || b === "unknown" || a === b;
}

function familyCompatibleWith(population: MilkFamily, assessment: Assessment<FamilyValue>): boolean {
  if (assessment.state === "unknown") return true;
  if (assessment.state === "resolved") return familiesCompatible(population, assessment.value.family);
  return assessment.alternatives.some(value => familiesCompatible(population, value.family));
}

function vesselsCompatible(a: VesselKind, b: VesselKind): boolean {
  if (a === "unknown" || b === "unknown" || a === "container" || b === "container") return true;
  return vesselClass(a) === vesselClass(b);
}

// ---------------------------------------------------------------------------
// Working model (mutable during decision application only)
// ---------------------------------------------------------------------------

interface WorkSlot {
  slotId: string;
  scopeId: string;
  basis: SlotBasis;
  sourceRowIds: string[];
  proofIds: string[];
  multiplicity: number;
  family: Assessment<FamilyValue>;
  refined: boolean;
  portion: Assessment<ResolvedPortion>;
  portionReason: string | null;
  userType?: UserTypeChoice;
  userPortion?: PortionInput;
  requiresUserPortion: boolean;
  dismissed: boolean;
  /** Blocks nutrition admission without deleting the witness or its portion. */
  nutritionHolds: string[];
}

interface WorkGroup {
  groupId: string;
  kind: UnresolvedKind;
  rowIds: string[];
  extraCandidateIds: string[];
  slotIds: string[];
  possibleTargetSlotIds: string[];
  amountAlternatives: QuantityProposal[];
  excludedProposalIds: string[];
  supportedCount: number;
  possibleExtraSlots: number;
  reasonCodes: string[];
  closed: "open" | "resolved" | "dismissed";
  /** Overflow group attached to an anonymous slot group. */
  overflowOf?: string;
}

interface Model {
  facts: Map<string, EntityFacts>;
  familyOf: Map<string, { assessment: Assessment<FamilyValue>; refined: boolean }>;
  slots: Map<string, WorkSlot>;
  groups: Map<string, WorkGroup>;
  rowOverrides: Map<string, { disposition: RowDispositionKind; slotIds: string[]; reason: string }>;
  reasonCodes: Set<string>;
  cardinalityReviewRequired: boolean;
  nearbyCandidates: PhysicalServingCandidate[];
}

function groupId(kind: UnresolvedKind, members: readonly string[]): string {
  return `grp:${kind}:${stableDigest(canonicalJson(sortedUnique(members)))}`;
}

// ---------------------------------------------------------------------------
// Distinct certificates and relation conflicts
// ---------------------------------------------------------------------------

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface RelationIndex {
  boundDifferent: Set<string>;
  boundSame: Set<string>;
  conflictClusters: string[][];
}

function relationIndex(claims: readonly EvidenceClaim[], entityToRow: Map<string, string>): RelationIndex {
  const boundDifferent = new Set<string>();
  const boundSame = new Set<string>();
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const claim of claims) {
    const body = claim.body;
    if (body.predicate !== "same_vessel" && body.predicate !== "different_vessel") continue;
    if (body.left.kind !== "entity" || body.right.kind !== "entity") continue;
    const left = entityToRow.get(body.left.entityId);
    const right = entityToRow.get(body.right.entityId);
    if (!left || !right || left === right) continue;
    if (body.predicate === "different_vessel" && claim.polarity === "negative") boundSame.add(pairKey(left, right));
    if (claim.polarity !== "affirmative") continue;
    if (body.predicate === "different_vessel" && claim.usableFor.includes("separate_identity")) boundDifferent.add(pairKey(left, right));
    if (body.predicate === "same_vessel") {
      boundSame.add(pairKey(left, right));
      for (const node of [left, right]) if (!parent.has(node)) parent.set(node, node);
      const a = find(left);
      const b = find(right);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  // Same-components are used only to detect contradictions, never to merge servings.
  const components = new Map<string, string[]>();
  for (const node of parent.keys()) components.set(find(node), [...(components.get(find(node)) ?? []), node]);
  const conflictClusters: string[][] = [];
  for (const members of components.values()) {
    const sorted = members.slice().sort();
    const contradicted = sorted.some((a, i) => sorted.slice(i + 1).some(b => boundDifferent.has(pairKey(a, b))));
    if (contradicted) conflictClusters.push(sorted);
  }
  return { boundDifferent, boundSame, conflictClusters: conflictClusters.sort(compareCanonical) };
}

function distinctCertificate(a: EntityFacts, b: EntityFacts, vA: VesselKind, vB: VesselKind, relations: RelationIndex, conflicted: Set<string>): boolean {
  const key = pairKey(a.rowId, b.rowId);
  if (conflicted.has(a.rowId) && conflicted.has(b.rowId)) return false;
  if (relations.boundSame.has(key)) return false;
  // C1: explicit bound distinctness between two own-drink witnesses.
  if (relations.boundDifferent.has(key)) return true;
  if (a.sameMarked || b.sameMarked || a.deniesDifferent || b.deniesDifferent) return false;
  // C2: opposite scene anchors on two own-vessel witnesses; never views or parts.
  if (!a.viewOrPart && !b.viewOrPart) {
    for (const side of a.sides.keys()) {
      if (b.sides.has(OPPOSITE[side]) && !a.sides.has(OPPOSITE[side]) && !b.sides.has(side)) return true;
    }
  }
  // C3: different concrete vessel classes, each with its own personal amount.
  const classA = vesselClass(vA);
  const classB = vesselClass(vB);
  if (classA !== classB && classA !== "container" && classB !== "container" &&
    (a.personal.length > 0 || a.aggregate.length > 0) && (b.personal.length > 0 || b.aggregate.length > 0)) {
    return true;
  }
  return false;
}

function maximumCliques(size: number, adjacent: (i: number, j: number) => boolean): number[] {
  if (size === 0) return [];
  const masks: number[] = [];
  let best = 0;
  for (let mask = 1; mask < 1 << size; mask += 1) {
    const members: number[] = [];
    for (let i = 0; i < size; i += 1) if (mask & (1 << i)) members.push(i);
    if (members.length < best) continue;
    let clique = true;
    for (let x = 0; x < members.length && clique; x += 1) {
      for (let y = x + 1; y < members.length; y += 1) {
        if (!adjacent(members[x], members[y])) { clique = false; break; }
      }
    }
    if (!clique) continue;
    if (members.length > best) { best = members.length; masks.length = 0; }
    masks.push(mask);
  }
  return masks;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateInput(input: TypedServingInput): { claims: EvidenceClaim[]; decisions: UserServingDecision[] } {
  const issues: string[] = [];
  if (typeof input.sceneId !== "string" || input.sceneId.trim() === "" || input.sceneId.length > 200) issues.push("invalid sceneId");
  if (input.rows.length > MAX_OBSERVED_ROWS) issues.push(`at most ${MAX_OBSERVED_ROWS} observed rows`);
  const rowIds = new Set<string>();
  for (const row of input.rows) {
    if (rowIds.has(row.rowId)) issues.push(`duplicate row id ${row.rowId}`);
    rowIds.add(row.rowId);
    if (row.sceneId !== input.sceneId) issues.push(`row ${row.rowId} belongs to another scene`);
  }
  const claims = new Map<string, EvidenceClaim>();
  const entityIds = new Set([...rowIds].map(rowEntityId));
  const checkReferent = (referent: Referent, claimId: string) => {
    if (referent.kind === "entity" && !entityIds.has(referent.entityId)) issues.push(`claim ${claimId} references unknown entity`);
    if (referent.kind === "unbound") {
      for (const id of referent.possibleEntityIds) if (!entityIds.has(id)) issues.push(`claim ${claimId} references unknown entity`);
    }
  };
  for (const raw of input.claims) {
    const parsed = evidenceClaimSchema.safeParse(raw);
    if (!parsed.success) { issues.push(`invalid claim ${raw?.claimId ?? "?"}`); continue; }
    const claim = raw;
    if (claim.source.sceneId !== input.sceneId) issues.push(`claim ${claim.claimId} belongs to another scene`);
    if (claim.source.rowId !== undefined && !rowIds.has(claim.source.rowId)) issues.push(`claim ${claim.claimId} cites unknown row`);
    const previous = claims.get(claim.claimId);
    if (previous && canonicalJson(previous) !== canonicalJson(claim)) issues.push(`conflicting claims share id ${claim.claimId}`);
    claims.set(claim.claimId, claim);
    const body = claim.body;
    switch (body.predicate) {
      case "presence": case "family": case "vessel": case "spatial":
        checkReferent(body.subject, claim.claimId);
        if (body.predicate === "spatial" && body.relativeTo !== "scene") checkReferent(body.relativeTo, claim.claimId);
        break;
      case "contains": checkReferent(body.vessel, claim.claimId); checkReferent(body.contentEntity, claim.claimId); break;
      case "same_vessel": case "different_vessel": checkReferent(body.left, claim.claimId); checkReferent(body.right, claim.claimId); break;
      case "cardinality": checkReferent(body.population, claim.claimId); break;
      case "quantity": checkReferent(body.proposal.target, claim.claimId); break;
      case "stock_transfer": checkReferent(body.from, claim.claimId); checkReferent(body.into, claim.claimId); break;
    }
  }
  const decisionResult = servingDecisionListSchema.safeParse(input.decisions ?? []);
  if (!decisionResult.success) issues.push("invalid decision list");
  if (issues.length > 0) throw new ServingContractError("invalid serving reconciliation input", sortedUnique(issues));
  return {
    claims: [...claims.values()].sort((a, b) => (a.claimId < b.claimId ? -1 : 1)),
    decisions: (decisionResult.data ?? []) as UserServingDecision[],
  };
}

// ---------------------------------------------------------------------------
// Base reconciliation (evidence only)
// ---------------------------------------------------------------------------

function buildModel(rows: readonly ObservedFoodRow[], claims: readonly EvidenceClaim[]): Model {
  const milkRows = rows.filter(row => row.subject.milkCandidate).sort((a, b) => (a.rowId < b.rowId ? -1 : 1));
  const milkIds = new Set(milkRows.map(row => row.rowId));
  // Non-milk rows contribute no evidence, even if claims were supplied for them.
  const usableClaims = claims.filter(claim => claim.source.rowId === undefined || milkIds.has(claim.source.rowId));
  const entityToRow = new Map(milkRows.map(row => [rowEntityId(row.rowId), row.rowId]));

  const model: Model = {
    facts: new Map(),
    familyOf: new Map(),
    slots: new Map(),
    groups: new Map(),
    rowOverrides: new Map(),
    reasonCodes: new Set(),
    cardinalityReviewRequired: false,
    nearbyCandidates: [],
  };
  for (const row of milkRows) {
    const facts = buildFacts(row, usableClaims);
    model.facts.set(row.rowId, facts);
    model.familyOf.set(row.rowId, familyAssessment(facts));
  }
  const vesselOf = new Map(milkRows.map(row => [row.rowId, vesselAssessment(model.facts.get(row.rowId)!)]));
  const addGroup = (group: Omit<WorkGroup, "closed">) => {
    model.groups.set(group.groupId, { ...group, closed: "open" });
    return group.groupId;
  };

  // Content contradictions: the row's own described object holds no drink.
  const conflictRows = milkRows.filter(row => model.facts.get(row.rowId)!.blocking !== null).map(row => row.rowId);
  for (const rowId of conflictRows) {
    const blocking = model.facts.get(rowId)!.blocking!;
    addGroup({
      groupId: groupId("unbound_object", [rowId]), kind: "unbound_object", rowIds: [rowId], extraCandidateIds: [], slotIds: [],
      possibleTargetSlotIds: [], amountAlternatives: [], excludedProposalIds: [], supportedCount: 0, possibleExtraSlots: 0,
      reasonCodes: [blocking.content === "empty" ? "row_object_empty" : "row_object_contains_non_drink"],
    });
  }
  const stockRows = milkRows.filter(row => {
    if (conflictRows.includes(row.rowId)) return false;
    const facts = model.facts.get(row.rowId)!;
    // A pour keeps the personal amount on this row. Only a stock container with no intake is unrelated.
    return facts.stockSource && facts.personal.length === 0 && facts.aggregate.length === 0;
  }).map(row => row.rowId);
  for (const rowId of stockRows) model.rowOverrides.set(rowId, { disposition: "unrelated", slotIds: [], reason: "stock_source_not_intake" });
  const active = milkRows.map(row => row.rowId).filter(id => !conflictRows.includes(id) && !stockRows.includes(id));

  // Relations.
  const relations = relationIndex(usableClaims, entityToRow);
  const conflicted = new Set(relations.conflictClusters.flat());
  for (const cluster of relations.conflictClusters) {
    addGroup({
      groupId: groupId("relation_conflict", cluster), kind: "relation_conflict", rowIds: cluster, extraCandidateIds: [], slotIds: [],
      possibleTargetSlotIds: [], amountAlternatives: [], excludedProposalIds: [], supportedCount: 0, possibleExtraSlots: 0,
      reasonCodes: ["contradictory_identity_relations"],
    });
  }

  // Direct object witnesses. A stock row that also states the poured amount is the intake
  // only when no separate destination witness exists; otherwise it would double-count.
  const pourRows = new Set(active.filter(rowId => {
    const facts = model.facts.get(rowId)!;
    return facts.stockSource && (facts.personal.length > 0 || facts.aggregate.length > 0);
  }));
  const allWitnesses = active.filter(rowId => {
    const facts = model.facts.get(rowId)!;
    return facts.presenceProofs.length > 0 && vesselOf.get(rowId)!.state === "resolved";
  });
  const nonPourWitnesses = allWitnesses.filter(rowId => !pourRows.has(rowId));
  if (nonPourWitnesses.length > 0) {
    for (const rowId of pourRows) {
      model.rowOverrides.set(rowId, { disposition: "unrelated", slotIds: [], reason: "stock_source_not_intake" });
    }
  }
  const witnesses = nonPourWitnesses.length > 0 ? nonPourWitnesses : allWitnesses;
  const resolvedVessel = (rowId: string) => {
    const assessment = vesselOf.get(rowId)!;
    return assessment.state === "resolved" ? assessment.value : "unknown";
  };
  const n = witnesses.length;
  const adjacent: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const certified = distinctCertificate(model.facts.get(witnesses[i])!, model.facts.get(witnesses[j])!,
        resolvedVessel(witnesses[i]), resolvedVessel(witnesses[j]), relations, conflicted);
      adjacent[i][j] = certified;
      adjacent[j][i] = certified;
    }
  }
  const neighbourhood = adjacent.map(row => row.reduce((mask, on, j) => (on ? mask | (1 << j) : mask), 0));
  // False twins describe interchangeable objects under the proof structure.
  const classes: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const home = classes.find(members => !adjacent[members[0]][i] && neighbourhood[members[0]] === neighbourhood[i]);
    if (home) home.push(i); else classes.push([i]);
  }
  const cliques = maximumCliques(classes.length, (a, b) => adjacent[classes[a][0]][classes[b][0]]);
  const popcount = (mask: number) => mask.toString(2).split("").filter(bit => bit === "1").length;
  const cliqueSize = cliques.length ? popcount(cliques[0]) : 0;
  const coreMask = cliques.reduce((acc, mask) => acc & mask, cliques.length ? -1 : 0);
  const unionMask = cliques.reduce((acc, mask) => acc | mask, 0);
  const core: string[] = [];
  let anonymousGroups: Array<{ pool: string[]; count: number; basis: SlotBasis }> = [];
  const looseClassMembers: string[] = [];
  const preservedClasses: string[][] = [];
  classes.forEach((members, index) => {
    const ids = members.map(i => witnesses[i]);
    if ((coreMask & (1 << index)) !== 0) {
      if (ids.length === 1) core.push(ids[0]);
      else anonymousGroups.push({ pool: ids, count: 1, basis: "interchangeable_witnesses" });
    } else if ((unionMask & (1 << index)) !== 0) {
      looseClassMembers.push(...ids);
    } else {
      // A witness outside every maximum clique is still a direct observation.
      preservedClasses.push(ids);
    }
  });
  const coreClassCount = popcount(coreMask >>> 0 & ((1 << classes.length) - 1));
  if (cliqueSize - coreClassCount > 0) {
    anonymousGroups.push({ pool: looseClassMembers, count: cliqueSize - coreClassCount, basis: "interchangeable_witnesses" });
  }

  // Cardinality: admitted counts, conflicts and polarity barriers.
  const populationClaims = usableClaims.filter(claim => claim.body.predicate === "cardinality" && claim.body.population.kind === "population");
  const admittedCounts = populationClaims.filter(claim => admitted(claim, "count"));
  const barriers = populationClaims.filter(claim => !admitted(claim, "count") && !claim.refusalReasons.includes("quoted_text"));
  const populationOf = (claim: EvidenceClaim) => (claim.body as Extract<EvidenceClaim["body"], { predicate: "cardinality" }>).population as Extract<Referent, { kind: "population" }>;
  const countOf = (claim: EvidenceClaim) => (claim.body as Extract<EvidenceClaim["body"], { predicate: "cardinality" }>).count;
  const overlaps = (a: Extract<Referent, { kind: "population" }>, b: Extract<Referent, { kind: "population" }>) =>
    familiesCompatible(a.family, b.family) && vesselsCompatible(a.vessel, b.vessel);
  const clusters: EvidenceClaim[][] = [];
  for (const claim of admittedCounts) {
    const touching = clusters.filter(cluster => cluster.some(other => overlaps(populationOf(other), populationOf(claim))));
    const merged = [claim, ...touching.flat()];
    for (const cluster of touching) clusters.splice(clusters.indexOf(cluster), 1);
    clusters.push(merged);
  }
  const memberRows = (population: Extract<Referent, { kind: "population" }>) => active.filter(rowId =>
    familyCompatibleWith(population.family, model.familyOf.get(rowId)!.assessment) &&
    vesselsCompatible(population.vessel, resolvedVessel(rowId)));

  const namedMultiplicity = (rowId: string) => model.facts.get(rowId)!.entityCount?.count ?? 1;
  const blockedClusters: Array<{ members: string[]; maxCount: number }> = [];
  const sortedClusters = clusters.map(cluster => cluster.slice().sort((a, b) => (a.claimId < b.claimId ? -1 : 1))).sort((a, b) => (a[0].claimId < b[0].claimId ? -1 : 1));
  for (const cluster of sortedClusters) {
    const keys = new Set(cluster.map(claim => `${populationOf(claim).scopeId}#${countOf(claim)}`));
    const barrier = barriers.some(other => cluster.some(claim => overlaps(populationOf(claim), populationOf(other))));
    const members = sortedUnique(cluster.flatMap(claim => memberRows(populationOf(claim))));
    if (keys.size > 1 || barrier) {
      model.cardinalityReviewRequired = true;
      model.reasonCodes.add(keys.size > 1 ? "cardinality_conflict" : "cardinality_review_required");
      blockedClusters.push({ members, maxCount: Math.max(...cluster.map(countOf)) });
      continue;
    }
    const population = populationOf(cluster[0]);
    const count = countOf(cluster[0]);
    const inPopulation = memberRows(population);
    const namedIn = core.filter(rowId => inPopulation.includes(rowId)).reduce((sum, rowId) => sum + namedMultiplicity(rowId), 0);
    const anonIn = anonymousGroups.filter(group => group.pool.every(rowId => inPopulation.includes(rowId))).reduce((sum, group) => sum + group.count, 0);
    const extra = count - namedIn - anonIn;
    if (extra < 0) model.reasonCodes.add("cardinality_below_direct_witnesses");
    if (extra <= 0) continue;
    const pool = inPopulation.filter(rowId => !core.includes(rowId));
    const absorbed = anonymousGroups.filter(group => group.pool.every(rowId => pool.includes(rowId)));
    anonymousGroups = anonymousGroups.filter(group => !absorbed.includes(group));
    anonymousGroups.push({ pool, count: extra + absorbed.reduce((sum, group) => sum + group.count, 0), basis: "cardinality" });
  }

  // Presence floor: one serving at most, only when nothing else supports one.
  if (core.length === 0 && anonymousGroups.length === 0) {
    const floorPool = active.filter(rowId => model.facts.get(rowId)!.presenceProofs.length > 0);
    if (floorPool.length > 0) anonymousGroups.push({ pool: floorPool, count: 1, basis: "presence_floor" });
  }

  // Named slots.
  for (const rowId of core) {
    const facts = model.facts.get(rowId)!;
    const family = model.familyOf.get(rowId)!;
    const reading = portionReading(facts);
    const slotId = `slot:${rowId}`;
    model.slots.set(slotId, {
      slotId, scopeId: "scene", basis: "direct_witness", sourceRowIds: [rowId],
      proofIds: sortedUnique([...facts.presenceProofs, ...[...facts.vessels.values()].flat()]),
      multiplicity: namedMultiplicity(rowId), family: family.assessment, refined: family.refined,
      portion: reading.assessment, portionReason: reading.reason, requiresUserPortion: false, dismissed: false,
      nutritionHolds: [],
    });
    if (reading.assessment.state === "conflict") {
      addGroup({
        groupId: groupId("exclusive_candidates", [slotId]), kind: "exclusive_candidates", rowIds: [rowId], extraCandidateIds: [],
        slotIds: [slotId], possibleTargetSlotIds: [], amountAlternatives: reading.alternatives, excludedProposalIds: [],
        supportedCount: 1, possibleExtraSlots: 0, reasonCodes: ["same_target_quantity_conflict"],
      });
    }
    if (family.assessment.state === "conflict") {
      addGroup({
        groupId: groupId("family_conflict", [slotId]), kind: "family_conflict", rowIds: [rowId], extraCandidateIds: [],
        slotIds: [slotId], possibleTargetSlotIds: [], amountAlternatives: [], excludedProposalIds: [],
        supportedCount: 1, possibleExtraSlots: 0, reasonCodes: ["same_referent_family_conflict"],
      });
    }
  }

  const identifiedRow = (rowId: string) => {
    const assessment = model.familyOf.get(rowId)?.assessment;
    if (!assessment || assessment.state === "unknown") return false;
    if (assessment.state === "conflict") {
      return assessment.alternatives.some(value => value.family !== "generic_milk" && value.family !== "unknown");
    }
    return assessment.value.family !== "generic_milk" && assessment.value.family !== "unknown";
  };
  // Generic observations must not donate their amounts onto an identified serving.
  const portionSourceRows = (pool: readonly string[]) => {
    const identified = pool.filter(identifiedRow);
    return identified.length > 0 && identified.length < pool.length ? identified : [...pool];
  };

  // Anonymous slot groups: a projection exists only when every candidate agrees.
  for (const group of anonymousGroups.sort((a, b) => compareCanonical(a.pool, b.pool))) {
    const pool = sortedUnique(group.pool);
    const portionIds = sortedUnique(group.basis === "interchangeable_witnesses" ? portionSourceRows(pool) : pool);
    const key = stableDigest(canonicalJson({ pool: portionIds, basis: group.basis }));
    const readings = portionIds.map(rowId => portionReading(model.facts.get(rowId)!));
    const families = portionIds.map(rowId => model.familyOf.get(rowId)!);
    const multiplicities = new Set(portionIds.map(rowId => namedMultiplicity(rowId)));
    const familyKeys = new Set(families.map(item => canonicalJson(item.assessment.state === "resolved" ? item.assessment.value : item.assessment)));
    const commonFamily = familyKeys.size <= 1;
    const resolvedPortions = readings.filter(item => item.assessment.state === "resolved");
    const portionKeys = new Set(readings.map(item => item.assessment.state === "resolved"
      ? canonicalJson({ ...item.assessment.value, proofIds: [] }) : item.assessment.state === "unknown" ? "unknown" : "conflict"));
    const commonPortion = portionKeys.size === 1 && multiplicities.size <= 1;
    const familyAssessmentValue: Assessment<FamilyValue> = commonFamily && families.length > 0
      ? families[0].assessment
      : (() => {
        const values = [...new Map(families.flatMap(item => item.assessment.state === "resolved" ? [item.assessment.value]
          : item.assessment.state === "conflict" ? item.assessment.alternatives : []).map(value => [familyKey(value), value])).values()].sort(compareCanonical);
        const claimIds = sortedUnique(portionIds.flatMap(rowId => model.facts.get(rowId)!.families.map(item => item.claimId)));
        return values.length >= 2 ? { state: "conflict", alternatives: values, claimIds } : { state: "unknown", claimIds };
      })();
    const refined = families.some(item => item.refined);
    const allAlternatives = distinctByAmount(portionIds.flatMap(rowId => {
      const facts = model.facts.get(rowId)!;
      return facts.aggregate.length > 0 ? [...facts.aggregate, ...facts.personal] : facts.personal;
    }));
    const slotIds: string[] = [];
    for (let k = 0; k < group.count; k += 1) {
      const slotId = `slot:${key}:${k}`;
      slotIds.push(slotId);
      let portion: Assessment<ResolvedPortion>;
      let portionReason: string | null;
      if (commonPortion && resolvedPortions.length === readings.length && readings.length > 0) {
        if (k < portionIds.length) {
          const value = (readings[0].assessment as Extract<Assessment<ResolvedPortion>, { state: "resolved" }>).value;
          const proofs = sortedUnique(resolvedPortions.flatMap(item => item.assessment.state === "resolved" ? item.assessment.proofIds : []));
          portion = { state: "resolved", value: { ...value, origin: portionIds.length > 1 ? "agreed_model_estimate" : "single_anchored_estimate", proofIds: proofs }, proofIds: proofs };
          portionReason = null;
        } else {
          portion = { state: "unknown", claimIds: [] };
          portionReason = "count_exceeds_observations";
        }
      } else if (commonPortion) {
        portion = { state: "unknown", claimIds: [] };
        portionReason = readings[0]?.reason ?? "count_without_observation";
      } else {
        const alternatives = allAlternatives.map(item => toPortion(item, "single_anchored_estimate", [...item.claimIds]));
        portion = alternatives.length >= 2
          ? { state: "conflict", alternatives, claimIds: sortedUnique(allAlternatives.flatMap(item => item.claimIds)) }
          : { state: "unknown", claimIds: [] };
        portionReason = "portion_identity_conflict";
      }
      model.slots.set(slotId, {
        slotId, scopeId: `pool:${key}`, basis: group.basis, sourceRowIds: portionIds,
        proofIds: sortedUnique(portionIds.flatMap(rowId => model.facts.get(rowId)!.presenceProofs)),
        multiplicity: multiplicities.size === 1 && portionIds.length === 1 ? namedMultiplicity(portionIds[0]) : 1,
        family: familyAssessmentValue, refined, portion, portionReason, requiresUserPortion: false, dismissed: false,
        nutritionHolds: [],
      });
    }
    const exclusiveId = groupId(commonPortion ? "family_conflict" : "exclusive_candidates", slotIds);
    if (!commonPortion || !commonFamily) {
      addGroup({
        groupId: exclusiveId, kind: commonPortion ? "family_conflict" : "exclusive_candidates", rowIds: portionIds, extraCandidateIds: [], slotIds,
        possibleTargetSlotIds: [], amountAlternatives: commonPortion ? [] : allAlternatives, excludedProposalIds: [],
        supportedCount: group.count, possibleExtraSlots: Math.max(0, portionIds.length - group.count),
        reasonCodes: [...(!commonPortion ? (group.count > 1 ? ["quantity_assignment_unresolved"] : ["portion_identity_conflict"]) : []),
          ...(!commonFamily ? ["family_ambiguity"] : [])],
      });
    }
    if (portionIds.length > group.count) {
      addGroup({
        groupId: groupId("possible_excess", portionIds), kind: "possible_excess", rowIds: portionIds, extraCandidateIds: [], slotIds: [],
        possibleTargetSlotIds: slotIds, amountAlternatives: [], excludedProposalIds: [], supportedCount: group.count,
        possibleExtraSlots: portionIds.length - group.count, reasonCodes: ["interchangeable_candidates_exceed_supported_count"],
        overflowOf: exclusiveId,
      });
    }
  }

  // Witnesses omitted from the maximum clique keep their own portion allocation.
  const allocated = new Set([...model.slots.values()].flatMap(slot => slot.sourceRowIds));
  for (const ids of preservedClasses) {
    for (const rowId of portionSourceRows(ids)) {
      if (allocated.has(rowId) || model.slots.has(`slot:${rowId}`)) continue;
      const facts = model.facts.get(rowId)!;
      const family = model.familyOf.get(rowId)!;
      const reading = portionReading(facts);
      const slotId = `slot:${rowId}`;
      model.slots.set(slotId, {
        slotId, scopeId: "scene", basis: "direct_witness", sourceRowIds: [rowId],
        proofIds: sortedUnique([...facts.presenceProofs, ...[...facts.vessels.values()].flat()]),
        multiplicity: 1, family: family.assessment, refined: family.refined,
        portion: reading.assessment, portionReason: reading.reason, requiresUserPortion: false, dismissed: false,
        nutritionHolds: ["distinctness_unresolved"],
      });
      allocated.add(rowId);
    }
  }

  // Rows without any slot: possible excess against compatible slots or a new serving.
  const inSlots = new Set([...model.slots.values()].flatMap(slot => slot.sourceRowIds));
  for (const rowId of active.filter(id => !inSlots.has(id))) {
    const family = model.familyOf.get(rowId)!.assessment;
    const vessel = resolvedVessel(rowId);
    const targets = [...model.slots.values()].filter(slot => {
      const slotFamily = slot.family;
      const familyOk = slotFamily.state !== "resolved" || familyCompatibleWith(slotFamily.value.family, family);
      const vesselOk = slot.sourceRowIds.some(source => vesselsCompatible(resolvedVessel(source), vessel));
      return familyOk && vesselOk;
    }).map(slot => slot.slotId).sort();
    addGroup({
      groupId: groupId("possible_excess", [rowId]), kind: "possible_excess", rowIds: [rowId], extraCandidateIds: [], slotIds: [],
      possibleTargetSlotIds: targets, amountAlternatives: [], excludedProposalIds: [], supportedCount: 0, possibleExtraSlots: 1,
      reasonCodes: [witnesses.includes(rowId) ? "unknown_possible_reference" : "no_independent_serving_proof"],
    });
  }

  // Review groups for blocked cardinality.
  const liveCount = (members: string[]) => [...model.slots.values()]
    .filter(slot => slot.sourceRowIds.some(rowId => members.includes(rowId)))
    .reduce((sum, slot) => sum + slot.multiplicity, 0);
  for (const blocked of blockedClusters) {
    const supported = liveCount(blocked.members);
    addGroup({
      groupId: groupId("unsupported_evidence", ["cardinality", ...blocked.members]), kind: "unsupported_evidence", rowIds: blocked.members,
      extraCandidateIds: [], slotIds: [], possibleTargetSlotIds: [], amountAlternatives: [], excludedProposalIds: [],
      supportedCount: supported, possibleExtraSlots: Math.max(0, blocked.maxCount - supported), reasonCodes: ["cardinality_review_required"],
    });
  }

  // Nearby drink objects named in milk rows: visible candidates, zero support.
  for (const claim of usableClaims) {
    const body = claim.body;
    if (body.predicate !== "presence" || body.subject.kind !== "unbound" || !claim.source.rowId) continue;
    if (body.content !== "milk" && body.content !== "white_drink") continue;
    const candidateId = `cand:obj:${claim.claimId}`;
    model.nearbyCandidates.push({
      candidateId, referent: body.subject, rowIds: [claim.source.rowId],
      existence: { state: "unknown", claimIds: [claim.claimId] },
      family: { state: "unknown", claimIds: [] }, vessel: { state: "unknown", claimIds: [] },
      quantityProposals: [], possibleSameAs: [],
    });
    addGroup({
      groupId: groupId("unbound_object", [candidateId]), kind: "unbound_object", rowIds: [], extraCandidateIds: [candidateId], slotIds: [],
      possibleTargetSlotIds: [], amountAlternatives: [], excludedProposalIds: [], supportedCount: 0, possibleExtraSlots: 1,
      reasonCodes: ["nearby_object_without_binding"],
    });
  }

  return model;
}

// ---------------------------------------------------------------------------
// User decisions (pure, sequential, bound to digest and revision)
// ---------------------------------------------------------------------------

function liveSlot(model: Model, slotId: string): WorkSlot | null {
  const slot = model.slots.get(slotId);
  return slot && !slot.dismissed ? slot : null;
}

function openGroup(model: Model, id: string): WorkGroup | null {
  const group = model.groups.get(id);
  return group && group.closed === "open" ? group : null;
}

function closeOverflow(model: Model, group: WorkGroup) {
  for (const other of model.groups.values()) {
    if (other.overflowOf === group.groupId && other.closed === "open") other.closed = "resolved";
  }
}

function userSlotFromRow(model: Model, groupKey: string, rowId: string, useOwnPortion: boolean): WorkSlot {
  const facts = model.facts.get(rowId)!;
  const family = model.familyOf.get(rowId)!;
  const reading = portionReading(facts);
  const own = useOwnPortion && reading.assessment.state === "resolved";
  return {
    slotId: `slot:${groupKey}:${rowId}`, scopeId: `user:${groupKey}`, basis: "user_declared", sourceRowIds: [rowId],
    proofIds: sortedUnique(facts.presenceProofs), multiplicity: 1, family: family.assessment, refined: family.refined,
    portion: own ? reading.assessment : { state: "unknown", claimIds: [] },
    portionReason: own ? null : useOwnPortion ? (reading.reason ?? "portion_required") : "user_portion_confirmation_required",
    requiresUserPortion: !own, dismissed: false, nutritionHolds: [],
  };
}

function applyDecision(model: Model, decision: UserServingDecision): string | null {
  const command = decision.command;
  switch (command.kind) {
    case "undo":
      return "undo_not_supported";
    case "set_type": {
      const slot = liveSlot(model, command.targetId);
      if (!slot) return "unknown_target";
      if (slot.family.state === "conflict") return "family_conflict_unresolved";
      slot.userType = command.choice;
      return null;
    }
    case "set_portion": {
      const slot = liveSlot(model, command.unitId);
      if (!slot) return "unknown_target";
      const blocked = [...model.groups.values()].some(group =>
        group.closed === "open" && group.kind === "exclusive_candidates" && group.slotIds.includes(slot.slotId));
      if (blocked) return "exclusive_group_requires_explicit_resolution";
      slot.userPortion = command.portion;
      return null;
    }
    case "one_serving": {
      const group = openGroup(model, command.groupId);
      if (!group) return "unknown_target";
      if (group.kind !== "exclusive_candidates" && group.kind !== "family_conflict") return "unsupported_command_for_group";
      const [keep, ...rest] = group.slotIds;
      const slot = liveSlot(model, keep);
      if (!slot) return "unknown_target";
      slot.userPortion = command.portion;
      slot.basis = "user_declared";
      for (const other of rest) { const extra = model.slots.get(other); if (extra) extra.dismissed = true; }
      group.closed = "resolved";
      closeOverflow(model, group);
      for (const rowId of group.rowIds) model.rowOverrides.set(rowId, { disposition: "superseded", slotIds: [keep], reason: "user_one_serving" });
      return null;
    }
    case "separate_servings": {
      const group = openGroup(model, command.groupId);
      if (!group) return "unknown_target";
      if (!["exclusive_candidates", "family_conflict", "possible_excess"].includes(group.kind)) return "unsupported_command_for_group";
      const expected = sortedUnique(group.rowIds.map(rowId => `cand:${rowId}`));
      if (canonicalJson(sortedUnique(command.unitIds)) !== canonicalJson(expected)) return "target_mismatch";
      const anonymous = group.overflowOf ? model.groups.get(group.overflowOf) : undefined;
      const replaced = group.kind === "possible_excess" && group.overflowOf
        ? [...model.slots.values()].filter(slot => slot.sourceRowIds.length > 1 && canonicalJson(slot.sourceRowIds) === canonicalJson(sortedUnique(group.rowIds))).map(slot => slot.slotId)
        : group.slotIds;
      for (const slotId of replaced) { const slot = model.slots.get(slotId); if (slot) slot.dismissed = true; }
      // An exclusive group needs an explicit amount per serving; a single
      // possible-excess row with its own explicit amount may keep it.
      const useOwnPortion = group.kind === "possible_excess";
      for (const rowId of group.rowIds) {
        const slot = userSlotFromRow(model, group.groupId, rowId, useOwnPortion);
        model.slots.set(slot.slotId, slot);
        model.rowOverrides.set(rowId, { disposition: "used_as_evidence", slotIds: [slot.slotId], reason: "user_separate_serving" });
      }
      group.closed = "resolved";
      closeOverflow(model, group);
      if (anonymous && anonymous.closed === "open") anonymous.closed = "resolved";
      return null;
    }
    case "dismiss_group": {
      const group = openGroup(model, command.groupId);
      if (!group) return "unknown_target";
      if (group.kind === "relation_conflict" || group.kind === "unsupported_evidence") return "unsupported_command_for_group";
      group.closed = "dismissed";
      if (group.overflowOf) return null; // extra candidates are duplicates; supported slots stay.
      for (const slotId of group.slotIds) { const slot = model.slots.get(slotId); if (slot) slot.dismissed = true; }
      closeOverflow(model, group);
      for (const rowId of group.rowIds) model.rowOverrides.set(rowId, { disposition: "superseded", slotIds: [], reason: "user_dismissed" });
      return null;
    }
    case "exclude_option": {
      const group = openGroup(model, command.groupId);
      if (!group) return "unknown_target";
      if (group.kind !== "exclusive_candidates") return "unsupported_command_for_group";
      if (!group.amountAlternatives.some(item => item.proposalId === command.proposalId)) return "unknown_target";
      group.excludedProposalIds = sortedUnique([...group.excludedProposalIds, command.proposalId]);
      const remaining = group.amountAlternatives.filter(item => !group.excludedProposalIds.includes(item.proposalId));
      if (remaining.length <= 1) group.reasonCodes = sortedUnique([...group.reasonCodes, "remaining_option_requires_explicit_acceptance"]);
      return null;
    }
  }
}

function applyDecisions(model: Model, decisions: readonly UserServingDecision[], sourceDigest: string) {
  const accepted: UserServingDecision[] = [];
  const rejected: Array<{ decisionId: string; reason: string }> = [];
  for (const decision of decisions) {
    const previous = accepted.find(item => item.decisionId === decision.decisionId);
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(decision)) rejected.push({ decisionId: decision.decisionId, reason: "decision_id_conflict" });
      continue; // identical replay is a no-op
    }
    if (decision.sourceDigest !== sourceDigest) { rejected.push({ decisionId: decision.decisionId, reason: "stale_source_digest" }); continue; }
    if (decision.expectedDecisionRevision !== accepted.length) { rejected.push({ decisionId: decision.decisionId, reason: "stale_decision_revision" }); continue; }
    const reason = applyDecision(model, decision);
    if (reason) { rejected.push({ decisionId: decision.decisionId, reason }); continue; }
    accepted.push(decision);
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function profileFor(slot: WorkSlot): { assessment: Assessment<ServingProfileId>; reason: string | null } {
  // A family conflict stays unresolved. A type command must not present it as solved.
  if (slot.family.state === "conflict") return { assessment: { state: "unknown", claimIds: slot.family.claimIds }, reason: "family_conflict" };
  if (slot.userType) {
    if (slot.userType === "other") return { assessment: { state: "unknown", claimIds: [] }, reason: "user_type_other" };
    if (slot.userType === "low-fat") return { assessment: { state: "unknown", claimIds: [] }, reason: "profile_unavailable" };
    return { assessment: { state: "resolved", value: slot.userType, proofIds: [] }, reason: null };
  }
  if (slot.family.state === "unknown") return { assessment: { state: "unknown", claimIds: slot.family.claimIds }, reason: "type_confirmation_required" };
  const value = slot.family.value;
  if (value.qualifier === "low_fat" || value.qualifier === "skim" || value.family === "almond" || value.family === "coconut" || value.family === "blend") {
    return { assessment: { state: "unknown", claimIds: slot.family.proofIds }, reason: "profile_unavailable" };
  }
  // Model oat/soy names and generic refinements still need the user type gate.
  if (value.family === "generic_milk" || value.family === "oat" || value.family === "soy" || slot.refined) {
    return { assessment: { state: "unknown", claimIds: slot.family.proofIds }, reason: "type_confirmation_required" };
  }
  const profile = PROFILE_BY_FAMILY[familyKey(value)];
  if (!profile) return { assessment: { state: "unknown", claimIds: slot.family.proofIds }, reason: "profile_unavailable" };
  return { assessment: { state: "resolved", value: profile, proofIds: slot.family.proofIds }, reason: null };
}

function project(sceneId: string, sourceDigest: string, rows: readonly ObservedFoodRow[], claims: readonly EvidenceClaim[],
  model: Model, accepted: UserServingDecision[], rejected: Array<{ decisionId: string; reason: string }>): ServingReconciliation {
  const openExclusive = new Set<string>();
  for (const group of model.groups.values()) {
    if (group.closed !== "open" || group.kind !== "exclusive_candidates") continue;
    for (const slotId of group.slotIds) openExclusive.add(slotId);
  }

  const supportedSlots: SupportedServingSlot[] = [];
  const confirmed: ConfirmedServing[] = [];
  for (const slot of [...model.slots.values()].sort((a, b) => (a.slotId < b.slotId ? -1 : 1))) {
    let portion = slot.portion;
    let portionReason = slot.portionReason;
    if (slot.userPortion) {
      portion = { state: "resolved", value: { ...slot.userPortion, origin: "user_amount", purpose: "personal", proofIds: [] }, proofIds: [] };
      portionReason = null;
    }
    const profile = profileFor(slot);
    const reasons = sortedUnique([
      ...slot.nutritionHolds,
      ...(portion.state !== "resolved" ? [portionReason ?? "portion_required"] : []),
      ...(profile.reason ? [profile.reason] : []),
      ...(openExclusive.has(slot.slotId) && !slot.userPortion ? ["exclusive_candidates_unresolved"] : []),
    ]);
    const status: SupportedServingSlot["status"] = slot.dismissed ? "dismissed" : reasons.length === 0 ? "confirmed" : "pending";
    supportedSlots.push({
      slotId: slot.slotId,
      scopeId: slot.scopeId,
      basis: slot.basis,
      proofIds: slot.proofIds,
      sourceCandidateIds: slot.sourceRowIds.map(rowId => `cand:${rowId}`),
      multiplicity: slot.multiplicity,
      family: slot.family,
      portion,
      profile: profile.assessment,
      status,
      pendingReasons: status === "pending" ? reasons : [],
    });
    if (status === "confirmed" && portion.state === "resolved" && profile.assessment.state === "resolved") {
      confirmed.push({
        unitId: `unit:${slot.slotId}`,
        slotIds: [slot.slotId],
        profileId: profile.assessment.value,
        ...(slot.userType ? { milkTypeChoice: slot.userType } : {}),
        portion: portion.value,
        multiplicity: slot.multiplicity,
        confirmation: slot.basis === "user_declared" || slot.userPortion ? "user_declared" : "evidence_admitted",
        proofIds: slot.proofIds,
      });
    }
  }
  const slotStatus = new Map(supportedSlots.map(slot => [slot.slotId, slot.status]));

  const unresolved: UnresolvedServing[] = [];
  for (const group of [...model.groups.values()].sort((a, b) => (a.groupId < b.groupId ? -1 : 1))) {
    if (group.closed !== "open") continue;
    const slotIds = group.slotIds.filter(slotId => slotStatus.get(slotId) === "pending");
    if (group.slotIds.length > 0 && slotIds.length === 0) continue;
    unresolved.push({
      groupId: group.groupId,
      kind: group.kind,
      candidateIds: sortedUnique([...group.rowIds.map(rowId => `cand:${rowId}`), ...group.extraCandidateIds]),
      slotIds,
      possibleTargetSlotIds: group.possibleTargetSlotIds.filter(slotId => slotStatus.get(slotId) !== "dismissed"),
      amountAlternatives: group.amountAlternatives,
      excludedProposalIds: group.excludedProposalIds,
      supportedCount: group.supportedCount,
      possibleExtraSlots: group.possibleExtraSlots,
      selectedCandidateId: null,
      reasonCodes: sortedUnique(group.reasonCodes),
    });
  }

  const groupsByRow = new Map<string, string[]>();
  for (const group of unresolved) {
    for (const candidateId of group.candidateIds) {
      const rowId = candidateId.startsWith("cand:obj:") ? null : candidateId.slice("cand:".length);
      if (rowId) groupsByRow.set(rowId, [...(groupsByRow.get(rowId) ?? []), group.groupId]);
    }
  }
  const dispositions: RowDisposition[] = rows.map(row => {
    const groupIds = sortedUnique(groupsByRow.get(row.rowId) ?? []);
    if (!row.subject.milkCandidate) {
      return { rowId: row.rowId, disposition: "unrelated" as const, slotIds: [], groupIds: [], reasonCodes: [row.subject.exclusionReason ?? "non_milk_subject"] };
    }
    const override = model.rowOverrides.get(row.rowId);
    if (override) {
      return { rowId: row.rowId, disposition: override.disposition, slotIds: override.slotIds, groupIds, reasonCodes: [override.reason] };
    }
    if (model.facts.get(row.rowId)?.blocking) {
      return { rowId: row.rowId, disposition: "conflict" as const, slotIds: [], groupIds, reasonCodes: ["row_label_contradicted_by_own_object"] };
    }
    const live = supportedSlots.filter(slot => slot.status !== "dismissed" && slot.sourceCandidateIds.includes(`cand:${row.rowId}`));
    const direct = live.filter(slot => slot.sourceCandidateIds.length === 1);
    if (direct.length > 0) {
      return { rowId: row.rowId, disposition: "used_as_evidence" as const, slotIds: direct.map(slot => slot.slotId), groupIds, reasonCodes: [] };
    }
    if (live.length > 0) {
      return { rowId: row.rowId, disposition: "alternative" as const, slotIds: live.map(slot => slot.slotId), groupIds, reasonCodes: ["interchangeable_candidate"] };
    }
    const groupReasons = sortedUnique(unresolved.filter(group => groupIds.includes(group.groupId)).flatMap(group => group.reasonCodes));
    return {
      rowId: row.rowId,
      disposition: "possible_excess" as const,
      slotIds: [],
      groupIds,
      reasonCodes: groupReasons.length > 0 ? groupReasons : ["no_independent_serving_proof"],
    };
  }).sort((a, b) => (a.rowId < b.rowId ? -1 : 1));

  const candidates: PhysicalServingCandidate[] = [];
  const milkFacts = [...model.facts.values()];
  for (const facts of milkFacts) {
    const family = model.familyOf.get(facts.rowId)!.assessment;
    candidates.push({
      candidateId: facts.candidateId,
      referent: { kind: "entity", entityId: facts.entityId },
      rowIds: [facts.rowId],
      existence: facts.presenceProofs.length > 0 && !facts.blocking
        ? { state: "resolved", value: "present", proofIds: sortedUnique(facts.presenceProofs) }
        : { state: "unknown", claimIds: sortedUnique([...facts.presenceProofs, ...(facts.blocking?.proofs ?? [])]) },
      family,
      vessel: vesselAssessment(facts),
      quantityProposals: facts.allProposals,
      possibleSameAs: milkFacts
        .filter(other => other.rowId !== facts.rowId && familyCompatibleWith(
          family.state === "resolved" ? family.value.family : "unknown", model.familyOf.get(other.rowId)!.assessment))
        .map(other => other.candidateId).sort(),
    });
  }
  candidates.push(...model.nearbyCandidates);
  candidates.sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1));

  const live = supportedSlots.filter(slot => slot.status !== "dismissed");
  return {
    contractVersion: SERVING_CONTRACT_VERSION,
    engineVersion: SERVING_ENGINE_VERSION,
    grammarVersion: SERVING_GRAMMAR_VERSION,
    sceneId,
    sourceDigest,
    decisionRevision: accepted.length,
    rows: [...rows].sort((a, b) => (a.rowId < b.rowId ? -1 : 1)),
    claims: [...claims],
    candidates,
    supportedSlots,
    confirmed,
    unresolved,
    dispositions,
    acceptedDecisions: accepted,
    rejectedDecisions: rejected,
    summary: {
      supportedServingCount: live.reduce((sum, slot) => sum + slot.multiplicity, 0),
      confirmedServingCount: confirmed.length,
      pendingSlotCount: live.filter(slot => slot.status === "pending").length,
      unresolvedGroupCount: unresolved.length,
      cardinalityReviewRequired: model.cardinalityReviewRequired,
      reasonCodes: sortedUnique(model.reasonCodes),
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function semanticRowPayload(raw: ObservedFoodRow["raw"]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...raw };
  for (const key of ["recognitionConfidence", "portionConfidence", "duplicateMilkNotice", "otherMilkNotice", "suspectedDuplicateMilk"]) {
    delete copy[key];
  }
  for (const key of Object.keys(copy)) if (copy[key] === undefined) delete copy[key];
  return copy;
}

export function reconcileServingEvidence(input: TypedServingInput): ServingReconciliation {
  const { claims, decisions } = validateInput(input);
  const rows = [...input.rows].sort((a, b) => (a.rowId < b.rowId ? -1 : 1));
  const sourceDigest = stableDigest(canonicalJson({
    contract: SERVING_CONTRACT_VERSION,
    engine: SERVING_ENGINE_VERSION,
    grammar: SERVING_GRAMMAR_VERSION,
    sceneId: input.sceneId,
    rows: rows.map(row => ({
      rowId: row.rowId,
      sceneId: row.sceneId,
      semanticKey: row.semanticKey,
      subject: row.subject,
      raw: semanticRowPayload(row.raw),
    })),
    claims: claims.map(claim => ({
      body: claim.body,
      polarity: claim.polarity,
      scopeId: claim.scopeId,
      usableFor: claim.usableFor,
      source: {
        rowId: claim.source.rowId,
        field: claim.source.field,
        span: claim.source.span,
        entryKey: claim.source.entryKey,
        origin: claim.source.origin,
        grammarRule: claim.source.grammarRule,
        grammarVersion: claim.source.grammarVersion,
      },
    })),
  }));
  const model = buildModel(rows, claims);
  const { accepted, rejected } = applyDecisions(model, decisions, sourceDigest);
  return validateServingReconciliation(project(input.sceneId, sourceDigest, rows, claims, model, accepted, rejected));
}

export function reconcileMilkServingScene(
  input: ServingSceneInput & { decisions?: readonly UserServingDecision[] },
): ServingReconciliation {
  const evidence = interpretServingEvidence(input);
  return reconcileServingEvidence({ sceneId: evidence.sceneId, rows: evidence.rows, claims: evidence.claims, decisions: input.decisions });
}
