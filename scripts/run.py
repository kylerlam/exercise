"""Start an independent, persistent local Exercise process without installing anything."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
PORT = int(os.environ.get('PORT', '4186'))
URL = f'http://127.0.0.1:{PORT}'


def health():
    try:
        with urlopen(URL + '/api/health', timeout=1) as response:
            data = json.load(response)
        if (isinstance(data, dict) and data.get('app') == 'exercise' and data.get('status') == 'ok'
                and type(data.get('pid')) is int and data['pid'] > 0):
            return data
        return None
    except (URLError, OSError, ValueError, RecursionError):
        return None


def read_pid(path):
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def manage(action):
    state = health()
    # Preserve the original default-port PID file for already running installations.
    pid_file = RUNTIME / ('server.pid' if PORT == 4186 else f'server-{PORT}.pid')
    if action == 'stop':
        if not state:
            print('Exercise is already stopped.')
            return
        if read_pid(pid_file) != state['pid']:
            raise SystemExit('This process was started elsewhere. Stop it in its own terminal.')
        try:
            os.kill(state['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(40):
            current = health()
            if current is None or current['pid'] != state['pid']:
                pid_file.unlink(missing_ok=True)
                print('Exercise stopped. Your data is kept in data/.')
                return
            time.sleep(.1)
        raise SystemExit('The server is still stopping. Check its process before retrying.')
    if state:
        print(f'Exercise is already running: {URL}')
        return
    env = dict(os.environ, HOST='127.0.0.1', PORT=str(PORT), PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1')
    with (RUNTIME / 'server.log').open('ab') as log:
        process = subprocess.Popen([sys.executable, '-B', 'backend/server.py'], cwd=ROOT, env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    for _ in range(60):
        state = health()
        if state and state.get('pid') == process.pid:
            pid_file.write_text(str(process.pid))
            print(f'Exercise is running: {URL}')
            return
        if process.poll() is not None:
            process.wait()
            raise SystemExit('Startup failed. Read .runtime/server.log; check whether the port is in use.')
        time.sleep(.1)
    process.terminate()
    process.wait(timeout=5)
    raise SystemExit('Startup timed out. Read .runtime/server.log.')


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'start'
    if action not in ('start', 'stop', 'status'):
        raise SystemExit('Usage: python3 scripts/run.py [start|stop|status]')
    if action == 'status':
        print(f'Exercise is running: {URL}' if health() else 'Exercise is stopped.')
        return
    RUNTIME.mkdir(exist_ok=True, mode=0o700)
    with (RUNTIME / f'server-{PORT}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manage(action)


if __name__ == '__main__':
    main()
