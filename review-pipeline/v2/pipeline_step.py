import argparse
import contextlib
import fcntl
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import webbrowser

HERE = pathlib.Path(os.path.abspath(__file__)).parent  # not resolve(): the tools folder is assembled from links and project overrides
sys.path.insert(0, str(HERE))
import pipeline_ui as ui

GATES = {'00': '00', '01': '01', '02': '02', '03': '03', '04': '05', '05': '05', '06': '06', '07': '07'}
RED_GATE = 10
NAMES = {num: name for num, name, _ in ui.STEPS}
MARK = {'pass': '✔', 'fail': '✘', 'manual': '☝', 'running': '▶', 'wait': '·'}


def repo_root():
    if not os.environ.get('RV'):
        sys.exit('ABORT: set RV to the review checkout (the /review-pr extension does)')
    return pathlib.Path(os.environ['RV'])


def rule_roots():
    return [pathlib.Path(p) for p in os.environ.get('RULES', '').split(os.pathsep) if p]


def work_dir(pr):
    return repo_root() / 'reports' / 'reviews' / 'evidence' / pr / 'gates'


def widget_lines(pr, events, now):
    """The file is written once per event, so a clock in it would stand still: a running time is written as
    {{since:<epoch>}} for the reader (the /review-pr extension) to turn into the time that has passed; a finished
    step gets its duration."""
    steps, meta = ui.model(events)
    since = lambda secs: '{{since:%d}}' % (now - secs)
    lines = [f'Review #{pr}: {ui.banner_of(steps, meta, now, since)[1]}']
    for num, name, _ in ui.STEPS:
        s = steps[num]
        red = sum(1 for i in (s['items'] or []) if i['st'] in ('FAIL', 'ABORT'))
        if s['state'] == 'running':
            took = f' ({since(now - s["start"])})'
        elif s['start'] and s['end']:
            took = f' ({ui.fmt_secs(s["end"] - s["start"])})'
        else:
            took = ''
        lines.append(f'{MARK[s["state"]]} {num} {name}{took}{f" ({red} gate đỏ)" if s["state"] == "fail" and red else ""}')
    return lines


def emit(work, pr, step, state, msg='', **extra):
    work.mkdir(parents=True, exist_ok=True)
    event = {'ts': time.time(), 'step': step, 'state': state, 'msg': msg, **extra}
    with open(work / 'events.jsonl', 'a') as f:
        f.write(json.dumps(event, ensure_ascii=False) + '\n')
    tmp = work / f'widget.txt.{os.getpid()}.tmp'
    tmp.write_text('\n'.join(widget_lines(pr, ui.read_events(work / 'events.jsonl'), time.time())) + '\n')
    tmp.replace(work / 'widget.txt')


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def is_ui_process(pid):
    out = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout
    return 'pipeline_ui.py' in out


@contextlib.contextmanager
def locked(work):
    work.mkdir(parents=True, exist_ok=True)
    with open(work / 'begin.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def live_server(work):
    try:
        pid = int((work / 'ui.pid').read_text())
        port = int((work / 'ui.port').read_text())
    except (OSError, ValueError):
        return None
    return port if alive(pid) and is_ui_process(pid) and port_open(port) else None


def ensure_server(pr, work):
    port = live_server(work)
    if port:
        return f'http://127.0.0.1:{port}', False
    for name in ('ui.pid', 'ui.port'):
        (work / name).unlink(missing_ok=True)
    with open(work / 'ui.log', 'w') as log:
        proc = subprocess.Popen([sys.executable, str(HERE / 'pipeline_ui.py'), pr, '--work', str(work)],
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (work / 'ui.pid').write_text(str(proc.pid))
    for _ in range(100):
        if proc.poll() is not None:
            sys.exit(f'ABORT: UI thoát ngay (mã {proc.returncode}), xem {work / "ui.log"}')
        try:
            port = int((work / 'ui.port').read_text())
        except (OSError, ValueError):
            port = None
        if port and port_open(port):
            return f'http://127.0.0.1:{port}', True
        time.sleep(0.1)
    sys.exit(f'ABORT: UI không lên sau 10 giây, xem {work / "ui.log"}')


def revive(pr, work):
    if (work / 'ui.pid').exists() and not live_server(work):
        with locked(work):
            ensure_server(pr, work)


def cmd_begin(a):
    work = work_dir(a.pr)
    with locked(work):
        owner_file = work / 'owner'
        try:
            other = int(owner_file.read_text()) if a.owner and owner_file.exists() else None
        except ValueError:
            other = None
        if other and other != a.owner and alive(other) and not a.takeover:
            print(f'review #{a.pr} đang chạy ở tiến trình pi {other}. Thêm --takeover nếu chắc tiến trình đó không còn dùng nó.', file=sys.stderr)
            sys.exit(3)
        if a.owner:
            owner_file.write_text(str(a.owner))
        events = work / 'events.jsonl'
        existing = ui.read_events(events)
        resumed = bool(existing) and not any(e.get('state') == 'end' for e in existing) and not a.restart
        if existing and not resumed:
            events.rename(work / f'events-{time.strftime("%Y%m%d-%H%M%S")}.jsonl')
        if resumed:
            steps, _ = ui.model(existing)
            emit(work, a.pr, '-', 'resume', f'tiếp tục review #{a.pr}')
            next_step = next((n for n in NAMES if steps[n]['state'] != 'pass'), None)
            done = [n for n in NAMES if steps[n]['state'] == 'pass']
            waiting = next_step if next_step and steps[next_step]['state'] == 'manual' else None
        else:
            emit(work, a.pr, '-', 'begin', f'review #{a.pr} bắt đầu')
            next_step, done, waiting = '00', [], None
        url, started = ensure_server(a.pr, work)
    if started and not a.no_open:
        webbrowser.open(url)
    print(json.dumps({'url': url, 'widget': str(work / 'widget.txt'), 'resumed': resumed, 'next': next_step, 'done': done, 'waiting': waiting}))


def check_step(step):
    if step not in NAMES:
        sys.exit(f'ABORT: bước {step!r} không có, dùng một trong {" ".join(NAMES)}')


def cmd_start(a):
    check_step(a.step)
    emit(work_dir(a.pr), a.pr, a.step, 'start', a.msg)
    revive(a.pr, work_dir(a.pr))
    roots = rule_roots()
    guide = next((p for root in roots for p in sorted((root / 'steps').glob(f'{a.step}-*.md')) if not p.name.endswith('.rules.md')), None)
    print(guide.read_text() if guide else f'(không có file hướng dẫn cho bước {a.step})')
    print('\nThư mục rule, ưu tiên từ trên xuống (file nào có ở cả hai thì lấy bản trên): ' + ', '.join(str(r) for r in roots))


def cmd_note(a):
    check_step(a.step)
    emit(work_dir(a.pr), a.pr, a.step, 'note', a.msg)
    revive(a.pr, work_dir(a.pr))
    print('ok')


def cmd_done(a):
    check_step(a.step)
    work = work_dir(a.pr)
    revive(a.pr, work)
    enabled = os.environ.get('GATES', '').split()
    if enabled and a.step != '00' and GATES[a.step] not in enabled:
        items = [{'st': 'INFO', 'name': '', 'msg': 'không có gate máy cho bước này (pipeline.json): người tự kiểm theo hướng dẫn', 'detail': []}]
        emit(work, a.pr, a.step, 'done', verdict='pass', items=items)
        print(f'VERDICT bước {a.step} {NAMES[a.step]}: pass (không có gate máy)')
        return
    only = GATES[a.step] if a.step == '00' else f'00 {GATES[a.step]}'
    env = dict(os.environ, ONLY=only, WORK=str(work), RV=str(repo_root()))
    r = subprocess.run([str(HERE / 'pipeline_status.sh'), a.pr], env=env, capture_output=True, text=True, timeout=900)
    rows = {m['num']: m['st'] for m in ui.ROW.finditer(r.stdout)}
    if r.returncode not in (0, 1) or not rows:
        reason = (r.stderr.strip().splitlines() or ['không rõ lý do'])[-1]
        items = [{'st': 'ABORT', 'name': '', 'msg': f'pipeline_status.sh dừng với exit {r.returncode}: {reason}', 'detail': []}]
    else:
        items = ui.collect(work, rows)[a.step]
        if items is None:
            items = [{'st': 'FAIL', 'name': 'gate', 'msg': 'gate của bước này không chạy, không có log', 'detail': []}]
        if a.step != '00':
            stale = [i for i in ui.parse(work / '00-intake.log') or [] if i['st'] in ('FAIL', 'ABORT')]
            items = [{**i, 'name': 'intake'} for i in stale] + items
    verdict = ui.status_of(items)
    emit(work, a.pr, a.step, 'done', verdict=verdict, items=items)
    for it in ui.group(items):
        if it['st'] in ('FAIL', 'ABORT', 'MANUAL', 'WARN'):
            print(f'{it["st"]:6} {it["name"]} {it["msg"]}'.rstrip())
            for d in it['detail'][:6]:
                print(f'         {d}')
    print(f'VERDICT bước {a.step} {NAMES[a.step]}: {verdict}')
    sys.exit(RED_GATE if verdict == 'fail' else 0)


def cmd_stop(a):
    work = work_dir(a.pr)
    pid_file = work / 'ui.pid'
    if not pid_file.exists():
        print('không có UI đang chạy')
        return
    try:
        pid = int(pid_file.read_text())
    except ValueError:
        pid = None
    if pid and alive(pid) and is_ui_process(pid):
        os.kill(pid, 15)
        print('ok')
    elif pid and alive(pid):
        print(f'pid {pid} không phải server UI nên không dừng, chỉ xoá file pid')
    else:
        print('server UI đã tắt từ trước')
    for name in ('ui.pid', 'ui.port'):
        (work / name).unlink(missing_ok=True)


def cmd_end(a):
    emit(work_dir(a.pr), a.pr, '-', 'end', a.msg)
    print('ok')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name, fn, has_step in (('begin', cmd_begin, False), ('start', cmd_start, True), ('note', cmd_note, True),
                               ('done', cmd_done, True), ('end', cmd_end, False), ('stop', cmd_stop, False)):
        p = sub.add_parser(name)
        p.add_argument('pr')
        if has_step:
            p.add_argument('step')
        p.add_argument('--msg', default='')
        if name == 'begin':
            p.add_argument('--no-open', action='store_true')
            p.add_argument('--restart', action='store_true')
            p.add_argument('--takeover', action='store_true')
            p.add_argument('--owner', type=int)
        p.set_defaults(fn=fn)
    args = ap.parse_args()
    args.fn(args)
