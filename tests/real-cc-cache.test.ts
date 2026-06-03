import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCliConfig, realClaudePromptGate } from "./helpers/claude-cli.js";

test("real Claude prompt cache skips only unchanged post-prompt tests", () => {
  const previousCache = process.env.CCFLOW_TEST_REAL_CC_CACHE;
  const previousForce = process.env.CCFLOW_TEST_FORCE_REAL_CC;
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-real-cc-cache-")), "cache.json");

  try {
    process.env.CCFLOW_TEST_REAL_CC_CACHE = cacheFile;
    delete process.env.CCFLOW_TEST_FORCE_REAL_CC;

    const first = realClaudePromptGate("commit-smoke", "prompt v1");
    assert.equal(first.shouldRun, true);
    first.markPassed();

    const cached = realClaudePromptGate("commit-smoke", "prompt v1");
    assert.equal(cached.shouldRun, false);
    assert.match(cached.reason, /unchanged prompt/);

    const changed = realClaudePromptGate("commit-smoke", "prompt v2");
    assert.equal(changed.shouldRun, true);

    process.env.CCFLOW_TEST_FORCE_REAL_CC = "1";
    const forced = realClaudePromptGate("commit-smoke", "prompt v1");
    assert.equal(forced.shouldRun, true);
    assert.match(forced.reason, /forced/);
  } finally {
    restoreEnv("CCFLOW_TEST_REAL_CC_CACHE", previousCache);
    restoreEnv("CCFLOW_TEST_FORCE_REAL_CC", previousForce);
  }
});

test("skip-real-cc avoids probing the real Claude CLI", () => {
  const previousSkip = process.env.CCFLOW_TEST_SKIP_REAL_CC;

  try {
    process.env.CCFLOW_TEST_SKIP_REAL_CC = "1";
    assert.throws(() => claudeCliConfig(), /--skip-real-cc/);
  } finally {
    restoreEnv("CCFLOW_TEST_SKIP_REAL_CC", previousSkip);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
