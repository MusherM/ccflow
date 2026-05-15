import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { FlowNode } from "../types";

type TerminalPaneProps = {
  node: FlowNode | null;
  title: string;
  onClear: (nodeId: string) => Promise<void>;
};

export function TerminalPane({ node, title, onClear }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lineBufferRef = useRef("");
  const [connection, setConnection] = useState("offline");

  const onClearRef = useLatest(onClear);
  const nodeRef = useLatest(node);

  function createTerminal() {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      allowTransparency: false,
      fontFamily: '"Maple Mono NF CN", "JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
      fontSize: 13,
      scrollback: 1000,
      theme: makeTerminalTheme()
    });
    return terminal;
  }

  function disposeTerminal(terminal = terminalRef.current) {
    if (!terminal) return;
    if (terminalRef.current === terminal) {
      fitAddonRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    }
    terminal.dispose();
  }

  function fitAndSyncSize() {
    fitAddonRef.current?.fit();
    const t = terminalRef.current;
    const ws = socketRef.current;
    const activeNode = nodeRef.current;
    if (t && ws?.readyState === WebSocket.OPEN && activeNode) {
      ws.send(JSON.stringify({ type: "terminal-resize", nodeId: activeNode.id, cols: t.cols, rows: t.rows }));
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTerminalTheme = () => {
      const terminal = terminalRef.current;
      if (terminal) terminal.options.theme = makeTerminalTheme();
    };
    themeQuery.addEventListener("change", applyTerminalTheme);

    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        fitAndSyncSize();
      });
    });
    resizeObserver.observe(host);

    return () => {
      themeQuery.removeEventListener("change", applyTerminalTheme);
      resizeObserver.disconnect();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = createTerminal();
    terminal.open(host);
    terminalRef.current = terminal;

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    fitAddonRef.current = fit;
    const fitFrame = window.requestAnimationFrame(() => {
      if (terminalRef.current === terminal) fit.fit();
    });

    lineBufferRef.current = "";

    const dataDisposable = terminal.onData((data) => {
      const activeNode = nodeRef.current;
      const clear = onClearRef.current;
      if (!activeNode) return;
      const outgoing = interceptLocalCommand(data, lineBufferRef, activeNode.id, clear);
      if (outgoing && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "terminal-input", nodeId: activeNode.id, data: outgoing }));
      }
    });

    const focus = () => terminal.focus();
    host.addEventListener("pointerdown", focus);

    if (!node) {
      terminal.writeln("CCFLOW::NO NODE SELECTED");
      setConnection("offline");
      return () => {
        window.cancelAnimationFrame(fitFrame);
        host.removeEventListener("pointerdown", focus);
        dataDisposable.dispose();
        disposeTerminal(terminal);
      };
    }

    if (!node.tmuxSession) {
      terminal.writeln(`CCFLOW::NODE ${node.title} [${node.contextFidelity}]`);
      terminal.writeln("PRESS RUN / ATTACH TO START OR RECONNECT THE CLAUDE PTY.");
      closeSocket();
      setConnection("idle");
      return () => {
        window.cancelAnimationFrame(fitFrame);
        host.removeEventListener("pointerdown", focus);
        dataDisposable.dispose();
        disposeTerminal(terminal);
      };
    }

    terminal.writeln(`CCFLOW::LINK ${node.title} [${node.contextFidelity}]`);
    terminal.writeln("TYPE NORMALLY. /clear creates a clear node on Enter. //clear passes /clear through.");
    terminal.writeln("");
    terminal.focus();

    closeSocket();
    setConnection("connecting");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socketRef.current = socket;

    const onOpen = () => {
      if (socketRef.current !== socket) return;
      socket.send(JSON.stringify({ type: "attach", nodeId: node.id }));
      setConnection("attached");
      terminal.focus();
    };
    const onMessage = (event: MessageEvent) => {
      if (socketRef.current !== socket) return;
      const message = JSON.parse(event.data) as { type: string; data?: string; error?: string; session?: string };
      if (message.type === "terminal-output" && message.data) terminal.write(message.data);
      if (message.type === "terminal-snapshot" && message.data) {
        terminal.reset();
        terminal.write(message.data);
      }
      if (message.type === "attached") setConnection("attached");
      if (message.type === "error" && message.error) {
        setConnection("error");
        terminal.writeln(`\r\n${message.error}`);
      }
    };
    const onClose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        setConnection("closed");
      }
    };
    const onError = () => {
      if (socketRef.current === socket) setConnection("error");
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);

    return () => {
      window.cancelAnimationFrame(fitFrame);
      host.removeEventListener("pointerdown", focus);
      dataDisposable.dispose();
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      closeSocket(socket);
      disposeTerminal(terminal);
    };
  }, [node?.contextFidelity, node?.id, node?.title, node?.tmuxSession]);

  function closeSocket(s = socketRef.current) {
    if (!s) return;
    if (socketRef.current === s) socketRef.current = null;
    if (s.readyState === WebSocket.CONNECTING || s.readyState === WebSocket.OPEN) {
      s.close();
    }
  }

  return (
    <div className="terminal-shell">
      <div className="terminal-title">
        <span>{title}</span>
        <code>{node?.tmuxSession ?? connection}</code>
      </div>
      <div className="terminal-frame" ref={hostRef} />
    </div>
  );
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function makeTerminalTheme() {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (isDark) {
    return {
      background: "#0b0e0a",
      foreground: "#efe9d1",
      cursor: "#7fc89b",
      cursorAccent: "#0b0e0a",
      selectionBackground: "#2b3326",
      selectionForeground: "#efe9d1",
      black: "#0b0e0a",
      red: "#c36957",
      green: "#7fc89b",
      yellow: "#c2a85b",
      blue: "#86a98d",
      magenta: "#b98988",
      cyan: "#79b8a4",
      white: "#d8d3bd",
      brightBlack: "#343d2e",
      brightRed: "#dc806e",
      brightGreen: "#9fe0b6",
      brightYellow: "#dcc878",
      brightBlue: "#a4c4aa",
      brightMagenta: "#d5a5a2",
      brightCyan: "#98d3c1",
      brightWhite: "#fff8df"
    };
  }

  return {
    background: "#16130e",
    foreground: "#efe7cf",
    cursor: "#217c68",
    cursorAccent: "#f2efe7",
    selectionBackground: "#403828",
    selectionForeground: "#efe7cf",
    black: "#171512",
    red: "#bc3d2c",
    green: "#217c68",
    yellow: "#9b7416",
    blue: "#2f668f",
    magenta: "#8c5a70",
    cyan: "#3d8074",
    white: "#d9cfba",
    brightBlack: "#716957",
    brightRed: "#d24b2a",
    brightGreen: "#2f947d",
    brightYellow: "#b98b17",
    brightBlue: "#427da8",
    brightMagenta: "#a56f86",
    brightCyan: "#4a9c8f",
    brightWhite: "#fffaf0"
  };
}

function interceptLocalCommand(
  data: string,
  lineBufferRef: { current: string },
  nodeId: string,
  onClear: (nodeId: string) => Promise<void>
) {
  if (data === "") {
    lineBufferRef.current = lineBufferRef.current.slice(0, -1);
    return data;
  }

  if (data === "") {
    lineBufferRef.current = "";
    return data;
  }

  if (data === "\r" || data === "\n") {
    const line = lineBufferRef.current.trim();
    lineBufferRef.current = "";
    if (line === "/clear") {
      void onClear(nodeId);
      return "";
    }
    if (line === "//clear") return "/clear\r";
    return data;
  }

  if (!data.startsWith("")) lineBufferRef.current += data;
  return data;
}
