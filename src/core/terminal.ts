import type { WriteStream } from "node:tty";
import type { ReadStream } from "node:tty";

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
  "\x1b[<u",
].join("");

export function resetTerminalForChildProcess(output: WriteStream = process.stdout): void {
  if (!output.isTTY) return;
  output.write(terminalResetForChildProcess);
}

export function releaseStdinForChildProcess(input: ReadStream = process.stdin): void {
  if (input.setRawMode) input.setRawMode(false);
  input.pause();
}
