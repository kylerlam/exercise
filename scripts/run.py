"""Start an independent, persistent local Exercise process without installing anything."""
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
        return data if data.get('app') == 'exercise' else None
    except (URLError, OSError, ValueError):
        return None


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'start'
    if action not in ('start', 'stop', 'status'):
        raise SystemExit('Usage: python3 scripts/run.py [start|stop|status]')
    state = health()
    if action == 'status':
        print(f'Exercise is running: {URL}' if state else 'Exercise is stopped.')
        return
    pid_file = RUNTIME / 'server.pid'
    if action == 'stop':
        if not state:
            print('Exercise is already stopped.')
            return
        if not pid_file.exists() or int(pid_file.read_text().strip()) != state.get('pid'):
            raise SystemExit('This process was started elsewhere. Stop it in its own terminal.')
        os.kill(state['pid'], signal.SIGTERM)
        for _ in range(40):
            if not health():
                pid_file.unlink(missing_ok=True)
                print('Exercise stopped. Your data is kept in data/.')
                return
            time.sleep(.1)
        raise SystemExit('The server is still stopping. Check its process before retrying.')
    if state:
        print(f'Exercise is already running: {URL}')
        return
    RUNTIME.mkdir(exist_ok=True, mode=0o700)
    env = dict(os.environ, HOST='127.0.0.1', PORT=str(PORT), PYTHONDONTWRITEBYTECODE='1', PYTHONUNBUFFERED='1')
    with (RUNTIME / 'server.log').open('ab') as log:
        process = subprocess.Popen([sys.executable, '-B', 'backend/server.py'], cwd=ROOT, env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    pid_file.write_text(str(process.pid))
    for _ in range(60):
        state = health()
        if state and state.get('pid') == process.pid:
            print(f'Exercise is running: {URL}')
            return
        if process.poll() is not None:
            raise SystemExit('Startup failed. Read .runtime/server.log; check whether the port is in use.')
        time.sleep(.1)
    process.terminate()
    raise SystemExit('Startup timed out. Read .runtime/server.log.')


if __name__ == '__main__':
    main()
