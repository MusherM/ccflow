import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../src/core/claude.js";
import { defaultCcflowConfig } from "../src/core/config.js";

test("ClaudeAdapter reports disabled and spawn-error headless runs without mutating settings", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-claude-adapter-"));
  const adapter = new ClaudeAdapter();
  const previousDisable = process.env.CCFLOW_DISABLE_CLAUDE_JOBS;
  const previousBin = process.env.CCFLOW_CLAUDE_BIN;
  const previousArgs = process.env.CCFLOW_CLAUDE_ARGS;
  try {
    process.env.CCFLOW_DISABLE_CLAUDE_JOBS = "1";
    assert.deepEqual(adapter.runHeadless(repoRoot, "prompt", repoRoot), {
      ok: false,
      stdout: "",
      stderr: "Claude jobs are disabled by CCFLOW_DISABLE_CLAUDE_JOBS.",
    });

    delete process.env.CCFLOW_DISABLE_CLAUDE_JOBS;
    process.env.CCFLOW_CLAUDE_BIN = "__ccflow_missing_claude__";
    process.env.CCFLOW_CLAUDE_ARGS = "--alpha 'two words' \"three words\"";
    const failed = adapter.runHeadless(repoRoot, "prompt", repoRoot);
    assert.equal(failed.ok, false);
    assert.match(failed.stderr, /ENOENT/);

    const log = fs.readFileSync(path.join(repoRoot, ".ccflow", "logs", "ccflow.log"), "utf8");
    assert.match(log, /claude:headless:start/);
    assert.match(log, /claude:headless:error/);
  } finally {
    restoreEnv("CCFLOW_DISABLE_CLAUDE_JOBS", previousDisable);
    restoreEnv("CCFLOW_CLAUDE_BIN", previousBin);
    restoreEnv("CCFLOW_CLAUDE_ARGS", previousArgs);
  }
});

test("ClaudeAdapter can run headless prompts inside an existing Claude session", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-claude-resume-"));
  const script = path.join(repoRoot, "capture-args.mjs");
  const capture = path.join(repoRoot, "args.json");
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.CCFLOW_CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));",
      "process.stdout.write(JSON.stringify({ session_id: 'parent-session' }));",
    ].join("\n"),
  );

  const config = defaultCcflowConfig();
  config.claude.bin = process.execPath;
  config.claude.headlessArgs = [script];
  config.claude.model = "test-model";

  const previousCapture = process.env.CCFLOW_CAPTURE_ARGS;
  process.env.CCFLOW_CAPTURE_ARGS = capture;
  try {
    const result = new ClaudeAdapter().runHeadless(repoRoot, "commit prompt", repoRoot, config, {
      resumeSessionId: "parent-session",
    });

    assert.equal(result.ok, true);
    const args = JSON.parse(fs.readFileSync(capture, "utf8")) as string[];
    assert.deepEqual(args, [
      "-p",
      "commit prompt",
      "--resume",
      "parent-session",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--model",
      "test-model",
    ]);
  } finally {
    restoreEnv("CCFLOW_CAPTURE_ARGS", previousCapture);
  }
});

test("ClaudeAdapter resolves the newest matching Claude session id from project logs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-claude-home-"));
  const cwd = path.join(home, "repo");
  const projectDir = path.join(home, ".claude", "projects", "project-a");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  fs.writeFileSync(path.join(projectDir, "bad.jsonl"), "{not json\n");
  fs.writeFileSync(
    path.join(projectDir, "old.jsonl"),
    `${JSON.stringify({ sessionId: "old-session", cwd: path.join(home, "other") })}\n`,
  );
  fs.writeFileSync(
    path.join(projectDir, "new.jsonl"),
    [
      JSON.stringify({ sessionId: "ignored-session", cwd: path.join(home, "other") }),
      JSON.stringify({ sessionId: "matching-session", cwd }),
    ].join("\n"),
  );

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const adapter = new ClaudeAdapter() as unknown as {
      findRecentClaudeSessionId(cwd: string, options?: { afterMs?: number }): string | null;
    };
    assert.equal(adapter.findRecentClaudeSessionId(cwd), "matching-session");
    const sessionLogMtime = fs.statSync(path.join(projectDir, "new.jsonl")).mtimeMs;
    assert.equal(adapter.findRecentClaudeSessionId(cwd, { afterMs: sessionLogMtime + 1 }), null);
    assert.equal(adapter.findRecentClaudeSessionId(cwd, { afterMs: sessionLogMtime - 1 }), "matching-session");
    assert.equal(adapter.findRecentClaudeSessionId(path.join(home, "missing")), null);

    fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
    assert.equal(adapter.findRecentClaudeSessionId(cwd), null);
  } finally {
    restoreEnv("HOME", previousHome);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
