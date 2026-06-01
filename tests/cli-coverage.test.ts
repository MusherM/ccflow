import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import { GitAdapter } from "../src/core/git.js";
import { loadState, statePath } from "../src/core/storage.js";

test("__node-session without --node surfaces a usage error", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-no-node-"));
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "initial\n");
  git.commit(repoRoot, "test: initial readme");
  assert.equal(await runCli(["init"], { cwd: repoRoot, stdout: () => {} }), 0);

  await assert.rejects(
    () => runCli(["__node-session", "--repo", repoRoot], { cwd: repoRoot }),
    /Usage: ccflow __node-session/,
  );
});

test("__node-session without a git repo surfaces a RepositoryError", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-no-git-"));
  await assert.rejects(
    () => runCli(["__node-session", "--repo", cwd, "--node", "node_x"], { cwd }),
    /requires a Git repository/,
  );
});

test("init outside a git repo without --git fails and creates no state", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-init-no-git-"));
  const errors: string[] = [];
  const code = await runCli(["init"], {
    cwd,
    stderr: (value) => errors.push(value),
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /requires an existing Git repository/);
  assert.equal(fs.existsSync(statePath(cwd)), false);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
});

test("config path lists user-global, xdg-global, repo-shared, and repo-local entries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-config-paths-"));
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  const globalPath = path.join(root, "global.json");

  // Initialize a git repo so resolveRepository can detect it from cwd.
  const git = new GitAdapter();
  git.ensureRepo(repoRoot);

  const output: string[] = [];
  const code = await runCli(["config", "path"], {
    cwd: repoRoot,
    env: { ...process.env, CCFLOW_CONFIG: globalPath },
    stdout: (value) => output.push(value),
  });
  assert.equal(code, 0);
  const text = output.join("\n");
  assert.match(text, new RegExp(`userGlobal: ${globalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(text, /xdgGlobal: .*ccflow\/config\.json/);
  assert.match(text, /repoShared: .*\.ccflowrc/);
  assert.match(text, /repoLocal: .*config\.local\.json/);
});

test("config set without --global fails with a usage error", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-set-no-global-"));
  const errors: string[] = [];
  const code = await runCli(["config", "set", "prompts.commit.instructions", "[]"], {
    cwd,
    stderr: (value) => errors.push(value),
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /Only `ccflow config set --global <field> <value>` is supported/);
});

test("config set with missing value fails with a usage error", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-set-no-value-"));
  const errors: string[] = [];
  const code = await runCli(["config", "set", "--global", "prompts.commit.instructions"], {
    cwd,
    stderr: (value) => errors.push(value),
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /Usage: ccflow config set --global/);
});

test("init --git creates a git repo, state file, and re-init is idempotent", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-init-git-"));
  const initOut: string[] = [];
  assert.equal(await runCli(["init", "--git"], { cwd, stdout: (value) => initOut.push(value) }), 0);
  assert.equal(fs.existsSync(path.join(cwd, ".git")), true);
  assert.equal(fs.existsSync(statePath(cwd)), true);

  // Re-init keeps the existing state and reports already initialized.
  const secondOut: string[] = [];
  const beforeState = loadState(cwd);
  const code = await runCli(["init", "--git"], { cwd, stdout: (value) => secondOut.push(value) });
  assert.equal(code, 0);
  assert.match(secondOut.join("\n"), /CCFlow already initialized/);
  const afterState = loadState(cwd);
  assert.equal(afterState.currentNodeId, beforeState.currentNodeId);
});

test("help text mentions every documented flag", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cli-help-"));
  const output: string[] = [];
  const code = await runCli(["--help"], { cwd, stdout: (value) => output.push(value) });
  assert.equal(code, 0);
  const text = output.join("\n");
  for (const flag of ["--repo", "--no-auto-init", "--multitab", "--claude-bin", "--model", "--git", "--force", "--global", "--help", "--version"]) {
    assert.match(text, new RegExp(flag), `help text should mention ${flag}`);
  }
  for (const cmd of ["init", "doctor", "config", "config path", "config show-effective", "config set", "config prompt"]) {
    assert.match(text, new RegExp(cmd), `help text should mention ${cmd}`);
  }
});
