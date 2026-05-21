import type { ProtoNode } from './types.js';

export function createSampleData(): ProtoNode[] {
  return [
    // ── main 分支主干 ──
    {
      id: 'n1', title: 'Initial commit', type: 'internal', status: 'sealed',
      worktree: 'main', commitHash: 'abc1234', parentIds: [],
    },
    {
      id: 'n2', title: 'Add core types', type: 'internal', status: 'sealed',
      worktree: 'main', commitHash: 'def5678', parentIds: ['n1'],
    },
    {
      id: 'n3', title: 'Add storage API', type: 'internal', status: 'sealed',
      worktree: 'main', commitHash: 'ghi9012', parentIds: ['n2'],
    },
    // ── feat-fix 分支 ──
    {
      id: 'n4', title: 'Fix type export', type: 'internal', status: 'sealed',
      worktree: 'feat-fix', commitHash: 'jkl3456', parentIds: ['n2'],
    },
    {
      id: 'n5', title: 'Add field validation', type: 'internal', status: 'sealed',
      worktree: 'feat-fix', commitHash: 'mno7890', parentIds: ['n4'],
    },
    // ── feat-docs 分支 ──
    {
      id: 'n6', title: 'Update API docs', type: 'internal', status: 'sealed',
      worktree: 'feat-docs', commitHash: 'pqr1234', parentIds: ['n2'],
    },
    // ── 合并 feat-fix → main ──
    {
      id: 'n7', title: 'Merge feat-fix', type: 'internal', status: 'sealed',
      worktree: 'main', commitHash: 'stu5678', parentIds: ['n3', 'n5'],
    },
    // ── 合并 feat-docs → main ──
    {
      id: 'n8', title: 'Merge feat-docs', type: 'internal', status: 'sealed',
      worktree: 'main', commitHash: 'vwx9012', parentIds: ['n7', 'n6'],
    },
    // ── 新分支 feat-auth ──
    {
      id: 'n9', title: 'Add OAuth module', type: 'internal', status: 'sealed',
      worktree: 'feat-auth', commitHash: 'yza3456', parentIds: ['n8'],
    },
    {
      id: 'n10', title: 'WIP: token refresh', type: 'leaf', status: 'dirty',
      worktree: 'feat-auth', commitHash: undefined, parentIds: ['n9'],
    },
    // ── main 当前工作节点 ──
    {
      id: 'n11', title: 'WIP: storage module', type: 'leaf', status: 'dirty',
      worktree: 'main', commitHash: undefined, parentIds: ['n8'],
    },
  ];
}

export function createExtendedSampleData(): ProtoNode[] {
  return [
    ...createSampleData(),
    {
      id: 'n12', title: 'WIP: add logging', type: 'leaf', status: 'committing',
      worktree: 'feat-log', commitHash: undefined, parentIds: ['n8'],
    },
    {
      id: 'n13', title: 'Merge feat-auth', type: 'internal', status: 'sealed',
      worktree: 'main', commitHash: 'bcd7890', parentIds: ['n11', 'n10'],
    },
  ];
}
