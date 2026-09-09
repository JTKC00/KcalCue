import { spawn } from "node:child_process";

// Test-only public configuration; all auth/cloud calls are intercepted by the test browser.
// No credentials or real Supabase projects are used by this server.
const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: "https://kcalcue-test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  OPENAI_API_KEY: "",
  NUTRITION_API_KEY: "",
};
function run(args) {
  return spawn(process.execPath, ["node_modules/next/dist/bin/next", ...args], {
    env,
    stdio: "inherit",
  });
}
function exit(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
if ((await exit(run(["build"]))) !== 0) process.exit(1);
const server = run(["start", "--hostname", "127.0.0.1", "--port", "3100"]);
try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:3100/api/status")).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for local server. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("E2E server did not start");
  process.exitCode = await exit(
    spawn(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        ...process.argv.slice(2),
      ],
      { env, stdio: "inherit" },
    ),
  );
} finally {
  server.kill();
}
