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
CREATE_BREAKAWAY_FROM_JOB = 0x01000000   # 09-05: the app died with the harness that launched its cycle (a job object took the tree); break away


def log(msg):
    line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] [boot-cycle pid {os.getpid()}] {msg}'
    print(line, flush=True)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def tee(msg):
    # the organ watch tails boot_self.log (audit F31): a fatal cycle outcome must land where
    # the watch LOOKS — the app is dead, so nothing else can raise the alarm. The line carries
    # 'SELF-REBOOT' because that word is in the watch's grep pattern.
    log(msg)
    try:
        with open(os.path.join(REPO, 'boot_self.log'), 'a', encoding='utf-8') as f:
            f.write(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] [boot-cycle] {msg}\n')
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
        creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
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


MIN_QUIET_S = 180


def live_guard(status_json, min_quiet_s=MIN_QUIET_S):
    """THE LIVE GUARD (2026-09-04): the law said "live-guard before ANY kill -- user-turn age > 3 min,
    never over his conversation, never mid-flight" and this script never carried it: the cycle at
    02:30:00 on 09-04 killed boot_p282 thirteen seconds after his message ("I'll review the florida
    list in the morning...") landed, unanswered. The guard reads the app's own /status and REFUSES
    when a real turn of his is younger than min_quiet_s, when a reply is in flight, or when a real
    turn is still unanswered. Pure: takes the status JSON text, returns (ok, reason). An unreadable
    status refuses too -- a kill must never proceed on a guess."""
    import json
    try:
        st = json.loads(status_json or '')
    except (TypeError, ValueError):
        return False, 'status unreadable -- refusing to kill on a guess'
    if not isinstance(st, dict):
        return False, 'status malformed -- refusing to kill on a guess'
    if st.get('inFlight'):
        return False, 'a reply is in flight'
    if st.get('realUnanswered'):
        return False, 'a real turn of his is unanswered'
    age = st.get('lastRealUserTurnAgoMs')
    if age is None:
        age = st.get('lastUserTurnAgoMs')
    try:
        age = float(age)
    except (TypeError, ValueError):
        return False, 'the turn age is unreadable -- refusing to kill on a guess'
    if age < min_quiet_s * 1000:
        return False, f'his last turn was {age / 1000:.0f}s ago (< {min_quiet_s}s) -- never over his conversation'
    return True, f'quiet for {age / 3600000:.1f}h, nothing in flight, nothing unanswered'


def read_status():
    try:
        with urllib.request.urlopen(STATUS_URL, timeout=5) as r:
            return r.read().decode('utf-8', 'replace')
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser(description='Outside boot-cycler for the Side Quest app.')
    ap.add_argument('--root-pid', type=int, required=True, help='pid of the current electron ROOT (0 = already down)')
    ap.add_argument('--grace', type=int, default=25, help='seconds to wait for a clean self-exit before taskkill')
    ap.add_argument('--why', default='cycle', help='reason, for the log')
    ap.add_argument('--force', action='store_true', help='skip the live guard (an operator who has decided; logged as such)')
    ap.add_argument('--min-quiet', type=int, default=MIN_QUIET_S, help='seconds his last real turn must be older than')
    ap.add_argument('--check-guard', action='store_true', help='read a status JSON from stdin, print the guard verdict, exit 0 (ok) / 2 (refused); no cycle')
    args = ap.parse_args()

    if args.check_guard:
        ok, why = live_guard(sys.stdin.read(), args.min_quiet)
        print(('OK ' if ok else 'REFUSED ') + why)
        return 0 if ok else 2

    if not os.path.isfile(ELECTRON):
        log(f'FATAL: electron binary missing at {ELECTRON}')
        return 1
    if not take_lock():
        return 1
    try:
        log(f'cycle begins ({args.why}) -- old root pid {args.root_pid}, grace {args.grace}s')

        # 0) THE LIVE GUARD -- before any kill. The app's own /status says whether he is in
        #    conversation, whether a reply is in flight, whether a real turn waits unanswered.
        #    A refusal is the cycle's outcome, logged; --force is an operator's decision, logged.
        if args.root_pid and pid_alive(args.root_pid):
            body = read_status()
            if body is None:
                if not args.force:
                    log('REFUSED: the app does not answer /status -- a kill must not proceed on a guess (use --force if she is wedged)')
                    return 2
                log('--force: /status unreachable, proceeding on the operator\'s word')
            else:
                ok, why = live_guard(body, args.min_quiet)
                if not ok and not args.force:
                    log(f'REFUSED by the live guard: {why}')
                    return 2
                log(('--force over the live guard: ' if not ok else 'live guard passed: ') + why)

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
                tee(f'SELF-REBOOT WEDGED -- generation p{gen} is alive but silent; left standing for an operator, never killed blind')
                return 1
        tee('SELF-REBOOT FAILED -- SHE IS DOWN (two launch attempts, no answer; an operator must look)')
        return 1
    finally:
        try:
            os.unlink(LOCK)
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())
