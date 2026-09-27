import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const help = `Cloud Run private trial (explicit commands; no automatic deploy)
  node scripts/cloud-run.mjs preflight --config /private/trial-config.json
  node scripts/cloud-run.mjs build --config /private/trial-config.json --tag <immutable-tag>
  node scripts/cloud-run.mjs deploy --config /private/trial-config.json --tag <verified-tag>
  node scripts/cloud-run.mjs rollback --config /private/trial-config.json --revision <previous-revision>
  node scripts/cloud-run.mjs pause --config /private/trial-config.json
  node scripts/cloud-run.mjs resume --config /private/trial-config.json
Requires dedicated project label kcalcue=private-trial, authenticated gcloud, and docs/qa/cloud-run-release-guard.md setup.
GCLOUD_BIN may specify an absolute gcloud executable. No secret values are accepted in config.`;
const schema = z.object({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  region: z.literal("asia-east1"),
  firebaseApiKey: z.string().min(15).regex(/^[a-zA-Z0-9_-]+$/),
  firebaseAuthDomain: z.string().regex(/^(?:[a-z0-9-]+\.firebaseapp\.com|kcalcue\.snugzap\.com)$/),
  firebaseAppId: z.string().regex(/^1:\d+:web:[a-zA-Z0-9]+$/),
  allowedEmails: z.array(z.email()).min(1).max(10),
  openaiSecretVersion: z.string().regex(/^[1-9]\d*$/),
}).strict();

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, tag: { type: "string" }, revision: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const action = positionals[0];
  if (positionals.length !== 1 || !["preflight", "build", "deploy", "rollback", "pause", "resume"].includes(action)) throw new Error("Unknown action.");
  if (!values.config) throw new Error("Provide --config pointing to a private trial configuration.");
  const config = schema.parse(JSON.parse(readFileSync(values.config, "utf8")));
  const brandedDomain = config.projectId === "gen-lang-client-0116641325" && config.firebaseAuthDomain === "kcalcue.snugzap.com";
  if (!brandedDomain && config.firebaseAuthDomain !== `${config.projectId}.firebaseapp.com`) throw new Error("Firebase auth domain must match the dedicated project.");
  const executable = process.env.GCLOUD_BIN || "gcloud";
  function gcloud(args, capture = false) {
    const result = spawnSync(executable, [...args, "--project", config.projectId, "--quiet"], {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", shell: false,
    });
    if (result.error || result.status !== 0) throw new Error("gcloud failed; inspect the command result and authenticate/configure the dedicated project before retrying.");
    return capture ? result.stdout.trim() : "";
  }
  const normalizeEmails = value => value.split(",").map(email => email.trim().toLowerCase()).filter(Boolean).sort().join(",");
  function routeRevision(revision, analysisEnabled) {
    if (!/^kcalcue-[a-z0-9-]+$/.test(revision)) throw new Error("The updated revision could not be identified; traffic was not changed.");
    const candidate = JSON.parse(gcloud(["run", "revisions", "describe", revision, `--region=${config.region}`, "--format=json"], true));
    const candidateEnv = candidate.spec?.containers?.[0]?.env ?? [];
    const candidateValue = name => candidateEnv.find(entry => entry.name === name)?.value;
    if (candidateValue("KCALCUE_ANALYSIS_ENABLED") !== String(analysisEnabled) ||
        candidateValue("NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
        typeof candidateValue("KCALCUE_ALLOWED_EMAILS") !== "string" ||
        normalizeEmails(candidateValue("KCALCUE_ALLOWED_EMAILS")) !== normalizeEmails(config.allowedEmails.join(",")) ||
        !candidate.status?.conditions?.some(entry => entry.type === "Ready" && entry.status === "True")) {
      throw new Error("The updated revision has unexpected account, project or analysis settings, or is not ready; traffic was not changed.");
    }
    // A previous rollback pins traffic. Updating the template alone does not
    // move requests to the new revision, even when gcloud reports success.
    gcloud(["run", "services", "update-traffic", "kcalcue", `--region=${config.region}`, `--to-revisions=${revision}=100`]);
    verifyTraffic(revision);
    console.log(`PASS: ${revision} receives 100% of traffic; analysis=${analysisEnabled}.`);
  }
  function verifyTraffic(revision) {
    const service = JSON.parse(gcloud(["run", "services", "describe", "kcalcue", `--region=${config.region}`, "--format=json"], true));
    const serving = service.status?.traffic?.filter(entry => entry.percent > 0) ?? [];
    if (serving.length !== 1 || serving[0].revisionName !== revision || serving[0].percent !== 100 ||
        !service.status?.conditions?.some(entry => entry.type === "Ready" && entry.status === "True")) {
      throw new Error("Traffic verification failed; inspect the service before continuing the trial.");
    }
  }
  const label = gcloud(["projects", "describe", config.projectId, "--format=value(labels.kcalcue)"], true);
  if (label !== "private-trial") throw new Error("Refusing to modify a project without label kcalcue=private-trial.");
  if (action === "preflight") {
    const billing = gcloud(["billing", "projects", "describe", config.projectId, "--format=value(billingEnabled)"], true);
    if (billing.toLowerCase() !== "true") throw new Error("Billing is not enabled for the dedicated project.");
    const enabled = gcloud(["services", "list", "--enabled", "--format=value(config.name)"], true).split("\n");
    const required = ["run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "firestore.googleapis.com", "identitytoolkit.googleapis.com"];
    if (required.some(api => !enabled.includes(api))) throw new Error("Required project APIs are missing; finish CLOUD_RUN.md setup.");
    const secret = gcloud(["secrets", "versions", "describe", config.openaiSecretVersion, "--secret=kcalcue-openai", "--format=value(state)"], true);
    if (secret !== "ENABLED") throw new Error("The selected secret version is not enabled.");
    console.log("PASS: dedicated project label, billing, APIs and enabled secret version. Device flows, IAM permissions and alert delivery still require acceptance.");
    return;
  }
  if (action === "build" || action === "deploy") {
    if (!values.tag || !/^[a-z0-9][a-z0-9.-]{0,90}$/.test(values.tag) || values.tag === "latest") throw new Error("Provide a unique immutable --tag (not latest).");
    const image = `${config.region}-docker.pkg.dev/${config.projectId}/kcalcue/web:${values.tag}`;
    if (action === "build") {
      gcloud(["builds", "submit", ".", "--config=deploy/cloudbuild.yaml", `--region=${config.region}`,
        `--service-account=projects/${config.projectId}/serviceAccounts/kcalcue-builder@${config.projectId}.iam.gserviceaccount.com`,
        `--gcs-source-staging-dir=gs://${config.projectId}-kcalcue-build/source`,
        `--substitutions=^|^_IMAGE=${image}|_FIREBASE_API_KEY=${config.firebaseApiKey}|_FIREBASE_AUTH_DOMAIN=${config.firebaseAuthDomain}|_FIREBASE_APP_ID=${config.firebaseAppId}`]);
      return;
    }
    const digest = gcloud(["artifacts", "docker", "images", "describe", image, "--format=value(image_summary.digest)"], true);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Image digest could not be verified.");
    const services = JSON.parse(gcloud(["run", "services", "list", `--region=${config.region}`, "--filter=metadata.name=kcalcue", "--format=json"], true));
    if (!Array.isArray(services) || services.length > 1) throw new Error("Expected at most one KcalCue service; deployment stopped.");
    const existing = services[0];
    const currentEnv = existing?.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const envValue = name => currentEnv.find(entry => entry.name === name)?.value;
    if (existing) {
      if (envValue("NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
          typeof envValue("KCALCUE_ALLOWED_EMAILS") !== "string" ||
          normalizeEmails(envValue("KCALCUE_ALLOWED_EMAILS")) !== normalizeEmails(config.allowedEmails.join(","))) {
        throw new Error("Existing project or allowed-email list differs from config; deployment stopped before mutation.");
      }
      if (!["true", "false"].includes(envValue("KCALCUE_ANALYSIS_ENABLED"))) {
        throw new Error("Existing analysis switch is unknown; deployment stopped before mutation.");
      }
    }
    const analysisEnabled = envValue("KCALCUE_ANALYSIS_ENABLED") === "true";
    const temporary = mkdtempSync(path.join(tmpdir(), "kcalcue-deploy-"));
    try {
      const envFile = path.join(temporary, "runtime.json");
      writeFileSync(envFile, JSON.stringify({
        NEXT_PUBLIC_FIREBASE_API_KEY: config.firebaseApiKey,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: config.projectId,
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: config.firebaseAuthDomain,
        NEXT_PUBLIC_FIREBASE_APP_ID: config.firebaseAppId,
        KCALCUE_ALLOWED_EMAILS: config.allowedEmails.join(","),
        // A first deployment starts paused; subsequent releases preserve the operator's switch.
        KCALCUE_ANALYSIS_ENABLED: String(analysisEnabled), OPENAI_MODEL: "gpt-5.6-luna",
      }), { mode: 0o600 });
      const publicEnv = [
        `NEXT_PUBLIC_FIREBASE_API_KEY=${config.firebaseApiKey}`,
        `NEXT_PUBLIC_FIREBASE_PROJECT_ID=${config.projectId}`,
        `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${config.firebaseAuthDomain}`,
        `NEXT_PUBLIC_FIREBASE_APP_ID=${config.firebaseAppId}`,
        `KCALCUE_ANALYSIS_ENABLED=${analysisEnabled}`,
      ];
      const revision = gcloud(["run", "deploy", "kcalcue", `--image=${image.slice(0, image.lastIndexOf(":"))}@${digest}`,
        `--region=${config.region}`, `--service-account=kcalcue-runtime@${config.projectId}.iam.gserviceaccount.com`,
        "--allow-unauthenticated", "--no-traffic", "--port=8080", "--cpu=1", "--memory=1Gi", "--concurrency=4", "--timeout=120s",
        "--min=0", "--max=1", "--min-instances=0", "--max-instances=1", "--cpu-throttling", "--no-cpu-boost",
        ...(existing ? [`--update-env-vars=${publicEnv.join(",")}`, `--update-secrets=OPENAI_API_KEY=kcalcue-openai:${config.openaiSecretVersion}`]
          : [`--env-vars-file=${envFile}`, `--set-secrets=OPENAI_API_KEY=kcalcue-openai:${config.openaiSecretVersion}`]),
        "--format=value(status.latestCreatedRevisionName)"], true);
      routeRevision(revision, analysisEnabled);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  } else if (action === "rollback") {
    if (!values.revision || !/^kcalcue-[a-z0-9-]+$/.test(values.revision)) throw new Error("Provide the previously verified --revision.");
    const current = JSON.parse(gcloud(["run", "services", "describe", "kcalcue", `--region=${config.region}`, "--format=json"], true));
    const serving = current.status?.traffic?.filter(entry => entry.percent > 0) ?? [];
    if (serving.length !== 1 || serving[0].percent !== 100 ||
        !/^kcalcue-[a-z0-9-]+$/.test(serving[0].revisionName ?? "")) {
      throw new Error("Current serving revision is uncertain; rollback traffic was not changed.");
    }
    const active = JSON.parse(gcloud(["run", "revisions", "describe", serving[0].revisionName,
      `--region=${config.region}`, "--format=json"], true));
    const activeEnv = active.spec?.containers?.[0]?.env ?? [];
    const activeValue = name => activeEnv.find(entry => entry.name === name)?.value;
    if (activeValue("NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
        typeof activeValue("KCALCUE_ALLOWED_EMAILS") !== "string" ||
        normalizeEmails(activeValue("KCALCUE_ALLOWED_EMAILS")) !== normalizeEmails(config.allowedEmails.join(","))) {
      throw new Error("Current serving account or project settings differ from config; rollback traffic was not changed.");
    }
    const candidate = JSON.parse(gcloud(["run", "revisions", "describe", values.revision,
      `--region=${config.region}`, "--format=json"], true));
    const targetEnv = candidate.spec?.containers?.[0]?.env ?? [];
    const targetValue = name => targetEnv.find(entry => entry.name === name)?.value;
    if (targetValue("NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
        typeof targetValue("KCALCUE_ALLOWED_EMAILS") !== "string" ||
        normalizeEmails(targetValue("KCALCUE_ALLOWED_EMAILS")) !== normalizeEmails(config.allowedEmails.join(",")) ||
        !["true", "false"].includes(targetValue("KCALCUE_ANALYSIS_ENABLED")) ||
        !candidate.status?.conditions?.some(entry => entry.type === "Ready" && entry.status === "True")) {
      throw new Error("Rollback target is not a ready revision with the expected account, project and analysis settings; traffic was not changed.");
    }
    gcloud(["run", "services", "update-traffic", "kcalcue", `--region=${config.region}`, `--to-revisions=${values.revision}=100`]);
    verifyTraffic(values.revision);
    console.log(`PASS: ${values.revision} receives 100% of traffic after rollback.`);
  } else {
    const revision = gcloud(["run", "services", "update", "kcalcue", `--region=${config.region}`,
      `--update-env-vars=KCALCUE_ANALYSIS_ENABLED=${action === "resume"}`, "--no-traffic", "--format=value(status.latestCreatedRevisionName)"], true);
    routeRevision(revision, action === "resume");
  }
}
try { main(); } catch (error) {
  console.error(error instanceof Error && error.name === "Error" ? error.message : "Invalid private deployment configuration; no secret values are printed.");
  process.exitCode = 1;
}
