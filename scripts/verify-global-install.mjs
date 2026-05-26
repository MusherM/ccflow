import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccflow-install-"));
const cache = path.join(temp, "cache");
const pack = run("npm", ["pack", "--json", "--pack-destination", temp, "--cache", cache]);
const tarball = path.join(temp, JSON.parse(pack.stdout)[0].filename);
const prefix = path.join(temp, "prefix");

run("npm", ["install", "-g", "--prefix", prefix, "--cache", cache, tarball]);

const bin = process.platform === "win32"
  ? path.join(prefix, "ccflow.cmd")
  : path.join(prefix, "bin", "ccflow");

run(bin, ["--version"]);
run(bin, ["--help"]);

const repo = path.join(temp, "repo");
fs.mkdirSync(repo);
run(bin, ["init", "--git"], { cwd: repo });
run(bin, ["doctor"], { cwd: repo });

process.stdout.write(`Global install verification passed in ${temp}\n`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    process.stderr.write(`Command failed: ${command} ${args.join(" ")}\n`);
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result;
}
