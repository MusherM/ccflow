import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigError,
  configWithSources,
  defaultCcflowConfig,
  loadConfig,
  redactEffectiveConfig,
  resolveConfigPaths,
  setUserGlobalConfigValue,
  splitShellWords,
} from "../src/core/config.js";

test("splitShellWords handles plain, quoted, mixed, and empty input", () => {
  assert.deepEqual(splitShellWords(""), []);
  assert.deepEqual(splitShellWords("   "), []);
  assert.deepEqual(splitShellWords("a b c"), ["a", "b", "c"]);
  assert.deepEqual(splitShellWords("'a b' c"), ["a b", "c"]);
  assert.deepEqual(splitShellWords("\"a b\" c"), ["a b", "c"]);
  assert.deepEqual(splitShellWords("a'b c'd"), ["ab cd"]);
  assert.deepEqual(splitShellWords("a\tb\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitShellWords("'unterminated"), ["unterminated"]);
});

test("defaultCcflowConfig returns a deep copy each time", () => {
  const a = defaultCcflowConfig();
  const b = defaultCcflowConfig();
  assert.notEqual(a, b);
  assert.notEqual(a.prompts.commit.instructions, b.prompts.commit.instructions);
  a.prompts.commit.instructions.push("mutate");
  assert.equal(b.prompts.commit.instructions.length, 0);
});

test("resolveConfigPaths honors XDG_CONFIG_HOME and CCFLOW_CONFIG override", () => {
  const env = {
    HOME: "/home/me",
    XDG_CONFIG_HOME: "/home/me/.config",
    CCFLOW_CONFIG: "/etc/ccflow.json",
  };
  const paths = resolveConfigPaths("/repo", env);
  assert.equal(paths.userGlobalPath, "/etc/ccflow.json");
  assert.equal(paths.xdgGlobalPath, "/home/me/.config/ccflow/config.json");
  assert.equal(paths.repoSharedPath, "/repo/.ccflowrc");
  assert.equal(paths.repoLocalPath, "/repo/.ccflow/config.local.json");
});

test("loadConfig honors env-only config when no files exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-env-only-"));
  const env = {
    ...process.env,
    CCFLOW_CONFIG: path.join(root, "missing.json"),
    CCFLOW_CLAUDE_BIN: "/usr/bin/claude",
    CCFLOW_CLAUDE_MODEL: "opus",
    CCFLOW_CLAUDE_ARGS: "--quiet --resume",
    CCFLOW_DISABLE_CLAUDE_JOBS: "1",
    CCFLOW_TERMINAL_QUARANTINE_MS: "1234",
    CCFLOW_BRANCH_PREFIX: "team/",
    CCFLOW_WORKTREE_DIR: "workspaces",
    CCFLOW_AUTO_INIT: "0",
  };
  const loaded = loadConfig({ env });
  assert.equal(loaded.config.claude.bin, "/usr/bin/claude");
  assert.equal(loaded.config.claude.model, "opus");
  assert.deepEqual(loaded.config.claude.headlessArgs, ["--quiet", "--resume"]);
  assert.equal(loaded.config.claude.disableJobs, true);
  assert.equal(loaded.config.claude.terminalQuarantineMs, 1234);
  assert.equal(loaded.config.worktree.branchPrefix, "team/");
  assert.equal(loaded.config.worktree.directory, "workspaces");
  assert.equal(loaded.config.startup.autoInit, false);
});

test("setUserGlobalConfigValue writes a JSON value and rejects invalid values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-set-global-"));
  const globalPath = path.join(root, "global.json");
  const env = { ...process.env, CCFLOW_CONFIG: globalPath };
  setUserGlobalConfigValue("prompts.commit.messageStyle", "imperative", env);
  const loaded = JSON.parse(fs.readFileSync(globalPath, "utf8")) as Record<string, unknown>;
  assert.equal((loaded.prompts as Record<string, Record<string, string>>).commit.messageStyle, "imperative");

  setUserGlobalConfigValue("prompts.commit.instructions", "[\"a\",\"b\"]", env);
  const reloaded = JSON.parse(fs.readFileSync(globalPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(
    (reloaded.prompts as Record<string, Record<string, string[]>>).commit.instructions,
    ["a", "b"],
  );

  // Numeric values are parsed and validated by the schema.
  setUserGlobalConfigValue("claude.terminalQuarantineMs", "250", env);
  const numeric = JSON.parse(fs.readFileSync(globalPath, "utf8")) as Record<string, unknown>;
  assert.equal((numeric.claude as Record<string, number>).terminalQuarantineMs, 250);
});

test("setUserGlobalConfigValue throws ConfigError when written value violates schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-set-bad-"));
  const globalPath = path.join(root, "global.json");
  const env = { ...process.env, CCFLOW_CONFIG: globalPath };
  assert.throws(
    () => setUserGlobalConfigValue("claude.terminalQuarantineMs", "\"not-a-number\"", env),
    (error) => error instanceof ConfigError,
  );
});

test("setUserGlobalConfigValue rejects a numeric field given a non-numeric raw value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-set-bad-num-"));
  const globalPath = path.join(root, "global.json");
  const env = { ...process.env, CCFLOW_CONFIG: globalPath };
  assert.throws(
    () => setUserGlobalConfigValue("claude.terminalQuarantineMs", "true", env),
    (error) => error instanceof ConfigError,
  );
});

test("redactEffectiveConfig leaves default bin visible and redacts custom bin", () => {
  const defaultLoaded = loadConfig({
    env: { ...process.env, CCFLOW_CONFIG: path.join(os.tmpdir(), "missing.json") },
  });
  const redactedDefault = redactEffectiveConfig(defaultLoaded) as { claude: { bin: string } };
  assert.equal(redactedDefault.claude.bin, "claude");

  const customLoaded = loadConfig({
    env: {
      ...process.env,
      CCFLOW_CONFIG: path.join(os.tmpdir(), "missing.json"),
      CCFLOW_CLAUDE_BIN: "/opt/my-claude",
    },
  });
  const redactedCustom = redactEffectiveConfig(customLoaded) as { claude: { bin: string } };
  assert.equal(redactedCustom.claude.bin, "<configured>");
});

test("configWithSources serializes each source path when available", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-sources-"));
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  const globalPath = path.join(root, "global.json");
  fs.writeFileSync(globalPath, JSON.stringify({ claude: { model: "sonnet" } }));

  const loaded = loadConfig({
    repoRoot,
    env: { ...process.env, CCFLOW_CONFIG: globalPath },
  });
  const serialized = JSON.stringify(configWithSources(loaded));
  assert.match(serialized, /"claude\.model":\s*"user global config/);
  assert.match(serialized, /"config"/);
});
