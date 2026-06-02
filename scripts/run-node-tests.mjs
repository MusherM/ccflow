import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const coverage = process.argv.includes("--coverage");
const realHome = os.homedir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-test-home-"));
const fakeXdgHome = path.join(fakeHome, ".config");
const fakeCcflowConfig = path.join(fakeHome, ".ccflowrc");

fs.mkdirSync(fakeXdgHome, { recursive: true });
copyClaudeSettings(realHome, fakeHome);

const env = isolatedEnv({
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  XDG_CONFIG_HOME: fakeXdgHome,
  CCFLOW_CONFIG: fakeCcflowConfig,
  CCFLOW_TEST_HOME: fakeHome,
  CCFLOW_REAL_HOME: realHome,
});

const args = ["--test", "--test-concurrency=1"];
if (coverage) {
  args.push(
    "--experimental-test-coverage",
    "--test-coverage-include=dist-test/src/**/*.js",
    "--test-coverage-exclude=dist-test/tests/**/*.js",
    "--test-coverage-lines=95",
  );
}
args.push(...testFiles());

let result;
try {
  result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
} finally {
  cleanupFakeHome(fakeHome);
}

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);

function testFiles() {
  const testsDir = path.join(projectRoot, "dist-test", "tests");
  return fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("dist-test", "tests", name));
}

function isolatedEnv(overrides) {
  const env = { ...process.env };
  const preservedClaudeBin = env.CCFLOW_CLAUDE_BIN;
  const preservedClaudeArgs = env.CCFLOW_CLAUDE_ARGS;

  for (const key of Object.keys(env)) {
    if (key.startsWith("CCFLOW_")) delete env[key];
  }

  if (preservedClaudeBin) env.CCFLOW_CLAUDE_BIN = preservedClaudeBin;
  if (preservedClaudeArgs) env.CCFLOW_CLAUDE_ARGS = preservedClaudeArgs;
  return { ...env, ...overrides };
}

function copyClaudeSettings(sourceHome, targetHome) {
  const source = path.join(sourceHome, ".claude", "settings.json");
  if (!fs.existsSync(source)) return;

  const target = path.join(targetHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function cleanupFakeHome(home) {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best-effort cleanup only. Do not let transient temp-dir files mask test results.
  }
}
