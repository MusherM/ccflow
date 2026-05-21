export interface ProtoNode {
  id: string;
  title: string;
  type: 'leaf' | 'internal';
  status: 'dirty' | 'committing' | 'sealed' | 'merging';
  worktree: string;
  commitHash?: string;
  parentIds: string[];
}

export interface ColumnInfo {
  name: string;
  worktree: string;
  index: number;
  inkColor: string;
}

export interface Edge {
  from: { row: number; col: number };
  to: { row: number; col: number };
}

export interface LayoutResult {
  columns: ColumnInfo[];
  grid: (ProtoNode | null)[][];
  maxRow: number;
  maxCol: number;
  edges: Edge[];
}

export interface OutlineItem {
  node: ProtoNode;
  linePrefix: string;
}

export const INK_COLORS = ['green', 'cyan', 'magenta', 'blue', 'yellow'] as const;
