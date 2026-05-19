export type NodeStatus = "live" | "active" | "done" | "queued" | "conflict";
export type Direction = "left" | "right" | "up" | "down";

export interface PrototypeNode {
  id: string;
  title: string;
  branch: string;
  status: NodeStatus;
  kind: "root" | "branch" | "turn" | "merge";
  lane: number;
  row: number;
  summary: string;
  files: string[];
  tags: string[];
  accent: string;
}

export interface PrototypeEdge {
  from: string;
  to: string;
}

export interface GraphCell {
  char: string;
  style: StyleKey;
}

export interface GraphSegment {
  text: string;
  style: StyleKey;
}

export type StyleKey =
  | "empty"
  | "edge"
  | "node"
  | "nodeDim"
  | "focus"
  | "focusText"
  | "selected"
  | "selectedText"
  | "live"
  | "active"
  | "done"
  | "queued"
  | "conflict";

export const prototypeNodes: PrototypeNode[] = [
  {
    id: "root",
    title: "Initial cc session",
    branch: "main",
    status: "done",
    kind: "root",
    lane: 0,
    row: 1,
    summary: "Baseline product direction and repository context.",
    files: ["README.md", "src/main.ts"],
    tags: ["root"],
    accent: "#38bdf8",
  },
  {
    id: "plan",
    title: "Plan node graph UX",
    branch: "main",
    status: "active",
    kind: "turn",
    lane: 1,
    row: 0,
    summary: "Current mainline node, ready to continue in Claude Code.",
    files: ["src/tui.ts"],
    tags: ["active", "ux"],
    accent: "#22c55e",
  },
  {
    id: "branch-auth",
    title: "Explore auth branch",
    branch: "oauth-explore",
    status: "live",
    kind: "branch",
    lane: 1,
    row: 2,
    summary: "Parallel session with a live terminal attached.",
    files: ["src/core/storage.ts", "src/core/git.ts"],
    tags: ["branch", "live"],
    accent: "#f59e0b",
  },
  {
    id: "build",
    title: "Implement TUI shell",
    branch: "main",
    status: "queued",
    kind: "turn",
    lane: 2,
    row: 0,
    summary: "Candidate child node for the next coding slice.",
    files: ["src/core/graph.ts", "tests/core.test.ts"],
    tags: ["prototype"],
    accent: "#a78bfa",
  },
  {
    id: "review",
    title: "Review conflict surface",
    branch: "oauth-explore",
    status: "conflict",
    kind: "turn",
    lane: 2,
    row: 2,
    summary: "Shows how warning states and selected nodes read visually.",
    files: ["src/core/jobs.ts"],
    tags: ["needs-review"],
    accent: "#fb7185",
  },
  {
    id: "merge",
    title: "Merge selected work",
    branch: "merge",
    status: "queued",
    kind: "merge",
    lane: 3,
    row: 1,
    summary: "A merge node fed by multiple selected branches.",
    files: ["src/core/jobs.ts"],
    tags: ["merge"],
    accent: "#2dd4bf",
  },
];

export const prototypeEdges: PrototypeEdge[] = [
  { from: "root", to: "plan" },
  { from: "root", to: "branch-auth" },
  { from: "plan", to: "build" },
  { from: "branch-auth", to: "review" },
  { from: "build", to: "merge" },
  { from: "review", to: "merge" },
];

export const statusLabel: Record<NodeStatus, string> = {
  live: "live",
  active: "active",
  done: "done",
  queued: "queued",
  conflict: "conflict",
};

export function nodeById(id: string): PrototypeNode {
  const node = prototypeNodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`Unknown prototype node: ${id}`);
  }
  return node;
}

export function moveFocus(currentId: string, direction: Direction): string {
  const current = nodeById(currentId);
  const candidates = prototypeNodes
    .filter((node) => node.id !== currentId)
    .map((node) => {
      const dx = node.lane - current.lane;
      const dy = node.row - current.row;
      return { node, dx, dy };
    })
    .filter(({ dx, dy }) => {
      if (direction === "left") return dx < 0;
      if (direction === "right") return dx > 0;
      if (direction === "up") return dy < 0;
      return dy > 0;
    })
    .map(({ node, dx, dy }) => {
      const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
      const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
      return { id: node.id, score: cross * 10 + primary };
    })
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));

  return candidates[0]?.id ?? currentId;
}

export function layoutFor(width: number, height: number) {
  const nodeWidth = Math.max(12, Math.min(22, Math.floor((width - 8) / 4)));
  const nodeHeight = 5;
  const maxX = Math.max(1, width - nodeWidth - 2);
  const maxY = Math.max(1, height - nodeHeight - 2);
  const laneX = [0, 0.33, 0.64, 0.94];
  const rowY = [0.05, 0.48, 0.82];

  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const node of prototypeNodes) {
    positions.set(node.id, {
      x: Math.round(maxX * laneX[node.lane]),
      y: Math.round(maxY * rowY[node.row]),
      width: nodeWidth,
      height: nodeHeight,
    });
  }

  return positions;
}

export function buildGraphSegments(
  width: number,
  height: number,
  focusId: string,
  selectedIds: Set<string>,
): GraphSegment[][] {
  const cells = buildGraphCells(width, height, focusId, selectedIds);
  return cells.map((row) => {
    const segments: GraphSegment[] = [];
    let current = row[0]?.style ?? "empty";
    let text = "";

    for (const cell of row) {
      if (cell.style !== current) {
        segments.push({ text, style: current });
        text = cell.char;
        current = cell.style;
      } else {
        text += cell.char;
      }
    }
    if (text) {
      segments.push({ text, style: current });
    }
    return segments;
  });
}

export function buildEdgeLayer(width: number, height: number): string {
  const cells = blankGrid(width, height);
  drawEdges(cells, layoutFor(width, height));
  return cells.map((row) => row.map((cell) => (cell.style === "edge" ? cell.char : " ")).join("")).join("\n");
}

function buildGraphCells(
  width: number,
  height: number,
  focusId: string,
  selectedIds: Set<string>,
): GraphCell[][] {
  const cells = blankGrid(width, height);
  const positions = layoutFor(width, height);
  drawEdges(cells, positions);

  for (const node of prototypeNodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    drawNode(cells, node, position, node.id === focusId, selectedIds.has(node.id));
  }

  return cells;
}

function blankGrid(width: number, height: number): GraphCell[][] {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " ", style: "empty" as StyleKey })),
  );
}

function drawEdges(
  cells: GraphCell[][],
  positions: Map<string, { x: number; y: number; width: number; height: number }>,
): void {
  for (const edge of prototypeEdges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;

    const startX = from.x + from.width;
    const startY = from.y + Math.floor(from.height / 2);
    const endX = to.x - 1;
    const endY = to.y + Math.floor(to.height / 2);
    const midX = Math.max(startX + 1, Math.floor((startX + endX) / 2));

    drawHorizontal(cells, startX, midX, startY);
    drawVertical(cells, midX, startY, endY);
    drawHorizontal(cells, midX, endX, endY);
    setCell(cells, endX, endY, "▶", "edge");
  }
}

function drawHorizontal(cells: GraphCell[][], x1: number, x2: number, y: number): void {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  for (let x = left; x <= right; x += 1) {
    setCell(cells, x, y, "─", "edge");
  }
}

function drawVertical(cells: GraphCell[][], x: number, y1: number, y2: number): void {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  for (let y = top; y <= bottom; y += 1) {
    setCell(cells, x, y, "│", "edge");
  }
}

function drawNode(
  cells: GraphCell[][],
  node: PrototypeNode,
  position: { x: number; y: number; width: number; height: number },
  focused: boolean,
  selected: boolean,
): void {
  const style: StyleKey = focused ? "focus" : selected ? "selected" : node.status;
  const textStyle: StyleKey = focused ? "focusText" : selected ? "selectedText" : "node";
  const { x, y, width } = position;
  const innerWidth = width - 2;
  const title = truncate(node.title, innerWidth - 2);
  const status = `${statusLabel[node.status]} · ${node.branch}`;
  const tagLine = node.tags.map((tag) => `#${tag}`).join(" ");
  const indicator = node.status === "live" ? "●" : node.status === "done" ? "○" : "◌";

  drawText(cells, x, y, `╭${"─".repeat(innerWidth)}╮`, style);
  drawText(cells, x, y + 1, `│${indicator} ${pad(title, innerWidth - 2)}│`, textStyle);
  drawText(cells, x, y + 2, `│${pad(truncate(status, innerWidth), innerWidth)}│`, textStyle);
  drawText(cells, x, y + 3, `│${pad(truncate(tagLine || node.kind, innerWidth), innerWidth)}│`, textStyle);
  drawText(cells, x, y + 4, `╰${"─".repeat(innerWidth)}╯`, style);
}

function drawText(cells: GraphCell[][], x: number, y: number, text: string, style: StyleKey): void {
  [...text].forEach((char, offset) => setCell(cells, x + offset, y, char, style));
}

function setCell(cells: GraphCell[][], x: number, y: number, char: string, style: StyleKey): void {
  if (y < 0 || y >= cells.length || x < 0 || x >= cells[y].length) return;
  cells[y][x] = { char, style };
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

export function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value + " ".repeat(width - value.length);
}
