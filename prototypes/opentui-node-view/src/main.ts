import {
  Box,
  Text,
  TextAttributes,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import {
  buildEdgeLayer,
  layoutFor,
  moveFocus,
  nodeById,
  prototypeNodes,
  statusLabel,
  truncate,
  type Direction,
  type PrototypeNode,
} from "../../shared/nodes.js";
import { runNativeCc } from "../../shared/nativeCc.js";

interface AppState {
  focusId: string;
  selectedIds: Set<string>;
  enterNode: PrototypeNode | null;
  quit: boolean;
}

function renderApp(renderer: CliRenderer, state: AppState) {
  try {
    renderer.root.remove("app");
  } catch {
    // remove is best-effort: the first render has no previous app tree.
  }

  const width = Math.max(64, renderer.terminalWidth || renderer.width || 120);
  const height = Math.max(24, renderer.terminalHeight || renderer.height || 34);
  const compact = width < 112;
  const graphWidth = compact ? Math.max(58, width - 2) : Math.max(58, width - 38);
  const graphHeight = Math.max(18, height - 7);
  const focusNode = nodeById(state.focusId);

  renderer.root.add(
    Box(
      {
        id: "app",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: "#070b10",
      },
      toolbar(state.selectedIds.size),
      Box(
        {
          flexGrow: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          gap: 1,
        },
        graphPanel(graphWidth, graphHeight, state),
        compact
          ? compactSummary(focusNode, state.selectedIds.has(state.focusId), state.selectedIds.size)
          : sidePanel(focusNode, state.selectedIds.has(state.focusId), state.selectedIds.size),
      ),
      footer(),
    ),
  );

  renderer.requestRender();
}

function compactSummary(node: PrototypeNode, selected: boolean, selectedCount: number) {
  return Box(
    {
      position: "absolute",
      left: 2,
      bottom: 2,
      width: "95%",
      height: 4,
      border: true,
      borderStyle: "rounded",
      borderColor: node.accent,
      backgroundColor: "#0f172a",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    },
    Text({
      content: `${node.title}  ${node.branch}  selected ${selected ? "yes" : "no"}  set ${selectedCount}`,
      fg: node.accent,
      attributes: TextAttributes.BOLD,
    }),
    Text({ content: truncate(node.summary, 72), fg: "#94a3b8" }),
  );
}

function toolbar(selectedCount: number) {
  return Box(
    {
      height: 3,
      border: ["bottom"],
      borderStyle: "single",
      borderColor: "#1f2937",
      paddingLeft: 2,
      paddingRight: 2,
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: "#0f172a",
    },
    Text({
      content: "CCFlow  node manager prototype  OpenTUI / TypeScript + Zig core",
      fg: "#e5e7eb",
      attributes: TextAttributes.BOLD,
    }),
    Text({
      content: `selected ${selectedCount}`,
      fg: selectedCount ? "#facc15" : "#64748b",
    }),
  );
}

function graphPanel(width: number, height: number, state: AppState) {
  const positions = layoutFor(width - 2, height - 2);
  const edgeLayer = buildEdgeLayer(width - 2, height - 2);

  return Box(
    {
      width,
      height,
      border: true,
      borderStyle: "rounded",
      borderColor: "#334155",
      title: " node graph / OpenTUI renderer ",
      backgroundColor: "#020617",
      position: "relative",
    },
    Text({
      content: edgeLayer,
      fg: "#334155",
      position: "absolute",
      left: 1,
      top: 1,
      width: width - 2,
      height: height - 2,
    }),
    ...prototypeNodes.map((node) => {
      const pos = positions.get(node.id);
      if (!pos) return null;
      return nodeCard(node, pos.x + 1, pos.y + 1, pos.width, state.focusId === node.id, state.selectedIds.has(node.id));
    }),
  );
}

function nodeCard(
  node: PrototypeNode,
  left: number,
  top: number,
  width: number,
  focused: boolean,
  selected: boolean,
) {
  const borderColor = focused ? "#7dd3fc" : selected ? "#facc15" : node.accent;
  const backgroundColor = focused ? "#7dd3fc" : selected ? "#3f3205" : "#0b1120";
  const fg = focused ? "#020617" : "#e5e7eb";
  const indicator = node.status === "live" ? "●" : node.status === "done" ? "○" : "◌";

  return Box(
    {
      position: "absolute",
      left,
      top,
      width,
      height: 5,
      border: true,
      borderStyle: "rounded",
      borderColor,
      backgroundColor,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    },
    Text({
      content: `${indicator} ${truncate(node.title, width - 6)}`,
      fg,
      attributes: focused ? TextAttributes.BOLD : TextAttributes.NONE,
    }),
    Text({
      content: truncate(`${statusLabel[node.status]} · ${node.branch}`, width - 4),
      fg: focused ? "#0f172a" : node.accent,
    }),
    Text({
      content: truncate(node.tags.map((tag) => `#${tag}`).join(" ") || node.kind, width - 4),
      fg: focused ? "#0f172a" : "#94a3b8",
    }),
  );
}

function sidePanel(node: PrototypeNode, selected: boolean, selectedCount: number) {
  return Box(
    {
      width: 34,
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: node.accent,
      backgroundColor: "#0f172a",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
      gap: 1,
    },
    Text({ content: node.title, fg: node.accent, attributes: TextAttributes.BOLD }),
    field("id", node.id),
    field("branch", node.branch, node.accent),
    field("status", node.status, node.status === "conflict" ? "#fb7185" : node.accent),
    field("selected", selected ? "yes" : "no", selected ? "#facc15" : "#64748b"),
    Text({ content: "summary", fg: "#64748b" }),
    Text({ content: node.summary, fg: "#e5e7eb", wrapMode: "word" }),
    Text({ content: "files", fg: "#64748b" }),
    ...node.files.map((file) => Text({ content: `• ${file}`, fg: "#cbd5e1" })),
    Text({ content: `selection set: ${selectedCount}`, fg: "#94a3b8" }),
    Text({ content: "Enter opens real cc. Esc inside cc returns here.", fg: "#64748b", wrapMode: "word" }),
  );
}

function field(label: string, value: string, color = "#cbd5e1") {
  return Box(
    { flexDirection: "row" },
    Text({ content: label.padEnd(9), fg: "#64748b" }),
    Text({ content: value, fg: color }),
  );
}

function footer() {
  return Box(
    {
      height: 2,
      alignItems: "center",
      paddingLeft: 2,
      backgroundColor: "#070b10",
    },
    Text({
      content: "hjkl/arrows move   space select   enter cc   esc clear/return   q quit",
      fg: "#94a3b8",
    }),
  );
}

function keyToDirection(key: KeyEvent): Direction | null {
  if (key.name === "left" || key.sequence === "h") return "left";
  if (key.name === "right" || key.sequence === "l") return "right";
  if (key.name === "up" || key.sequence === "k") return "up";
  if (key.name === "down" || key.sequence === "j") return "down";
  return null;
}

async function runOpenTuiOnce(initialFocusId: string): Promise<AppState> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
    screenMode: "alternate-screen",
    targetFps: 30,
    consoleMode: "disabled",
    useKittyKeyboard: null,
    useMouse: false,
    enableMouseMovement: false,
    backgroundColor: "#070b10",
  });

  const state: AppState = {
    focusId: initialFocusId,
    selectedIds: new Set(),
    enterNode: null,
    quit: false,
  };

  const done = new Promise<AppState>((resolve) => {
    renderer.keyInput.on("keypress", (key) => {
      const direction = keyToDirection(key);
      if (direction) {
        state.focusId = moveFocus(state.focusId, direction);
        renderApp(renderer, state);
        key.preventDefault();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        state.enterNode = nodeById(state.focusId);
        renderer.destroy();
        resolve(state);
        return;
      }

      if (key.name === "space" || key.sequence === " ") {
        if (state.selectedIds.has(state.focusId)) {
          state.selectedIds.delete(state.focusId);
        } else {
          state.selectedIds.add(state.focusId);
        }
        renderApp(renderer, state);
        return;
      }

      if (key.name === "escape") {
        state.selectedIds.clear();
        renderApp(renderer, state);
        return;
      }

      if (key.sequence === "q") {
        state.quit = true;
        renderer.destroy();
        resolve(state);
      }
    });

    renderer.on("resize", () => renderApp(renderer, state));
    renderer.on("destroy", () => resolve(state));
  });

  renderApp(renderer, state);
  renderer.start();

  return done;
}

async function main() {
  let focusId = prototypeNodes[0].id;

  while (true) {
    const result = await runOpenTuiOnce(focusId);
    if (!result.enterNode || result.quit) {
      break;
    }
    focusId = result.enterNode.id;
    await runNativeCc(result.enterNode);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
