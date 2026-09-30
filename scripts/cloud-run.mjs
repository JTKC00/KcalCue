import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const help = `Cloud Run private trial (explicit commands; staging never promotes)
  node scripts/cloud-run.mjs preflight --config /private/trial-config.json
  node scripts/cloud-run.mjs build --config /private/trial-config.json --tag <immutable-tag>
  node scripts/cloud-run.mjs stage --config /private/trial-config.json --tag <verified-tag>
  node scripts/cloud-run.mjs promote --config /private/trial-config.json --revision <candidate-revision>
  node scripts/cloud-run.mjs rollback --config /private/trial-config.json --revision <previous-revision>
  node scripts/cloud-run.mjs pause --config /private/trial-config.json
  node scripts/cloud-run.mjs resume --config /private/trial-config.json
stage creates a zero-traffic candidate and does not call update-traffic.
promote is separate and requires the exact candidate revision after inspection and approval.
deploy was split for safety and is rejected.
Optional nutritionSecretVersion maps NUTRITION_API_KEY to kcalcue-nutrition:<version>. Omit it to keep the OpenAI secret only.
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
  nutritionSecretVersion: z.string().regex(/^[1-9]\d*$/).optional(),
}).strict();
const actions = ["preflight", "build", "stage", "promote", "rollback", "pause", "resume"];
const productionModel = "gpt-5.6-luna";
const deployRetired = "deploy was split for safety and no longer stages and promotes in one step. Use stage to create a zero-traffic candidate, then promote --revision <candidate> after inspection and approval.";

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, tag: { type: "string" }, revision: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const action = positionals[0];
  if (positionals.length !== 1) throw new Error("Unknown action.");
  if (action === "deploy") throw new Error(deployRetired);
  if (!actions.includes(action)) throw new Error("Unknown action.");
  if (!values.config) throw new Error("Provide --config pointing to a private trial configuration.");
  const config = schema.parse(JSON.parse(readFileSync(values.config, "utf8")));
  const brandedDomain = config.projectId === "gen-lang-client-0116641325" && config.firebaseAuthDomain === "kcalcue.snugzap.com";
  if (!brandedDomain && config.firebaseAuthDomain !== `${config.projectId}.firebaseapp.com`) throw new Error("Firebase auth domain must match the dedicated project.");
  const isRevision = value => typeof value === "string" && /^kcalcue-[a-z0-9-]+$/.test(value);
  const isTag = value => typeof value === "string" && /^[a-z0-9][a-z0-9.-]{0,90}$/.test(value) && value !== "latest";
  if ((action === "build" || action === "stage") && !isTag(values.tag)) throw new Error("Provide a unique immutable --tag (not latest).");
  if (action === "promote" && !isRevision(values.revision)) throw new Error("Provide the verified candidate --revision.");
  if (action === "rollback" && !isRevision(values.revision)) throw new Error("Provide the previously verified --revision.");
  const executable = process.env.GCLOUD_BIN || "gcloud";
  function gcloud(args, capture = false) {
    const result = spawnSync(executable, [...args, "--project", config.projectId, "--quiet"], {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", shell: false,
    });
    if (result.error || result.status !== 0) throw new Error("gcloud failed; inspect the command result and authenticate/configure the dedicated project before retrying.");
    return capture ? result.stdout.trim() : "";
  }
  const normalizeEmails = value => value.split(",").map(email => email.trim().toLowerCase()).filter(Boolean).sort().join(",");
  const expectedEmails = () => normalizeEmails(config.allowedEmails.join(","));
  const imagePrefix = `${config.region}-docker.pkg.dev/${config.projectId}/kcalcue/web@`;
  const declaredSecrets = [
    { envName: "OPENAI_API_KEY", secretName: "kcalcue-openai", secretVersion: config.openaiSecretVersion },
    ...(config.nutritionSecretVersion
      ? [{ envName: "NUTRITION_API_KEY", secretName: "kcalcue-nutrition", secretVersion: config.nutritionSecretVersion }]
      : []),
  ];
  const secretFlag = `--set-secrets=${declaredSecrets.map(secret => `${secret.envName}=${secret.secretName}:${secret.secretVersion}`).join(",")}`;
  const secretMismatch = "Revision secrets do not match the declared production secret set; traffic was not changed.";
  function describeRevision(revision) {
    if (!isRevision(revision)) throw new Error("The updated revision could not be identified; traffic was not changed.");
    const described = JSON.parse(gcloud(["run", "revisions", "describe", revision, `--region=${config.region}`, "--format=json"], true));
    const containers = described?.spec?.containers;
    if (!Array.isArray(containers) || containers.length !== 1) throw new Error("Revision container configuration is uncertain; traffic was not changed.");
    return { described, container: containers[0] };
  }
  function requireEnv(container) {
    if (!Array.isArray(container?.env)) throw new Error("Revision environment is uncertain; traffic was not changed.");
    return container.env;
  }
  function envValue(container, name) {
    const matches = container.env.filter(entry => entry?.name === name);
    if (matches.length > 1) throw new Error("Revision environment is ambiguous; traffic was not changed.");
    return matches.length === 1 ? matches[0].value : undefined;
  }
  function geminiPresent(described, container) {
    if (container.env.some(entry => entry?.name === "GEMINI_MODEL" || entry?.name === "GEMINI_API_KEY")) return true;
    if (container.env.some(entry => entry?.name === "KCALCUE_VISION_PROVIDER" && entry?.value === "gemini")) return true;
    if (container.env.some(entry => {
      const ref = entry?.valueFrom?.secretKeyRef ?? entry?.valueSource?.secretKeyRef;
      const secretName = ref?.name ?? ref?.secret;
      return secretName === "kcalcue-gemini" || secretName === "GEMINI_API_KEY";
    })) return true;
    const volumes = described?.spec?.volumes ?? [];
    if (!Array.isArray(volumes)) return true;
    return volumes.some(volume => {
      const name = volume?.secret?.secretName ?? volume?.secretName;
      return name === "kcalcue-gemini" || name === "GEMINI_API_KEY";
    });
  }
  function assertPinnedImage(container, described, expectedImage) {
    const image = container?.image;
    const digest = typeof image === "string" && image.startsWith(imagePrefix) ? image.slice(imagePrefix.length) : "";
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Revision image is not an immutable project digest; traffic was not changed.");
    const statusDigest = described?.status?.imageDigest;
    if (statusDigest != null && statusDigest !== digest) throw new Error("Revision image digest does not match the staged image; traffic was not changed.");
    if (expectedImage != null && image !== expectedImage) throw new Error("Revision image digest does not match the staged image; traffic was not changed.");
  }
  function assertProductionSecrets(described, container) {
    const secretEntries = [];
    for (const entry of container.env) {
      if (!entry || typeof entry.name !== "string") throw new Error("Revision environment is uncertain; traffic was not changed.");
      if (entry.valueFrom !== undefined || entry.valueSource !== undefined) {
        if (entry.value !== undefined) throw new Error("Revision secret configuration is uncertain; traffic was not changed.");
        const ref = entry.valueFrom?.secretKeyRef ?? entry.valueSource?.secretKeyRef;
        const secretName = ref?.name ?? ref?.secret;
        const secretVersion = ref?.key ?? ref?.version;
        if (typeof secretName !== "string" || secretName.length === 0 || secretVersion == null) throw new Error("Revision secret configuration is uncertain; traffic was not changed.");
        secretEntries.push({ envName: entry.name, secretName, secretVersion: String(secretVersion) });
      }
    }
    const volumes = described?.spec?.volumes ?? [];
    if (!Array.isArray(volumes) || volumes.some(volume => volume?.secret || volume?.secretName)) throw new Error(secretMismatch);
    const sameSecret = (actual, expected) => actual.envName === expected.envName && actual.secretName === expected.secretName && actual.secretVersion === expected.secretVersion;
    const matchesDeclared = secretEntries.length === declaredSecrets.length && declaredSecrets.every(expected => secretEntries.filter(actual => sameSecret(actual, expected)).length === 1);
    if (!matchesDeclared) throw new Error(secretMismatch);
  }
  // Candidate revisions must declare the production provider. Rollback may
  // target an older OpenAI revision that predates KCALCUE_VISION_PROVIDER.
  function assertProductionProvider(described, container, { requireProvider, expectedImage }) {
    if (geminiPresent(described, container)) throw new Error("Gemini RC configuration is still present; traffic was not changed.");
    const provider = envValue(container, "KCALCUE_VISION_PROVIDER");
    const providerMismatch = requireProvider ? provider !== "openai" : provider !== undefined && provider !== "openai";
    if (providerMismatch) throw new Error("Vision provider is not openai; traffic was not changed.");
    if (envValue(container, "OPENAI_MODEL") !== productionModel) throw new Error("OpenAI model is not gpt-5.6-luna; traffic was not changed.");
    assertProductionSecrets(described, container);
    assertPinnedImage(container, described, expectedImage);
  }
  function assertCandidate(revision, analysisEnabled, expectedImage) {
    const { described, container } = describeRevision(revision);
    requireEnv(container);
    const ready = Array.isArray(described?.status?.conditions)
      ? described.status.conditions.filter(entry => entry?.type === "Ready" && entry?.status === "True")
      : [];
    if (ready.length !== 1) throw new Error("Revision is not Ready; traffic was not changed.");
    if (envValue(container, "NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId) throw new Error("Firebase project does not match config; traffic was not changed.");
    const emails = envValue(container, "KCALCUE_ALLOWED_EMAILS");
    if (typeof emails !== "string" || normalizeEmails(emails) !== expectedEmails()) throw new Error("Account allowlist does not match config; traffic was not changed.");
    if (envValue(container, "KCALCUE_ANALYSIS_ENABLED") !== String(analysisEnabled)) throw new Error("Analysis switch does not match the approved production state; traffic was not changed.");
    assertProductionProvider(described, container, { requireProvider: true, expectedImage });
  }
  function productionTraffic() {
    const service = JSON.parse(gcloud(["run", "services", "describe", "kcalcue", `--region=${config.region}`, "--format=json"], true));
    const traffic = service?.status?.traffic;
    if (!Array.isArray(traffic)) throw new Error("Current serving revision is uncertain; traffic was not changed.");
    return { service, traffic, serving: traffic.filter(entry => entry && typeof entry === "object" && entry.percent > 0) };
  }
  function requireSingleServing() {
    const snapshot = productionTraffic();
    const name = snapshot.serving[0]?.revisionName;
    if (snapshot.serving.length !== 1 || snapshot.serving[0].percent !== 100 || !isRevision(name)) {
      throw new Error("Current serving revision is uncertain; traffic was not changed.");
    }
    return { ...snapshot, revision: name };
  }
  function verifyTraffic(revision) {
    const { service, serving } = productionTraffic();
    if (serving.length !== 1 || serving[0].revisionName !== revision || serving[0].percent !== 100 ||
        !service.status?.conditions?.some(entry => entry.type === "Ready" && entry.status === "True")) {
      throw new Error("Traffic verification failed; inspect the service before continuing the trial.");
    }
  }
  function assertStagedTraffic(candidate, previous) {
    const { traffic, serving } = productionTraffic();
    if (traffic.some(entry => entry?.revisionName === candidate && entry.percent > 0)) {
      throw new Error("Candidate received production traffic; traffic was not changed.");
    }
    if (previous) {
      if (serving.length !== 1 || serving[0].revisionName !== previous || serving[0].percent !== 100) {
        throw new Error("Production traffic is no longer entirely on the pre-stage revision; traffic was not changed.");
      }
      return;
    }
    if (serving.length !== 0) throw new Error("Production traffic is not empty after the first stage; traffic was not changed.");
  }
  function readServingState() {
    const services = JSON.parse(gcloud(["run", "services", "list", `--region=${config.region}`, "--filter=metadata.name=kcalcue", "--format=json"], true));
    if (!Array.isArray(services) || services.length > 1) throw new Error("Expected at most one KcalCue service; deployment stopped.");
    if (services.length === 0) return null;
    const { revision } = requireSingleServing();
    const { container } = describeRevision(revision);
    requireEnv(container);
    const project = envValue(container, "NEXT_PUBLIC_FIREBASE_PROJECT_ID");
    const emails = envValue(container, "KCALCUE_ALLOWED_EMAILS");
    const analysis = envValue(container, "KCALCUE_ANALYSIS_ENABLED");
    if (project !== config.projectId || typeof emails !== "string" || normalizeEmails(emails) !== expectedEmails()) {
      throw new Error("Existing project or allowed-email list differs from config; deployment stopped before mutation.");
    }
    if (analysis !== "true" && analysis !== "false") throw new Error("Existing analysis switch is unknown; deployment stopped before mutation.");
    return { revision, analysisEnabled: analysis === "true", image: container.image };
  }
  function withRuntimeFile(analysisEnabled, fn) {
    const temporary = mkdtempSync(path.join(tmpdir(), "kcalcue-deploy-"));
    try {
      const envFile = path.join(temporary, "runtime.json");
      // JSON is accepted by gcloud's env-vars-file parser. The file replaces
      // every existing variable, so a Gemini template value cannot survive.
      writeFileSync(envFile, JSON.stringify({
        NEXT_PUBLIC_FIREBASE_API_KEY: config.firebaseApiKey,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: config.projectId,
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: config.firebaseAuthDomain,
        NEXT_PUBLIC_FIREBASE_APP_ID: config.firebaseAppId,
        KCALCUE_ALLOWED_EMAILS: config.allowedEmails.join(","),
        KCALCUE_ANALYSIS_ENABLED: String(analysisEnabled),
        OPENAI_MODEL: productionModel,
        KCALCUE_VISION_PROVIDER: "openai",
      }), { mode: 0o600 });
      return fn(envFile);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  function pinnedImageForTag(tag) {
    const image = `${config.region}-docker.pkg.dev/${config.projectId}/kcalcue/web:${tag}`;
    const digest = gcloud(["artifacts", "docker", "images", "describe", image, "--format=value(image_summary.digest)"], true);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Image digest could not be verified.");
    return `${imagePrefix}${digest}`;
  }
  function routeRevision(revision, analysisEnabled, expectedImage) {
    assertCandidate(revision, analysisEnabled, expectedImage);
    gcloud(["run", "services", "update-traffic", "kcalcue", `--region=${config.region}`, `--to-revisions=${revision}=100`]);
    verifyTraffic(revision);
    console.log(`PASS: ${revision} receives 100% of traffic; analysis=${analysisEnabled}.`);
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
    if (config.nutritionSecretVersion) {
      const nutrition = spawnSync(executable, ["secrets", "versions", "describe", config.nutritionSecretVersion, "--secret=kcalcue-nutrition", "--format=value(state)", "--project", config.projectId, "--quiet"], {
        stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: false,
      });
      if (nutrition.error || nutrition.status !== 0 || nutrition.stdout.trim() !== "ENABLED") {
        throw new Error("The configured nutrition secret version is missing or not enabled.");
      }
    }
    console.log("PASS: dedicated project label, billing, APIs and enabled secret version. Device flows, IAM permissions and alert delivery still require acceptance.");
    return;
  }
  if (action === "build") {
    const image = `${config.region}-docker.pkg.dev/${config.projectId}/kcalcue/web:${values.tag}`;
    gcloud(["builds", "submit", ".", "--config=deploy/cloudbuild.yaml", `--region=${config.region}`,
      `--service-account=projects/${config.projectId}/serviceAccounts/kcalcue-builder@${config.projectId}.iam.gserviceaccount.com`,
      `--gcs-source-staging-dir=gs://${config.projectId}-kcalcue-build/source`,
      `--substitutions=^|^_IMAGE=${image}|_FIREBASE_API_KEY=${config.firebaseApiKey}|_FIREBASE_AUTH_DOMAIN=${config.firebaseAuthDomain}|_FIREBASE_APP_ID=${config.firebaseAppId}`]);
    return;
  }
  if (action === "stage") {
    const pinnedImage = pinnedImageForTag(values.tag);
    const serving = readServingState();
    const analysisEnabled = serving ? serving.analysisEnabled : false;
    const revision = withRuntimeFile(analysisEnabled, envFile => gcloud(["run", "deploy", "kcalcue", `--image=${pinnedImage}`,
      `--region=${config.region}`, `--service-account=kcalcue-runtime@${config.projectId}.iam.gserviceaccount.com`,
      "--allow-unauthenticated", "--no-traffic", "--port=8080", "--cpu=1", "--memory=1Gi", "--concurrency=4", "--timeout=120s",
      "--min=0", "--max=1", "--min-instances=0", "--max-instances=1", "--cpu-throttling", "--no-cpu-boost",
      `--env-vars-file=${envFile}`, secretFlag, "--format=value(status.latestCreatedRevisionName)"], true));
    assertCandidate(revision, analysisEnabled, pinnedImage);
    assertStagedTraffic(revision, serving?.revision ?? null);
    console.log(serving
      ? `PASS: staged ${revision} at 0% traffic; production remains ${serving.revision}; analysis=${analysisEnabled}.`
      : `PASS: staged ${revision} at 0% traffic; no production revision is serving; analysis=${analysisEnabled}.`);
    return;
  }
  if (action === "promote") {
    const current = JSON.parse(gcloud(["run", "services", "describe", "kcalcue", `--region=${config.region}`, "--format=json"], true));
    const serving = current.status?.traffic?.filter(entry => entry.percent > 0) ?? [];
    if (!Array.isArray(current.status?.traffic) || serving.length !== 1 || serving[0].percent !== 100 || !isRevision(serving[0].revisionName)) {
      throw new Error("Current serving revision is uncertain; traffic was not changed.");
    }
    const active = describeRevision(serving[0].revisionName);
    requireEnv(active.container);
    const activeEmails = envValue(active.container, "KCALCUE_ALLOWED_EMAILS");
    const activeAnalysis = envValue(active.container, "KCALCUE_ANALYSIS_ENABLED");
    if (envValue(active.container, "NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
        typeof activeEmails !== "string" || normalizeEmails(activeEmails) !== expectedEmails()) {
      throw new Error("Current serving account or project settings differ from config; promotion stopped before traffic mutation.");
    }
    if (activeAnalysis !== "true" && activeAnalysis !== "false") throw new Error("Existing analysis switch is unknown; promotion stopped before traffic mutation.");
    routeRevision(values.revision, activeAnalysis === "true", null);
    return;
  }
  if (action === "rollback") {
    const current = JSON.parse(gcloud(["run", "services", "describe", "kcalcue", `--region=${config.region}`, "--format=json"], true));
    const serving = current.status?.traffic?.filter(entry => entry.percent > 0) ?? [];
    if (!Array.isArray(current.status?.traffic) || serving.length !== 1 || serving[0].percent !== 100 || !isRevision(serving[0].revisionName)) {
      throw new Error("Current serving revision is uncertain; rollback traffic was not changed.");
    }
    const active = describeRevision(serving[0].revisionName);
    requireEnv(active.container);
    const activeEmails = envValue(active.container, "KCALCUE_ALLOWED_EMAILS");
    if (envValue(active.container, "NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
        typeof activeEmails !== "string" || normalizeEmails(activeEmails) !== expectedEmails()) {
      throw new Error("Current serving account or project settings differ from config; rollback traffic was not changed.");
    }
    const target = describeRevision(values.revision);
    requireEnv(target.container);
    const targetEmails = envValue(target.container, "KCALCUE_ALLOWED_EMAILS");
    const targetReady = Array.isArray(target.described.status?.conditions)
      ? target.described.status.conditions.filter(entry => entry?.type === "Ready" && entry?.status === "True")
      : [];
    if (envValue(target.container, "NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== config.projectId ||
        typeof targetEmails !== "string" || normalizeEmails(targetEmails) !== expectedEmails() ||
        !["true", "false"].includes(envValue(target.container, "KCALCUE_ANALYSIS_ENABLED")) ||
        targetReady.length !== 1) {
      throw new Error("Rollback target is not a ready revision with the expected account, project and analysis settings; traffic was not changed.");
    }
    assertProductionProvider(target.described, target.container, { requireProvider: false, expectedImage: null });
    gcloud(["run", "services", "update-traffic", "kcalcue", `--region=${config.region}`, `--to-revisions=${values.revision}=100`]);
    verifyTraffic(values.revision);
    console.log(`PASS: ${values.revision} receives 100% of traffic after rollback.`);
    return;
  }
  const serving = readServingState();
  if (!serving) throw new Error("Current serving revision is uncertain; traffic was not changed.");
  const digest = typeof serving.image === "string" && serving.image.startsWith(imagePrefix) ? serving.image.slice(imagePrefix.length) : "";
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Serving revision image is not an immutable project digest; traffic was not changed.");
  const analysisEnabled = action === "resume";
  const revision = withRuntimeFile(analysisEnabled, envFile => gcloud(["run", "services", "update", "kcalcue", `--image=${serving.image}`,
    `--region=${config.region}`, "--no-traffic", `--env-vars-file=${envFile}`, secretFlag,
    "--format=value(status.latestCreatedRevisionName)"], true));
  routeRevision(revision, analysisEnabled, serving.image);
}
try { main(); } catch (error) {
  console.error(error instanceof Error && error.name === "Error" ? error.message : "Invalid private deployment configuration; no secret values are printed.");
  process.exitCode = 1;
}
