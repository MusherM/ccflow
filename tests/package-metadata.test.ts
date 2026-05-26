import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("package metadata is publishable as a scoped CLI package", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.name, "@lxy/ccflow");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin.ccflow, "./bin/ccflow.js");
  assert.equal(pkg.publishConfig.access, "public");
  assert.ok(pkg.files.includes("bin"));
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.equal(pkg.dependencies["@opentui/core"], "^0.2.14");
  assert.equal(pkg.dependencies.ink, undefined);
  assert.equal(pkg.devDependencies.ink, "^7.0.3");
});
