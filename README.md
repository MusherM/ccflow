# CCFlow

CCFlow 是面向 Claude Code 的节点式会话和 Git 工作流管理器。当前实现已经切到 TypeScript + OpenTUI：主程序直接读取当前仓库的 `.ccflow/` JSON 状态，不再依赖旧的 Python TUI/CLI 或 Node REST server。

## 当前能力

- 初始化 `.ccflow/ccflow.json`、`.ccflow/prompts.json`、`.ccflow/sessions/`、`.ccflow/jobs/`
- 在 OpenTUI 节点图中展示 leaf/internal、commit、worktree、Claude session 状态
- 叶子节点 `Enter` 进入 Claude Code；非叶子节点 `Enter` 只显示只读详情
- 叶子节点中直接启动 Claude Code；Claude 退出后回到节点图，并保存可恢复 session 信息
- `Tab` 从 leaf 向后创建下一个节点：dirty 时启动独立 Claude Code commit job，再冻结父节点
- `Shift+Tab` 从当前节点的父节点创建同级 leaf
- `Space` 多选 leaf，`m` 启动 Claude Code merge job 并创建 merge leaf
- `s` 显式切换 CCFlow 当前 worktree，UI 用绿色/黄色区分当前和其他 worktree
- `d` 删除 leaf，并将对应 worktree `git reset --hard` 回父节点 commit
- commit / merge / delete 等长任务会在节点管理界面显示进行状态
- commit/merge prompt 均来自 `.ccflow/prompts.json`

## 目录结构

```text
src/
  main.ts          # 程序入口
  tui.ts           # OpenTUI 节点图和键盘交互
  core/
    graph.ts       # 节点 DAG 和 spec 不变量
    storage.ts     # .ccflow JSON 持久化
    git.ts         # Git/worktree adapter
    claude.ts      # Claude Code adapter
    jobs.ts        # commit/merge job runner
    prompts.ts     # 默认 prompts.json
    types.ts       # 数据模型
tests/
  core.test.ts     # spec-first 核心回归测试
prototypes/
  opentui-node-view/ # 保留的 OpenTUI 交互原型
  ink-node-view/     # 旧 Ink 原型，仅作对照
```

## 使用

```bash
npm install
npm run dev -- /path/to/repo
```

不传路径时默认使用当前目录。OpenTUI 运行时需要 Bun，`npm run dev` 会通过 `bun run src/main.ts` 启动。首次运行会创建 `.ccflow/`，并确保目标目录是 Git 仓库。

## 快捷键

| 按键 | 行为 |
| --- | --- |
| `↑ / ↓ / ← / →` 或 `h/j/k/l` | 在节点间移动 |
| `Enter` | leaf 进入 Claude；internal 进入详情 |
| `Esc` | 详情返回图；图中清空选择；Claude 中原样发送给 Claude Code |
| `Tab` | 从当前 leaf 创建下一个节点 |
| `Shift+Tab` | 创建同级 leaf |
| `Space` | 多选 leaf |
| `m` | 合并已选 leaf |
| `s` | 切换当前 worktree |
| `d` | 删除当前 leaf 并 reset 到父节点 commit |
| `q` | 退出 |

进入 Claude Code 后，CCFlow 不再监听快捷键；使用 Claude Code 自身退出方式（如 `/exit` 或 `Ctrl+D`）回到节点图。

## 验证

```bash
npm test
npm run typecheck
npm run proto:typecheck
```

默认测试会调用真实 Claude Code 来验证 commit job：测试在临时 Git 仓库中直接修改 `README.md`，再通过创建下一个 leaf 或 OpenTUI `Tab` 触发 ccflow commit job；commit 必须由真实 `claude -p` 完成。默认使用 `claude`，也可以指定：

```bash
CCFLOW_CLAUDE_BIN=/path/to/claude npm test
```

测试默认给 Claude Code 传入 `--permission-mode bypassPermissions --max-budget-usd 1`；需要覆盖时可设置 `CCFLOW_CLAUDE_ARGS`。

## 日志

运行时日志写入目标仓库：

```bash
tail -f /path/to/repo/.ccflow/logs/ccflow.log
```

`proto:opentui` 仍然保留为交互原型入口：

```bash
npm run proto:opentui
```

## 设计不变量

1. 会话即节点。
2. 只有 leaf 节点可继续工作。
3. internal 节点是历史快照，只读且不可恢复 Claude session。
4. 创建下一个节点会先 commit 父节点并保存父节点 session。
5. CCFlow 不拦截 Claude Code 内部键盘输入；从 Claude 回图依赖 Claude Code 自身退出。
6. CCFlow 重启后优先用 `claude --resume <session_id>`。
7. worktree 是文件状态载体，当前 worktree 必须在 UI 中显式展示。
8. merge 只接受 leaf，merge 前所有 leaf 必须有 commit。
9. commit/merge job 使用独立 Claude Code 进程。
10. prompt 配置化，不能写死在业务流程里。
