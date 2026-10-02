#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PUBLIC_REGISTRY_HOST = "registry.npmjs.org";

/** Returns lockfile entries whose `resolved` URL points anywhere but the public npm registry. */
export function findForeignResolvedUrls(lock) {
  const foreign = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const { resolved } = entry;
    if (!resolved || entry.link) continue;
    let host;
    try {
      host = new URL(resolved).host;
    } catch {
      host = undefined;
    }
    if (host !== PUBLIC_REGISTRY_HOST) foreign.push({ path, resolved });
  }
  return foreign;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? "package-lock.json";
  const foreign = findForeignResolvedUrls(JSON.parse(readFileSync(file, "utf8")));
  if (foreign.length > 0) {
    for (const { path, resolved } of foreign) console.error(`${path}: ${resolved}`);
    console.error(
      `${file} resolves packages outside https://${PUBLIC_REGISTRY_HOST}/. ` +
        "Regenerate it with NPM_CONFIG_REGISTRY=https://registry.npmjs.org/.",
    );
    process.exit(1);
  }
}
