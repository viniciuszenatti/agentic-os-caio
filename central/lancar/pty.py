"""Roda um comando num pseudo-terminal e devolve no stdout o que ele imprimiu.

O `claude --cloud` só roda com terminal interativo; a Central chama este helper
por argv (nunca por shell): python3 -I pty.py <segundos> -- claude --cloud "<prompt>"
A sessão continua na nuvem quando o processo local termina.
"""
import os, pty, sys, time, select, signal, fcntl, termios, struct

secs = float(sys.argv[1])
cmd = sys.argv[sys.argv.index('--') + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
buf = b''
fim = time.time() + secs
while time.time() < fim:
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try:
            pedaco = os.read(fd, 65536)
        except OSError:
            break
        if not pedaco:
            break
        buf += pedaco
        # basta a linha de teleport: a sessão já existe na nuvem
        if b'Resume with:' in buf or b'requires an interactive terminal' in buf:
            time.sleep(0.5)
            break
    if os.waitpid(pid, os.WNOHANG)[0]:
        break
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
sys.stdout.buffer.write(buf)
