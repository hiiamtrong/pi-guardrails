import argparse
import html
import json
import pathlib
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STEPS = [
    ('00', 'intake', 'PR đúng người, đúng head, đã fetch'),
    ('01', 'comments', 'mọi review và comment, kể cả bot, đã xếp loại'),
    ('02', 'map', 'impact map và các điểm ngoài diff'),
    ('03', 'verify', 'chạy test, trial, mutant, probe có bằng chứng'),
    ('04', 'outside-diff', 'dữ liệu bị xoá, bước chạy tay, request thật qua service kia'),
    ('05', 'draft', '7 điểm, rủi ro chưa kiểm, giọng, bằng chứng'),
    ('06', 'post', 'pin khớp, người review đã OK, guard'),
    ('07', 'after', 'comment mới, review so với head'),
]
LOGS = {'00': '00-intake', '01': '01-comments', '02': '02-impact-map', '03': '03-runs', '06': '06-pin', '07': '07-after'}
STEP04 = re.compile(r'^(data-|rollout|release-lbl|cross)')
LINE = re.compile(r'^(?P<pre>[A-Z]+):\s+(?P<st>PASS|FAIL|MANUAL|WARN|INFO|ABORT)\b\s*(?P<rest>.*)$')
ROW = re.compile(r'^(?P<num>\d\d)\s+\S+\s+(?P<st>PASS|FAIL|ABORT)\s+rc=(?P<rc>\d+)', re.M)
LABEL = {'pass': 'XONG', 'fail': 'LỖI', 'manual': 'CHỜ NGƯỜI', 'running': 'ĐANG LÀM', 'wait': 'CHƯA TỚI'}
ICON = {'PASS': '✔', 'FAIL': '✘', 'ABORT': '✘', 'MANUAL': '☝', 'WARN': '⚠', 'INFO': '·'}
E = html.escape


def parse(path):
    if not path.exists():
        return None
    items, last = [], None
    for raw in path.read_text(errors='replace').splitlines():
        m = LINE.match(raw)
        if m:
            name, msg = '', m['rest'].strip()
            if m['pre'] == 'DRAFT':
                name, _, msg = msg.partition(' ')
                msg = msg.strip()
            last = {'st': m['st'], 'name': name, 'msg': msg, 'detail': []}
            items.append(last)
        elif raw.strip() and last is not None and raw.startswith(' '):
            last['detail'].append(raw.strip())
        elif raw.strip():
            last = {'st': 'INFO', 'name': '', 'msg': raw.strip(), 'detail': []}
            items.append(last)
    return items


def log_tail(path, n=6):
    return path.read_text(errors='replace').splitlines()[-n:] if path.exists() else []


def status_of(items):
    if items is None:
        return 'wait'
    sts = {i['st'] for i in items}
    if sts & {'FAIL', 'ABORT'}:
        return 'fail'
    return 'manual' if 'MANUAL' in sts else 'pass'


def collect(work, rows):
    steps = {num: parse(work / f'{LOGS[num]}.log') if num in LOGS else None for num, _, _ in STEPS}
    draft = parse(work / '05-draft.log')
    unreported = [num for num in LOGS if rows.get(num, 'PASS') != 'PASS' and status_of(steps[num]) != 'fail']
    if rows.get('05', 'PASS') != 'PASS' and status_of(draft) != 'fail':
        unreported.append('05')
    if draft is not None:
        steps['04'] = [i for i in draft if STEP04.match(i['name'])]
        steps['05'] = [i for i in draft if not STEP04.match(i['name'])]
    for num in unreported:
        log = work / ('05-draft.log' if num == '05' else f'{LOGS[num]}.log')
        item = {'st': 'FAIL', 'name': 'gate', 'detail': log_tail(log),
                'msg': f'pipeline_status.sh báo {rows[num]} cho bước này nhưng log không có dòng FAIL nào: gate có thể đã chạy hỏng'}
        steps[num] = (steps[num] or []) + [item]
    return steps


def read_events(path):
    out = []
    if path.exists():
        for line in path.read_text(errors='replace').splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def model(events):
    steps = {num: {'state': 'wait', 'start': None, 'end': None, 'notes': [], 'items': None, 'msg': ''} for num, _, _ in STEPS}
    meta = {'begin': None, 'end': None, 'end_msg': '', 'last': None, 'last_ts': None}
    for ev in events:
        kind, num = ev.get('state'), ev.get('step')
        meta['last_ts'] = ev.get('ts', meta['last_ts'])
        if kind == 'begin':
            meta['begin'] = ev['ts']
        elif kind == 'end':
            meta['end'], meta['end_msg'] = ev['ts'], ev.get('msg', '')
        elif num in steps:
            s = steps[num]
            meta['last'] = num
            if kind == 'start':
                s.update(state='running', start=ev['ts'], end=None, notes=[], items=None, msg=ev.get('msg', ''))
            elif kind == 'note':
                s['notes'].append((ev['ts'], ev.get('msg', '')))
            elif kind == 'done':
                s.update(state=ev.get('verdict', 'fail'), end=ev['ts'], items=ev.get('items') or [])
    return steps, meta


def group(items):
    reason = lambda i: i['msg'].rsplit("': ", 1)[-1]
    counts = {}
    for i in items:
        if i['st'] in ('FAIL', 'ABORT') and "': " in i['msg']:
            counts.setdefault((i['st'], i['name'], reason(i)), []).append(i)
    out, done = [], set()
    for i in items:
        key = (i['st'], i['name'], reason(i))
        if key not in counts or len(counts[key]) < 3:
            out.append(i)
        elif key not in done:
            done.add(key)
            where = [x['msg'].split(': ', 1)[0] for x in counts[key]]
            out.append({'st': i['st'], 'name': i['name'], 'msg': f'{len(where)} lần: {key[2]}', 'detail': where})
    return out


def fmt_secs(n):
    n = int(n)
    return f'{n // 60}m{n % 60:02d}s' if n >= 60 else f'{n}s'


def clock(ts):
    return time.strftime('%H:%M:%S', time.localtime(ts))


IDLE_WARN_SECONDS = 300


def banner_of(steps, meta, now, fmt=None):
    fmt = fmt or fmt_secs
    name = {n: nm for n, nm, _ in STEPS}
    if meta['end']:
        return 'ok', f'Xong: {meta["end_msg"] or "review kết thúc"}'
    running = [n for n, s in steps.items() if s['state'] == 'running']
    if running:
        n = running[-1]
        s = steps[n]
        now_doing = s['notes'][-1][1] if s['notes'] else s['msg']
        idle = now - (meta['last_ts'] or s['start'])
        if idle >= IDLE_WARN_SECONDS:
            return 'wait', (f'Bước {n} {name[n]} đang làm nhưng {fmt(idle)} chưa có ghi chú mới: '
                            f'agent có thể đang chạy lệnh dài hoặc đã dừng (lần cuối: {now_doing})').rstrip(': ')
        return 'run', f'Đang ở bước {n} {name[n]} ({fmt(now - s["start"])}): {now_doing}'.rstrip(': ')
    n = meta['last']
    if n is None:
        return 'wait', 'Chưa bắt đầu bước nào' if meta['begin'] else 'Chưa có review nào chạy'
    s = steps[n]
    if s['state'] == 'fail':
        red = sum(1 for i in (s['items'] or []) if i['st'] in ('FAIL', 'ABORT'))
        return 'bad', f'Bước {n} {name[n]} lỗi: {red} gate đỏ. Sửa rồi chạy lại gate của bước này'
    if s['state'] == 'manual':
        if n == '05':
            return 'wait', 'Bước 05 draft xong: chờ bạn đọc bản nháp rồi nói OK post'
        return 'wait', f'Bước {n} {name[n]} chờ bạn kiểm tay'
    return 'wait', f'Bước {n} {name[n]} đã xong, bước kế chưa bắt đầu'


def item_html(it):
    nm = f'<code>{E(it["name"])}</code> ' if it['name'] else ''
    out = [f'<div class="row {it["st"].lower()}"><span class="i">{ICON[it["st"]]}</span>{nm}{E(it["msg"])}']
    if it.get('detail'):
        out.append('<ul>' + ''.join(f'<li>{E(d)}</li>' for d in it['detail'][:12]) + '</ul>')
    out.append('</div>')
    return ''.join(out)


def render(pr, events, now):
    steps, meta = model(events)
    kind, text = banner_of(steps, meta, now)
    cur = next((n for n, s in steps.items() if s['state'] == 'running'), meta['last'])
    out = ['<div id="app">', f'<div class="banner {kind}">{E(text)}</div>']
    started = f'bắt đầu {clock(meta["begin"])} · ' if meta['begin'] else ''
    out.append(f'<div class="meta">PR #{E(str(pr))} · {started}cập nhật {clock(now)}</div><div class="flow">')
    for num, name, _ in STEPS:
        s = steps[num]
        out.append(f'<a href="#s{num}" class="node {s["state"]}{" cur" if num == cur else ""}"><span class="n">{num}</span>{E(name)}'
                   f'<span class="s">{LABEL[s["state"]]}</span></a>')
    out.append('</div>')
    for num, name, purpose in STEPS:
        s = steps[num]
        if s['start']:
            span = fmt_secs((s['end'] or now) - s['start'])
            timing = f' · {clock(s["start"])} · {span}'
        else:
            timing = ''
        red = sum(1 for i in (s['items'] or []) if i['st'] in ('FAIL', 'ABORT'))
        opened = ' open' if s['state'] in ('running', 'fail', 'manual') else ''
        out.append(f'<details id="s{num}" class="step {s["state"]}"{opened}><summary><b>{num} {E(name)}</b> '
                   f'<span class="tag {s["state"]}">{LABEL[s["state"]]}</span> <span class="purpose">{E(purpose)}</span>'
                   f'{timing}{f" · {red} lỗi" if red else ""}</summary>')
        if s['state'] == 'wait':
            out.append('<p class="empty">Chưa tới bước này.</p>')
        if s['msg'] and s['state'] != 'wait':
            out.append(f'<div class="row info"><span class="i">▶</span>{E(s["msg"])}</div>')
        for ts, msg in s['notes'][-8:]:
            out.append(f'<div class="row note"><span class="i">·</span><span class="t">{clock(ts)}</span> {E(msg)}</div>')
        for it in group(s['items'] or []):
            if it['st'] == 'INFO' and s['state'] == 'pass':
                continue
            out.append(item_html(it))
        out.append('</details>')
    out.append('<details class="step log"><summary><b>Nhật ký</b> <span class="purpose">mọi sự kiện theo thời gian</span></summary>')
    for ev in events[-60:]:
        label = ev.get('step') if ev.get('step') in steps else '-'
        out.append(f'<div class="row note"><span class="t">{clock(ev["ts"])}</span> <code>{E(label)} {E(str(ev.get("state")))}</code> {E(str(ev.get("msg", "")))}</div>')
    out.append('</details></div>')
    return '\n'.join(out)


PAGE = '''<!doctype html><html lang="vi"><meta charset="utf-8"><title>Review #{pr}</title>
<style>
body{{font:14px/1.45 -apple-system,Segoe UI,sans-serif;margin:0;padding:18px;background:#f6f7f9;color:#1d2330}}
.banner{{padding:12px 16px;border-radius:8px;font-size:16px;font-weight:600;margin-bottom:8px}}
.banner.bad{{background:#fde8e8;color:#9b1c1c}}.banner.wait{{background:#fff4d6;color:#7a5600}}.banner.ok{{background:#dcf5e3;color:#0f5c2b}}.banner.run{{background:#e0ecff;color:#123d99}}
.meta{{color:#5b6475;margin-bottom:12px}}
.flow{{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}}
.node{{flex:1 1 110px;min-width:110px;padding:8px 10px;border-radius:8px;text-decoration:none;color:inherit;background:#eceef2;border:2px solid transparent;display:flex;flex-direction:column}}
.node .n{{font-size:11px;color:#5b6475}}.node .s{{font-size:11px;margin-top:2px;font-weight:600}}
.node.pass{{background:#dcf5e3}}.node.fail{{background:#fde8e8}}.node.manual{{background:#fff4d6}}.node.running{{background:#e0ecff}}.node.wait{{color:#7a8394}}
.node.cur{{border-color:#1d4ed8}}
.step{{background:#fff;border:1px solid #dfe3ea;border-radius:8px;margin-bottom:8px;padding:6px 12px}}
.step.fail{{border-left:5px solid #d93025}}.step.manual{{border-left:5px solid #e0a100}}.step.pass{{border-left:5px solid #1a9c4b}}.step.running{{border-left:5px solid #1d4ed8}}
summary{{cursor:pointer;padding:4px 0}}.purpose{{color:#5b6475;margin-left:6px}}
.tag{{font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;background:#e8eaef}}
.tag.fail{{background:#d93025;color:#fff}}.tag.pass{{background:#1a9c4b;color:#fff}}.tag.manual{{background:#e0a100;color:#fff}}.tag.running{{background:#1d4ed8;color:#fff}}
.row{{padding:5px 8px;margin:3px 0;border-radius:5px;word-break:break-word}}
.row.fail,.row.abort{{background:#fdecea}}.row.manual{{background:#fff8e1}}.row.warn{{background:#fff3e0}}.row.pass{{color:#3f6b4f}}.row.info{{background:#eef3ff}}.row.note .t{{color:#7a8394;font-size:12px}}
.row .i{{display:inline-block;width:18px;font-weight:700}}
code{{background:#eef0f4;padding:1px 5px;border-radius:4px}}
ul{{margin:4px 0 2px 24px;padding:0;font-size:13px;color:#4a5365}}li{{overflow-wrap:anywhere}}.empty{{color:#7a8394}}
</style><body>
{app}
<script>
const chosen=new Map();let last=null;
document.addEventListener('click',e=>{{const s=e.target.closest('summary');if(s){{const d=s.parentElement;setTimeout(()=>chosen.set(d.id,d.open))}}}});
setInterval(async()=>{{try{{const t=await (await fetch(location.pathname,{{cache:'no-store'}})).text();if(t===last)return;last=t;
const n=new DOMParser().parseFromString(t,'text/html').getElementById('app');if(!n)return;
document.getElementById('app').replaceWith(n);
document.querySelectorAll('details').forEach(d=>{{if(chosen.has(d.id))d.open=chosen.get(d.id)}});}}catch(e){{}}}},2000);
</script></html>'''


def page(pr, work):
    return PAGE.format(pr=pr, app=render(pr, read_events(work / 'events.jsonl'), time.time()))


PORTS = range(8765, 8865)


class UiServer(ThreadingHTTPServer):
    allow_reuse_address = False


def bind(handler, port):
    for candidate in ([port] if port else PORTS):
        try:
            return UiServer(('127.0.0.1', candidate), handler)
        except OSError:
            continue
    raise SystemExit(f'không còn cổng trống trong {PORTS.start}-{PORTS.stop - 1}')


def serve(pr, work, port):
    own = set()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Host') not in own:
                self.send_response(403)
                self.end_headers()
                return
            if self.path == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            data = page(pr, work).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = bind(Handler, port)
    bound = server.server_address[1]
    own.update({f'127.0.0.1:{bound}', f'localhost:{bound}'})
    (work / 'ui.port').write_text(str(bound))
    print(f'http://127.0.0.1:{bound}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('pr')
    ap.add_argument('--work', required=True)
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--once')
    a = ap.parse_args()
    work = pathlib.Path(a.work)
    if a.once:
        pathlib.Path(a.once).write_text(page(a.pr, work))
    else:
        serve(a.pr, work, a.port)
