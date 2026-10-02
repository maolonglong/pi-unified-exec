import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findForeignResolvedUrls } from "./check-lockfile-registry.mjs";

const lock = (packages) => ({ lockfileVersion: 3, packages });

test("accepts the public registry, workspace links and entries without a resolved URL", () => {
  assert.deepEqual(
    findForeignResolvedUrls(
      lock({
        "": { name: "root" },
        "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
        "node_modules/pkg": { resolved: "packages/pkg", link: true },
        "node_modules/b": { version: "1.0.0" },
      }),
    ),
    [],
  );
});

test("reports packages resolved from another registry, mirror or git host", () => {
  assert.deepEqual(
    findForeignResolvedUrls(
      lock({
        "node_modules/a": { resolved: "https://registry.example.test/a/-/a-1.0.0.tgz" },
        "node_modules/b": { resolved: "https://registry.npmjs.org.evil.test/b/-/b-1.0.0.tgz" },
        "node_modules/c": { resolved: "git+ssh://git@github.com/o/c.git#abc" },
      }),
    ).map((entry) => entry.path),
    ["node_modules/a", "node_modules/b", "node_modules/c"],
  );
});

test("the command exits non-zero and names the offending package", () => {
  const directory = mkdtempSync(join(tmpdir(), "lockfile-registry-test-"));
  try {
    const file = join(directory, "package-lock.json");
    writeFileSync(
      file,
      JSON.stringify(lock({ "node_modules/a": { resolved: "https://mirror.example.test/a.tgz" } })),
    );
    assert.throws(
      () =>
        execFileSync("node", ["scripts/check-lockfile-registry.mjs", file], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (error) => error.status === 1 && error.stderr.includes("node_modules/a"),
    );
    writeFileSync(file, JSON.stringify(lock({})));
    execFileSync("node", ["scripts/check-lockfile-registry.mjs", file], { stdio: "ignore" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
