#!/usr/bin/env python3
"""Capture raw PTY bytes from an interactive `claude`, mimicking claude-view's
spawn (portable-pty, 120x34, TERM=xterm-256color, COLORTERM=truecolor).

Usage: ptycap.py <outprefix> <seconds> <prompt...>
Writes <outprefix>.bin   : raw concatenated master bytes
       <outprefix>.frames: one line per read: "<t_rel> <nbytes> <hex>"
"""
import os, pty, sys, time, select, fcntl, termios, struct, signal, subprocess

out = sys.argv[1]
dur = float(sys.argv[2])
prompt = " ".join(sys.argv[3:])

pid, fd = pty.fork()
if pid == 0:
    for k in [k for k in os.environ if k.startswith("CLAUDECODE") or k.startswith("CLAUDE_CODE") or k in ("CLAUDE_PID","CLAUDE_EFFORT")]:
        os.environ.pop(k, None)
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    os.environ["CLAUDE_VIEW_ID"] = "ptycap-research"
    os.chdir(os.environ.get("PTYCAP_CWD", os.getcwd()))
    os.execvp("claude", ["claude", "--dangerously-skip-permissions", "--model", "haiku"] + os.environ.get("PTYCAP_EXTRA","").split())
    os._exit(127)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 120, 0, 0))

binf = open(out + ".bin", "wb")
frf = open(out + ".frames", "w")
t0 = time.time()
sent = False
last_activity = t0

def pump(deadline):
    global last_activity
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        t = time.time() - t0
        binf.write(data); binf.flush()
        frf.write("%.4f %d %s\n" % (t, len(data), data.hex())); frf.flush()
        last_activity = time.time()
    return True

# let the TUI boot
pump(t0 + 6.0)
# type the prompt, then Enter (separately, like a human)
os.write(fd, prompt.encode())
frf.write("# SENT_PROMPT %.4f\n" % (time.time() - t0)); frf.flush()
pump(time.time() + 1.0)
os.write(fd, b"\r")
frf.write("# SENT_ENTER %.4f\n" % (time.time() - t0)); frf.flush()
pump(t0 + dur)
frf.write("# DONE %.4f\n" % (time.time() - t0))
try:
    os.kill(pid, signal.SIGKILL)
except Exception:
    pass
binf.close(); frf.close()
print("captured", os.path.getsize(out + ".bin"), "bytes")
