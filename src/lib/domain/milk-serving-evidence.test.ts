import { describe, expect, it } from "vitest";
import { interpretCountStatement, interpretServingEvidence } from "@/lib/domain/milk-serving-evidence";
import { evidenceClaimSchema, type EvidenceClaim } from "@/lib/domain/milk-serving-contract";
import { analysis, milkRow, oatRow, permutations, sandwichRow, wholeRow } from "@/lib/domain/milk-serving.fixture";

/**
 * Layer 1: language -> evidence. These tests never call the reconciler.
 */

const ownEntity = (rowId: string) => ({ kind: "entity", entityId: `ent:${rowId}` });

function rowClaims(claims: EvidenceClaim[], rowId: string) {
  return claims.filter(claim => claim.source.rowId === rowId);
}

describe("count statement grammar: P1-E unmarked questions, contractions and hedges", () => {
  const refused = [
    "三盒燕麥奶嗎",
    "三盒燕麦奶吗",
    "係咪三盒燕麥奶",
    "Are there three oat milk cartons",
    "can't see three oat milk cartons",
    "未證實有三盒燕麥奶",
    "未确认三盒燕麦奶",
    "會唔會其實有四樽豆奶",
    "尚未證明畫面有四盒杏仁奶",
    "Does the photograph show two soy bottles",
    "不是沒有四盒牛奶",
    "請核對兩杯是否同一杯",
    "Is there two oat milk cartons",
    "Could there be three oat milk cartons",
    "I don't see three oat milk cartons",
    "There aren't three oat milk cartons",
    "It isn't three oat milk cartons",
    "cannot see three oat milk cartons",
    "沒有三盒燕麥奶",
    "没有三盒燕麦奶",
    "看不到三盒燕麥奶",
    "睇唔到三盒燕麥奶",
    "唔係三盒燕麥奶",
    "冇三盒燕麥奶",
    "no three oat milk cartons",
    "maybe three oat milk cartons",
    "可能有三盒燕麥奶",
    "三盒燕麥奶？",
    "三盒燕麥奶?",
    "是不是三盒燕麥奶",
    "有冇三盒燕麥奶",
    "唔係三盒只係一盒燕麥奶",
    "至少三盒燕麥奶",
    "十盒燕麥奶",
    "2.5盒燕麥奶",
    "「兩盒優惠」",
  ];
  for (const text of refused) {
    it(`does not admit an affirmative count: ${text}`, () => {
      const reading = interpretCountStatement(text);
      expect(reading.admitted).toBe(false);
      expect(reading.refusalReasons.length).toBeGreaterThan(0);
    });
  }

  it("classifies polarity for each P1-E phrase", () => {
    expect(interpretCountStatement("三盒燕麥奶嗎").polarity).toBe("questioned");
    expect(interpretCountStatement("三盒燕麦奶吗").polarity).toBe("questioned");
    expect(interpretCountStatement("係咪三盒燕麥奶").polarity).toBe("questioned");
    expect(interpretCountStatement("Are there three oat milk cartons").polarity).toBe("questioned");
    expect(interpretCountStatement("can't see three oat milk cartons").polarity).toBe("negative");
    expect(interpretCountStatement("未證實有三盒燕麥奶").polarity).toBe("uncertain");
  });

  const admitted: Array<[string, number, string, string]> = [
    ["兩盒燕麥奶", 2, "oat", "carton"],
    ["三盒燕麥奶", 3, "oat", "carton"],
    ["两盒燕麦奶", 2, "oat", "carton"],
    ["無糖燕麥奶兩盒", 2, "oat", "carton"],
    ["无糖燕麦奶两盒", 2, "oat", "carton"],
    ["燕麥奶兩盒", 2, "oat", "carton"],
    ["有三盒燕麥奶", 3, "oat", "carton"],
    ["two oat milk cartons", 2, "oat", "carton"],
    ["three oat milk cartons", 3, "oat", "carton"],
    ["3 oat milk cartons", 3, "oat", "carton"],
    ["two cartons of oat milk", 2, "oat", "carton"],
    ["There are three oat milk cartons", 3, "oat", "carton"],
    ["two unsweetened oat milk cartons", 2, "oat", "carton"],
    ["兩杯全脂牛奶", 2, "dairy", "glass"],
    ["兩樽豆奶", 2, "soy", "bottle"],
  ];
  for (const [text, count, family, vessel] of admitted) {
    it(`admits the complete affirmative production: ${text}`, () => {
      const reading = interpretCountStatement(text);
      expect(reading.polarity).toBe("affirmative");
      expect(reading.admitted).toBe(true);
      expect(reading.count).toEqual({ count, family, vessel });
    });
  }

  it("treats 無糖 / unsweetened as a qualifier, never as negation", () => {
    expect(interpretCountStatement("無糖燕麥奶兩盒").polarity).toBe("affirmative");
    expect(interpretCountStatement("two unsweetened oat milk cartons").polarity).toBe("affirmative");
  });

  it("does not read non-milk counts as milk cardinality", () => {
    expect(interpretCountStatement("旁邊兩包曲奇").count).toBeNull();
    expect(interpretCountStatement("two spoons").count).toBeNull();
  });

  it("treats one carton as presence, not exact cardinality", () => {
    expect(interpretCountStatement("一盒燕麥奶").count).toBeNull();
  });

  it("refuses quoted marketing copy", () => {
    const reading = interpretCountStatement("「兩盒優惠」");
    expect(reading.quoted).toBe(true);
    expect(reading.admitted).toBe(false);
  });

  it("refuses partial productions with unconsumed tokens", () => {
    for (const text of ["好似兩盒燕麥奶咁", "兩盒燕麥奶定三盒", "two or three oat milk cartons", "比兩盒燕麥奶多"]) {
      expect(interpretCountStatement(text).admitted).toBe(false);
    }
  });
});

describe("scene evidence: subject binding and attribution", () => {
  it("binds own-note soy contents to a generic glass row (P1-A family evidence)", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-a",
      analysis: analysis([milkRow("左邊玻璃杯裝豆漿", 250, { preparationMethod: "玻璃杯" })]),
    });
    const rowId = evidence.rows[0].rowId;
    const claims = rowClaims(evidence.claims, rowId);
    const usable = (predicate: string) =>
      claims.filter(claim => claim.body.predicate === predicate && claim.polarity === "affirmative");
    expect(usable("family").some(claim =>
      claim.body.predicate === "family" && claim.body.family === "soy" &&
      JSON.stringify(claim.body.subject) === JSON.stringify(ownEntity(rowId)) &&
      claim.usableFor.includes("family"))).toBe(true);
    expect(usable("vessel").some(claim => claim.body.predicate === "vessel" && claim.body.vessel === "glass")).toBe(true);
    expect(usable("spatial").some(claim =>
      claim.body.predicate === "spatial" && claim.body.relation === "left" && claim.body.relativeTo === "scene")).toBe(true);
  });

  it("keeps a generic label generic when only normalizedName guesses whole milk", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-label",
      analysis: analysis([milkRow(undefined, 250, { normalizedName: "whole milk" })]),
    });
    const families = evidence.claims.filter(claim =>
      claim.body.predicate === "family" && claim.usableFor.includes("family"));
    expect(families.every(claim => claim.body.predicate === "family" && claim.body.family === "generic_milk")).toBe(true);
  });

  it("binds a spoon container to the row as non-drink content, never as a milk vessel (P1-B)", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-b",
      analysis: analysis([milkRow("後方另一個白色容器，內有湯匙")]),
    });
    const rowId = evidence.rows[0].rowId;
    const claims = rowClaims(evidence.claims, rowId);
    expect(claims.some(claim =>
      claim.body.predicate === "presence" && claim.body.content === "non_drink" && claim.polarity === "affirmative")).toBe(true);
    expect(claims.some(claim =>
      claim.body.predicate === "vessel" && claim.body.vessel !== "unknown" && claim.usableFor.includes("existence"))).toBe(false);
  });

  it("does not bind a nearby object to the row's own vessel", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-near",
      analysis: analysis([oatRow("燕麥奶紙盒，旁邊另一杯")]),
    });
    const rowId = evidence.rows[0].rowId;
    const own = rowClaims(evidence.claims, rowId).filter(claim =>
      claim.body.predicate === "vessel" && JSON.stringify(claim.body.subject) === JSON.stringify(ownEntity(rowId)));
    expect([...new Set(own.map(claim => claim.body.predicate === "vessel" && claim.body.vessel))]).toEqual(["carton"]);
  });

  it("marks 'X 的前方' and 'front of the glass' as part/view, not a scene position", () => {
    for (const notes of ["這杯牛奶的前方", "front of the glass", "back of the same glass"]) {
      const evidence = interpretServingEvidence({ sceneId: "s-part", analysis: analysis([milkRow(notes)]) });
      const spatial = evidence.claims.filter(claim => claim.body.predicate === "spatial");
      expect(spatial.every(claim =>
        claim.body.predicate === "spatial" && (claim.body.relation === "part" || claim.body.relation === "view"))).toBe(true);
    }
  });

  it("does not let 'not the same glass' on a carton row bind to that carton", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-misbound",
      analysis: analysis([oatRow("紙盒燕麥奶 not the same glass"), oatRow("紙盒燕麥奶")]),
    });
    expect(evidence.claims.some(claim => claim.usableFor.includes("separate_identity"))).toBe(false);
  });

  it("binds 'the two drink glasses are not the same glass' only when exactly two glass witnesses exist", () => {
    const glasses = [
      milkRow("玻璃杯內有牛奶", 250, { preparationMethod: "玻璃杯" }),
      milkRow("玻璃杯內有白色飲品", 250, { preparationMethod: "玻璃杯" }),
    ];
    const pair = interpretServingEvidence({
      sceneId: "s-pair",
      analysis: analysis(glasses, ["The two drink glasses are not the same glass"]),
    });
    const bound = pair.claims.filter(claim =>
      claim.body.predicate === "different_vessel" && claim.usableFor.includes("separate_identity"));
    expect(bound).toHaveLength(1);

    const three = interpretServingEvidence({
      sceneId: "s-pair3",
      analysis: analysis([...glasses, milkRow("玻璃杯", 250, { preparationMethod: "玻璃杯" })],
        ["The two drink glasses are not the same glass"]),
    });
    expect(three.claims.some(claim => claim.usableFor.includes("separate_identity"))).toBe(false);
  });

  it("records 'not another glass, the same glass turned' as denial plus view, never separation", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-turn",
      analysis: analysis([milkRow("這不是另一杯，只是同一杯轉到另一面", 250, { preparationMethod: "玻璃杯" })]),
    });
    expect(evidence.claims.some(claim => claim.usableFor.includes("separate_identity"))).toBe(false);
    expect(evidence.claims.some(claim =>
      claim.body.predicate === "different_vessel" && claim.polarity === "negative")).toBe(true);
  });

  it("gives non-milk rows no milk evidence, even when their notes mention milk", () => {
    const evidence = interpretServingEvidence({ sceneId: "s-sw", analysis: analysis([sandwichRow, wholeRow()]) });
    const sandwich = evidence.rows.find(row => row.raw.normalizedName === "sandwich")!;
    expect(sandwich.subject.milkCandidate).toBe(false);
    expect(rowClaims(evidence.claims, sandwich.rowId)).toEqual([]);
  });

  it("excludes composite milk dishes before matching milk substrings", () => {
    for (const [displayName, normalizedName] of [["牛奶布甸", "milk pudding"], ["奶茶", "milk tea"], ["朱古力奶", "chocolate milk"]]) {
      const evidence = interpretServingEvidence({
        sceneId: "s-comp",
        analysis: analysis([milkRow(undefined, 250, { displayName, normalizedName })]),
      });
      expect(evidence.rows[0].subject.milkCandidate).toBe(false);
    }
  });

  it("never lets uncertaintyReasons or unknownInformation authorize count or existence", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-unc",
      analysis: analysis([oatRow("燕麥奶紙盒", 250, { uncertaintyReasons: ["三盒燕麥奶"] })], [], {
        unknownInformation: ["兩盒燕麥奶"],
        uncertaintyReasons: ["三盒燕麥奶"],
        estimatedInformation: ["兩盒燕麥奶"],
      }),
    });
    const fromUncertain = evidence.claims.filter(claim =>
      ["uncertaintyReasons", "unknownInformation", "estimatedInformation"].includes(claim.source.field));
    expect(fromUncertain.length).toBeGreaterThan(0);
    expect(fromUncertain.every(claim => !claim.usableFor.includes("count") && !claim.usableFor.includes("existence"))).toBe(true);
  });

  it("deduplicates repeated evidence strings into one semantic claim", () => {
    const repeated = interpretServingEvidence({
      sceneId: "s-dup",
      analysis: analysis([oatRow(), oatRow()], ["兩盒燕麥奶", "兩盒燕麥奶", "兩盒燕麥奶"]),
    });
    const counts = repeated.claims.filter(claim => claim.body.predicate === "cardinality" && claim.usableFor.includes("count"));
    expect(counts).toHaveLength(1);
  });

  it("produces spans that slice the preserved raw text", () => {
    const notes = "前方透明玻璃杯內可見牛奶，旁邊有湯匙";
    const evidence = interpretServingEvidence({ sceneId: "s-span", analysis: analysis([milkRow(notes)]) });
    for (const claim of evidence.claims.filter(item => item.source.field === "notes")) {
      const [start, end] = claim.source.span;
      expect(end).toBeGreaterThan(start);
      expect(notes.slice(start, end).length).toBe(end - start);
      expect(end).toBeLessThanOrEqual(notes.length);
    }
  });

  it("ignores application annotations when deriving row identity and claims", () => {
    const raw = milkRow("前方");
    const annotated = { ...raw, suspectedDuplicateMilk: true as const, duplicateMilkNotice: "x", otherMilkNotice: "y" };
    const a = interpretServingEvidence({ sceneId: "s-ann", analysis: analysis([raw]) });
    const b = interpretServingEvidence({ sceneId: "s-ann", analysis: analysis([annotated]) });
    expect(b.rows[0].rowId).toBe(a.rows[0].rowId);
    expect(b.claims).toEqual(a.claims);
  });

  it("is deterministic and order-independent at the claim level", () => {
    const rows = [oatRow(), milkRow("前方透明玻璃杯內可見牛奶"), wholeRow("右邊玻璃杯裝全脂牛奶")];
    const baseline = interpretServingEvidence({ sceneId: "s-perm", analysis: analysis(rows, ["兩盒燕麥奶"]) });
    for (const order of permutations(rows)) {
      const other = interpretServingEvidence({ sceneId: "s-perm", analysis: analysis(order, ["兩盒燕麥奶"]) });
      expect(other.claims).toEqual(baseline.claims);
      expect(other.rows.map(row => row.rowId).sort()).toEqual(baseline.rows.map(row => row.rowId).sort());
    }
  });

  it("assigns distinct stable IDs to byte-identical rows without using their index", () => {
    const evidence = interpretServingEvidence({ sceneId: "s-ident", analysis: analysis([oatRow(), oatRow(), oatRow()]) });
    const ids = evidence.rows.map(row => row.rowId);
    expect(new Set(ids).size).toBe(3);
    expect(new Set(evidence.rows.map(row => row.semanticKey)).size).toBe(1);
  });

  it("emits only schema-valid claims", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-valid",
      analysis: analysis([
        milkRow("左邊玻璃杯裝豆漿", 250, { preparationMethod: "玻璃杯" }),
        milkRow("後方另一個白色容器，內有湯匙"),
        oatRow("燕麥奶紙盒，旁邊另一杯椰奶"),
      ], ["三盒燕麥奶嗎", "兩盒燕麥奶", "「兩盒優惠」"]),
    });
    for (const claim of evidence.claims) expect(() => evidenceClaimSchema.parse(claim)).not.toThrow();
  });

  it("classifies package capacity as capacity, not a personal portion", () => {
    const evidence = interpretServingEvidence({
      sceneId: "s-cap",
      analysis: analysis([oatRow("包裝標示1L容量", null)]),
    });
    const quantities = evidence.claims.filter(claim => claim.body.predicate === "quantity");
    expect(quantities.some(claim =>
      claim.body.predicate === "quantity" && claim.body.proposal.purpose === "package_capacity")).toBe(true);
    expect(quantities.some(claim =>
      claim.body.predicate === "quantity" && claim.body.proposal.purpose === "row_personal_estimate" &&
      claim.body.proposal.min !== null)).toBe(false);
  });
});
