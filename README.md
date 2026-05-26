# CCFlow

CCFlow is a terminal workflow manager for Claude Code sessions, Git commits, and Git worktrees. It lets you move through a node graph of work, branch from prior commits, merge leaves, and resume Claude Code sessions from the right worktree.

## Install

```bash
npm i -g @lxy/ccflow
```

CCFlow requires Node.js 22 or newer, Git, and the Claude Code CLI available as `claude` or configured through CCFlow config.

## First Run

From an existing Git repository:

```bash
ccflow
```

On first launch, CCFlow initializes repository-local runtime state in `.ccflow/` and opens the TUI. If you prefer an explicit setup step:

```bash
ccflow init
ccflow
```

Outside a Git repository, `ccflow` will not silently run `git init`. To create a new Git repository and initialize CCFlow explicitly:

```bash
ccflow init --git
```

## Commands

```bash
ccflow [--repo <path>] [--no-auto-init]
ccflow init [path] [--git] [--force]
ccflow doctor [--repo <path>]
ccflow config path [--repo <path>]
ccflow config show-effective [--repo <path>]
ccflow config set --global <field> <value>
ccflow config prompt <commit|merge> [--repo <path>]
ccflow --help
ccflow --version
```

`--repo` lets you run CCFlow from anywhere while targeting a specific repository. Running from nested directories or CCFlow-managed worktrees resolves back to the owner repository state instead of creating a separate project.

## Configuration

Runtime state lives in `.ccflow/` and should stay untracked. Shared project configuration belongs in `.ccflowrc`; machine-local project overrides belong in `.ccflow/config.local.json`; user defaults belong in `~/.ccflowrc` or `$XDG_CONFIG_HOME/ccflow/config.json`.

Effective precedence, from lowest to highest:

1. Built-in defaults
2. `<repo>/.ccflowrc`
3. `~/.ccflowrc` or `$XDG_CONFIG_HOME/ccflow/config.json`
4. `<repo>/.ccflow/config.local.json`
5. Environment variables and CLI flags

Project-shared config can set safe workflow defaults, but local executable paths, secrets, and restricted Claude Code arguments must come from user-global config, repo-local config, environment variables, or CLI flags.

## Prompt Customization

CCFlow keeps non-overridable kernel instructions for commit and merge jobs. Those instructions protect the workflow contract: commit jobs must leave the worktree clean or clean with nothing to commit, and merge jobs must resolve conflicts and create a merge commit when possible or preserve conflicts for interactive takeover.

Users and projects can add guidance through additive fields such as commit instructions, merge instructions, commit message style, and test preferences. Full prompt replacement is rejected by default.

Inspect the effective prompt without launching Claude Code:

```bash
ccflow config prompt commit
ccflow config prompt merge
```

## Release Verification

Before publishing:

```bash
npm run verify:release
```

This builds runtime artifacts, runs tests, checks package contents, installs the generated tarball into an isolated global prefix, and verifies the installed `ccflow` command.
