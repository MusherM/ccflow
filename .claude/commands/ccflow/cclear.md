---
name: cclear
description: Save a CCFlow checkpoint of the current work and clear context
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

## Step 2: Generate a Google-style commit message via Haiku

Use the Agent tool with `model="haiku"` to generate a proper Google-style commit message. The agent prompt should be:

```
Generate a Google-style conventional commit message for the following changes. 
Context summary: <summary from Step 1>

Rules:
- Subject line: ≤50 chars, imperative mood, use conventional commit prefixes (feat/fix/refactor/docs/chore/test)
- Blank line after subject
- Body: 2-5 bullet points explaining WHAT changed and WHY
- Blank line after body
- Footer: "CCFlow: checkpoint"

Output ONLY the commit message, no other text.
```

Save the generated commit message to `/tmp/ccflow-commit-msg.txt`. Verify the file exists and has content.

## Step 3: Run the CCFlow command

Execute this Bash command EXACTLY:

```bash
uv run --directory /Users/lixinyang/project/CCFlow/cmd/ccflow-cli ccflow cclear --summary-file /tmp/ccflow-commit-msg.txt
```

IMPORTANT: Do NOT modify the command path. Use it exactly as written.

## Step 4: Parse the response

The command outputs a single JSON line to stdout. Parse it.

If `ok` is true:
- Tell the user in Chinese: "CCFlow 已保存节点: <title> (commit: <commit>)"
- Example: "CCFlow 已保存节点: feat: add user authentication (commit: a3f2b1c)"

If `ok` is false:
- Tell the user: "CCFlow 保存失败: <error>"

## Step 5: Clear context and start fresh

After reporting the result, you MUST treat this as a fresh conversation start. The checkpoint has been saved to git — all prior work is safely stored and can be resumed via the TUI.

- Do NOT reference or recall any details from before this cclear call.
- If the user asks about prior work, check git log or the CCFlow TUI rather than relying on conversation memory.
- Respond as if this is the beginning of a new session.
