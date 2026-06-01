import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildNodeSessionCommand,
  currentCcflowCommand,
  detectTerminalApp,
  openTerminalTab,
  resolveExecutable,
  terminalDisplayName,
} from "../src/core/terminal-tabs.js";

test("currentCcflowCommand uses CCFLOW_SELF_COMMAND when provided", () => {
  const env = { CCFLOW_SELF_COMMAND: "/opt/node /opt/ccflow.js" };
  const argv = ["/usr/local/bin/node", "/Users/me/ccflow/dist/main.js"];
  const execPath = "/usr/local/bin/node";
  assert.deepEqual(currentCcflowCommand(env, argv, execPath), ["/opt/node", "/opt/ccflow.js"]);
});

test("currentCcflowCommand falls back to argv script when the script path exists", () => {
  const env = {};
  const tempScript = path.join(os.tmpdir(), "ccflow-current-cmd-test.js");
  fs.writeFileSync(tempScript, "");
  try {
    const argv = ["/usr/local/bin/node", tempScript];
    assert.deepEqual(currentCcflowCommand(env, argv, "/usr/local/bin/node"), [
      "/usr/local/bin/node",
      tempScript,
    ]);
  } finally {
    fs.rmSync(tempScript, { force: true });
  }
});

test("currentCcflowCommand falls back to bare ccflow when argv[1] is missing or absent", () => {
  const env = {};
  assert.deepEqual(currentCcflowCommand(env, ["/usr/local/bin/node"], "/usr/local/bin/node"), ["ccflow"]);
  // A non-absolute argv[1] also falls through to the bare default.
  assert.deepEqual(currentCcflowCommand(env, ["/usr/local/bin/node", "ccflow"], "/usr/local/bin/node"), ["ccflow"]);
  // A path that does not exist also falls through.
  assert.deepEqual(
    currentCcflowCommand(env, ["/usr/local/bin/node", "/no/such/file.js"], "/usr/local/bin/node"),
    ["ccflow"],
  );
});

test("resolveExecutable returns absolute path unchanged", () => {
  assert.equal(resolveExecutable("/abs/claude", {}), "/abs/claude");
});

test("resolveExecutable returns relative path with slash unchanged", () => {
  assert.equal(resolveExecutable("./bin/claude", {}), "./bin/claude");
});

test("resolveExecutable resolves bare names against PATH", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-resolve-"));
  const target = path.join(binDir, "ccflow-test-bin");
  fs.writeFileSync(target, "");
  fs.chmodSync(target, 0o755);
  const env = { PATH: `${binDir}${path.delimiter}/usr/bin` };
  assert.equal(resolveExecutable("ccflow-test-bin", env), target);
});

test("resolveExecutable returns bare name when not on PATH", () => {
  const env = { PATH: "/nope" };
  assert.equal(resolveExecutable("ccflow-unknown", env), "ccflow-unknown");
});

test("buildNodeSessionCommand uses an explicit ccflow command override", () => {
  const cmd = buildNodeSessionCommand({
    repoRoot: "/repo",
    nodeId: "node_x",
    ccflowCommand: ["ccflow"],
  });
  assert.equal(cmd, "'ccflow' '__node-session' '--repo' '/repo' '--node' 'node_x'");
});

test("buildNodeSessionCommand quotes the repo path and node id safely", () => {
  const cmd = buildNodeSessionCommand({
    repoRoot: "/tmp/repo with space",
    nodeId: "node_x",
    ccflowCommand: ["ccflow"],
  });
  assert.equal(cmd, "'ccflow' '__node-session' '--repo' '/tmp/repo with space' '--node' 'node_x'");
});

test("buildNodeSessionCommand resolves the claude bin against PATH", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-cmd-bin-"));
  const claudeBin = path.join(binDir, "ccflow-cmd-test-bin");
  fs.writeFileSync(claudeBin, "");
  fs.chmodSync(claudeBin, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  try {
    const cmd = buildNodeSessionCommand({
      repoRoot: "/repo",
      nodeId: "node_x",
      ccflowCommand: ["ccflow"],
      claudeBin: "ccflow-cmd-test-bin",
    });
    const escaped = claudeBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(cmd, new RegExp(`--claude-bin' '${escaped}`));
  } finally {
    process.env.PATH = previousPath;
  }
});

test("openTerminalTab routes forced wezterm, kitty, gnome-terminal, konsole, xfce4-terminal, alacritty, xterm", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  const cases: Array<{ env: Record<string, string>; bin: string; expected: string[]; platform: NodeJS.Platform }> = [
    {
      env: { CCFLOW_TERMINAL_APP: "wezterm", SHELL: "/bin/zsh" },
      bin: "wezterm",
      platform: "darwin",
      expected: ["cli", "spawn", "--cwd", "/repo", "--", "/bin/zsh", "-lc", "echo ok"],
    },
    {
      env: { CCFLOW_TERMINAL_APP: "kitty", SHELL: "/bin/zsh" },
      bin: "kitty",
      platform: "linux",
      expected: ["@", "launch", "--type=tab", "--cwd", "/repo", "--tab-title", "CCFlow node", "--", "/bin/zsh", "-lc", "echo ok"],
    },
    {
      env: { CCFLOW_TERMINAL_APP: "gnome-terminal", SHELL: "/bin/bash" },
      bin: "gnome-terminal",
      platform: "linux",
      expected: ["--tab", "--working-directory", "/repo", "--title", "CCFlow node", "--", "/bin/bash", "-lc", "echo ok"],
    },
    {
      env: { CCFLOW_TERMINAL_APP: "konsole", SHELL: "/bin/zsh" },
      bin: "konsole",
      platform: "linux",
      expected: ["--new-tab", "--workdir", "/repo", "-p", "tabtitle=CCFlow node", "-e", "/bin/zsh", "-lc", "echo ok"],
    },
    {
      env: { CCFLOW_TERMINAL_APP: "xfce4-terminal", SHELL: "/bin/sh" },
      bin: "xfce4-terminal",
      platform: "linux",
      expected: ["--tab", "--working-directory", "/repo", "--title", "CCFlow node", "--command", "echo ok"],
    },
    {
      env: { CCFLOW_TERMINAL_APP: "alacritty", SHELL: "/bin/sh" },
      bin: "alacritty",
      platform: "linux",
      expected: ["--working-directory", "/repo", "-e", "/bin/sh", "-lc", "echo ok"],
    },
    {
      env: { CCFLOW_TERMINAL_APP: "xterm", SHELL: "/bin/sh" },
      bin: "xterm",
      platform: "linux",
      expected: ["-T", "CCFlow node", "-e", "/bin/sh", "-lc", "echo ok"],
    },
  ];

  for (const testCase of cases) {
    calls.length = 0;
    const result = openTerminalTab(
      { command: "echo ok", cwd: "/repo", title: "CCFlow node" },
      { env: testCase.env, platform: testCase.platform, spawnSync: spawnSync as never },
    );
    assert.equal(calls.length, 1, `expected one call for ${testCase.env.CCFLOW_TERMINAL_APP}`);
    assert.equal(calls[0]?.bin, testCase.bin);
    assert.deepEqual(calls[0]?.args, testCase.expected);
    assert.equal(result.terminal, testCase.env.CCFLOW_TERMINAL_APP);
    assert.equal(result.target, testCase.bin === "alacritty" || testCase.bin === "xterm" ? "window" : "tab");
  }
});

test("openTerminalTab skips macOS-only terminals on non-darwin platforms", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  // iterm2 is darwin-only; on linux the launch plan builder returns no plans, so
  // openTerminalTab throws "Unsupported terminal".
  assert.throws(
    () =>
      openTerminalTab(
        { command: "echo ok", cwd: "/repo" },
        { env: { CCFLOW_TERMINAL_APP: "iterm2" }, platform: "linux", spawnSync: spawnSync as never },
      ),
    /Unsupported terminal for CCFlow MultiTab/,
  );
  assert.equal(calls.length, 0);
});

test("openTerminalTab uses AppleScript and writes no command for ghostty", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  const result = openTerminalTab(
    { command: "echo ok", cwd: "/repo", title: "CCFlow node" },
    { env: { CCFLOW_TERMINAL_APP: "ghostty" }, platform: "darwin", spawnSync: spawnSync as never },
  );

  assert.equal(result.terminal, "ghostty");
  assert.equal(result.terminalName, "Ghostty");
  assert.equal(result.target, "tab");
  const script = calls[0]?.args[1] ?? "";
  assert.match(script, /tell application "Ghostty"/);
  assert.match(script, /set initial input of cfg to "echo ok" & linefeed/);
  assert.doesNotMatch(script, /set command of cfg to/);
});

test("openTerminalTab surfaces Terminal.app AppleScript when forced", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  const result = openTerminalTab(
    { command: "echo ok", cwd: "/tmp/repo", title: "CCFlow node" },
    { env: { CCFLOW_TERMINAL_APP: "Terminal.app" }, platform: "darwin", spawnSync: spawnSync as never },
  );

  assert.equal(result.terminal, "terminal-app");
  const script = calls[0]?.args[1] ?? "";
  assert.match(script, /tell application "Terminal"/);
  assert.match(script, /set custom title of newTab to "CCFlow node"/);
  assert.match(script, /cd '\/tmp\/repo' && echo ok/);
});

test("openTerminalTab throws when forced terminal is unsupported", () => {
  assert.throws(
    () => openTerminalTab({ command: "echo ok", cwd: "/repo" }, { env: { CCFLOW_TERMINAL_APP: "warp" } }),
    /Unsupported CCFLOW_TERMINAL_APP/,
  );
});

test("openTerminalTab surfaces child process errors across multiple plans", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let counter = 0;
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    counter += 1;
    if (counter === 1) return { status: 1, stderr: "first fail", error: undefined };
    return { status: 0, stderr: "", error: undefined };
  };

  const result = openTerminalTab(
    { command: "echo ok", cwd: "/repo" },
    { env: { CCFLOW_TERMINAL_APP: "wezterm" }, platform: "darwin", spawnSync: spawnSync as never },
  );

  assert.equal(calls.length, 2);
  assert.equal(result.terminal, "wezterm");
});

test("openTerminalTab wraps spawn error messages into thrown error", () => {
  const spawnSync = () => ({ status: null, stderr: "", error: new Error("boom") });
  assert.throws(
    () =>
      openTerminalTab(
        { command: "echo ok", cwd: "/repo" },
        { env: { CCFLOW_TERMINAL_APP: "wezterm" }, platform: "darwin", spawnSync: spawnSync as never },
      ),
    /boom/,
  );
});

test("openTerminalTab falls back to terminal list when no terminal detected on linux", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  const result = openTerminalTab(
    { command: "echo ok", cwd: "/repo", title: "CCFlow" },
    { env: { SHELL: "/bin/bash" }, platform: "linux", spawnSync: spawnSync as never },
  );

  // First fallback candidate that succeeds is wezterm.
  assert.equal(result.terminal, "wezterm");
  assert.ok(calls[0]?.bin === "wezterm");
});

test("openTerminalTab surfaces all-failed launchers when no terminal works", () => {
  const spawnSync = () => ({ status: 1, stderr: "not installed", error: undefined });
  assert.throws(
    () =>
      openTerminalTab(
        { command: "echo ok", cwd: "/repo" },
        { env: {}, platform: "linux", spawnSync: spawnSync as never },
      ),
    /Failed to open CCFlow node in a terminal tab/,
  );
});

test("detectTerminalApp returns null when no signal is present", () => {
  assert.equal(detectTerminalApp({}), null);
  assert.equal(detectTerminalApp({ TERM: "dumb" }), null);
});

test("terminalDisplayName returns friendly labels for every supported terminal", () => {
  for (const id of [
    "ghostty",
    "iterm2",
    "terminal-app",
    "wezterm",
    "kitty",
    "windows-terminal",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "xterm",
    "x-terminal-emulator",
  ] as const) {
    assert.ok(terminalDisplayName(id).length > 0, `display name should be non-empty for ${id}`);
  }
});
