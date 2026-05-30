import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type BinBootstrapModule = {
  isMainModule(scriptPath?: string, moduleUrl?: string): boolean;
  splitSearchPath(value: string, platform?: NodeJS.Platform): string[];
  normalizePathEntry(entry: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
  collectSearchPathEntries(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
  resolveCommand(command: string, options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  }): string | null;
};

test("global bin resolves Bun from Windows MINGW paths", async () => {
  const bootstrap = await loadBootstrapModule();

  assert.deepEqual(
    bootstrap.splitSearchPath("/c/Users/14562/.bun/bin:/usr/bin", "win32"),
    ["/c/Users/14562/.bun/bin", "/usr/bin"],
  );
  assert.equal(
    bootstrap.normalizePathEntry("/c/Users/14562/.bun/bin", {}, "win32"),
    "C:\\Users\\14562\\.bun\\bin",
  );
  assert.deepEqual(
    bootstrap.collectSearchPathEntries({ Path: "/c/Users/14562/.bun/bin:/usr/bin" }, "win32"),
    ["C:\\Users\\14562\\.bun\\bin", "/usr/bin"],
  );
});

test("global bin applies PATHEXT during Windows Bun lookup", async () => {
  const bootstrap = await loadBootstrapModule();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-bun-bootstrap-"));
  const bunExe = path.join(binDir, "bun.EXE");
  fs.writeFileSync(bunExe, "");

  assert.equal(
    bootstrap.resolveCommand("bun", {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".EXE" },
    }),
    bunExe,
  );
});

test("global bin treats npm symlink shims as the main module", async () => {
  const bootstrap = await loadBootstrapModule();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-bin-main-"));
  const target = path.join(temp, "ccflow.js");
  const link = path.join(temp, "ccflow");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, link);

  assert.equal(bootstrap.isMainModule(link, pathToFileURL(target).href), true);
  assert.equal(bootstrap.isMainModule(link, pathToFileURL(fs.realpathSync(target)).href), true);
});

async function loadBootstrapModule(): Promise<BinBootstrapModule> {
  return await import(pathToFileURL(path.resolve("bin/ccflow.js")).href) as BinBootstrapModule;
}
