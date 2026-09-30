import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const digest = "sha256:" + "a".repeat(64);
const image = `asia-east1-docker.pkg.dev/demo-kcalcue/kcalcue/web@${digest}`;

// The fake service template is contaminated with Gemini. A revision describe
// returns the deployed env/secret replacement, unless a failure mode forces
// the candidate to stay contaminated or to carry the wrong digest.
function run(action: "pause" | "resume" | "deploy" | "rollback" | "stage" | "promote" | "preflight", failure = "", options: { nutritionSecretVersion?: string } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "kcalcue-cloud-routing-test-"));
  temporary.push(directory);
  const executable = path.join(directory, "gcloud.mjs");
  const trace = path.join(directory, "trace.jsonl");
  const state = path.join(directory, "state.json");
  const config = path.join(directory, "config.json");
  writeFileSync(state, JSON.stringify({ enabled: action === "pause" ? "true" : "false", routed: false,
    routedRevision: "kcalcue-00001-old", configuredEmails: null, candidateEnv: null, secretFlag: null, listedEnv: null }));
  writeFileSync(config, JSON.stringify({
    projectId: "demo-kcalcue", region: "asia-east1", firebaseApiKey: "test-firebase-public-key",
    firebaseAuthDomain: "demo-kcalcue.firebaseapp.com", firebaseAppId: "1:123:web:abc",
    allowedEmails: ["tester@example.com"], openaiSecretVersion: "1",
    ...(options.nutritionSecretVersion ? { nutritionSecretVersion: options.nutritionSecretVersion } : {}),
  }));
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.KCAL_TEST_TRACE, JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(process.env.KCAL_TEST_STATE, 'utf8'));
const failure = process.env.KCAL_TEST_FAILURE || '';
const matches = (...prefix) => prefix.every((part, index) => args[index] === part);
const emit = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const pinned = digest => 'asia-east1-docker.pkg.dev/demo-kcalcue/kcalcue/web@sha256:' + digest;
const templateEnv = () => [
  ...(failure === 'missing-switch' ? [] : [{ name: 'KCALCUE_ANALYSIS_ENABLED', value: failure === 'unknown-switch' ? 'maybe' : state.enabled }]),
  { name: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', value: 'demo-kcalcue' },
  { name: 'KCALCUE_ALLOWED_EMAILS', value: failure === 'allowed-mismatch' ? 'other@example.com' : 'tester@example.com' },
  { name: 'KCALCUE_VISION_PROVIDER', value: 'gemini' },
  { name: 'GEMINI_MODEL', value: 'gemini-3.8-flash' },
  { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'kcalcue-gemini', key: '1' } } },
];
const secretEntriesFromFlag = flag => flag.slice(flag.indexOf('=') + 1).split(',').filter(Boolean).map(pair => {
  const separator = pair.indexOf('=');
  const spec = pair.slice(separator + 1);
  const colon = spec.indexOf(':');
  return { name: pair.slice(0, separator), valueFrom: { secretKeyRef: { name: spec.slice(0, colon), key: spec.slice(colon + 1) || 'latest' } } };
});
const deployedEnv = () => {
  if (state.candidateEnv) {
    const entries = Object.entries(state.candidateEnv).map(([name, value]) => ({ name, value: String(value) }));
    if (typeof state.secretFlag === 'string' && state.secretFlag.startsWith('--set-secrets=')) entries.push(...secretEntriesFromFlag(state.secretFlag));
    else entries.push({ name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'kcalcue-gemini', key: '1' } } });
    return entries;
  }
  const entries = templateEnv().map(entry => ({ ...entry }));
  for (const [name, value] of Object.entries(state.envOverlay || {})) {
    const index = entries.findIndex(entry => entry.name === name);
    const next = { name, value: String(value) };
    if (index >= 0) entries[index] = next;
    else entries.push(next);
  }
  if (typeof state.secretFlag === 'string' && state.secretFlag.startsWith('--set-secrets=')) {
    return entries.filter(entry => !entry.valueFrom).concat(secretEntriesFromFlag(state.secretFlag));
  }
  if (typeof state.secretFlag === 'string' && state.secretFlag.startsWith('--update-secrets=')) entries.push(...secretEntriesFromFlag(state.secretFlag));
  return entries;
};
if (matches('projects', 'describe')) emit('private-trial');
else if (matches('billing', 'projects', 'describe')) emit('true');
else if (matches('services', 'list')) emit(['run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'secretmanager.googleapis.com', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com'].join('\\n'));
else if (matches('secrets', 'versions', 'describe')) {
  const secretArg = args.find(value => value.startsWith('--secret=')) || '';
  if (secretArg === '--secret=kcalcue-nutrition' && failure === 'nutrition-missing') process.exit(1);
  emit(secretArg === '--secret=kcalcue-nutrition' && failure === 'nutrition-disabled' ? 'DISABLED' : 'ENABLED');
}
else if (matches('artifacts', 'docker', 'images', 'describe')) emit('sha256:' + 'a'.repeat(64));
else if (matches('run', 'services', 'list')) {
  const listed = failure === 'new-service' ? [] : [{ spec: { template: { spec: { containers: [{ env: templateEnv() }] } } } }];
  state.listedEnv = listed[0] ? listed[0].spec.template.spec.containers[0].env : null;
  writeFileSync(process.env.KCAL_TEST_STATE, JSON.stringify(state));
  emit(listed);
}
else if (matches('run', 'services', 'update') || matches('run', 'deploy')) {
  const flag = args.find(value => value.startsWith('--update-env-vars='));
  if (flag) {
    state.envOverlay = {};
    for (const pair of flag.slice('--update-env-vars='.length).split(',')) {
      const separator = pair.indexOf('=');
      state.envOverlay[pair.slice(0, separator)] = pair.slice(separator + 1);
      if (pair.startsWith('KCALCUE_ANALYSIS_ENABLED=')) state.enabled = pair.endsWith('=true') ? 'true' : 'false';
    }
  }
  const file = args.find(value => value.startsWith('--env-vars-file='));
  if (file) {
    const variables = JSON.parse(readFileSync(file.slice('--env-vars-file='.length), 'utf8'));
    state.enabled = variables.KCALCUE_ANALYSIS_ENABLED;
    state.configuredEmails = variables.KCALCUE_ALLOWED_EMAILS;
    state.candidateEnv = variables;
  }
  const secret = args.find(value => value.startsWith('--set-secrets=') || value.startsWith('--update-secrets='));
  if (secret) state.secretFlag = secret;
  const imageFlag = args.find(value => value.startsWith('--image='));
  if (imageFlag) state.image = imageFlag.slice('--image='.length);
  writeFileSync(process.env.KCAL_TEST_STATE, JSON.stringify(state));
  emit(failure === 'invalid-revision' ? '' : 'kcalcue-00003-new');
} else if (matches('run', 'revisions', 'describe')) {
  const revision = args[3];
  const isRollbackTarget = revision === 'kcalcue-00002-old';
  const isCurrent = revision === 'kcalcue-00001-old';
  const isNew = revision === 'kcalcue-00003-new';
  const gemini = (failure === 'gemini-candidate' && !isCurrent) || (failure === 'rollback-gemini' && isRollbackTarget);
  const mutated = Boolean(state.candidateEnv || state.secretFlag || state.envOverlay || state.image);
  const project = isRollbackTarget && failure === 'rollback-project-mismatch' ? 'other-project' : 'demo-kcalcue';
  const emails = (isRollbackTarget && failure === 'rollback-allowed-mismatch') || (isCurrent && (failure === 'rollback-current-allowed-mismatch' || failure === 'allowed-mismatch'))
    ? 'other@example.com' : 'tester@example.com';
  let analysis = state.enabled;
  if (failure === 'wrong-switch' || (isRollbackTarget && failure === 'rollback-switch-unknown')) analysis = 'wrong';
  else if (isCurrent && failure === 'missing-switch') analysis = undefined;
  else if (isCurrent && failure === 'unknown-switch') analysis = 'maybe';
  const revisionImage = isCurrent && failure === 'unpinned-image'
    ? 'asia-east1-docker.pkg.dev/demo-kcalcue/kcalcue/web:latest'
    : failure === 'digest-mismatch' && !isCurrent
      ? pinned('b'.repeat(64))
      : isNew && mutated && failure !== 'gemini-candidate'
        ? (state.image || 'asia-east1-docker.pkg.dev/demo-kcalcue/kcalcue/web:latest')
        : pinned('a'.repeat(64));
  let env;
  if (isNew && mutated && failure !== 'gemini-candidate' && failure !== 'digest-mismatch') env = deployedEnv();
  else env = [
    ...(analysis === undefined ? [] : [{ name: 'KCALCUE_ANALYSIS_ENABLED', value: analysis }]),
    { name: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID', value: project },
    { name: 'KCALCUE_ALLOWED_EMAILS', value: emails },
    ...(failure === 'rollback-legacy-provider' && isRollbackTarget ? [] : [{ name: 'KCALCUE_VISION_PROVIDER', value: gemini ? 'gemini' : 'openai' }]),
    { name: 'OPENAI_MODEL', value: 'gpt-5.6-luna' },
    ...(gemini ? [
      { name: 'GEMINI_MODEL', value: 'gemini-3.8-flash' },
      { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'kcalcue-gemini', key: '1' } } },
    ] : []),
    { name: 'OPENAI_API_KEY', valueFrom: { secretKeyRef: { name: 'kcalcue-openai', key: '1' } } },
  ];
  const nutritionVersion = process.env.KCAL_TEST_NUTRITION_VERSION || '';
  const builtFromDeploy = isNew && mutated && failure !== 'gemini-candidate' && failure !== 'digest-mismatch';
  if (!builtFromDeploy && nutritionVersion && !gemini && !(failure === 'rollback-omit-nutrition' && isRollbackTarget) && !env.some(entry => entry.name === 'NUTRITION_API_KEY')) {
    env.push({ name: 'NUTRITION_API_KEY', valueFrom: { secretKeyRef: { name: 'kcalcue-nutrition', key: nutritionVersion } } });
  }
  if (!isCurrent && failure === 'extra-secret') env.push({ name: 'OTHER_API_KEY', valueFrom: { secretKeyRef: { name: 'kcalcue-other', key: '1' } } });
  if (!isCurrent && (failure === 'wrong-nutrition-name' || failure === 'wrong-nutrition-version')) {
    env = env.map(entry => {
      if (entry.name !== 'NUTRITION_API_KEY' || !entry.valueFrom) return entry;
      return { name: 'NUTRITION_API_KEY', valueFrom: { secretKeyRef: {
        name: failure === 'wrong-nutrition-name' ? 'kcalcue-food' : 'kcalcue-nutrition',
        key: failure === 'wrong-nutrition-version' ? '9' : entry.valueFrom.secretKeyRef.key,
      } } };
    });
  }
  emit({
    spec: { containers: [{ env, image: revisionImage }] },
    status: { conditions: [{ type: 'Ready', status: isRollbackTarget && failure === 'rollback-not-ready' ? 'False' : 'True' }] },
  });
} else if (matches('run', 'services', 'update-traffic')) {
  state.routed = failure !== 'unchanged-traffic';
  if (state.routed) state.routedRevision = args.find(value => value.startsWith('--to-revisions='))?.slice('--to-revisions='.length).split('=')[0];
  writeFileSync(process.env.KCAL_TEST_STATE, JSON.stringify(state));
} else if (matches('run', 'services', 'describe')) {
  const traffic = failure === 'new-service' && !state.routed ? [] : [{ revisionName: state.routedRevision, percent: 100 }];
  emit({ status: { traffic, conditions: [{ type: 'Ready', status: 'True' }] } });
} else { console.error('Unexpected fake gcloud invocation'); process.exit(2); }
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ["scripts/cloud-run.mjs", action, "--config", config,
    ...(action === "deploy" || action === "stage" ? ["--tag", "trial-test"] : []),
    ...(action === "rollback" ? ["--revision", "kcalcue-00002-old"] : []),
    ...(action === "promote" && failure !== "missing-revision" ? ["--revision", "kcalcue-00003-new"] : [])], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GCLOUD_BIN: executable,
      KCAL_TEST_TRACE: trace, KCAL_TEST_STATE: state, KCAL_TEST_FAILURE: failure,
      KCAL_TEST_NUTRITION_VERSION: options.nutritionSecretVersion ?? "" },
  });
  const calls = existsSync(trace)
    ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])
    : [];
  return { result, calls, finalState: JSON.parse(readFileSync(state, "utf8")) as {
    enabled: string; configuredEmails: string | null; routed: boolean; routedRevision: string;
    candidateEnv: Record<string, string> | null; secretFlag: string | null;
    listedEnv: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef: { name: string; key: string } } }> | null;
  } };
}

function trafficChanged(calls: string[][]) {
  return calls.some(call => call.includes("update-traffic") || call.some(arg => arg.includes("--to-revisions=")));
}

describe("Cloud Run stage and promote", () => {
  it("rejects deploy before any gcloud call", () => {
    const { result, calls } = run("deploy");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stage/);
    expect(result.stderr).toMatch(/promote/);
    expect(calls).toEqual([]);
  });

  it("stages an OpenAI candidate from a Gemini-contaminated template without promoting it", () => {
    const { result, calls, finalState } = run("stage");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS: staged kcalcue-00003-new at 0% traffic; production remains kcalcue-00001-old; analysis=false.");
    expect(trafficChanged(calls)).toBe(false);
    expect(finalState.routed).toBe(false);
    expect(finalState.routedRevision).toBe("kcalcue-00001-old");
    const deploy = calls.find(call => call[0] === "run" && call[1] === "deploy") ?? [];
    expect(deploy).toContain("--no-traffic");
    expect(deploy).toContain(`--image=${image}`);
    expect(deploy).toContain("--set-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    expect(deploy.some(value => value.startsWith("--update-env-vars=") || value.startsWith("--update-secrets="))).toBe(false);
    expect(deploy.some(value => value.startsWith("--env-vars-file="))).toBe(true);
    expect(finalState.candidateEnv).toMatchObject({
      KCALCUE_VISION_PROVIDER: "openai",
      OPENAI_MODEL: "gpt-5.6-luna",
      KCALCUE_ANALYSIS_ENABLED: "false",
      KCALCUE_ALLOWED_EMAILS: "tester@example.com",
    });
    expect(finalState.candidateEnv).not.toHaveProperty("GEMINI_MODEL");
    expect(finalState.candidateEnv).not.toHaveProperty("GEMINI_API_KEY");
    expect(finalState.secretFlag).toBe("--set-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    expect(finalState.listedEnv).toEqual(expect.arrayContaining([
      { name: "KCALCUE_VISION_PROVIDER", value: "gemini" },
      { name: "GEMINI_MODEL", value: "gemini-3.8-flash" },
      { name: "GEMINI_API_KEY", valueFrom: { secretKeyRef: { name: "kcalcue-gemini", key: "1" } } },
    ]));
    const servingDescribe = calls.findIndex(call => call[1] === "revisions" && call[3] === "kcalcue-00001-old");
    const deployIndex = calls.findIndex(call => call[1] === "deploy");
    expect(servingDescribe).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(servingDescribe);
    const created = calls.findIndex(call => call[0] === "run" && call[1] === "revisions" && call[3] === "kcalcue-00003-new");
    expect(created).toBeGreaterThan(calls.findIndex(call => call[1] === "deploy"));
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["run", "services", "describe"]);
  });

  it.each(["stage", "promote"] as const)("rejects a Gemini candidate before production traffic changes: %s", action => {
    const { result, calls, finalState } = run(action, "gemini-candidate");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Gemini RC configuration");
    expect(result.stderr).toContain("traffic was not changed");
    expect(result.stderr).not.toContain("kcalcue-gemini");
    expect(trafficChanged(calls)).toBe(false);
    expect(finalState.routedRevision).toBe("kcalcue-00001-old");
    if (action === "stage") expect(calls.some(call => call[1] === "deploy")).toBe(true);
  });

  it("rejects a staged digest that is not the resolved artifact", () => {
    const { result, calls } = run("stage", "digest-mismatch");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("image digest does not match");
    expect(result.stderr).toContain("traffic was not changed");
    expect(trafficChanged(calls)).toBe(false);
  });

  it("promotes only a named candidate after checks and readback", () => {
    const staged = run("stage");
    expect(staged.result.status, staged.result.stderr).toBe(0);
    expect(trafficChanged(staged.calls)).toBe(false);
    const promoted = run("promote");
    expect(promoted.result.status, promoted.result.stderr).toBe(0);
    expect(promoted.result.stdout).toContain("PASS: kcalcue-00003-new receives 100% of traffic");
    expect(promoted.finalState.routedRevision).toBe("kcalcue-00003-new");
    const candidateDescribe = promoted.calls.findIndex(call => call[1] === "revisions" && call[2] === "describe" && call[3] === "kcalcue-00003-new");
    const traffic = promoted.calls.findIndex(call => call.includes("update-traffic"));
    expect(candidateDescribe).toBeGreaterThanOrEqual(0);
    expect(traffic).toBeGreaterThan(candidateDescribe);
    expect(promoted.calls.at(-1)?.slice(0, 3)).toEqual(["run", "services", "describe"]);
    expect(promoted.calls.some(call => call[1] === "deploy")).toBe(false);
  });

  it("requires promote --revision before contacting Cloud Run", () => {
    const { result, calls } = run("promote", "missing-revision");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provide the verified candidate --revision.");
    expect(calls).toEqual([]);
  });

  it("refuses an existing service with a different account allowlist before staging", () => {
    const { result, calls } = run("stage", "allowed-mismatch");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("allowed-email list differs");
    expect(calls.some(call => call[1] === "deploy")).toBe(false);
    expect(trafficChanged(calls)).toBe(false);
  });

  it.each(["missing-switch", "unknown-switch"])("stops before stage when the serving analysis switch is %s", failure => {
    const { result, calls } = run("stage", failure);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Existing analysis switch is unknown");
    expect(calls.some(call => call[1] === "deploy")).toBe(false);
    expect(trafficChanged(calls)).toBe(false);
  });

  it("keeps the first staged service paused and without production traffic", () => {
    const { result, calls, finalState } = run("stage", "new-service");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no production revision is serving");
    const deploy = calls.find(call => call[1] === "deploy") ?? [];
    expect(deploy.some(value => value.startsWith("--env-vars-file="))).toBe(true);
    expect(deploy).toContain("--set-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    expect(deploy).toContain("--no-traffic");
    expect(trafficChanged(calls)).toBe(false);
    expect(finalState.enabled).toBe("false");
    expect(finalState.configuredEmails).toBe("tester@example.com");
    expect(finalState.candidateEnv?.KCALCUE_VISION_PROVIDER).toBe("openai");
  });
});

describe("Cloud Run routing after rollback", () => {
  it.each(["pause", "resume"] as const)("%s promotes only after replacing the serving runtime", action => {
    const { result, calls } = run(action);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`analysis=${action === "resume"}`);
    expect(calls.some(call => call.includes("--to-revisions=kcalcue-00003-new=100"))).toBe(true);
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["run", "services", "describe"]);
    const update = calls.find(call => call[1] === "services" && call[2] === "update") ?? [];
    expect(update).toContain("--no-traffic");
    expect(update).toContain(`--image=${image}`);
    expect(update.some(value => value.startsWith("--env-vars-file="))).toBe(true);
    expect(update.some(value => value.startsWith("--update-env-vars="))).toBe(false);
    expect(update).toContain("--set-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    const verified = calls.findIndex(call => call[1] === "revisions" && call[3] === "kcalcue-00003-new");
    expect(calls.findIndex(call => call.includes("update-traffic"))).toBeGreaterThan(verified);
  });

  it("does not pause onto an unpinned serving image", () => {
    const { result, calls } = run("pause", "unpinned-image");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("immutable project digest");
    expect(calls.some(call => call[2] === "update")).toBe(false);
    expect(trafficChanged(calls)).toBe(false);
  });

  it("does not promote a pause revision that still contains Gemini", () => {
    const { result, calls } = run("pause", "gemini-candidate");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Gemini RC configuration");
    expect(result.stderr).toContain("traffic was not changed");
    expect(calls.some(call => call[2] === "update")).toBe(true);
    expect(trafficChanged(calls)).toBe(false);
  });

  it("verifies a rollback route before reporting success", () => {
    const success = run("rollback");
    expect(success.result.status, success.result.stderr).toBe(0);
    expect(success.result.stdout).toContain("PASS: kcalcue-00002-old");
    expect(success.calls.at(-1)?.slice(0, 3)).toEqual(["run", "services", "describe"]);
    const mismatch = run("rollback", "unchanged-traffic");
    expect(mismatch.result.status).toBe(1);
    expect(mismatch.result.stderr).toContain("Traffic verification failed");
    expect(mismatch.result.stdout).not.toContain("PASS");
  });

  it("still rolls back to an older OpenAI revision that has no provider variable", () => {
    const { result, calls } = run("rollback", "rollback-legacy-provider");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS: kcalcue-00002-old");
    expect(calls.some(call => call.includes("update-traffic"))).toBe(true);
  });

  it("refuses a Gemini rollback target before moving traffic", () => {
    const { result, calls } = run("rollback", "rollback-gemini");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Gemini RC configuration");
    expect(result.stderr).toContain("traffic was not changed");
    expect(calls.some(call => call.includes("update-traffic"))).toBe(false);
  });

  it.each(["rollback-project-mismatch", "rollback-allowed-mismatch", "rollback-switch-unknown", "rollback-not-ready"])(
    "refuses an incompatible rollback target before moving traffic: %s", failure => {
      const { result, calls } = run("rollback", failure);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Rollback target is not a ready revision");
      expect(calls.some(call => call.includes("update-traffic"))).toBe(false);
    },
  );

  it("refuses rollback when config no longer matches the current serving account list", () => {
    const { result, calls } = run("rollback", "rollback-current-allowed-mismatch");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Current serving account or project settings differ");
    expect(calls.some(call => call.includes("update-traffic"))).toBe(false);
  });

  it.each(["wrong-switch", "invalid-revision"])("refuses traffic changes with %s", failure => {
    const { result, calls } = run("resume", failure);
    expect(result.status).toBe(1);
    expect(calls.some(call => call.includes("update-traffic"))).toBe(false);
  });

  it("does not report success if the serving route remains unchanged", () => {
    const { result } = run("pause", "unchanged-traffic");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Traffic verification failed");
    expect(result.stdout).not.toContain("PASS");
  });
});

const nutritionConfig = { nutritionSecretVersion: "2" };
const nutritionSecrets = "--set-secrets=OPENAI_API_KEY=kcalcue-openai:1,NUTRITION_API_KEY=kcalcue-nutrition:2";

describe("declared production secrets", () => {
  it("stages both approved secrets when nutrition is configured", () => {
    const { result, calls, finalState } = run("stage", "", nutritionConfig);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("production remains kcalcue-00001-old");
    expect(finalState.secretFlag).toBe(nutritionSecrets);
    expect(finalState.routedRevision).toBe("kcalcue-00001-old");
    expect(trafficChanged(calls)).toBe(false);
  });

  it("stages OpenAI only when nutrition is not configured", () => {
    const { result, calls, finalState } = run("stage");
    expect(result.status, result.stderr).toBe(0);
    expect(finalState.secretFlag).toBe("--set-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    expect(finalState.secretFlag).not.toContain("NUTRITION");
    expect(trafficChanged(calls)).toBe(false);
  });

  it.each(["stage", "promote"] as const)("rejects an undeclared extra secret before traffic changes: %s", action => {
    const { result, calls } = run(action, "extra-secret", nutritionConfig);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("declared production secret set");
    expect(result.stderr).toContain("traffic was not changed");
    expect(trafficChanged(calls)).toBe(false);
  });

  it.each(["wrong-nutrition-name", "wrong-nutrition-version"])("rejects a nutrition secret outside the declared contract: %s", failure => {
    const { result, calls, finalState } = run("stage", failure, nutritionConfig);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("declared production secret set");
    expect(result.stderr).toContain("traffic was not changed");
    expect(finalState.secretFlag).toBe(nutritionSecrets);
    expect(trafficChanged(calls)).toBe(false);
  });

  it("uses the declared nutrition secret when pausing", () => {
    const { result, calls } = run("pause", "", nutritionConfig);
    expect(result.status, result.stderr).toBe(0);
    const update = calls.find(call => call[2] === "update") ?? [];
    expect(update).toContain(nutritionSecrets);
    expect(calls.some(call => call.includes("update-traffic"))).toBe(true);
  });

  it("rolls back only when the target matches the declared nutrition secret", () => {
    const success = run("rollback", "", nutritionConfig);
    expect(success.result.status, success.result.stderr).toBe(0);
    expect(success.calls.some(call => call.includes("update-traffic"))).toBe(true);
    const missing = run("rollback", "rollback-omit-nutrition", nutritionConfig);
    expect(missing.result.status).toBe(1);
    expect(missing.result.stderr).toContain("declared production secret set");
    expect(missing.calls.some(call => call.includes("update-traffic"))).toBe(false);
  });

  it("preflight checks an enabled nutrition secret version when configured", () => {
    const { result, calls } = run("preflight", "", nutritionConfig);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(calls.some(call => call.includes("--secret=kcalcue-openai") && call.includes("1"))).toBe(true);
    expect(calls.some(call => call.includes("--secret=kcalcue-nutrition") && call.includes("2"))).toBe(true);
  });

  it("preflight skips nutrition when the config does not declare it", () => {
    const { result, calls } = run("preflight");
    expect(result.status, result.stderr).toBe(0);
    expect(calls.some(call => call.includes("--secret=kcalcue-nutrition"))).toBe(false);
  });

  it.each(["nutrition-disabled", "nutrition-missing"])("preflight rejects a %s nutrition secret version", failure => {
    const { result, calls } = run("preflight", failure, nutritionConfig);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("configured nutrition secret version is missing or not enabled");
    expect(calls.some(call => call[1] === "deploy" || call.includes("update-traffic"))).toBe(false);
  });
});
