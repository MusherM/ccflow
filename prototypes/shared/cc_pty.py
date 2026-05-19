#!/usr/bin/env python3
"""Run the user's real cc command inside a PTY until Esc returns to the prototype."""

from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import shutil
import signal
import struct
import sys
import termios
import tty

ESCAPE_PASSTHROUGH_PREFIXES = (b"\x1b[", b"\x1bO", b"\x1b]", b"\x1bP", b"\x1b^", b"\x1b_")


def _resize(fd: int) -> None:
    size = shutil.get_terminal_size((120, 36))
    packed = struct.pack("HHHH", size.lines, size.columns, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _is_return_escape(data: bytes) -> bool:
    if data == b"\x1b[27u" or (data.startswith(b"\x1b[27;") and data.endswith(b"u")):
        return True
    return data.startswith(b"\x1b") and not data.startswith(ESCAPE_PASSTHROUGH_PREFIXES)


def _read_escape_or_sequence(stdin_fd: int, data: bytes) -> bytes:
    if data != b"\x1b":
        return data

    ready, _, _ = select.select([stdin_fd], [], [], 0.05)
    if not ready:
        return data
    return data + os.read(stdin_fd, 4096)


def _request_child_exit(child_pid: int) -> None:
    try:
        os.killpg(os.getpgid(child_pid), signal.SIGHUP)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(child_pid, signal.SIGHUP)
        except ProcessLookupError:
            pass


def main() -> int:
    command = os.environ.get("CCFLOW_CC_CMD", "cc")
    shell = os.environ.get("SHELL", "/bin/zsh")
    stdin_fd = sys.stdin.fileno()
    old_attrs = termios.tcgetattr(stdin_fd)
    child_pid = -1
    child_fd = -1

    try:
        sys.stdout.write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H")
        sys.stdout.flush()

        child_pid, child_fd = pty.fork()
        if child_pid == 0:
            if os.environ.get("TERM") in (None, "", "dumb"):
                os.environ["TERM"] = "xterm-256color"
            os.environ.setdefault("COLORTERM", "truecolor")
            os.execvpe(shell, [shell, "-lic", command], os.environ)

        _resize(child_fd)

        def handle_resize(_signum, _frame):
            if child_fd >= 0:
                _resize(child_fd)

        signal.signal(signal.SIGWINCH, handle_resize)
        tty.setraw(stdin_fd)

        while True:
            try:
                ready, _, _ = select.select([stdin_fd, child_fd], [], [])
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                raise

            if stdin_fd in ready:
                data = os.read(stdin_fd, 4096)
                if not data:
                    break
                data = _read_escape_or_sequence(stdin_fd, data)
                if _is_return_escape(data):
                    _request_child_exit(child_pid)
                    break
                os.write(child_fd, data)

            if child_fd in ready:
                try:
                    data = os.read(child_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)

    finally:
        termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_attrs)
        if child_fd >= 0:
            try:
                os.close(child_fd)
            except OSError:
                pass
        if child_pid > 0:
            try:
                os.waitpid(child_pid, os.WNOHANG)
            except ChildProcessError:
                pass
        sys.stdout.write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
