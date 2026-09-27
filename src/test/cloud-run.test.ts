import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Model the real Cloud Run behavior observed after rollback: changing a
// revision does not move a route pinned to an older revision.
function run(action: "pause" | "resume" | "deploy" | "rollback", failure = "") {
  const directory = mkdtempSync(path.join(tmpdir(), "kcalcue-cloud-routing-test-"));
  temporary.push(directory);
  const executable = path.join(directory, "gcloud.mjs");
  const trace = path.join(directory, "trace.jsonl");
  const state = path.join(directory, "state.json");
  const config = path.join(directory, "config.json");
  writeFileSync(state, JSON.stringify({ enabled: action === "pause" ? "true" : "false", routed: false,
    routedRevision: "kcalcue-00001-old", configuredEmails: null }));
  writeFileSync(config, JSON.stringify({
    projectId: "demo-kcalcue", region: "asia-east1", firebaseApiKey: "test-firebase-public-key",
    firebaseAuthDomain: "demo-kcalcue.firebaseapp.com", firebaseAppId: "1:123:web:abc",
    allowedEmails: ["tester@example.com"], openaiSecretVersion: "1",
  }));
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.KCAL_TEST_TRACE, JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(process.env.KCAL_TEST_STATE, 'utf8'));
const matches = (...prefix) => prefix.every((part, index) => args[index] === part);
const emit = value => console.log(typeof value === 'string' ? value : JSON.stringify(value));
if (matches('projects', 'describe')) emit('private-trial');
else if (matches('artifacts', 'docker', 'images', 'describe')) emit('sha256:' + 'a'.repeat(64));
else if (matches('run', 'services', 'list')) emit(process.env.KCAL_TEST_FAILURE === 'new-service' ? [] :
  [{spec:{template:{spec:{containers:[{env:[
    ...(process.env.KCAL_TEST_FAILURE === 'missing-switch' ? [] :
      [{name:'KCALCUE_ANALYSIS_ENABLED',value:process.env.KCAL_TEST_FAILURE === 'unknown-switch' ? 'maybe' : state.enabled}]),
    {name:'NEXT_PUBLIC_FIREBASE_PROJECT_ID',value:'demo-kcalcue'},
    {name:'KCALCUE_ALLOWED_EMAILS',value:process.env.KCAL_TEST_FAILURE === 'allowed-mismatch' ? 'other@example.com' : 'tester@example.com'}
  ]}]}}}}]);
else if (matches('run', 'services', 'update') || matches('run', 'deploy')) {
  const flag = args.find(value => value.startsWith('--update-env-vars='));
  if (flag) state.enabled = flag.includes('KCALCUE_ANALYSIS_ENABLED=true') ? 'true' : 'false';
  const file = args.find(value => value.startsWith('--env-vars-file='));
  if (file) {
    const variables = JSON.parse(readFileSync(file.slice('--env-vars-file='.length), 'utf8'));
    state.enabled = variables.KCALCUE_ANALYSIS_ENABLED;
    state.configuredEmails = variables.KCALCUE_ALLOWED_EMAILS;
  }
  writeFileSync(process.env.KCAL_TEST_STATE, JSON.stringify(state));
  emit(process.env.KCAL_TEST_FAILURE === 'invalid-revision' ? '' : 'kcalcue-00003-new');
} else if (matches('run', 'revisions', 'describe')) {
  const isRollbackTarget = args[3] === 'kcalcue-00002-old';
  const isCurrent = args[3] === 'kcalcue-00001-old';
  emit({spec:{containers:[{env:[
    {name:'KCALCUE_ANALYSIS_ENABLED',value:process.env.KCAL_TEST_FAILURE === 'wrong-switch' || isRollbackTarget && process.env.KCAL_TEST_FAILURE === 'rollback-switch-unknown' ? 'wrong' : state.enabled},
    {name:'NEXT_PUBLIC_FIREBASE_PROJECT_ID',value:isRollbackTarget && process.env.KCAL_TEST_FAILURE === 'rollback-project-mismatch' ? 'other-project' : 'demo-kcalcue'},
    {name:'KCALCUE_ALLOWED_EMAILS',value:isRollbackTarget && process.env.KCAL_TEST_FAILURE === 'rollback-allowed-mismatch' || isCurrent && process.env.KCAL_TEST_FAILURE === 'rollback-current-allowed-mismatch' ? 'other@example.com' : 'tester@example.com'}
  ]}]},status:{conditions:[{type:'Ready',status:isRollbackTarget && process.env.KCAL_TEST_FAILURE === 'rollback-not-ready' ? 'False' : 'True'}]}});
} else if (matches('run', 'services', 'update-traffic')) {
  state.routed = process.env.KCAL_TEST_FAILURE !== 'unchanged-traffic';
  if (state.routed) state.routedRevision = args.find(value => value.startsWith('--to-revisions='))?.slice('--to-revisions='.length).split('=')[0];
  writeFileSync(process.env.KCAL_TEST_STATE, JSON.stringify(state));
} else if (matches('run', 'services', 'describe')) {
  emit({status:{traffic:[{revisionName:state.routedRevision,percent:100}],conditions:[{type:'Ready',status:'True'}]}});
} else { console.error('Unexpected fake gcloud invocation'); process.exit(2); }
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ["scripts/cloud-run.mjs", action, "--config", config,
    ...(action === "deploy" ? ["--tag", "trial-test"] : []),
    ...(action === "rollback" ? ["--revision", "kcalcue-00002-old"] : [])], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GCLOUD_BIN: executable,
      KCAL_TEST_TRACE: trace, KCAL_TEST_STATE: state, KCAL_TEST_FAILURE: failure },
  });
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  return { result, calls, finalState: JSON.parse(readFileSync(state, "utf8")) as {
    enabled: string; configuredEmails: string | null;
  } };
}

describe("Cloud Run routing after rollback", () => {
  it.each(["pause", "resume", "deploy"] as const)("%s moves the pinned route to the changed revision", action => {
    const { result, calls } = run(action);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`analysis=${action === "resume"}`);
    expect(calls.some(call => call.includes("--to-revisions=kcalcue-00003-new=100"))).toBe(true);
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["run", "services", "describe"]);
    const mutation = calls.find(call => call.slice(0, 2).join(" ") === (action === "deploy" ? "run deploy" : "run services") &&
      call.includes("--no-traffic"));
    expect(mutation).toBeDefined();
  });

  it("preserves an existing account allowlist and other runtime environment values", () => {
    const { result, calls } = run("deploy");
    expect(result.status, result.stderr).toBe(0);
    const deploy = calls.find(call => call.slice(0, 2).join(" ") === "run deploy") ?? [];
    expect(deploy).toContain("--no-traffic");
    expect(deploy.some(value => value.startsWith("--env-vars-file="))).toBe(false);
    expect(deploy.some(value => value.startsWith("--set-secrets="))).toBe(false);
    expect(deploy).toContain("--update-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    const update = deploy.find(value => value.startsWith("--update-env-vars=")) ?? "";
    expect(update).toContain("KCALCUE_ANALYSIS_ENABLED=false");
    expect(update).not.toContain("KCALCUE_ALLOWED_EMAILS");
  });

  it("refuses an existing service with a different account allowlist before deployment", () => {
    const { result, calls } = run("deploy", "allowed-mismatch");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("allowed-email list differs");
    expect(calls.some(call => call.slice(0, 2).join(" ") === "run deploy")).toBe(false);
    expect(calls.some(call => call.includes("update-traffic"))).toBe(false);
  });

  it.each(["missing-switch", "unknown-switch"])("stops before deploy when the existing analysis switch is %s", failure => {
    const { result, calls } = run("deploy", failure);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Existing analysis switch is unknown");
    expect(calls.some(call => call.slice(0, 2).join(" ") === "run deploy")).toBe(false);
    expect(calls.some(call => call.includes("update-traffic"))).toBe(false);
  });

  it("keeps the first deployment paused and provides its explicit account list", () => {
    const { result, calls, finalState } = run("deploy", "new-service");
    expect(result.status, result.stderr).toBe(0);
    const deploy = calls.find(call => call.slice(0, 2).join(" ") === "run deploy") ?? [];
    expect(deploy.some(value => value.startsWith("--env-vars-file="))).toBe(true);
    expect(deploy).toContain("--set-secrets=OPENAI_API_KEY=kcalcue-openai:1");
    expect(deploy).toContain("--no-traffic");
    expect(finalState.enabled).toBe("false");
    expect(finalState.configuredEmails).toBe("tester@example.com");
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
