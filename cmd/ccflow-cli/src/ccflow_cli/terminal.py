"""Cross-platform terminal opener.

Opens a new terminal window at the given working directory and optionally
runs a command. Falls back to printing instructions when no supported
terminal emulator is detected.
"""

from __future__ import annotations

import os
import platform
import shlex
import subprocess


def open_terminal(worktree_path: str, command: str = "cc") -> bool:
    """Open a new terminal at *worktree_path* and run *command*.

    Returns True if a terminal was launched, False if the user must
    open one manually.
    """
    system = platform.system()

    if system == "Darwin":
        return _macos_terminal(worktree_path, command)
    elif system == "Linux":
        return _linux_terminal(worktree_path, command)

    _print_manual(worktree_path, command)
    return False


def _macos_terminal(path: str, cmd: str) -> bool:
    escaped = shlex.quote(f"cd {shlex.quote(path)} && {cmd}")
    script = f'tell app "Terminal" to do script {escaped}'
    try:
        subprocess.run(["osascript", "-e", script], check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        _print_manual(path, cmd)
        return False


def _linux_terminal(path: str, cmd: str) -> bool:
    for emulator in ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"]:
        if subprocess.run(["which", emulator], capture_output=True).returncode == 0:
            if emulator == "gnome-terminal":
                subprocess.Popen(
                    [emulator, "--working-directory", path, "--", "bash", "-c", cmd],
                    start_new_session=True,
                )
                return True
            elif emulator == "konsole":
                subprocess.Popen(
                    [emulator, "--workdir", path, "--hold", "-e", "bash", "-c", cmd],
                    start_new_session=True,
                )
                return True
            elif emulator in ("xfce4-terminal", "xterm"):
                subprocess.Popen(
                    [emulator, "-e", f"cd {shlex.quote(path)} && {cmd}"],
                    start_new_session=True,
                )
                return True

    _print_manual(path, cmd)
    return False


def _print_manual(path: str, cmd: str) -> None:
    print(f"请在终端中手动运行:  cd {path} && {cmd}", file=os.sys.stderr)
