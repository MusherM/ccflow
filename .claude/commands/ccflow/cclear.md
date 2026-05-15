---
name: cclear
description: Save a CCFlow checkpoint of the current work and continue
category: CCFlow
tags: [ccflow, checkpoint]
args:
  - name: summary
    description: One-line summary for this checkpoint (optional — cc will auto-generate)
    required: false
---

You MUST execute the following steps when the user runs /cclear:

## Step 1: Generate a summary

If the user did not provide a summary, generate a concise one-line Chinese description (≤50 characters) that captures what was accomplished in this session so far.

## Step 2: Run the CCFlow command

Execute this Bash command EXACTLY, replacing `<summary>` with the summary from Step 1:

```bash
uv run --directory /Users/lixinyang/project/CCFlow/cmd/ccflow-cli ccflow cclear --summary "<summary>"
```

IMPORTANT: Do NOT modify the command path. Use it exactly as written.

## Step 3: Parse the response

The command outputs a single JSON line to stdout. Parse it.

If `ok` is true:
- Tell the user in Chinese: "CCFlow 已保存节点: <title> (commit: <commit>)"
- Example: "CCFlow 已保存节点: 实现用户认证模块 (commit: a3f2b1c)"

If `ok` is false:
- Tell the user: "CCFlow 保存失败: <error>"

## Step 4: Continue working

After reporting the result, continue your work normally. This is NOT a standard /clear — do NOT clear your conversation context. All previous context MUST be preserved.
