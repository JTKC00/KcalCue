import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCatalogSync } from "./sync-nutrition-catalog.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCatalogSync(["--source", "mcdonalds-hk", ...process.argv.slice(2)]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
