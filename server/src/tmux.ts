import { spawn } from "node:child_process";
import type WebSocket from "ws";
import { ptyLogPath } from "./paths.js";
import { run, tryRun } from "./shell.js";
import type { AgentInvocation, FlowNode } from "./types.js";

function safeSessionName(nodeId: string) {
  return `ccflow_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80)}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandFor(invocation: AgentInvocation, claudeSessionId?: string) {
  if (invocation.resumeStrategy === "resume-session" && claudeSessionId) {
    return `claude --resume ${shellQuote(claudeSessionId)}`;
  }
  return "claude";
}

export class TmuxRuntime {
  hasSession(session: string) {
    return tryRun("tmux", ["has-session", "-t", session]).ok;
  }

  ensureSession(node: FlowNode, invocation: AgentInvocation) {
    const session = node.tmuxSession ?? safeSessionName(node.id);
    if (this.hasSession(session)) return session;

    const command = commandFor(invocation, node.claudeSessionId);
    run("tmux", ["new-session", "-d", "-s", session, "-c", invocation.cwd, command]);
    run("tmux", ["pipe-pane", "-o", "-t", session, `cat >> ${shellQuote(ptyLogPath(node.id))}`]);
    return session;
  }

  sendRaw(session: string, data: string) {
    for (const key of tokenizeKeys(data)) {
      const result = key.kind === "literal"
        ? tryRun("tmux", ["send-keys", "-l", "-t", session, key.value])
        : tryRun("tmux", ["send-keys", "-t", session, key.value]);
      if (!result.ok) return result;
    }
    return { ok: true as const, stdout: "" };
  }

  capture(session: string) {
    const result = tryRun("tmux", ["capture-pane", "-p", "-e", "-t", session]);
    return result.ok ? result.stdout : "";
  }

  resize(session: string, cols: number, rows: number) {
    const safeCols = Math.max(20, Math.min(400, Math.floor(cols)));
    const safeRows = Math.max(8, Math.min(160, Math.floor(rows)));
    const resizeWindow = tryRun("tmux", ["resize-window", "-t", session, "-x", String(safeCols), "-y", String(safeRows)]);
    if (!resizeWindow.ok) return resizeWindow;
    return tryRun("tmux", ["resize-pane", "-t", session, "-x", String(safeCols), "-y", String(safeRows)]);
  }

  attach(ws: WebSocket, session: string) {
    const proc = spawn("tmux", ["-C", "attach-session", "-t", session], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" }
    });
    let cleanedUp = false;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    let lineBuffer = "";
    const onStdout = (data: string) => {
      lineBuffer += data;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const output = this.parseControlOutput(line);
        if (output && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "terminal-output", data: output }));
        }
      }
    };

    const onStderr = (data: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "terminal-output", data }));
      }
    };

    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);

    const onProcError = (err: Error) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", error: `tmux process error: ${err.message}` }));
      }
      cleanup(false);
    };

    const onProcExit = () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", error: "tmux control process exited" }));
      }
      cleanup(false);
    };

    const onWsClose = () => {
      cleanup();
    };

    proc.on("error", onProcError);
    proc.on("exit", onProcExit);
    ws.on("close", onWsClose);

    function cleanup(killProcess = true) {
      if (cleanedUp) return;
      cleanedUp = true;
      proc.stdout.removeListener("data", onStdout);
      proc.stderr.removeListener("data", onStderr);
      proc.removeListener("error", onProcError);
      proc.removeListener("exit", onProcExit);
      ws.removeListener("close", onWsClose);
      if (killProcess && proc.exitCode === null && !proc.killed) {
        proc.kill();
      }
    }

    return () => cleanup();
  }

  private parseControlOutput(line: string) {
    if (line.startsWith("%output ")) {
      const firstSpace = line.indexOf(" ");
      const secondSpace = line.indexOf(" ", firstSpace + 1);
      if (secondSpace === -1) return undefined;
      return this.decodeTmuxControl(line.slice(secondSpace + 1));
    }
    if (line.startsWith("%continue ")) {
      const firstSpace = line.indexOf(" ");
      if (firstSpace === -1) return undefined;
      return this.decodeTmuxControl(line.slice(firstSpace + 1));
    }
    return undefined;
  }

  private decodeTmuxControl(value: string) {
    return value.replace(/\\([0-7]{3}|.)/g, (_, escape: string) => {
      if (/^[0-7]{3}$/.test(escape)) {
        return String.fromCharCode(Number.parseInt(escape, 8));
      }
      switch (escape) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "\\":
          return "\\";
        default:
          return escape;
      }
    });
  }
}

type TmuxKey = { kind: "literal"; value: string } | { kind: "named"; value: string };

function tokenizeKeys(data: string) {
  const keys: TmuxKey[] = [];
  let literal = "";

  const flush = () => {
    if (literal) {
      keys.push({ kind: "literal", value: literal });
      literal = "";
    }
  };

  for (let index = 0; index < data.length; index += 1) {
    const rest = data.slice(index);
    const sequence = specialSequence(rest);
    if (sequence) {
      flush();
      keys.push({ kind: "named", value: sequence.key });
      index += sequence.length - 1;
      continue;
    }
    literal += data[index] ?? "";
  }

  flush();
  return keys;
}

function specialSequence(input: string) {
  const sequences: Array<[string, string]> = [
    ["\r", "Enter"],
    ["\n", "Enter"],
    ["\t", "Tab"],
    ["", "C-c"],
    ["", "C-u"],
    ["", "BSpace"],
    ["[A", "Up"],
    ["[B", "Down"],
    ["[C", "Right"],
    ["[D", "Left"],
    ["[3~", "Delete"],
    ["[H", "Home"],
    ["[F", "End"]
  ];

  for (const [sequence, key] of sequences) {
    if (input.startsWith(sequence)) return { key, length: sequence.length };
  }
  return undefined;
}
