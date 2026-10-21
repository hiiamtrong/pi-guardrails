"""check_draft.py <draft.md> --triggers T.tsv --expected E.tsv --wt <worktree> [--labels a,b]

On #19233 every gate that existed was a WARNING or a human read; these are the checks that must stop the post.
"""
import argparse
import os
import pathlib
import re
import subprocess
import sys

POINTS = ['Breaks current production behaviour', 'Feature flag', 'Serious bug', 'Architecture',
          'Style and conventions', 'AI misuse', 'Hard to follow']
# Keep in sync with "Voice of the review" and "House style" in
# /Users/hiiamtrong/Works/Sotatek/slive/swag-server-review/AGENTS.local.md
BANNED = [('—', 'em dash'), (r'(?i)\bmutants?\b', '"mutant"'), (r'\bApproving\.', '"Approving."'),
          (r'\bFlagging:', '"Flagging:"'), (r'(?i)I have tests for them if you want them', 'câu kết cố định'),
          (r'\d+ of \d+ mutants', 'thống kê mutant'), (r'\(\d+ passed\)', 'thống kê pytest'),
          (r'Clear in 30 seconds', 'nhãn điểm 7 sai'), (r'(?m)^\s*[🔴🟠🟡🟢]', 'prefix mức độ'),
          (r'(?i)could potentially|it\'s worth noting', 'cụm AI'),
          # Added 20/10 after #18541: sentences that read as a report about the tooling, not as a colleague talking.
          (r'(?i)\bin several ways\b', 'kể công cụ: "in several ways"'),
          (r'(?is)\bI broke\b[^\n]{0,200}\bcaught\b', 'kể công cụ: "I broke ... caught"'),
          (r'(?i)\b(?:which|as) we agreed\b', 'nhắc lại thoả thuận cũ'),
          (r'(?i)\bapprovals? (?:was|were) dismissed\b', 'nhắc việc approval của người khác: báo Han trên Slack, không để trong review')]
results = []


def norm(s):
    """Compare sentences without caring about case, backticks, quotes, spacing or the final full stop."""
    return re.sub(r'\s+', ' ', re.sub(r'[`"\'“”]', '', s)).strip().lower().rstrip('.,;:')


def quote_in_body(quote, body):
    return bool(quote.strip('" `')) and norm(quote) in norm(body)


def repeated_phrase(text, n=8):
    """The first run of n words that appears twice in the posted text (code blocks excluded), or None."""
    words = re.findall(r"[a-z0-9_']+", re.sub(r'(?s)```.*?```', ' ', text).lower())
    seen = {}
    for i in range(len(words) - n + 1):
        gram = ' '.join(words[i:i + n])
        if gram in seen and i - seen[gram] >= n:
            return gram
        seen.setdefault(gram, i)
    return None


def say(status, code, msg):
    results.append(status)
    print(f'DRAFT: {status:6} {code:12} {msg}')


def section(text, title):
    m = re.search(rf'^## {re.escape(title)}[^\n]*\n(.*?)(?=^## |\Z)', text, re.S | re.M)
    return m.group(1) if m else None


def table(body):
    out = []
    for line in (body or '').splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if line.strip().startswith('|') and not set(cells[0]) <= set('-: ') and len(cells) > 2:
            out.append(cells)
    return out[1:]


def tsv(path, kind=None):
    rows = [l.split('\t') for l in pathlib.Path(path).read_text().splitlines() if l and l != 'NONE']
    return [r for r in rows if kind is None or r[0] == kind]


def check_points(body, event):
    answers = {}
    for i, label in enumerate(POINTS, 1):
        pm = re.search(rf'(?m)^{i}\. {re.escape(label)}: (Yes|No issue|No|N/A)\b', body)
        answers[i] = pm.group(1) if pm else None
    missing = [i for i, v in answers.items() if v is None]
    say('FAIL' if missing else 'PASS', '7points', f'thiếu/sai nhãn điểm {missing}' if missing else 'đủ 7 điểm, đúng nhãn')
    yes = [i for i, v in answers.items() if v == 'Yes']
    bad = yes and event != 'REQUEST_CHANGES'
    say('FAIL' if bad else 'PASS', 'yes=>RC', f'Yes ở {yes or "không điểm nào"}, event {event}')


def check_risk(text, event, override):
    risk = re.search(r'(?m)^- \*\*Rủi ro chưa kiểm:\*\*[ \t]*(.*)$', text)
    txt = risk.group(1).strip() if risk else ''
    has = bool(txt) and not re.fullmatch(r'(?i)(không|không có|none|n/a)\.?', txt)
    bad = event == 'APPROVE' and has and not override
    say('FAIL' if bad else 'PASS', 'risk',
        f'APPROVE khi "Rủi ro chưa kiểm" = {txt[:70]!r} (AGENTS.local.md:322)' if bad else f'rủi ro chưa kiểm: {"có" if has else "không"}, event {event}')
    unchecked = re.findall(r'(?m)^\|[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*\**chưa kiểm', section(text, 'Comment đã có') or '')
    bad = unchecked and event == 'APPROVE' and not override
    say('FAIL' if bad else 'PASS', 'unchecked', f'{len(unchecked)} comment "chưa kiểm", event {event}')


def check_deletes(text, body, deletes, wt, root, event, override):
    if not deletes:
        say('PASS', 'data-delete', 'diff không có điểm xoá')
        return
    rows = table(section(text, 'Dữ liệu bị xoá'))
    if not rows:
        sites = ', '.join(r[1].split('/')[-1] for r in deletes)
        say('FAIL', 'data-delete', f'diff có {len(deletes)} điểm xoá ({sites}) mà bản nháp không có bảng "## Dữ liệu bị xoá"')
        return
    joined = '\n'.join('|'.join(r) for r in rows)
    for t in deletes:
        short = t[1].split('/')[-1]
        say('PASS' if short in joined else 'FAIL', 'data-site', f'{short} ({t[2]}) {"có" if short in joined else "chưa có"} dòng trong bảng')
    for r in rows:
        if len(r) < 8:
            say('FAIL', 'data-row', f'dòng {r[0]!r} thiếu cột (cần 8)')
            continue
        fn = re.search(r'`(\w+)`', r[4])
        found = fn and subprocess.run(['git', '-C', wt, 'grep', '-q', '-P', rf'def {fn.group(1)}\(', 'HEAD'],
                                      capture_output=True).returncode == 0
        say('PASS' if found else 'FAIL', 'data-source', f'lệnh xoá ở nguồn {r[4]!r}: {"có def" if found else "không tìm thấy def"}')
        # Comparing with develop let #19233 pass: develop deleted even more. Only the source of truth can accept a loss.
        unsure = not r[5] or re.match(r'(?i)(chưa kiểm|không\b|\?)', r[5])
        bad = unsure and event == 'APPROVE' and not override
        say('FAIL' if bad else 'PASS', 'data-truth', f'nguồn thật: {r[5]!r}, event {event}')
        shrink = any(int(y) < int(x) for x, y in re.findall(r'(\d+)\s*(?:→|->)\s*(\d+)', r[2]))
        # "The body then says what is deleted and why that is accepted": a loss the source agrees with is still stated.
        if shrink:
            quote = r[6].strip('" `')
            ok = quote_in_body(quote, body)
            say('PASS' if ok else 'FAIL', 'data-body', f'PR head giảm {r[2]!r}; câu trong body: {quote[:50]!r} {"có" if ok else "không có"}')
        probe = shrink and not re.match(r'(?i)đồng ý', r[5])
        ev = pathlib.Path(root, r[7].strip('` ')) if r[7].strip('` -') else None
        ok = ev and ev.is_file() and (not probe or ('before' in ev.read_text() and 'after' in ev.read_text()))
        say('PASS' if ok else 'FAIL', 'data-evid', f'{r[7]!r}: {"có" if ok else "không có file"}{", cần before/after vì mất mà nguồn chưa đồng ý" if probe else ""}')


def check_rollout(text, body, labels, event, override):
    sec = section(text, 'Bước chạy tay') or ''
    keys = ['Ai chạy', 'Con số an toàn', 'Lệnh chứng minh đã xong']
    miss = [k for k in keys if not re.search(rf'{k}:\**[ \t]*\S', sec)]
    say('FAIL' if miss else 'PASS', 'rollout', f'diff có bước chạy tay; thiếu {miss} (#18729 bị revert vì thế)' if miss else 'đủ ba dòng')
    unknown = [k for k in keys if re.search(rf'{k}:\**[ \t]*chưa', sec)]
    bad = unknown and event == 'APPROVE' and not override
    say('FAIL' if bad else 'PASS', 'rollout-gap', f'{unknown or "không dòng nào"} còn "chưa", event {event} (#18729: approve chấp nhận bước viết tay không số, không lệnh kiểm)')
    if not any(l.startswith('release/') for l in labels):
        ok = 'release/' in body or override
        say('PASS' if ok else 'FAIL', 'release-lbl', f'nhãn {labels}, không có release/*; body {"có" if ok else "không"} nêu (AGENTS.local.md:212)')


def main():
    ap = argparse.ArgumentParser()
    for opt in ('--triggers', '--expected', '--wt'):
        ap.add_argument(opt, required=True)
    ap.add_argument('draft')
    ap.add_argument('--labels', default='')
    ap.add_argument('--rv', default=os.environ.get('RV'), required='RV' not in os.environ)
    ap.add_argument('--evid-root', help='thư mục chứa evidence/, mặc định <rv>/reports/reviews')
    a = ap.parse_args()
    root = a.evid_root or f'{a.rv}/reports/reviews'
    text = pathlib.Path(a.draft).read_text()
    override = bool(re.search(r'(?m)^- \*\*Theo ghi đè:\*\*[ \t]*[^\s<].*\b\d{1,2}[:h]\d{2}\b', text))
    m = re.search(r'(?:Planned event|Event): `(\w+)`', text)
    event = m.group(1) if m else None
    say('PASS' if event in ('APPROVE', 'REQUEST_CHANGES', 'COMMENT') else 'FAIL', 'event', f'Planned event = {event}')
    drafted = re.search(r'Reviewed head: `([0-9a-f]{40})`', text)
    current = subprocess.run(['git', '-C', a.wt, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    same = bool(drafted) and drafted.group(1) == current
    say('PASS' if same else 'FAIL', 'head', f'bản nháp review head {drafted.group(1)[:10] if drafted else "?"}, worktree ở {current[:10] or "?"}' + ('' if same else ': head đã đổi hoặc chưa fetch, chạy lại bước 00 và các bước phụ thuộc head'))
    bm = re.search(r'\*\*Body \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao', text, re.S)
    body = bm.group(1) if bm else ''
    posted = body + '\n'.join(re.findall(r'\*\*(?:Comment|Reply) \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao', text, re.S))

    check_points(body, event)
    check_risk(text, event, override)
    check_deletes(text, body, tsv(a.triggers, 'DATA_DELETE'), a.wt, root, event, override)
    if tsv(a.triggers, 'ROLLOUT_MANUAL'):
        check_rollout(text, body, [l for l in a.labels.split(',') if l], event, override)
    if tsv(a.triggers, 'FLAG_SLACK'):
        say('PASS' if 'Heads up' in body else 'FAIL', 'flag', 'câu cờ migration/tiền trong body (AGENTS.local.md:209, :360)')
        say('MANUAL', 'flag-slack', 'đã báo trên Slack: chỉ người kiểm được')
    if tsv(a.triggers, 'CROSS_SERVICE'):
        sec = section(text, 'Request thật qua service kia') or ''
        ok = 'evidence/' in sec or ('chưa kiểm' in sec and (event != 'APPROVE' or override))
        say('PASS' if ok else 'FAIL', 'cross', f'theo request thật qua service kia (#19011, AGENTS.local.md:282): {"có bằng chứng" if "evidence/" in sec else "chưa kiểm" if sec else "thiếu mục"}, event {event}')
    tests = tsv(a.expected)
    if tests:
        sec = section(text, 'Test có độc lập với code không') or ''
        miss = [t[1] for t in tests if t[1] not in sec]
        say('FAIL' if miss else 'PASS', 'test-indep', f'{len(tests) - len(miss)}/{len(tests)} test đã xếp loại' + (f'; thiếu {miss[0]}…' if miss else ''))
    hits = [(name, re.search(pat, posted).group(0)) for pat, name in BANNED if re.search(pat, posted)]
    say('FAIL' if hits else 'PASS', 'voice', f'text sẽ post có: {hits}' if hits else 'không có cụm cấm')
    dup = repeated_phrase(posted)
    say('FAIL' if dup else 'PASS', 'voice-dup', f'cùng một ý viết hai lần: {dup!r}' if dup else 'không lặp ý')
    say('MANUAL', 'voice-human', 'giọng đồng nghiệp, một ý chính: Theo đọc')
    refs = sorted(set(re.findall(r'evidence/[\w./-]+', text)))
    bad = [r for r in refs if not (pathlib.Path(root) / r.rstrip('.,)')).exists()]
    say('FAIL' if bad else 'PASS', 'evid-refs', f'không tồn tại: {bad}' if bad else f'{len(refs)} đường dẫn bằng chứng đều tồn tại')
    sys.exit(1 if 'FAIL' in results else 0)


if __name__ == '__main__':
    main()
