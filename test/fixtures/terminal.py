"""Drive the real first-use terminal prompt for Unix CLI tests using Python's stdlib PTY."""
import errno
import os
import pty
import select
import signal
import sys
import time

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:-1])

output = b""
answered = False
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if not select.select([terminal], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        output += chunk
        if not answered and b"Existing private GitHub clone directory:" in output:
            os.write(terminal, sys.argv[-1].encode() + b"\n")
            answered = True
    else:
        os.kill(pid, signal.SIGTERM)
        raise TimeoutError("CLI prompt did not finish")
finally:
    os.close(terminal)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
