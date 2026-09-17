import os,pty,time,select,fcntl,termios,struct,signal,subprocess,glob
D=os.path.expanduser("~/.claude/projects/-home-quantumvik-WorkPersonal-claude-view")
before=set(glob.glob(D+"/*.jsonl"))
pid,fd=pty.fork()
if pid==0:
    for k in [k for k in os.environ if k.startswith("CLAUDECODE") or k.startswith("CLAUDE_CODE") or k in ("CLAUDE_PID","CLAUDE_EFFORT")]:
        os.environ.pop(k, None)
    os.environ["TERM"]="xterm-256color"; os.environ["COLORTERM"]="truecolor"
    os.chdir("/home/quantumvik/WorkPersonal/claude-view")
    os.execvp("claude",["claude","--dangerously-skip-permissions","--model","haiku"])
    os._exit(127)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",34,120,0,0))
t0=time.time(); out=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"e13_pty.bin"),"wb")
def pump(dl):
    while time.time()<dl:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: d=os.read(fd,65536)
            except OSError: return
            if not d: return
            out.write(d); out.flush()
def snap(tag):
    now=set(glob.glob(D+"/*.jsonl"))
    new=[os.path.basename(p) for p in now-before]
    print("%-28s t=%5.1f new_jsonl=%s" % (tag,time.time()-t0,new or "NONE"))
pump(t0+7)
os.write(fd,b"Reply with just the word OK. Do not use any tools.")
pump(time.time()+1); os.write(fd,b"\r")
for i in range(6):
    pump(time.time()+5); snap("during-session +%ds"%((i+1)*5))
os.write(fd,b"/exit\r")
print("--- sent /exit ---")
for i in range(6):
    pump(time.time()+2); snap("after-/exit +%ds"%((i+1)*2))
try: os.kill(pid,signal.SIGKILL)
except: pass
time.sleep(1); snap("after-kill")
