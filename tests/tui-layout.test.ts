import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, sealLeafAndCreateChild } from "../src/core/graph.js";
import { emptyStats, type CcflowState } from "../src/core/types.js";
import { chooseExistingFocusId, ensureNodeVisible, layoutGraph, projectVisiblePositions, sanitizeGraphViewport } from "../src/core/tui-layout.js";

test("graph layout keeps node widths fixed when horizontal lanes exceed the viewport", () => {
  const state = createLinearState(8);
  const positions = layoutGraph(state);
  const widths = new Set(positions.map((position) => position.width));
  const last = positions.find((position) => position.node.id === state.currentNodeId);

  assert.deepEqual([...widths], [28]);
  assert.ok(last);
  assert.ok(last.x + last.width > 68);
});

test("TUI restores the last persisted focus and graph viewport", () => {
  const state = createLinearState(3);
  state.ui = {
    focusNodeId: state.currentNodeId,
    graphViewport: { x: 41.8, y: 3.2 },
  };

  const focusId = chooseExistingFocusId(state, state.ui.focusNodeId);
  const viewport = sanitizeGraphViewport(state.ui.graphViewport);

  assert.equal(focusId, state.currentNodeId);
  assert.deepEqual(viewport, { x: 41, y: 3 });
});

test("graph viewport pans automatically when the focused node is outside the canvas", () => {
  const state = createLinearState(6);
  const positions = layoutGraph(state);
  const focusId = state.currentNodeId;

  const viewport = ensureNodeVisible({ x: 0, y: 0 }, positions, focusId, 68, 17);

  const visibleFocus = projectVisiblePositions(positions, viewport, 68, 17)
    .find((position) => position.node.id === focusId);

  assert.ok(viewport.x > 0);
  assert.ok(visibleFocus);
  assert.ok(visibleFocus.x >= 0);
  assert.ok(visibleFocus.x + visibleFocus.width <= 68);
});

function createLinearState(depth: number): CcflowState {
  const state = createInitialState({
    repoRoot: "/tmp/ccflow-layout-test",
    branch: "main",
    commitHash: "commit_root",
    now: "2026-05-22T00:00:00.000Z",
    idFactory: () => "node_root",
  });

  let leafId = state.currentNodeId;
  for (let index = 1; index <= depth; index += 1) {
    const child = sealLeafAndCreateChild(state, {
      leafId,
      commitHash: `commit_${index}`,
      commitMessage: `step ${index}`,
      sessionId: null,
      stats: emptyStats(),
      now: `2026-05-22T00:00:${String(index).padStart(2, "0")}.000Z`,
      idFactory: () => `node_${index}`,
    });
    leafId = child.id;
  }

  return state;
}
