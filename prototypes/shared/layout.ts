import type { ProtoNode, LayoutResult, ColumnInfo, OutlineItem } from './types.js';
import { INK_COLORS } from './types.js';

export interface Edge {
  from: { row: number; col: number };
  to: { row: number; col: number };
}

/**
 * Compute a column-based grid layout from a DAG of nodes.
 * Columns = branches, Rows = time (old at top, new at bottom).
 */
export function computeLayout(nodes: ProtoNode[]): LayoutResult & { edges: Edge[] } {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // parentId -> childNodeIds
  const childrenMap = new Map<string, string[]>();
  for (const n of nodes) {
    for (const pid of n.parentIds) {
      const list = childrenMap.get(pid) || [];
      list.push(n.id);
      childrenMap.set(pid, list);
    }
  }

  const positions = new Map<string, { row: number; col: number }>();
  const branchNames: string[] = [];
  let currentRow = 0;

  function assign(nodeId: string, col: number): void {
    if (positions.has(nodeId)) return;

    const node = nodeMap.get(nodeId)!;
    
    // For merge nodes, we ensure they get a fresh row to highlight the merge
    if (node.parentIds.length >= 2) {
      currentRow++;
    }

    positions.set(nodeId, { row: currentRow, col });
    
    if (branchNames[col] === undefined) {
      branchNames[col] = node.worktree;
    }

    const children = childrenMap.get(nodeId) || [];
    if (children.length > 0) {
      const parentRow = currentRow;
      for (let i = 0; i < children.length; i++) {
        // Increment row for each level of depth
        if (i === 0) currentRow = parentRow + 1;
        const childCol = i === 0 ? col : branchNames.length;
        assign(children[i], childCol);
      }
    }
  }

  // Start from root nodes
  const roots = nodes.filter(n => n.parentIds.length === 0);
  for (const root of roots) {
    assign(root.id, 0);
    currentRow++;
  }

  const numCols = branchNames.length;
  const maxRow = Math.max(...Array.from(positions.values()).map(p => p.row), 0);
  const grid: (ProtoNode | null)[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    grid.push(new Array(numCols).fill(null));
  }

  for (const [nodeId, { row, col }] of positions) {
    grid[row][col] = nodeMap.get(nodeId)!;
  }

  const edges: Edge[] = [];
  for (const node of nodes) {
    const pos = positions.get(node.id)!;
    for (const pid of node.parentIds) {
      const ppos = positions.get(pid);
      if (ppos) {
        edges.push({ from: ppos, to: pos });
      }
    }
  }

  const columns: ColumnInfo[] = branchNames.map((name, i) => ({
    name,
    worktree: name,
    index: i,
    inkColor: INK_COLORS[i % INK_COLORS.length],
  }));

  return { columns, grid, maxRow, maxCol: numCols, edges };
}

/**
 * Compute an indented outline (tree) view from a DAG of nodes.
 * Returns a flat list for vertical navigation, each with a tree-connector prefix.
 */
export function computeOutline(nodes: ProtoNode[]): OutlineItem[] {
  const childrenMap = new Map<string, string[]>();
  for (const n of nodes) {
    childrenMap.set(n.id, []);
    for (const pid of n.parentIds) {
      const list = childrenMap.get(pid) || [];
      list.push(n.id);
      childrenMap.set(pid, list);
    }
  }

  const result: OutlineItem[] = [];

  function walk(nodeId: string, prefix: string, isLastAmongSiblings: boolean) {
    const node = nodes.find(n => n.id === nodeId)!;
    const children = childrenMap.get(nodeId) || [];
    const isRoot = node.parentIds.length === 0;

    const connector = isRoot ? '' : (isLastAmongSiblings ? '└── ' : '├── ');
    result.push({ node, linePrefix: prefix + connector });

    let childPrefix = prefix;
    if (!isRoot) {
      childPrefix += isLastAmongSiblings ? '    ' : '│   ';
    }

    for (let i = 0; i < children.length; i++) {
      walk(children[i], childPrefix, i === children.length - 1);
    }
  }

  const roots = nodes.filter(n => n.parentIds.length === 0);
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i].id, '', i === roots.length - 1);
  }

  return result;
}
