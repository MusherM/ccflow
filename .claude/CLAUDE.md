# CCFlow 项目指南

这是 CCFlow 项目的根目录。CCFlow 是一个 Claude Code 工作流管理工具——在不侵入 cc 原生体验的前提下提供会话节点图可视化、分叉探索、跨分支合并等功能。

## 目录结构

- `server/` — Node.js 守护进程（REST API、git 操作、SQLite、tmux）
- `cmd/ccflow-cli/` — Python CLI（cc 通过 Bash tool 调用的桥接层）
- `design-prototypes/ccflow-tui/` — Python/Textual 终端 UI（TUI 节点图管理器）
- `commands/` — cc 自定义 slash command Markdown 模板
- `client/` — React Web 前端（浏览器端节点图画布）

## 关键规则

- 永远用中文回复用户
- 管理 Python 包时永远使用 `uv`
- 如果 CCFlow 的核心工作流有更改（如 `/cclear`、`/diverge`、TUI 交互、架构变更），**必须同步更新 README.md**，确保文档与实现一致
