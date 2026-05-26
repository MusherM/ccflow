import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, configWithSources, loadConfig, setUserGlobalConfigValue } from "../src/core/config.js";

test("config precedence merges nested objects and replaces arrays with source attribution", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-config-"));
  const globalPath = path.join(root, "global.json");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(path.join(repoRoot, ".ccflow"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".ccflowrc"), JSON.stringify({
    prompts: {
      commit: {
        instructions: ["project"],
        messageStyle: "project style",
      },
    },
  }));
  fs.writeFileSync(globalPath, JSON.stringify({
    prompts: {
      commit: {
        instructions: ["global"],
      },
    },
  }));
  fs.writeFileSync(path.join(repoRoot, ".ccflow", "config.local.json"), JSON.stringify({
    prompts: {
      commit: {
        messageStyle: "local style",
      },
    },
  }));

  const loaded = loadConfig({
    repoRoot,
    env: { ...process.env, CCFLOW_CONFIG: globalPath },
    cliOverrides: { prompts: { commit: { testPreferences: ["cli check"] } } },
  });

  assert.deepEqual(loaded.config.prompts.commit.instructions, ["global"]);
  assert.equal(loaded.config.prompts.commit.messageStyle, "local style");
  assert.deepEqual(loaded.config.prompts.commit.testPreferences, ["cli check"]);
  assert.equal(loaded.sources["prompts.commit.instructions"]?.kind, "user-global");
  assert.equal(loaded.sources["prompts.commit.messageStyle"]?.kind, "repo-local");
  assert.equal(loaded.sources["prompts.commit.testPreferences"]?.kind, "cli");
});

test("config validation rejects unknown fields, shared local executables, and full prompt replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-config-invalid-"));
  fs.writeFileSync(path.join(root, ".ccflowrc"), JSON.stringify({ claude: { bin: "/tmp/claude" } }));
  assert.throws(
    () => loadConfig({ repoRoot: root, env: { ...process.env, CCFLOW_CONFIG: path.join(root, "missing-global.json") } }),
    (error) => error instanceof ConfigError && /claude\.bin/.test(error.message),
  );

  fs.writeFileSync(path.join(root, ".ccflowrc"), JSON.stringify({ prompts: { commit: { prompt: "replace everything" } } }));
  assert.throws(
    () => loadConfig({ repoRoot: root, env: { ...process.env, CCFLOW_CONFIG: path.join(root, "missing-global.json") } }),
    (error) => error instanceof ConfigError && /full prompt replacement/.test(error.message),
  );

  fs.writeFileSync(path.join(root, ".ccflowrc"), JSON.stringify({ nope: true }));
  assert.throws(
    () => loadConfig({ repoRoot: root, env: { ...process.env, CCFLOW_CONFIG: path.join(root, "missing-global.json") } }),
    (error) => error instanceof ConfigError && /unknown config field nope/.test(error.message),
  );
});

test("legacy prompts are additive and new config can override prompt arrays", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-legacy-prompts-"));
  fs.mkdirSync(path.join(root, ".ccflow"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ccflow", "prompts.json"), JSON.stringify({
    commit: { system: "legacy commit system", prompt: "legacy commit prompt", commands: {} },
    merge: { system: "legacy merge system", prompt: "legacy merge prompt", commands: {} },
  }));

  let loaded = loadConfig({ repoRoot: root, env: { ...process.env, CCFLOW_CONFIG: path.join(root, "missing-global.json") } });
  assert.deepEqual(loaded.config.prompts.commit.instructions, ["legacy commit system", "legacy commit prompt"]);
  assert.equal(loaded.sources["prompts.commit.instructions"]?.kind, "legacy");

  fs.writeFileSync(path.join(root, ".ccflowrc"), JSON.stringify({ prompts: { commit: { instructions: ["project replacement"] } } }));
  loaded = loadConfig({ repoRoot: root, env: { ...process.env, CCFLOW_CONFIG: path.join(root, "missing-global.json") } });
  assert.deepEqual(loaded.config.prompts.commit.instructions, ["project replacement"]);
  assert.equal(loaded.sources["prompts.commit.instructions"]?.kind, "repo-shared");
});

test("config set writes user global config and validates effective output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-config-set-"));
  const globalPath = path.join(root, "global.json");
  const file = setUserGlobalConfigValue("prompts.commit.instructions", "[\"one\",\"two\"]", { ...process.env, CCFLOW_CONFIG: globalPath });
  assert.equal(file, globalPath);
  const loaded = loadConfig({ env: { ...process.env, CCFLOW_CONFIG: globalPath } });
  assert.deepEqual(loaded.config.prompts.commit.instructions, ["one", "two"]);
  assert.ok(JSON.stringify(configWithSources(loaded)).includes("prompts.commit.instructions"));
});
