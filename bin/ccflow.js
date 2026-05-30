#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path, { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(thisFile));
const entry = join(packageRoot, "dist", "main.js");
const windowsDefaultPathExt = [".COM", ".EXE", ".BAT", ".CMD"];

if (isMainModule()) {
  await main();
}

async function main() {
  if (!process.versions.bun && process.env.CCFLOW_BUN_BOOTSTRAP !== "0") {
    const bunCommand = resolveCommand("bun");
    if (bunCommand) {
      const result = spawnSync(bunCommand, [entry, ...process.argv.slice(2)], {
        env: { ...process.env, CCFLOW_BUN_BOOTSTRAP: "0" },
        stdio: "inherit",
      });

      if (!result.error) {
        if (result.signal) {
          process.kill(process.pid, result.signal);
        }
        process.exit(result.status ?? 1);
      }
    }
  }

  await import("../dist/main.js");
}

export function resolveCommand(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? ((candidate) => isExecutableFile(candidate, platform));
  const names = commandCandidateNames(command, env, platform);

  for (const dir of collectSearchPathEntries(env, platform)) {
    for (const name of names) {
      const candidate = joinCommandPath(dir, name, platform);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return null;
}

export function collectSearchPathEntries(env = process.env, platform = process.platform) {
  const values = Object.entries(env)
    .filter(([key, value]) => key.toLowerCase() === "path" && typeof value === "string")
    .map(([, value]) => value);
  const entries = [];
  for (const value of values) {
    for (const entry of splitSearchPath(value, platform)) {
      const normalized = normalizePathEntry(entry, env, platform);
      if (normalized) entries.push(normalized);
    }
  }
  return unique(entries);
}

export function splitSearchPath(value, platform = process.platform) {
  if (!value) return [];
  if (platform !== "win32") return value.split(path.delimiter).filter(Boolean);
  if (value.includes(";")) return value.split(";").filter(Boolean);
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("$")) {
    return value.split(":").filter(Boolean);
  }
  return [value];
}

export function normalizePathEntry(entry, env = process.env, platform = process.platform) {
  const trimmed = stripWrappingQuotes(expandEnvVars(entry.trim(), env));
  if (platform !== "win32") return trimmed;

  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const home = normalizePathEntry(env.USERPROFILE ?? env.HOME ?? "", env, platform);
    const relative = trimmed.slice(2).replaceAll("/", "\\");
    return relative ? path.win32.join(home, relative) : home;
  }

  const cygwin = trimmed.match(/^\/cygdrive\/([a-zA-Z])(?:\/(.*))?$/);
  if (cygwin) return windowsDrivePath(cygwin[1], cygwin[2] ?? "");

  const wsl = trimmed.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (wsl) return windowsDrivePath(wsl[1], wsl[2] ?? "");

  const mingw = trimmed.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (mingw) return windowsDrivePath(mingw[1], mingw[2] ?? "");

  return trimmed;
}

export function commandCandidateNames(command, env = process.env, platform = process.platform) {
  if (platform !== "win32" || path.win32.extname(command)) return [command];

  const pathExt = (env.PATHEXT ?? env.PathExt ?? "")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const extensions = pathExt.length > 0 ? pathExt : windowsDefaultPathExt;
  return unique([...extensions.map((extension) => `${command}${extension}`), command]);
}

function isExecutableFile(candidate, platform) {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile() && !stats.isSymbolicLink()) return false;
    if (platform === "win32") return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function joinCommandPath(dir, command, platform) {
  return platform === "win32" && looksLikeWindowsPath(dir)
    ? path.win32.join(dir, command)
    : path.join(dir, command);
}

function looksLikeWindowsPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}

function stripWrappingQuotes(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function expandEnvVars(value, env) {
  return value
    .replace(/%([^%]+)%/g, (match, name) => env[name] ?? env[name.toUpperCase()] ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
      const name = braced ?? bare;
      return env[name] ?? env[name.toUpperCase()] ?? match;
    });
}

function windowsDrivePath(drive, rest) {
  return `${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`;
}

function unique(values) {
  return [...new Set(values)];
}

export function isMainModule(scriptPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!scriptPath) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(scriptPath);
  } catch {
    return moduleUrl === pathToFileURL(path.resolve(scriptPath)).href;
  }
}
