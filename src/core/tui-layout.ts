import { getNode, isSafeFocusTarget } from "./graph.js";
import type { CcflowNode, CcflowState } from "./types.js";

export interface GraphViewport {
  x: number;
  y: number;
}

export interface PositionedNode {
  node: CcflowNode;
  x: number;
  y: number;
  width: number;
  height: number;
  lane: number;
  row: number;
}

export const GRAPH_NODE_WIDTH = 32;
export const GRAPH_NODE_HEIGHT = 5;

const GRAPH_LANE_GAP = 10;
const GRAPH_ROW_GAP = 2;
const GRAPH_CANVAS_PADDING_X = 2;
const GRAPH_CANVAS_PADDING_Y = 1;
const GRAPH_FOCUS_MARGIN_X = 4;
const GRAPH_FOCUS_MARGIN_Y = 2;

export function chooseExistingFocusId(state: CcflowState, preferredId: string | undefined): string {
  if (preferredId && state.nodes[preferredId]) return preferredId;
  if (state.nodes[state.currentNodeId]) return state.currentNodeId;
  const fallback = Object.values(state.nodes).find((node) => isSafeFocusTarget(state, node.id)) ?? Object.values(state.nodes)[0];
  if (!fallback) throw new Error("No nodes available to focus");
  return fallback.id;
}

export function sanitizeGraphViewport(viewport: GraphViewport | undefined): GraphViewport {
  const x = viewport?.x;
  const y = viewport?.y;
  return {
    x: typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0,
    y: typeof y === "number" && Number.isFinite(y) ? Math.max(0, Math.floor(y)) : 0,
  };
}

export function layoutGraph(state: CcflowState): PositionedNode[] {
  const ranked = rankNodes(state);
  return Object.values(state.nodes)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((node) => {
      const rank = ranked.get(node.id) ?? { lane: 0, row: 0 };
      return {
        node,
        x: GRAPH_CANVAS_PADDING_X + rank.lane * (GRAPH_NODE_WIDTH + GRAPH_LANE_GAP),
        y: GRAPH_CANVAS_PADDING_Y + rank.row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
        lane: rank.lane,
        row: rank.row,
      };
    });
}

export function ensureNodeVisible(
  viewport: GraphViewport,
  positions: PositionedNode[],
  focusId: string,
  viewportWidth: number,
  viewportHeight: number,
): GraphViewport {
  const focus = positions.find((position) => position.node.id === focusId);
  if (!focus) return sanitizeGraphViewport(viewport);

  let nextX = viewport.x;
  let nextY = viewport.y;
  const left = focus.x - GRAPH_FOCUS_MARGIN_X;
  const right = focus.x + focus.width + GRAPH_FOCUS_MARGIN_X;
  const top = focus.y - GRAPH_FOCUS_MARGIN_Y;
  const bottom = focus.y + focus.height + GRAPH_FOCUS_MARGIN_Y;

  if (left < nextX) nextX = left;
  else if (right > nextX + viewportWidth) nextX = right - viewportWidth;

  if (top < nextY) nextY = top;
  else if (bottom > nextY + viewportHeight) nextY = bottom - viewportHeight;

  return sanitizeGraphViewport({ x: nextX, y: nextY });
}

export function projectVisiblePositions(
  positions: PositionedNode[],
  viewport: GraphViewport,
  viewportWidth: number,
  viewportHeight: number,
): PositionedNode[] {
  return positions
    .map((position) => ({
      ...position,
      x: position.x - viewport.x,
      y: position.y - viewport.y,
    }))
    .filter((position) => (
      position.x < viewportWidth &&
      position.y < viewportHeight &&
      position.x + position.width > 0 &&
      position.y + position.height > 0
    ));
}

export function rankNodes(state: CcflowState): Map<string, { lane: number; row: number }> {
  const nodes = Object.values(state.nodes).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const depthCache = new Map<string, number>();
  const depthOf = (node: CcflowNode): number => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) return cached;
    const depth = node.parents.length
      ? Math.max(...node.parents.map((parentId) => depthOf(getNode(state, parentId)))) + 1
      : 0;
    depthCache.set(node.id, depth);
    return depth;
  };
  const byLane = new Map<number, CcflowNode[]>();
  for (const node of nodes) {
    const lane = depthOf(node);
    const laneNodes = byLane.get(lane) ?? [];
    laneNodes.push(node);
    byLane.set(lane, laneNodes);
  }
  const ranked = new Map<string, { lane: number; row: number }>();
  for (const [lane, laneNodes] of byLane) {
    laneNodes.forEach((node, row) => ranked.set(node.id, { lane, row }));
  }
  return ranked;
}

export function buildEdgeLayer(
  state: CcflowState,
  positions: PositionedNode[],
  width: number,
  height: number,
  viewport: GraphViewport,
): string {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const byId = new Map(positions.map((position) => [position.node.id, position]));
  for (const node of Object.values(state.nodes)) {
    const from = byId.get(node.id);
    if (!from) continue;
    for (const childId of node.children) {
      const to = byId.get(childId);
      if (!to) continue;
      drawEdge(cells, from, to, viewport);
    }
  }
  return cells.map((row) => row.join("")).join("\n");
}

function drawEdge(cells: string[][], from: PositionedNode, to: PositionedNode, viewport: GraphViewport): void {
  const startX = from.x + from.width;
  const startY = from.y + Math.floor(from.height / 2);
  const endX = to.x - 1;
  const endY = to.y + Math.floor(to.height / 2);
  const midX = Math.max(startX + 1, Math.floor((startX + endX) / 2));
  if (endY === startY) {
    // Straight horizontal connector — a single stroke ending in the arrow head.
    drawHorizontal(cells, startX, endX - 1, startY, viewport);
  } else {
    drawHorizontal(cells, startX, midX, startY, viewport);
    drawVertical(cells, midX, startY, endY, viewport);
    drawHorizontal(cells, midX, endX - 1, endY, viewport);
    // Replace the two elbow cells with the appropriate Unicode box-drawing
    // character so the L-bend reads as one continuous connector rather than
    // the overlap of horizontal/vertical strokes.
    const goingDown = endY > startY;
    const firstElbow = goingDown ? "┐" : "┘"; // right-then-down | right-then-up
    const secondElbow = goingDown ? "└" : "┌"; // down-then-right | up-then-right
    setWorldCell(cells, midX, startY, viewport, firstElbow);
    setWorldCell(cells, midX, endY, viewport, secondElbow);
  }
  setWorldCell(cells, endX, endY, viewport, "▶");
}

function drawHorizontal(cells: string[][], x1: number, x2: number, y: number, viewport: GraphViewport): void {
  const screenY = y - viewport.y;
  if (screenY < 0 || screenY >= cells.length) return;
  const width = cells[screenY]?.length ?? 0;
  const minX = Math.max(Math.min(x1, x2), viewport.x);
  const maxX = Math.min(Math.max(x1, x2), viewport.x + width - 1);
  for (let x = minX; x <= maxX; x += 1) setWorldCell(cells, x, y, viewport, "─");
}

function drawVertical(cells: string[][], x: number, y1: number, y2: number, viewport: GraphViewport): void {
  const screenX = x - viewport.x;
  if (screenX < 0 || screenX >= (cells[0]?.length ?? 0)) return;
  const minY = Math.max(Math.min(y1, y2), viewport.y);
  const maxY = Math.min(Math.max(y1, y2), viewport.y + cells.length - 1);
  for (let y = minY; y <= maxY; y += 1) setWorldCell(cells, x, y, viewport, "│");
}

function setWorldCell(cells: string[][], x: number, y: number, viewport: GraphViewport, value: string): void {
  const screenX = x - viewport.x;
  const screenY = y - viewport.y;
  if (screenY < 0 || screenY >= cells.length || screenX < 0 || screenX >= cells[screenY].length) return;
  cells[screenY][screenX] = value;
}
