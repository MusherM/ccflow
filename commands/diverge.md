---
name: diverge
description: Create an exploration branch from the current work state
category: CCFlow
tags: [ccflow, branch]
args:
  - name: name
    description: A short name for the exploration branch
    required: true
  - name: summary
    description: Optional summary of what this branch explores
    required: false
---

You MUST execute the following steps when the user runs /diverge with a branch name.

## Step 1: Confirm branch name

Use the branch name provided by the user. If no name was given, ask the user to provide one.

## Step 2: Generate a summary

Generate a concise one-line Chinese description (≤50 characters) of what this exploration branch will investigate.

## Step 3: Run the CCFlow command

Replace `<name>` with the branch name and `<summary>` with the summary, then execute:

```bash
uv run --directory __CCFLOW_ROOT__/cmd/ccflow-cli ccflow diverge --name "<name>" --summary "<summary>"
```

IMPORTANT: Do NOT modify the command path. Use it exactly as written.

## Step 4: Parse the response

The command outputs a single JSON line. Parse it.

If `ok` is true:
- Tell the user in Chinese:
  "分支已创建: <name>"
  "工作树路径: <worktree_path>"
  If `terminal_opened` is true: "新终端已打开，在工作树中启动了 Claude Code。"
  If `terminal_opened` is false: "请在新终端中运行: cd <worktree_path> && cc"

If `ok` is false:
- Tell the user: "分叉创建失败: <error>"

## Step 5: Continue

Continue working normally in the current session. The exploration branch has been created as a sibling node — it shares the same parent as the current node but lives on a separate git worktree.
