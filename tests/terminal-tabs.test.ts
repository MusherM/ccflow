import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNodeSessionCommand,
  detectTerminalApp,
  openTerminalTab,
  shellQuote,
  terminalDisplayName,
} from "../src/core/terminal-tabs.js";

test("terminal tab detection recognizes mainstream terminal apps", () => {
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "iTerm.app" }), "iterm2");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "iTerm2" }), "iterm2");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "ghostty" }), "ghostty");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "Apple_Terminal" }), "terminal-app");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "WezTerm" }), "wezterm");
  assert.equal(detectTerminalApp({ TERM: "xterm-kitty" }), "kitty");
  assert.equal(detectTerminalApp({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources" }), "ghostty");
  assert.equal(detectTerminalApp({ WEZTERM_PANE: "1" }), "wezterm");
  assert.equal(detectTerminalApp({ KITTY_WINDOW_ID: "1" }), "kitty");
  assert.equal(detectTerminalApp({ WT_SESSION: "session" }), "windows-terminal");
  assert.equal(detectTerminalApp({ KONSOLE_VERSION: "240800" }), "konsole");
  assert.equal(detectTerminalApp({ CCFLOW_TERMINAL_APP: "iTerm2" }), "iterm2");
  assert.equal(detectTerminalApp({ CCFLOW_TERMINAL_APP: "Terminal.app" }), "terminal-app");
  assert.equal(detectTerminalApp({ TERM_PROGRAM: "vscode" }), null);
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

test("openTerminalTab hides AppleScript details behind the public launch interface", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };
  const command = "'/usr/local/bin/node' '/tmp/ccflow main.js' '__node-session'";

  const ghostty = openTerminalTab(
    { command, cwd: "/repo with space", title: "CCFlow node_1" },
    { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin", spawnSync: spawnSync as never },
  );

  assert.equal(ghostty.terminal, "ghostty");
  assert.equal(ghostty.terminalName, "Ghostty");
  assert.equal(ghostty.target, "tab");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.bin, "osascript");
  assert.equal(calls[0]?.args[0], "-e");
  const ghosttyScript = calls[0]?.args[1] ?? "";
  assert.match(ghosttyScript, /tell application "Ghostty"/);
  assert.match(ghosttyScript, /set initial working directory of cfg to "\/repo with space"/);
  assert.match(ghosttyScript, /set initial input of cfg to/);
  assert.match(ghosttyScript, /'\/tmp\/ccflow main.js'/);
  assert.doesNotMatch(ghosttyScript, /set command of cfg/);

  calls.length = 0;
  const iterm = openTerminalTab(
    { command: "printf 'hello'", cwd: "/tmp/repo", title: "CCFlow node_1" },
    { env: { TERM_PROGRAM: "iTerm.app" }, platform: "darwin", spawnSync: spawnSync as never },
  );

  assert.equal(iterm.terminal, "iterm2");
  assert.equal(calls.length, 1);
  const itermScript = calls[0]?.args[1] ?? "";
  assert.match(itermScript, /tell application id "com.googlecode.iterm2"/);
  assert.match(itermScript, /create tab with default profile/);
  assert.match(itermScript, /write text "cd '\/tmp\/repo' && printf 'hello'"/);
  assert.doesNotMatch(itermScript, /create tab with default profile command/);
});

test("openTerminalTab dispatches to native CLI launchers when available", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    return { status: 0, stderr: "", error: undefined };
  };

  const wezterm = openTerminalTab(
    { command: "echo ok", cwd: "/repo", title: "CCFlow node" },
    { env: { TERM_PROGRAM: "WezTerm", SHELL: "/bin/zsh" }, platform: "darwin", spawnSync: spawnSync as never },
  );
  assert.equal(wezterm.terminal, "wezterm");
  assert.equal(calls[0]?.bin, "wezterm");
  assert.deepEqual(calls[0]?.args, ["cli", "spawn", "--cwd", "/repo", "--", "/bin/zsh", "-lc", "echo ok"]);

  calls.length = 0;
  const windowsTerminal = openTerminalTab(
    { command: "ccflow __node-session", cwd: "C:\\repo", title: "CCFlow node" },
    { env: { WT_SESSION: "session" }, platform: "win32", spawnSync: spawnSync as never },
  );
  assert.equal(windowsTerminal.terminal, "windows-terminal");
  assert.equal(calls[0]?.bin, "wt");
  assert.deepEqual(calls[0]?.args, ["-w", "0", "new-tab", "--startingDirectory", "C:\\repo", "--title", "CCFlow node", "cmd.exe", "/d", "/k", "ccflow __node-session"]);
});

test("openTerminalTab rejects unsupported terminals and reports launcher failures", () => {
  assert.throws(
    () => openTerminalTab({ command: "echo ok", cwd: "/repo" }, { env: { CCFLOW_TERMINAL_APP: "warp" }, platform: "darwin" }),
    /Unsupported CCFLOW_TERMINAL_APP/,
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
  assert.equal(terminalDisplayName("terminal-app"), "Terminal.app");
});
