"""
scripts/boot_cycle.py -- THE OUTSIDE HAND (Lucas 09-01: full reboot control means she can
"spawn an outside boot cycle python"). app.relaunch() is an INSIDE mechanism: it only works
while the dying process is healthy enough to run JS, and if the relaunch chain breaks she is
DOWN with nobody to restart her. This script is the outside actor. Spawned DETACHED (by
_selfRebootTick in main.js, or by an operator's hand), it survives the app's death, waits for
the old root to exit (kills the tree if it lingers past grace), verifies the port actually
drained, launches the next generation with proper boot_pN log redirects, and confirms the app
ANSWERS before it exits. Two launch attempts, then a loud failure in its log.

Usage:  python scripts/boot_cycle.py --root-pid <pid> [--grace 25] [--why "reason"]
Log:    boot_cycle.log (appended, stamped; the pen jail denies it like every log)
Lock:   boot_cycle.lock (single-cycler guard; stale locks from dead cyclers are reclaimed)

No third-party deps -- ctypes/urllib/socket only, so it runs on the bare system python.
"""
import argparse
import ctypes
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(REPO, 'boot_cycle.log')
LOCK = os.path.join(REPO, 'boot_cycle.lock')
ELECTRON = os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
PORT = 8767
STATUS_URL = f'http://127.0.0.1:{PORT}/status'

SYNCHRONIZE = 0x00100000
WAIT_TIMEOUT = 0x00000102
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def log(msg):
    line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] [boot-cycle pid {os.getpid()}] {msg}'
    print(line, flush=True)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def pid_alive(pid):
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(SYNCHRONIZE, False, int(pid))
    if not h:
        return False
    try:
        return k32.WaitForSingleObject(h, 0) == WAIT_TIMEOUT
    finally:
        k32.CloseHandle(h)


def wait_pid_exit(pid, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(1)
    return not pid_alive(pid)


def port_open():
    try:
        with socket.create_connection(('127.0.0.1', PORT), timeout=1):
            return True
    except OSError:
        return False


def take_lock():
    # One cycler at a time. A lock whose pid is dead is stale -- reclaim it.
    for _ in range(2):
        try:
            fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            return True
        except FileExistsError:
            try:
                with open(LOCK, encoding='utf-8') as f:
                    holder = int(f.read().strip() or '0')
            except (OSError, ValueError):
                holder = 0
            if holder and pid_alive(holder):
                log(f'another cycler (pid {holder}) holds the lock -- standing down')
                return False
            log(f'stale lock from dead pid {holder} -- reclaiming')
            try:
                os.unlink(LOCK)
            except OSError:
                return False
    return False


def next_generation():
    n = 0
    try:
        for name in os.listdir(REPO):
            m = re.match(r'^boot_p(\d+)\.log$', name)
            if m:
                n = max(n, int(m.group(1)))
    except OSError:
        pass
    return n + 1


def launch():
    gen = next_generation()
    out_path = os.path.join(REPO, f'boot_p{gen}.log')
    err_path = os.path.join(REPO, f'boot_p{gen}.err.log')
    out = open(out_path, 'ab')
    err = open(err_path, 'ab')
    p = subprocess.Popen(
        [ELECTRON, '.'], cwd=REPO, stdout=out, stderr=err,
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
    )
    log(f'launched generation p{gen} (root pid {p.pid}) -> boot_p{gen}.log')
    return p.pid, gen


def status_ok(timeout_s):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(STATUS_URL, timeout=5) as r:
                body = r.read().decode('utf-8', 'replace')
            if '"ok":true' in body.replace(' ', ''):
                return body
        except OSError:
            pass
        time.sleep(3)
    return None


def main():
    ap = argparse.ArgumentParser(description='Outside boot-cycler for the Side Quest app.')
    ap.add_argument('--root-pid', type=int, required=True, help='pid of the current electron ROOT (0 = already down)')
    ap.add_argument('--grace', type=int, default=25, help='seconds to wait for a clean self-exit before taskkill')
    ap.add_argument('--why', default='cycle', help='reason, for the log')
    args = ap.parse_args()

    if not os.path.isfile(ELECTRON):
        log(f'FATAL: electron binary missing at {ELECTRON}')
        return 1
    if not take_lock():
        return 1
    try:
        log(f'cycle begins ({args.why}) -- old root pid {args.root_pid}, grace {args.grace}s')

        # 1) Let the old generation die on its own terms; enforce if it lingers.
        if args.root_pid and pid_alive(args.root_pid):
            if wait_pid_exit(args.root_pid, args.grace):
                log('old root exited on its own')
            else:
                log(f'old root outlived grace -- taskkill /T /F {args.root_pid}')
                subprocess.run(['taskkill', '/PID', str(args.root_pid), '/T', '/F'],
                               capture_output=True)
                wait_pid_exit(args.root_pid, 10)
        else:
            log('old root already gone')

        # 2) The port is the truth of "down" -- the listener lives in the old main process.
        for _ in range(15):
            if not port_open():
                break
            time.sleep(1)
        if port_open():
            log(f'FATAL: port {PORT} still answers after the old root died -- refusing to double-boot')
            return 1

        # 3) Launch, verify she answers; one honest retry, then a loud failure.
        for attempt in (1, 2):
            pid, gen = launch()
            body = status_ok(120)
            if body:
                log(f'generation p{gen} is UP and answering: {body.strip()}')
                return 0
            log(f'attempt {attempt}: p{gen} (pid {pid}) never answered within 120s')
            if pid_alive(pid):
                log('it is alive but silent -- leaving it standing (an operator should look), not killing blind')
                return 1
        log('FATAL: two launch attempts, no answer -- SHE IS DOWN and needs an operator')
        return 1
    finally:
        try:
            os.unlink(LOCK)
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())
