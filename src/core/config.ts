import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PromptsConfig } from "./types.js";
import { promptsPath } from "./storage.js";

export type ConfigSourceKind = "defaults" | "legacy" | "repo-shared" | "user-global" | "repo-local" | "env" | "cli";

export interface ConfigSource {
  kind: ConfigSourceKind;
  label: string;
  path?: string;
}

export interface CcflowConfig {
  claude: {
    bin: string;
    headlessArgs: string[];
    interactiveArgs: string[];
    model: string;
    disableJobs: boolean;
    terminalQuarantineMs: number;
  };
  startup: {
    autoInit: boolean;
  };
  terminal: {
    multitab: boolean;
  };
  worktree: {
    enterLeafAutoSwitch: boolean;
    warnBeforeSwitch: boolean;
    directory: string;
    branchPrefix: string;
  };
  merge: {
    sealMergedInputs: boolean;
    headlessResolution: boolean;
  };
  prompts: {
    commit: {
      instructions: string[];
      messageStyle: string | null;
      testPreferences: string[];
    };
    merge: {
      instructions: string[];
      testPreferences: string[];
    };
  };
  tests: {
    commands: string[];
  };
}

export type PartialCcflowConfig = DeepPartial<CcflowConfig>;

export interface ConfigPaths {
  repoSharedPath?: string;
  repoLocalPath?: string;
  userGlobalPath: string;
  xdgGlobalPath: string;
}

export interface LoadedConfig {
  config: CcflowConfig;
  sources: Record<string, ConfigSource>;
  paths: ConfigPaths;
  files: ConfigSource[];
  legacyPromptPath?: string;
}

export class ConfigError extends Error {
  constructor(public readonly diagnostics: string[]) {
    super(diagnostics.join("\n"));
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]> | null
      : T[K] | null;
};

const defaultConfig: CcflowConfig = {
  claude: {
    bin: "claude",
    headlessArgs: [],
    interactiveArgs: ["--dangerously-skip-permissions"],
    model: "haiku",
    disableJobs: false,
    terminalQuarantineMs: 800,
  },
  startup: {
    autoInit: true,
  },
  terminal: {
    multitab: false,
  },
  worktree: {
    enterLeafAutoSwitch: true,
    warnBeforeSwitch: false,
    directory: ".worktrees",
    branchPrefix: "ccflow/",
  },
  merge: {
    sealMergedInputs: true,
    headlessResolution: true,
  },
  prompts: {
    commit: {
      instructions: [],
      messageStyle: "concise conventional commits when appropriate",
      testPreferences: [],
    },
    merge: {
      instructions: [],
      testPreferences: [],
    },
  },
  tests: {
    commands: [],
  },
};

const allowedSchema = {
  claude: {
    bin: "string",
    headlessArgs: "string[]",
    interactiveArgs: "string[]",
    model: "string",
    disableJobs: "boolean",
    terminalQuarantineMs: "number",
  },
  startup: {
    autoInit: "boolean",
  },
  terminal: {
    multitab: "boolean",
  },
  worktree: {
    enterLeafAutoSwitch: "boolean",
    warnBeforeSwitch: "boolean",
    directory: "string",
    branchPrefix: "string",
  },
  merge: {
    sealMergedInputs: "boolean",
    headlessResolution: "boolean",
  },
  prompts: {
    commit: {
      instructions: "string[]",
      messageStyle: "string|null",
      testPreferences: "string[]",
    },
    merge: {
      instructions: "string[]",
      testPreferences: "string[]",
    },
  },
  tests: {
    commands: "string[]",
  },
} as const;

const sharedRestrictedFields = new Set([
  "claude.bin",
  "claude.headlessArgs",
  "claude.interactiveArgs",
  "claude.disableJobs",
]);

export function defaultCcflowConfig(): CcflowConfig {
  return structuredClone(defaultConfig);
}

export function resolveConfigPaths(repoRoot?: string, env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const home = os.homedir();
  const xdgBase = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const homeGlobalPath = path.join(home, ".ccflowrc");
  const xdgGlobalPath = path.join(xdgBase, "ccflow", "config.json");
  const userGlobalPath = env.CCFLOW_CONFIG ?? (fs.existsSync(xdgGlobalPath) && !fs.existsSync(homeGlobalPath) ? xdgGlobalPath : homeGlobalPath);
  return {
    repoSharedPath: repoRoot ? path.join(repoRoot, ".ccflowrc") : undefined,
    repoLocalPath: repoRoot ? path.join(repoRoot, ".ccflow", "config.local.json") : undefined,
    userGlobalPath,
    xdgGlobalPath,
  };
}

export function loadConfig(input: {
  repoRoot?: string;
  cliOverrides?: PartialCcflowConfig;
  env?: NodeJS.ProcessEnv;
  includeLegacy?: boolean;
} = {}): LoadedConfig {
  const env = input.env ?? process.env;
  const paths = resolveConfigPaths(input.repoRoot, env);
  const config = defaultCcflowConfig();
  const sources: Record<string, ConfigSource> = {};
  seedDefaultSources(config, sources);
  const files: ConfigSource[] = [];

  const applySource = (source: ConfigSource, value: unknown): void => {
    const partial = validatePartialConfig(value, source);
    mergeConfig(config, partial, source, sources);
    files.push(source);
  };

  if (input.includeLegacy !== false && input.repoRoot) {
    const legacy = legacyPromptsToConfig(input.repoRoot);
    if (legacy) {
      mergeConfig(config, legacy.config, legacy.source, sources);
      files.push(legacy.source);
    }
  }

  if (paths.repoSharedPath && fs.existsSync(paths.repoSharedPath)) {
    applySource({ kind: "repo-shared", label: "repo shared config", path: paths.repoSharedPath }, readJson(paths.repoSharedPath));
  }
  if (fs.existsSync(paths.userGlobalPath)) {
    applySource({ kind: "user-global", label: "user global config", path: paths.userGlobalPath }, readJson(paths.userGlobalPath));
  }
  if (paths.repoLocalPath && fs.existsSync(paths.repoLocalPath)) {
    applySource({ kind: "repo-local", label: "repo local config", path: paths.repoLocalPath }, readJson(paths.repoLocalPath));
  }

  const envConfig = envToConfig(env);
  if (envConfig) mergeConfig(config, envConfig, { kind: "env", label: "environment" }, sources);

  if (input.cliOverrides) {
    const source = { kind: "cli" as const, label: "CLI flags" };
    const partial = validatePartialConfig(input.cliOverrides, source);
    mergeConfig(config, partial, source, sources);
  }

  return {
    config,
    sources,
    paths,
    files,
    legacyPromptPath: input.repoRoot && fs.existsSync(promptsPath(input.repoRoot)) ? promptsPath(input.repoRoot) : undefined,
  };
}

export function setUserGlobalConfigValue(fieldPath: string, rawValue: string, env: NodeJS.ProcessEnv = process.env): string {
  const paths = resolveConfigPaths(undefined, env);
  const file = paths.userGlobalPath;
  const existing = fs.existsSync(file) ? readJson(file) : {};
  const value = parseConfigValue(rawValue);
  setByPath(existing, fieldPath, value);
  validatePartialConfig(existing, { kind: "user-global", label: "user global config", path: file });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  return file;
}

export function redactEffectiveConfig(loaded: LoadedConfig): unknown {
  const redacted = structuredClone(loaded.config) as unknown as Record<string, unknown>;
  const claude = redacted.claude as Record<string, unknown>;
  if (claude.bin && loaded.sources["claude.bin"]?.kind !== "defaults") claude.bin = "<configured>";
  return redacted;
}

export function configWithSources(loaded: LoadedConfig): unknown {
  return {
    config: redactEffectiveConfig(loaded),
    sources: Object.fromEntries(
      Object.entries(loaded.sources).map(([field, source]) => [
        field,
        source.path ? `${source.label}: ${source.path}` : source.label,
      ]),
    ),
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError([`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`]);
  }
}

function validatePartialConfig(value: unknown, source: ConfigSource): PartialCcflowConfig {
  if (!isPlainObject(value)) throw new ConfigError([`${sourceLabel(source)}: config must be a JSON object`]);
  const diagnostics: string[] = [];
  validateObject(value, allowedSchema, [], source, diagnostics);
  if (diagnostics.length > 0) throw new ConfigError(diagnostics);
  return value as PartialCcflowConfig;
}

function validateObject(value: Record<string, unknown>, schema: unknown, pathParts: string[], source: ConfigSource, diagnostics: string[]): void {
  if (!isPlainObject(schema)) return;
  const schemaObject = schema as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    const field = nextPath.join(".");
    const expected = schemaObject[key];
    if (expected === undefined) {
      if (/^prompts\.(commit|merge)\.(prompt|system)$/.test(field)) {
        diagnostics.push(`${sourceLabel(source)}: ${field} is a full prompt replacement; use additive prompt instructions instead`);
      } else {
        diagnostics.push(`${sourceLabel(source)}: unknown config field ${field}`);
      }
      continue;
    }
    if (source.kind === "repo-shared" && sharedRestrictedFields.has(field)) {
      diagnostics.push(`${sourceLabel(source)}: ${field} can only be set by user-global, repo-local, env, or CLI sources`);
      continue;
    }
    if (isPlainObject(expected)) {
      if (child === null) continue;
      if (!isPlainObject(child)) {
        diagnostics.push(`${sourceLabel(source)}: ${field} must be an object`);
        continue;
      }
      validateObject(child, expected, nextPath, source, diagnostics);
      continue;
    }
    validateLeaf(child, String(expected), field, source, diagnostics);
  }
}

function validateLeaf(value: unknown, expected: string, field: string, source: ConfigSource, diagnostics: string[]): void {
  if (value === null && expected.endsWith("|null")) return;
  if (expected === "string" && typeof value === "string") return;
  if (expected === "boolean" && typeof value === "boolean") return;
  if (expected === "number" && typeof value === "number" && Number.isFinite(value)) return;
  if (expected === "string|null" && typeof value === "string") return;
  if (expected === "string[]" && Array.isArray(value) && value.every((item) => typeof item === "string")) return;
  diagnostics.push(`${sourceLabel(source)}: ${field} must be ${expected}`);
}

function mergeConfig(target: unknown, patch: PartialCcflowConfig, source: ConfigSource, sources: Record<string, ConfigSource>, prefix = ""): void {
  for (const [key, value] of Object.entries(patch)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) continue;
    const targetRecord = target as unknown as Record<string, unknown>;
    if (value === null) {
      targetRecord[key] = getDefaultAtPath(field);
      sources[field] = source;
      continue;
    }
    if (Array.isArray(value)) {
      targetRecord[key] = [...value];
      sources[field] = source;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(targetRecord[key])) {
      mergeConfig(targetRecord[key], value as PartialCcflowConfig, source, sources, field);
      continue;
    }
    targetRecord[key] = value;
    sources[field] = source;
  }
}

function seedDefaultSources(value: unknown, sources: Record<string, ConfigSource>, prefix = ""): void {
  const source = { kind: "defaults" as const, label: "built-in defaults" };
  if (Array.isArray(value) || !isPlainObject(value)) {
    if (prefix) sources[prefix] = source;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    seedDefaultSources(child, sources, prefix ? `${prefix}.${key}` : key);
  }
}

function legacyPromptsToConfig(repoRoot: string): { config: PartialCcflowConfig; source: ConfigSource } | null {
  const file = promptsPath(repoRoot);
  if (!fs.existsSync(file)) return null;
  const parsed = readJson(file) as PromptsConfig;
  const commitInstructions = [parsed.commit?.system, parsed.commit?.prompt].filter((value): value is string => Boolean(value?.trim()));
  const mergeInstructions = [parsed.merge?.system, parsed.merge?.prompt].filter((value): value is string => Boolean(value?.trim()));
  return {
    source: { kind: "legacy", label: "legacy prompts", path: file },
    config: {
      prompts: {
        commit: { instructions: commitInstructions },
        merge: { instructions: mergeInstructions },
      },
    },
  };
}

function envToConfig(env: NodeJS.ProcessEnv): PartialCcflowConfig | null {
  const config: PartialCcflowConfig = {};
  if (env.CCFLOW_CLAUDE_BIN) config.claude = { ...(config.claude ?? {}), bin: env.CCFLOW_CLAUDE_BIN };
  if (env.CCFLOW_CLAUDE_ARGS) config.claude = { ...(config.claude ?? {}), headlessArgs: splitShellWords(env.CCFLOW_CLAUDE_ARGS) };
  if (env.CCFLOW_CLAUDE_MODEL) config.claude = { ...(config.claude ?? {}), model: env.CCFLOW_CLAUDE_MODEL };
  if (env.CCFLOW_DISABLE_CLAUDE_JOBS) config.claude = { ...(config.claude ?? {}), disableJobs: env.CCFLOW_DISABLE_CLAUDE_JOBS === "1" };
  if (env.CCFLOW_TERMINAL_QUARANTINE_MS) config.claude = { ...(config.claude ?? {}), terminalQuarantineMs: Number(env.CCFLOW_TERMINAL_QUARANTINE_MS) };
  if (env.CCFLOW_MULTITAB) config.terminal = { multitab: env.CCFLOW_MULTITAB === "1" };
  if (env.CCFLOW_BRANCH_PREFIX) config.worktree = { ...(config.worktree ?? {}), branchPrefix: env.CCFLOW_BRANCH_PREFIX };
  if (env.CCFLOW_WORKTREE_DIR) config.worktree = { ...(config.worktree ?? {}), directory: env.CCFLOW_WORKTREE_DIR };
  if (env.CCFLOW_AUTO_INIT) config.startup = { autoInit: env.CCFLOW_AUTO_INIT !== "0" };
  return Object.keys(config).length > 0 ? config : null;
}

function getDefaultAtPath(field: string): unknown {
  return field.split(".").reduce((current: unknown, key) => (current as Record<string, unknown>)[key], defaultConfig);
}

function setByPath(target: unknown, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split(".").filter(Boolean);
  if (parts.length === 0) throw new ConfigError(["field path cannot be empty"]);
  let current = target as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
  }
}

function sourceLabel(source: ConfigSource): string {
  return source.path ? `${source.path}` : source.label;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}
