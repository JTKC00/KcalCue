import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

it.each([
  ["gen-lang-client-0116641325", "kcalcue.snugzap.com", true],
  ["demo-kcalcue", "kcalcue.snugzap.com", false],
  ["demo-kcalcue", "demo-kcalcue.firebaseapp.com", true],
  ["demo-kcalcue", "another-project.firebaseapp.com", false],
  ["gen-lang-client-0116641325", "attacker.example", false],
])("checks project %s with auth domain %s", (projectId, firebaseAuthDomain, allowed) => {
  const directory = mkdtempSync(path.join(tmpdir(), "kcalcue-domain-test-"));
  directories.push(directory);
  const config = path.join(directory, "config.json");
  const executable = path.join(directory, "gcloud.mjs");
  writeFileSync(config, JSON.stringify({ projectId, firebaseAuthDomain, region: "asia-east1",
    firebaseApiKey: "test-firebase-public-key", firebaseAppId: "1:123:web:abc",
    allowedEmails: ["tester@example.com"], openaiSecretVersion: "1" }));
  writeFileSync(executable, "#!/usr/bin/env node\nconsole.log('project-check-reached');\n", { mode: 0o700 });
  const result = spawnSync(process.execPath, ["scripts/cloud-run.mjs", "preflight", "--config", config], {
    encoding: "utf8", env: { ...process.env, GCLOUD_BIN: executable },
  });
  // The fake project lacks the required label, so accepted domains reach that
  // independent guard; rejected domains fail before any cloud operation.
  expect(result.status).toBe(1);
  expect(result.stderr.includes("without label")).toBe(allowed);
  if (!allowed) expect(result.stderr).toMatch(/domain must match|Invalid private deployment configuration/);
});
