import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { assertSupportedNodeVersion, runCcflowApp } from "../src/app.js";
import { GitAdapter } from "../src/core/git.js";
import { nodeSessionLockPath } from "../src/core/node-session.js";
import { loadState, statePath } from "../src/core/storage.js";

test("help and version work outside repositories without side effects", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-help-"));
  const output: string[] = [];
  assert.equal(await runCli(["--version"], { cwd, stdout: (value) => output.push(value), stderr: (value) => output.push(value) }), 0);
  assert.equal(await runCli(["--help"], { cwd, stdout: (value) => output.push(value), stderr: (value) => output.push(value) }), 0);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".ccflow")), false);
  assert.match(output.join("\n"), /Usage:/);
  assert.match(output.join("\n"), /--multitab/);
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

test("multitab CLI flag is passed into effective TUI config", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-multitab-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);

  let multitab: boolean | null = null;
  assert.equal(
    await runCli(["--multitab"], {
      cwd: repoRoot,
      startTui: async (_state, options) => {
        multitab = options.config.terminal.multitab;
      },
    }),
    0,
  );
  assert.equal(multitab, true);
});

test("default launch keeps multitab disabled", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-current-tab-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);

  let multitab: boolean | null = null;
  assert.equal(
    await runCli([], {
      cwd: repoRoot,
      startTui: async (_state, options) => {
        multitab = options.config.terminal.multitab;
      },
    }),
    0,
  );
  assert.equal(multitab, false);
});

test("unsupported Node startup fails before repository state mutation", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-node-version-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);

  assert.doesNotThrow(() => assertSupportedNodeVersion("22.0.0"));
  await assert.rejects(
    () => runCcflowApp({ cwd: repoRoot, nodeVersion: "21.9.0", startTui: async () => {} }),
    /requires Node\.js >=22/,
  );
  assert.equal(fs.existsSync(statePath(repoRoot)), false);
});

test("CLI reports missing option values and invalid config subcommands", async () => {
  await assert.rejects(() => runCli(["--repo"]), /--repo requires a value/);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-errors-"));
  const errors: string[] = [];
  assert.equal(await runCli(["config", "unknown"], { cwd, stderr: (value) => errors.push(value) }), 1);
  assert.match(errors.join("\n"), /Unknown config command/);

  errors.length = 0;
  assert.equal(await runCli(["config", "prompt", "bad"], { cwd, stderr: (value) => errors.push(value) }), 1);
  assert.match(errors.join("\n"), /Usage: ccflow config prompt/);
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

test("doctor reports repository state, config, and Claude CLI availability", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-doctor-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");

  const initOutput: string[] = [];
  assert.equal(await runCli(["init"], { cwd: repoRoot, stdout: (value) => initOutput.push(value) }), 0);
  assert.equal(fs.existsSync(statePath(repoRoot)), true);

  const output: string[] = [];
  const env = { ...process.env, CCFLOW_CLAUDE_BIN: "__ccflow_missing_claude__" };
  const doctorCode = await runCli(["doctor"], { cwd: repoRoot, env, stdout: (value) => output.push(value) });
  assert.ok(doctorCode === 0 || doctorCode === 1);
  const text = output.join("\n");
  assert.match(text, /CCFlow doctor/);
  assert.match(text, /Repository:/);
  assert.match(text, /CCFlow state invariants are valid/);
  assert.match(text, /Config valid/);
  assert.match(text, /Claude Code CLI not available/);
  assert.match(text, /Summary: [01] error\(s\), 1 warning\(s\)/);

  output.length = 0;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-doctor-outside-"));
  const outsideCode = await runCli(["doctor"], { cwd: outside, env, stdout: (value) => output.push(value) });
  assert.ok(outsideCode === 0 || outsideCode === 1);
  assert.match(output.join("\n"), /No Git repository found/);
});

test("internal node-session command runs the configured Claude binary and updates state", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-node-session-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");

  assert.equal(await runCli(["init"], { cwd: repoRoot, stdout: () => {} }), 0);
  const nodeId = loadState(repoRoot).currentNodeId;
  const fakeClaude = path.join(repoRoot, "fake-claude.sh");
  fs.writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeClaude, 0o755);

  const output: string[] = [];
  const code = await runCli(
    ["__node-session", "--repo", repoRoot, "--node", nodeId, "--claude-bin", fakeClaude],
    { cwd: repoRoot, stdout: (value) => output.push(value), stderr: (value) => output.push(value) },
  );

  const saved = loadState(repoRoot);
  assert.equal(code, 0, output.join("\n"));
  assert.equal(saved.nodes[nodeId]?.status, "LeafNew");
  assert.equal(saved.nodes[nodeId]?.cc.processId, null);
  assert.equal(fs.existsSync(nodeSessionLockPath(repoRoot, nodeId)), false);
});
