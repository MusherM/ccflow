# CCFlow

CCFlow 是 Claude Code 的工作流管理工具。它在不侵入 cc 原生体验的前提下，提供会话节点图可视化、分叉探索、跨分支合并等能力。

## 架构

```
用户 → cc (Claude Code CLI)          ← 日常工作入口
         │  /cclear  /diverge
         ▼
     ccflow CLI (Python)              ← 桥接层，cc 通过 Bash tool 调用
         │  REST API (127.0.0.1:4389)
         ▼
     ccflow Server (Node.js)          ← git 操作、SQLite 状态管理
         │
         ├── git worktree            ← 分叉探索的独立工作副本
         ├── SQLite (~/.ccflow)      ← 节点/项目持久化
         └── tmux bridge             ← 终端会话管理

     ccflow TUI (Python/Textual)      ← 节点图可视化 & 交互合并
         └── 读取同一 Server 的 REST API
```

## 组件

| 组件 | 路径 | 技术 | 职责 |
|------|------|------|------|
| Server | `server/` | Node.js + Express + SQLite | REST API、git worktree/merge/snapshot、tmux 终端桥接 |
| CLI | `cmd/ccflow-cli/` | Python | cc 通过 Bash tool 调用的子命令（cclear、diverge、init） |
| TUI | `tui/` | Python + Textual | 终端内的 DAG 节点图可视化和交互管理 |
| Commands | `commands/` | Markdown | cc 自定义 slash command 模板（cclear.md、diverge.md） |

## 快速开始

### 1. 启动 Server

```bash
npm install
npm run dev:server
```

### 2. 初始化项目

```bash
cd /path/to/your-project
uv run --directory /path/to/CCFlow/cmd/ccflow-cli ccflow init
```

这会在你的项目中：
- 确保 CCFlow Server 在后台运行
- 在 Server 中注册项目（创建根节点）
- 安装 `.claude/commands/ccflow/cclear.md` 和 `diverge.md`

### 3. 在 cc 中使用

当你在已初始化的项目中启动 cc 后，可以直接使用：

```
/cclear              → checkpoint：保存当前状态（git commit）并继续工作
/cclear 实现了登录   → 自定义 summary
/diverge explore-oauth    → 从当前节点分叉，创建独立 worktree + 新终端
```

**`/cclear` 行为**（不是 `/clear`！）：
- git add -A && git commit（隐式，标题取自 summary）
- 在节点图中创建向后连接的新节点
- 不清除 cc 的会话上下文
- 通过 cc 弹通知告知完成

**`/diverge <name>` 行为**：
- git commit 当前状态
- 从当前节点的**父节点** commit 创建 git worktree
- 创建与当前节点平级的新探索节点
- 自动打开新终端并在 worktree 中启动 cc

### 4. 启动 TUI

```bash
uv run --directory /path/to/CCFlow/cmd/ccflow-cli ccflow tui
```

也可以用快捷键操作：
- `↑↓` / `j k` — 移动焦点
- `Space` — 选中/取消节点
- `Shift+Click` — 追加选择
- `D` — 从焦点节点分叉
- `M` — 合并已选节点（需要 ≥2 个不同分支）
- `C` — 继续焦点节点的会话
- `Enter` — 检视节点详情
- `R` — 刷新 graph
- `Q` — 退出

## 数据存储

所有 CCFlow 数据在 `~/.ccflow/` 下：
- `ccflow.sqlite` — 项目和节点状态
- `worktrees/<projectId>/<nodeId>/` — git worktree 工作副本
- `transcripts/` — 会话转录
- `summaries/` — 上下文摘要

## 关键设计原则

1. **零侵入**：不启用 CCFlow 功能时，cc 体验与原生完全一致
2. **隐式 git 管理**：commit/worktree/merge 操作对用户透明，通过 cc 通知反馈
3. **节点即会话**：每个会话阶段都是一个节点，/cclear 和 /diverge 自然产生图结构
4. **平级分叉**：diverge 创建与当前节点共享父节点的**兄弟**节点，不是子节点
