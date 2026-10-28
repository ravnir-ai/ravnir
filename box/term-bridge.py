#!/usr/bin/env python3
"""Terminal bridge for Ravnir's Shell tab.

Runs a command on a new pseudo terminal and relays it over stdin and stdout,
so the server needs no native PTY module. It runs on the host for a bot
without a box, and inside the box (through `exec -i`) for a bot with one.

Input is framed: one type byte, a four-byte big-endian length, the payload.
Type 0 is keyboard input, type 1 is a resize ("COLS ROWS").
Output is the raw terminal stream.

usage: term-bridge.py COLS ROWS -- COMMAND [ARGS...]
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

INPUT = 0
RESIZE = 1


def set_size(fd, cols, rows):
    cols = max(2, min(500, cols))
    rows = max(2, min(300, rows))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        try:
            written = os.write(fd, data)
        except InterruptedError:
            continue
        data = data[written:]


def hang_up(pid):
    # Closing the tab hangs up the shell like closing a terminal window.
    # Jobs started with nohup, setsid or tmux keep running.
    for sig in (signal.SIGHUP, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            # pty.fork() can return in the parent before the child creates its
            # session. EOF can arrive in that gap: no process group yet, but
            # the child still needs to be stopped and reaped.
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
        deadline = time.time() + 2
        while time.time() < deadline:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                return
            time.sleep(0.05)


def main(argv):
    if len(argv) < 4 or argv[2] != "--":
        sys.stderr.write(__doc__.strip().splitlines()[-1] + "\n")
        return 2
    cols, rows, command = int(argv[0]), int(argv[1]), argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        try:
            set_size(0, cols, rows)
        except OSError:
            pass
        os.environ.setdefault("TERM", "xterm-256color")
        try:
            os.execvp(command[0], command)
        except OSError as error:
            sys.stderr.write(f"{command[0]}: {error.strerror}\n")
            os._exit(127)

    out = sys.stdout.fileno()
    pending = b""
    reading_input = True
    while True:
        watch = [master, 0] if reading_input else [master]
        try:
            ready, _, _ = select.select(watch, [], [])
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:  # Linux: the shell exited
                    break
                raise
            if not data:  # macOS: the shell exited
                break
            write_all(out, data)
        if reading_input and 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                reading_input = False
                hang_up(pid)
                break
            pending += chunk
            while len(pending) >= 5:
                kind = pending[0]
                size = struct.unpack(">I", pending[1:5])[0]
                if len(pending) < 5 + size:
                    break
                payload, pending = pending[5:5 + size], pending[5 + size:]
                if kind == INPUT:
                    write_all(master, payload)
                elif kind == RESIZE:
                    try:
                        new_cols, new_rows = (int(part) for part in payload.decode().split())
                        set_size(master, new_cols, new_rows)
                    except (ValueError, OSError):
                        pass

    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        return 0
    code = os.waitstatus_to_exitcode(status)
    return 128 - code if code < 0 else code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
