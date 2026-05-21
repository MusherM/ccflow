# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CCFlow 是面向 Claude Code 的节点式会话和 Git 工作流管理器，状态存储在目标仓库的 `.ccflow/` 目录中。

## 开发命令

```bash
npm run dev -- /path/to/repo   # 启动 TUI
npm run build                 # 编译 TypeScript
npm run typecheck             # 类型检查
npm run test                  # 运行测试（含真实 claude -p 验证）
npm run proto:opentui         # 运行交互原型
CCFLOW_CLAUDE_BIN=/path/to/claude npm test   # 指定 claude 二进制
```

## 架构

```
src/
  main.ts          # 入口：初始化状态 → 启动 TUI
  tui.ts           # OpenTUI 节点图交互（键盘分发、状态机）
  core/
    graph.ts       # 节点 DAG + 不变量断言（系统边界，修改前先补测试）
    storage.ts     # .ccflow JSON 读写
    git.ts         # Git/worktree 操作
    claude.ts      # Claude Code 会话管理
    jobs.ts        # commit/merge job runner（独立 Claude Code 进程）
    types.ts       # 数据模型
```

**状态流**：main.ts 创建初始状态 → normalizeAfterBoot 清理进程残留 → TUI 处理所有交互（node 创建、切换、commit、merge、delete）→ storage.ts 持久化。

**不变量**（graph.ts:assertGraphInvariants）：
- 只有 leaf 节点可继续工作
- internal 节点必有 commit 且 status 为 sealed
- 正好一个 worktree 是 current
- 节点双向引用（父子节点互相指向）

## 规则

- 永远用中文回复用户。
- 核心工作流、TUI 交互、架构或数据模型变化时，必须同步更新 `README.md`。
- `src/core/graph.ts` 中的不变量是系统边界，修改前先补测试。
- 所有涉及 Claude Code/cc 的测试必须走真实 cc 流程，不能用 fake/stub/mock 替代；需要直接在沙箱外运行测试，确保 `claude`/`cc` CLI 能被真实调用起来。
