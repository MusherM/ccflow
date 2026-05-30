import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("package metadata is publishable as the scoped CLI package", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.name, "@musherm/ccflow");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.ccflow, "bin/ccflow.js");
  assert.equal(pkg.publishConfig, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.ok(pkg.files.includes("assets/ccflow-intro.png"));
  assert.ok(pkg.files.includes("assets/ccflow-logo.png"));
  assert.ok(pkg.files.includes("assets/ccflow-tui-node-graph.png"));
  assert.ok(pkg.files.includes("bin"));
  assert.ok(pkg.files.includes("dist"));
  assert.equal(pkg.files.some((file: string) => file.startsWith("scripts/")), false);
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("README_zh.md"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.equal(pkg.dependencies["@opentui/core"], "^0.2.14");
  assert.equal(pkg.dependencies.ink, undefined);
  assert.equal(pkg.devDependencies.ink, "^7.0.3");
});
