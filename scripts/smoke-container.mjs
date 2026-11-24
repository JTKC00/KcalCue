import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

assert.notEqual(process.getuid?.(), 0, "Runtime must not run as root");
assert.equal((await readdir("/app")).some(name => name.startsWith(".env")), false, "No env files in runtime image");
assert.ok(!process.env.OPENAI_API_KEY, "Smoke test must use a secret-free container");
const origin = `http://127.0.0.1:${process.env.PORT || "8080"}`;
const status = await fetch(`${origin}/api/status`);
assert.equal(status.status, 200);
assert.equal((await status.json()).online, true);
const page = await fetch(origin);
assert.equal(page.status, 200);
assert.ok(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
const html = await page.text();
const assets = [...new Set([...html.matchAll(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/g)].map(match => match[1].replaceAll("&amp;", "&")))];
assert.ok(assets.length > 0, "Page must reference built JS/CSS");
const fonts = new Set();
for (const asset of assets) {
  const response = await fetch(new URL(asset, origin));
  assert.equal(response.status, 200);
  if (/\.css(?:\?|$)/.test(asset)) {
    for (const match of (await response.text()).matchAll(/url\(\s*["']?(\/fonts\/[^"')\s]+)/g)) fonts.add(match[1]);
  }
}
// Self-hosted fonts live in public/, which both ignore files allowlist file by
// file. A missing entry would only show up as a 404 here, not in the build.
assert.ok(fonts.size > 0, "Built CSS must reference self-hosted fonts");
for (const font of fonts) {
  const response = await fetch(new URL(font, origin));
  assert.equal(response.status, 200, `Font ${font} must be served`);
  assert.match(response.headers.get("content-type") ?? "", /^font\/woff2/, `Font ${font} must be served as woff2`);
  assert.ok((await response.arrayBuffer()).byteLength > 0, `Font ${font} must not be empty`);
}
assert.equal((await fetch(`${origin}/sw.js`)).status, 200);
assert.equal((await fetch(`${origin}/manifest.webmanifest`)).status, 200);
const meals = await fetch(`${origin}/api/meals`);
assert.ok([401, 503].includes(meals.status), "Anonymous meal access must be rejected");
const form = new FormData(); form.set("mode", "demo");
const demo = await fetch(`${origin}/api/analyze`, { method: "POST", body: form });
assert.equal(demo.status, 200);
assert.equal((await demo.json()).mode, "demo");
console.log(`PASS: non-root, no env files, health, CSP, ${assets.length} static assets, ${fonts.size} fonts, PWA, anonymous rejection and Demo. No live API called.`);
