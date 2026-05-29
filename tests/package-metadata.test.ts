import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("package metadata is publishable as an unscoped CLI package", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.name, "ccflow");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.ccflow, "./bin/ccflow.js");
  assert.equal(pkg.publishConfig, undefined);
  assert.equal(pkg.scripts.postinstall, "node scripts/verify-opentui-runtime.mjs");
  assert.ok(pkg.files.includes("assets/ccflow-intro.png"));
  assert.ok(pkg.files.includes("assets/ccflow-logo.png"));
  assert.ok(pkg.files.includes("bin"));
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("scripts/verify-opentui-runtime.mjs"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("README_zh.md"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.equal(pkg.dependencies["@opentui/core"], "^0.2.14");
  assert.equal(pkg.dependencies.ink, undefined);
  assert.equal(pkg.devDependencies.ink, "^7.0.3");
});
