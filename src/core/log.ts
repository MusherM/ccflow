import fs from "node:fs";
import path from "node:path";

export function ccflowLogPath(repoRoot: string): string {
  return path.join(repoRoot, ".ccflow", "logs", "ccflow.log");
}

export function logEvent(repoRoot: string, event: string, details: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...details,
  });
  const file = ccflowLogPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}
