"""check_draft.py <draft.md> --triggers T.tsv --expected E.tsv --wt <worktree> [--labels a,b]

On #19233 every gate that existed was a WARNING or a human read; these are the checks that must stop the post.
"""
import argparse
import os
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import triggers_config as tc  # noqa: E402

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
V = None
POINTER = re.compile(r'https?://\S+|evidence/\S+|[\w./-]+\.\w+:\d+')
# An agreement is read again from a URL, an evidence file, a file:line, a comment id, a commit, a PR/issue number or a dated note; "đã hỏi" alone is not.
AGREE_POINTER = re.compile(r'https?://\S+|evidence/\S+|[\w./-]+\.\w+:\d+|(?<![\w.])\d{7,}(?![\w.])|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|#\d{2,}|\b\d{4}-\d{2}-\d{2}\b')
DELETER_WINDOW = 80


def vocab():
    global V
    V = V or tc.load()
    return V


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


def origin_missing(sec, rows, wt):
    """Giá trị của VALUE_ORIGIN chưa có dòng nào trong mục vừa nêu tên, vừa trích một chỗ ghi thật (file.py:dòng trong worktree, tên
    nằm trong 2 dòng quanh đó) hoặc nói không có chỗ ghi: một `file.py:dòng` bịa không qua được."""
    def cited(ident, line):
        for path, n in re.findall(r'([\w./-]+\.py):(\d+)', line):
            try:
                src = (pathlib.Path(wt) / path).read_text().splitlines()
            except OSError:
                continue
            if re.search(rf'(?<![A-Za-z0-9]){re.escape(ident)}', '\n'.join(src[max(0, int(n) - 3):int(n) + 2])):
                return True
        return False

    return [i for i in dict.fromkeys(r[3].split(' | ')[0] for r in rows)
            if not any(re.search(rf'\b{re.escape(i)}\b', l) and ('không có chỗ ghi' in l or cited(i, l)) for l in sec.splitlines())]


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


# Same shape as the block build_payload.py turns into an inline comment; a heading that does not match is dropped without a word.
INLINE_BLOCK = re.compile(
    r'^### \d+\. `([^`]+)` L(\d+)(?:-L(\d+))? \((?:RIGHT|LEFT)\)\s*\n\n'
    r'\*\*Comment \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao', re.S | re.M)
CODE_LINE = re.compile(r'`[\w./-]+\.(?:py|go|ts|js|sql|sh|ya?ml):\d+(?:-\d+)?`')


def check_inline(text, body, event=None):
    """A finding tied to a line goes in an inline comment the author can apply with a click, not only in the body (#19323: a type-hint
    finding on four lines sat in the body of four reviews with no inline comment)."""
    marked = len(re.findall(r'(?m)^\*\*Comment \(EN, sẽ post\):\*\*', text))
    blocks = INLINE_BLOCK.findall(text)
    if marked != len(blocks):
        say('FAIL', 'inline-form', f'{marked} khối "Comment (EN, sẽ post)" nhưng build_payload chỉ đọc được {len(blocks)}: heading phải là "### N. `path` L12 (RIGHT)" rồi dòng trống, "**Comment (EN, sẽ post):**", "**Vì sao"')
    if blocks:
        say('PASS', 'inline', f'{len(blocks)} inline comment trong {len({b[0] for b in blocks})} file')
        return
    yes = [i for i, label in enumerate(POINTS[:6], 1) if re.search(rf'(?m)^{i}\. {re.escape(label)}: Yes\b', body)]
    cited = CODE_LINE.findall(body)
    if yes or cited or event == 'REQUEST_CHANGES':
        why = []
        if yes:
            why.append(f'điểm {yes} trả lời Yes')
        if cited:
            why.append(f'body trỏ {cited[0]}')
        if event == 'REQUEST_CHANGES':
            why.append('event REQUEST_CHANGES')
        why = ', '.join(why)
        say('MANUAL', 'inline', f'không có inline comment mà {why}: finding gắn dòng nên là inline kèm `suggestion` (AGENTS.local.md:197, :426); bỏ qua nếu là finding cấp PR (mô tả, nhãn, stack)')
    else:
        say('PASS', 'inline', 'không có finding nào cần gắn dòng')


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


def source_def(name):
    """git grep -P pattern for the definition of `name`: def, func, function, fn, fun, sub, a JS assignment, or a Java-style method."""
    n = re.escape(name)
    return (rf'(?:\b(?:def|func|function|fn|fun|sub)\s+(?:\([^)]*\)\s*)?{n}\b'
            rf'|\b{n}\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)'
            rf'|\b(?:public|private|protected|static|internal)[\w<>\[\], ?]*\s+{n}\s*\()')


def definitions(wt, name):
    r = subprocess.run(['git', '-C', wt, 'grep', '-n', '-P', source_def(name), 'HEAD'], capture_output=True, text=True)
    return [(row.split(':')[1], int(row.split(':')[2])) for row in r.stdout.splitlines()]


def deletes_something(wt, name):
    """A function named as the deleter at the source must itself call something that removes data (the repo's `delete` vocabulary)."""
    for path, line in definitions(wt, name):
        src = subprocess.run(['git', '-C', wt, 'show', f'HEAD:{path}'], capture_output=True, text=True).stdout.splitlines()
        if vocab().delete.search('\n'.join(src[line:line + DELETER_WINDOW])):
            return True
    return False


def check_deletes(text, body, deletes, wt, root, event, override, final=True):
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
        defined = bool(fn) and bool(definitions(wt, fn.group(1)))
        # A row the draft marks `N/A:` claims there is no deleter (a false alarm of the scanner): the name still has to exist, it need not delete.
        none = bool(re.match(r'(?i)n/?a\b', r[5]))
        real = defined and (none or deletes_something(wt, fn.group(1)))
        why = ('có def, dòng N/A nên không cần lệnh xoá' if none else 'có def và trong ' + str(DELETER_WINDOW) + ' dòng sau có lệnh xoá') if real else ('có def nhưng không có lệnh xoá nào trong ' + str(DELETER_WINDOW) + ' dòng sau (khớp triggers.delete)' if defined else 'không tìm thấy def hay func')
        say('PASS' if real else 'FAIL', 'data-source', f'lệnh xoá ở nguồn {r[4]!r}: {why}')
        # Comparing with develop let #19233 pass: develop deleted even more. Only the source of truth can accept a loss.
        agreed = bool(re.match(r'(?i)đồng ý', r[5]))
        unsure = not r[5] or re.match(r'(?i)(chưa kiểm|không\b|\?)', r[5])
        bad = unsure and event == 'APPROVE' and not override
        say('FAIL' if bad else 'PASS', 'data-truth', f'nguồn thật: {r[5]!r}, event {event}')
        if agreed and not AGREE_POINTER.search(r[5]):
            say('FAIL', 'data-agree', f'"đồng ý" phải trỏ tới nơi đọc được (URL, evidence/..., file:dòng, id comment, commit, #PR hay ngày duyệt): {r[5]!r}')
        shrink = any(int(y) < int(x) for x, y in re.findall(r'(\d+)\s*(?:→|->)\s*(\d+)', r[2]))
        # "The body then says what is deleted and why that is accepted": a loss the source agrees with is still stated.
        if shrink and final:
            quote = r[6].strip('" `')
            ok = quote_in_body(quote, body)
            say('PASS' if ok else 'FAIL', 'data-body', f'PR head giảm {r[2]!r}; câu trong body: {quote[:50]!r} {"có" if ok else "không có"}')
        probe = shrink and not agreed
        ev = pathlib.Path(root, r[7].strip('` ')) if r[7].strip('` -') else None
        evidence = ev.read_text() if ev and ev.is_file() else ''
        numbers = {n for pair in re.findall(r'(\d+)\s*(?:→|->)\s*(\d+)', r[2]) for n in pair}
        missing = sorted(n for n in numbers if not re.search(rf'(?<!\d){n}(?!\d)', evidence)) if shrink else []
        ok = bool(ev and ev.is_file()) and not missing and (not probe or ('before' in evidence and 'after' in evidence))
        say('PASS' if ok else 'FAIL', 'data-evid', f'{r[7]!r}: ' + ('có' if ok else ('không có file' if not (ev and ev.is_file()) else f'thiếu số {missing} của {r[2]!r}' if missing else 'cần before/after')) + (', cần before/after vì mất mà nguồn chưa đồng ý' if probe and ok else ''))


def check_rollout(text, body, labels, event, override, final=True):
    sec = section(text, 'Bước chạy tay') or ''
    keys = ['Ai chạy', 'Con số an toàn', 'Lệnh chứng minh đã xong']
    miss = [k for k in keys if not re.search(rf'{k}:\**[ \t]*\S', sec)]
    say('FAIL' if miss else 'PASS', 'rollout', f'diff có bước chạy tay; thiếu {miss} (#18729 bị revert vì thế)' if miss else 'đủ ba dòng')
    unknown = [k for k in keys if re.search(rf'{k}:\**[ \t]*chưa', sec)]
    bad = unknown and event == 'APPROVE' and not override
    say('FAIL' if bad else 'PASS', 'rollout-gap', f'{unknown or "không dòng nào"} còn "chưa", event {event} (#18729: approve chấp nhận bước viết tay không số, không lệnh kiểm)')
    if final and not any(l.startswith('release/') for l in labels):
        ok = 'release/' in body or override
        say('PASS' if ok else 'FAIL', 'release-lbl', f'nhãn {labels}, không có release/*; body {"có" if ok else "không"} nêu (AGENTS.local.md:212)')


def check_cross_file(text, rows, event, override):
    """A file that already talks to another service changed, but not necessarily the call: the draft says why that call is untouched, or follows it."""
    sec = section(text, 'Request thật qua service kia') or ''
    for r in rows:
        path = r[1].rsplit(':', 1)[0]
        tail = '/'.join(path.split('/')[-2:])
        line = next((l for l in sec.splitlines() if tail in l), '')
        ok = 'evidence/' in line or bool(re.search(r'(?i)không (đụng|liên quan).{15,}', line)) or ('chưa kiểm' in line and event != 'APPROVE') or override
        say('PASS' if ok else 'FAIL', 'cross-file', f'{path} {r[3]}: ' + ('đã nêu' if ok else f'chưa có dòng nêu "{tail}" với "không đụng đường gọi: <lý do>" hay evidence/'))


def check_config(text, rows, event, override):
    sec = section(text, 'Cấu hình khai báo mà code không đọc') or ''
    for r in rows:
        line = next((l for l in sec.splitlines() if re.search(rf'\b{re.escape(r[3])}\b', l)), '')
        unread = bool(re.search(r'(?i)không ai đọc', line))
        ok = unread or bool(POINTER.search(line))
        say('PASS' if ok else 'FAIL', 'config-unread', f'{r[1]} {r[3]}: ' + ('có chỗ đọc, bằng chứng hay "không ai đọc"' if ok else 'khai báo mà không thấy code đọc; nêu tên khoá cùng file:dòng đọc nó, URL, evidence/ hay "không ai đọc"'))
        if unread and event == 'APPROVE' and not override:
            say('FAIL', 'config-gap', f'{r[3]}: "không ai đọc" mà vẫn APPROVE (swag-openim #66: khai báo không có nghĩa là được dùng)')


def run_outside(a, text, body, event, override, root, final):
    """The checks of step 04. `final` is False when the body is not written yet (gate 04): the checks that quote the body wait for gate 05."""
    check_deletes(text, body, tsv(a.triggers, 'DATA_DELETE'), a.wt, root, event, override, final)
    if tsv(a.triggers, 'ROLLOUT_MANUAL'):
        check_rollout(text, body, [l for l in a.labels.split(',') if l], event, override, final)
    if final and tsv(a.triggers, 'FLAG_SLACK'):
        say('PASS' if 'Heads up' in body else 'FAIL', 'flag', 'câu cờ migration/tiền trong body (AGENTS.local.md:209, :360)')
        say('MANUAL', 'flag-slack', 'đã báo trên Slack: chỉ người kiểm được')
    if tsv(a.triggers, 'CROSS_SERVICE'):
        sec = section(text, 'Request thật qua service kia') or ''
        ok = 'evidence/' in sec or ('chưa kiểm' in sec and (event != 'APPROVE' or override))
        say('PASS' if ok else 'FAIL', 'cross', f'theo request thật qua service kia (#19011, AGENTS.local.md:282): {"có bằng chứng" if "evidence/" in sec else "chưa kiểm" if sec else "thiếu mục"}, event {event}')
    rows = tsv(a.triggers, 'CROSS_FILE')
    if rows:
        check_cross_file(text, rows, event, override)
    rows = tsv(a.triggers, 'CONFIG_UNREAD')
    if rows:
        check_config(text, rows, event, override)


def main():
    ap = argparse.ArgumentParser()
    for opt in ('--triggers', '--expected', '--wt'):
        ap.add_argument(opt, required=True)
    ap.add_argument('draft')
    ap.add_argument('--labels', default='')
    ap.add_argument('--step', choices=['04'], help='chỉ chạy các kiểm tra của bước 04 (chưa có body, nên bỏ các kiểm tra cần body)')
    ap.add_argument('--rv', default=os.environ.get('RV'), required='RV' not in os.environ)
    ap.add_argument('--evid-root', help='thư mục chứa evidence/, mặc định <rv>/reports/reviews')
    a = ap.parse_args()
    root = a.evid_root or f'{a.rv}/reports/reviews'
    text = pathlib.Path(a.draft).read_text()
    override = bool(re.search(r'(?m)^- \*\*Theo ghi đè:\*\*[ \t]*[^\s<].*\b\d{1,2}[:h]\d{2}\b', text))
    m = re.search(r'(?:Planned event|Event): `(\w+)`', text)
    event = m.group(1) if m else None
    if a.step == '04':
        run_outside(a, text, '', event, override, root, final=False)
        sys.exit(1 if 'FAIL' in results else 0)
    say('PASS' if event in ('APPROVE', 'REQUEST_CHANGES', 'COMMENT') else 'FAIL', 'event', f'Planned event = {event}')
    drafted = re.search(r'Reviewed head: `([0-9a-f]{40})`', text)
    current = subprocess.run(['git', '-C', a.wt, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    same = bool(drafted) and drafted.group(1) == current
    say('PASS' if same else 'FAIL', 'head', f'bản nháp review head {drafted.group(1)[:10] if drafted else "?"}, worktree ở {current[:10] or "?"}' + ('' if same else ': head đã đổi hoặc chưa fetch, chạy lại bước 00 và các bước phụ thuộc head'))
    bm = re.search(r'\*\*Body \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao', text, re.S)
    body = bm.group(1) if bm else ''
    posted = body + '\n'.join(re.findall(r'\*\*(?:Comment|Reply) \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao', text, re.S))

    check_points(body, event)
    check_inline(text, body, event)
    check_risk(text, event, override)
    run_outside(a, text, body, event, override, root, final=True)
    origins = tsv(a.triggers, 'VALUE_ORIGIN')
    if origins:
        miss = origin_missing(section(text, 'Giá trị có thể rỗng do ai ghi') or '', origins, a.wt)
        say('FAIL' if miss else 'PASS', 'origin', f'{len(origins) - len(miss)}/{len(origins)} giá trị đã truy về chỗ ghi' + (f'; thiếu {miss[0]}…: dòng phải nêu tên giá trị và trích file.py:dòng có thật, tên nằm trong 2 dòng quanh đó' if miss else '') + ' (#19308: test dựng dữ liệu khác với activate_session thật)')
        say('MANUAL', 'origin-test', 'test dựng dữ liệu qua đúng chỗ ghi đó, không tự dựng: chỉ người kiểm được')
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
