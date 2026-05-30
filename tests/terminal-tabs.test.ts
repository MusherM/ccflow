import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGhosttyTabAppleScript,
  buildITerm2TabAppleScript,
  buildNodeSessionCommand,
  detectTerminalApp,
  openTerminalTab,
  shellQuote,
} from "../src/core/terminal-tabs.js";

test("terminal tab detection recognizes iTerm2 and Ghostty", () => {
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "iTerm2" }), "iterm2");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "ghostty" }), "ghostty");
  assert.equal(detectTerminalApp({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources" }), "ghostty");
  assert.equal(detectTerminalApp({ CCFLOW_TERMINAL_APP: "iTerm2" }), "iterm2");
  assert.equal(detectTerminalApp({ CCFLOW_TERMINAL_APP: "Ghostty" }), "ghostty");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "Apple_Terminal" }), null);
});

test("terminal tab command quoting preserves repo paths and node ids", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("has space"), "'has space'");
  assert.equal(shellQuote("has'quote"), "'has'\\''quote'");

  const command = buildNodeSessionCommand({
    repoRoot: "/tmp/repo with space",
    nodeId: "node_1",
    ccflowCommand: ["/usr/local/bin/node", "/tmp/ccflow main.js"],
    claudeBin: "/opt/Claude Code/bin/claude",
    model: "haiku",
  });

  assert.equal(
    command,
    "'/usr/local/bin/node' '/tmp/ccflow main.js' '__node-session' '--repo' '/tmp/repo with space' '--node' 'node_1' '--claude-bin' '/opt/Claude Code/bin/claude' '--model' 'haiku'",
  );
});

test("terminal tab AppleScripts create an iTerm2 or Ghostty tab with the node command", () => {
  const command = "printf 'hello'";
  const cwd = "/tmp/repo";
  const title = "CCFlow node_1";

  const iterm = buildITerm2TabAppleScript({ command, cwd, title });
  assert.match(iterm, /tell application "iTerm2"/);
  assert.match(iterm, /create tab with default profile command/);
  assert.match(iterm, /set name to "CCFlow node_1"/);
  assert.match(iterm, /printf 'hello'/);

  const ghostty = buildGhosttyTabAppleScript({ command, cwd, title });
  assert.match(ghostty, /tell application "Ghostty"/);
  assert.match(ghostty, /set cfg to new surface configuration/);
  assert.match(ghostty, /set command of cfg to/);
  assert.match(ghostty, /set initial working directory of cfg to "\/tmp\/repo"/);
});

test("openTerminalTab dispatches to osascript for supported terminals", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  const result = openTerminalTab(
    { command: "echo ok", cwd: "/repo", title: "CCFlow node" },
    { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin", spawnSync: spawnSync as never },
  );

  assert.equal(result.terminal, "ghostty");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.bin, "osascript");
  assert.equal(calls[0]?.args[0], "-e");
  assert.match(calls[0]?.args[1] ?? "", /tell application "Ghostty"/);
});

test("openTerminalTab rejects unsupported terminals and failed AppleScript launches", () => {
  assert.throws(
    () => openTerminalTab({ command: "echo ok", cwd: "/repo" }, { env: { TERM_PROGRAM: "Apple_Terminal" }, platform: "darwin" }),
    /Unsupported terminal/,
  );
  assert.throws(
    () => openTerminalTab({ command: "echo ok", cwd: "/repo" }, { env: { TERM_PROGRAM: "iTerm.app" }, platform: "linux" }),
    /macOS/,
  );
  assert.throws(
    () =>
      openTerminalTab(
        { command: "echo ok", cwd: "/repo" },
        {
          env: { TERM_PROGRAM: "iTerm.app" },
          platform: "darwin",
          spawnSync: (() => ({ status: 1, stderr: "not allowed", error: undefined })) as never,
        },
      ),
    /not allowed/,
  );
});
