import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { runCcflowApp } from "../src/app.js";
import { GitAdapter } from "../src/core/git.js";
import { statePath } from "../src/core/storage.js";

test("help and version work outside repositories without side effects", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-help-"));
  const output: string[] = [];
  assert.equal(await runCli(["--version"], { cwd, stdout: (value) => output.push(value), stderr: (value) => output.push(value) }), 0);
  assert.equal(await runCli(["--help"], { cwd, stdout: (value) => output.push(value), stderr: (value) => output.push(value) }), 0);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".ccflow")), false);
  assert.match(output.join("\n"), /Usage:/);
});

test("init rejects non-git directories unless --git is provided", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-init-"));
  const errors: string[] = [];
  assert.equal(await runCli(["init"], { cwd, stderr: (value) => errors.push(value) }), 1);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  assert.match(errors.join("\n"), /requires an existing Git repository/);

  const output: string[] = [];
  assert.equal(await runCli(["init", "--git"], { cwd, stdout: (value) => output.push(value) }), 0);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), true);
  assert.equal(fs.existsSync(statePath(cwd)), true);
  assert.equal(fs.existsSync(path.join(cwd, ".ccflow", "prompts.json")), false);
});

test("default launch auto-initializes git repos and no-auto-init rejects missing state", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-launch-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);

  const errors: string[] = [];
  assert.equal(await runCli(["--no-auto-init"], { cwd: repoRoot, stderr: (value) => errors.push(value), startTui: async () => {} }), 1);
  assert.equal(fs.existsSync(statePath(repoRoot)), false);
  assert.match(errors.join("\n"), /not initialized/);

  let tuiStarted = false;
  assert.equal(await runCli([], { cwd: repoRoot, startTui: async () => { tuiStarted = true; } }), 0);
  assert.equal(tuiStarted, true);
  assert.equal(fs.existsSync(statePath(repoRoot)), true);
});

test("unsupported Node startup fails before repository state mutation", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-node-version-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);

  await assert.rejects(
    () => runCcflowApp({ cwd: repoRoot, nodeVersion: "21.9.0", startTui: async () => {} }),
    /requires Node\.js >=22/,
  );
  assert.equal(fs.existsSync(statePath(repoRoot)), false);
});

test("config commands expose paths, effective config, set, and prompt inspection", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-config-"));
  const globalPath = path.join(cwd, "global.json");
  const env = { ...process.env, CCFLOW_CONFIG: globalPath };
  const output: string[] = [];

  assert.equal(await runCli(["config", "path"], { cwd, env, stdout: (value) => output.push(value) }), 0);
  assert.match(output.join("\n"), /userGlobal:/);

  assert.equal(await runCli(["config", "set", "--global", "prompts.commit.instructions", "[\"from cli\"]"], { cwd, env, stdout: (value) => output.push(value) }), 0);
  assert.equal(fs.existsSync(globalPath), true);

  output.length = 0;
  assert.equal(await runCli(["config", "show-effective"], { cwd, env, stdout: (value) => output.push(value) }), 0);
  assert.match(output.join("\n"), /from cli/);

  output.length = 0;
  assert.equal(await runCli(["config", "prompt", "commit"], { cwd, env, stdout: (value) => output.push(value) }), 0);
  assert.match(output.join("\n"), /Effective commit prompt/);
  assert.match(output.join("\n"), /from cli/);
});
