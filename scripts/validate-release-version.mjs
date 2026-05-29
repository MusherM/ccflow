import fs from "node:fs";
import { spawnSync } from "node:child_process";

const registry = process.env.npm_config_registry ?? "https://registry.npmjs.org";
const refName = process.env.GITHUB_REF_NAME;
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = parseVersion(pkg.version);

if (!version) {
  fail(`package.json version ${JSON.stringify(pkg.version)} is not a formal X.Y.Z version.`);
}

if (refName && refName !== `v${pkg.version}`) {
  fail(`Tag ${refName} does not match package.json version ${pkg.version}.`);
}

const published = readPublishedVersions(pkg.name);
const highest = published
  .map(parseVersion)
  .filter(Boolean)
  .sort(compareVersions)
  .at(-1);

if (highest && compareVersions(version, highest) <= 0) {
  fail(`Release version ${pkg.version} must be greater than the highest published version ${formatVersion(highest)}.`);
}

process.stdout.write(
  highest
    ? `Release version ${pkg.version} is greater than published version ${formatVersion(highest)}.\n`
    : `Release version ${pkg.version} is the first published version for ${pkg.name}.\n`,
);

function readPublishedVersions(name) {
  const result = spawnSync("npm", ["view", name, "versions", "--json", `--registry=${registry}`], {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/E404|404 Not Found|is not in this registry/.test(output)) return [];
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}

function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(raw));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
