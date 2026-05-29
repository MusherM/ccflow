# CCFlow

[中文版](./README_zh.md)

<p align="center">
  <img src="./assets/ccflow-logo.png" alt="CCFlow logo" width="220">
</p>

CCFlow is a terminal workflow manager for Claude Code sessions, Git commits, and Git worktrees. It lets you move through a node graph of work, branch from prior commits, merge leaves, and resume Claude Code sessions from the right worktree.

![CCFlow project map](./assets/ccflow-intro.png)

## Requirements

- Node.js 22 or newer
- Git
- Bun on `PATH` for the OpenTUI runtime
- Claude Code CLI available as `claude`, or configured through CCFlow config

The package install runs an OpenTUI runtime check. Installation fails when neither Bun nor a Node.js build with `node:ffi` support can load `@opentui/core`.

## Install

CCFlow 0.1.0 is intended to be installed from the package tarball produced by this repository.

1. Install Bun first.

   macOS and Linux:

   ```bash
   curl -fsSL https://bun.com/install | bash
   bun --version
   ```

   You can also install Bun with Homebrew or another package manager as long as `bun` is available on `PATH`.

2. Clone the repository and install development dependencies.

   ```bash
   git clone https://github.com/lxy/ccflow.git
   cd ccflow
   npm install
   ```

3. Build the npm tarball.

   ```bash
   npm pack
   ```

   `npm pack` runs the package `prepack` script, builds `dist/`, and creates `ccflow-0.1.0.tgz` in the repository root.

4. Install the generated tarball globally.

   ```bash
   npm install -g ./ccflow-0.1.0.tgz
   ccflow --version
   ccflow doctor
   ```

   Re-run `npm pack` and the global tarball install after changing source code that should be reflected in the installed CLI.

## First Run

From an existing Git repository:

```bash
ccflow
```

On first launch, CCFlow resolves the owner Git repository, initializes repository-local runtime state in `.ccflow/`, and opens the TUI. `.ccflow/`, `.worktrees/`, and `.claude/` are internal runtime paths and should stay untracked.

If you prefer an explicit setup step:

```bash
ccflow init
ccflow
```

Outside a Git repository, `ccflow` will not silently run `git init`. To create a new Git repository and initialize CCFlow explicitly:

```bash
mkdir my-work
cd my-work
ccflow init --git
ccflow
```

Useful first-run checks:

```bash
ccflow doctor
ccflow config path
ccflow config show-effective
```

`ccflow doctor` checks Node.js, Git, the OpenTUI runtime, repository state, config validity, prompt config, and Claude Code CLI availability.

## Commands

```bash
ccflow [--repo <path>] [--no-auto-init] [--claude-bin <path>] [--model <name>]
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

`--no-auto-init` disables first-run repository initialization for that invocation. `--claude-bin` and `--model` override Claude Code settings for that invocation.

## Configuration

Runtime state lives in `.ccflow/`. Shared project configuration belongs in `<repo>/.ccflowrc`; machine-local project overrides belong in `<repo>/.ccflow/config.local.json`; user defaults belong in `~/.ccflowrc` or `$XDG_CONFIG_HOME/ccflow/config.json`.

Config files are JSON objects. Environment variables and CLI flags are converted into the same config shape, then merged into the effective config.

Effective precedence, from lowest to highest:

1. Built-in defaults
2. Legacy `<repo>/.ccflow/prompts.json`, if present
3. Shared project config: `<repo>/.ccflowrc`
4. User-global config: `~/.ccflowrc` or `$XDG_CONFIG_HOME/ccflow/config.json`
5. Repo-local config: `<repo>/.ccflow/config.local.json`
6. Environment variables
7. CLI flags

If `CCFLOW_CONFIG` is set, it becomes the user-global config path. Otherwise CCFlow uses `$XDG_CONFIG_HOME/ccflow/config.json` only when it exists and `~/.ccflowrc` does not; in all other cases it uses `~/.ccflowrc`.

Nested objects are merged field by field. Arrays replace the lower-precedence array. Setting a field to `null` resets that field to its built-in default.

Project-shared config can set safe workflow defaults, but local executable paths, restricted Claude Code arguments, and job-disabling settings must come from user-global config, repo-local config, environment variables, or CLI flags. In particular, `<repo>/.ccflowrc` cannot set:

- `claude.bin`
- `claude.headlessArgs`
- `claude.interactiveArgs`
- `claude.disableJobs`

Inspect config paths and the effective config with source attribution:

```bash
ccflow config path
ccflow config show-effective
```

Set user-global values from the CLI:

```bash
ccflow config set --global claude.model sonnet
ccflow config set --global prompts.commit.instructions '["Keep commits small.","Run npm test before committing."]'
```

## Config Reference

```json
{
  "claude": {
    "bin": "claude",
    "headlessArgs": [],
    "interactiveArgs": ["--dangerously-skip-permissions"],
    "model": "haiku",
    "disableJobs": false,
    "terminalQuarantineMs": 800
  },
  "startup": {
    "autoInit": true
  },
  "worktree": {
    "enterLeafAutoSwitch": true,
    "warnBeforeSwitch": false,
    "directory": ".worktrees",
    "branchPrefix": "ccflow/"
  },
  "merge": {
    "sealMergedInputs": true,
    "headlessResolution": true
  },
  "prompts": {
    "commit": {
      "instructions": [],
      "messageStyle": "concise conventional commits when appropriate",
      "testPreferences": []
    },
    "merge": {
      "instructions": [],
      "testPreferences": []
    }
  },
  "tests": {
    "commands": []
  }
}
```

Field meanings:

- `claude.bin`: executable used for interactive and headless Claude Code calls.
- `claude.headlessArgs`: extra arguments placed before `-p` for background commit and merge jobs.
- `claude.interactiveArgs`: arguments used when entering or resuming an interactive Claude Code session.
- `claude.model`: model name passed to headless Claude Code jobs.
- `claude.disableJobs`: disables background Claude Code jobs when `true`.
- `claude.terminalQuarantineMs`: delay after returning from interactive Claude Code before CCFlow redraws the TUI.
- `startup.autoInit`: allows `ccflow` to initialize `.ccflow/` automatically in an existing Git repository.
- `worktree.enterLeafAutoSwitch`: switches the shell/worktree context automatically when entering a leaf.
- `worktree.warnBeforeSwitch`: asks for confirmation before worktree switching when enabled.
- `worktree.directory`: directory used for CCFlow-managed worktrees.
- `worktree.branchPrefix`: prefix for generated CCFlow branches.
- `merge.sealMergedInputs`: seals merge input leaves after a successful merge.
- `merge.headlessResolution`: lets Claude Code attempt merge-conflict resolution in a background job.
- `prompts.commit.instructions`: additional commit-job guidance appended to the protected kernel prompt.
- `prompts.commit.messageStyle`: commit message style guidance.
- `prompts.commit.testPreferences`: commit-job testing preferences appended to the prompt.
- `prompts.merge.instructions`: additional merge-job guidance appended to the protected kernel prompt.
- `prompts.merge.testPreferences`: merge-job testing preferences appended to the prompt.
- `tests.commands`: known project check commands included in commit and merge job prompts.

Environment variable mapping:

| Environment variable | Config field |
| --- | --- |
| `CCFLOW_CONFIG` | user-global config file path |
| `CCFLOW_CLAUDE_BIN` | `claude.bin` |
| `CCFLOW_CLAUDE_ARGS` | `claude.headlessArgs` |
| `CCFLOW_CLAUDE_MODEL` | `claude.model` |
| `CCFLOW_DISABLE_CLAUDE_JOBS` | `claude.disableJobs` (`1` means `true`) |
| `CCFLOW_TERMINAL_QUARANTINE_MS` | `claude.terminalQuarantineMs` |
| `CCFLOW_BRANCH_PREFIX` | `worktree.branchPrefix` |
| `CCFLOW_WORKTREE_DIR` | `worktree.directory` |
| `CCFLOW_AUTO_INIT` | `startup.autoInit` (`0` means `false`) |

CLI override mapping:

| CLI flag | Config field |
| --- | --- |
| `--no-auto-init` | `startup.autoInit=false` |
| `--claude-bin <path>` | `claude.bin` |
| `--model <name>` | `claude.model` |

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
