# CCFlow 项目指南

这是 CCFlow 的根目录。当前实现是 TypeScript + OpenTUI 的节点式 Claude Code 会话管理器，状态存储在目标仓库的 `.ccflow/` 目录中。

## 目录结构

- `src/` — 新的生产实现
- `src/core/` — 数据模型、DAG 操作、JSON 存储、Git adapter、Claude adapter、job runner
- `src/tui.ts` — OpenTUI 节点图交互
- `tests/` — 核心行为回归测试
- `prototypes/` — 保留的交互原型，不作为生产入口

## 关键规则

- 永远用中文回复用户。
- 不再新增 Python TUI/CLI 或 REST server 路径。
- 核心工作流、TUI 交互、架构或数据模型变化时，必须同步更新 `README.md`。
- `src/core/graph.ts` 中的不变量是系统边界，修改前先补测试。
