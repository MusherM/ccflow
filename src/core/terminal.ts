import type { WriteStream } from "node:tty";
import type { ReadStream } from "node:tty";

const childOwnedSignals: NodeJS.Signals[] = ["SIGINT"];

const terminalResetForChildProcess = [
  "\x1b[?25h",
  "\x1b[?1l",
  "\x1b>",
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1004l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?2004l",
  "\x1b[?2026l",
  "\x1b[?2027l",
  "\x1b[?2031l",
  "\x1b[>4;0m",
  "\x1b[=u",
].join("");

export function resetTerminalForChildProcess(output: WriteStream = process.stdout): void {
  if (!output.isTTY) return;
  output.write(terminalResetForChildProcess);
}

export function releaseStdinForChildProcess(input: ReadStream = process.stdin): void {
  input.removeAllListeners("data");
  if (input.setRawMode) input.setRawMode(false);
  input.pause();
}

export function drainTerminalInputBuffer(input: ReadStream = process.stdin): void {
  if (!input.isTTY) return;
  while (input.read() !== null) {}
}

export function ignoreProcessSignalsForChildProcess(
  signals: NodeJS.Signals[] = childOwnedSignals,
  options: { restoreExisting?: boolean } = {},
): () => void {
  const restoreExisting = options.restoreExisting ?? true;
  const listeners = signals.map((signal) => {
    const existing = process.rawListeners(signal);
    process.removeAllListeners(signal);
    const listener = () => {};
    process.on(signal, listener);
    return { signal, listener, existing };
  });
  let restored = false;

  return () => {
    if (restored) return;
    restored = true;
    for (const { signal, listener, existing } of listeners) {
      process.off(signal, listener);
      if (restoreExisting) {
        for (const existingListener of existing) {
          process.on(signal, existingListener);
        }
      }
    }
  };
}

export async function drainProcessSignalsForChildProcess(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function quarantineTerminalInput(
  options: { input?: ReadStream; durationMs?: number } = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  if (!input.isTTY) return;

  const durationMs = options.durationMs ?? Number(process.env.CCFLOW_TERMINAL_QUARANTINE_MS ?? "500");
  const previousRawMode = input.isRaw ?? false;
  const discard = () => {};

  input.on("data", discard);
  if (input.setRawMode) input.setRawMode(true);
  input.resume();

  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, durationMs)));

  input.off("data", discard);
  drainTerminalInputBuffer(input);
  if (input.setRawMode) input.setRawMode(previousRawMode);
  if (!previousRawMode) input.pause();
}
