"""check_runs.py [--head SHA] [--changed FILE] <log>...   Each "== ... ==" block of an evidence log must prove the run happened before anyone reads it.

run_pr_tests.sh drops pytest's exit code (replay/rc-loss.txt), so a block without pytest_rc= cannot tell
"nothing failed" from "nothing ran"; a block written before run_tests_rc.sh existed fails here on purpose.
"""
import re
import sys

SUMMARY = re.compile(r'\b(\d+) (passed|failed|errors?)\b')
fails = 0


def say(status, where, msg):
    global fails
    fails += status == 'FAIL'
    print(f'RUNS: {status:6} {where:28} {msg}')


args = sys.argv[1:]
head = None
if '--head' in args:
    at = args.index('--head')
    head = args[at + 1][:10]
    del args[at:at + 2]
changed = None
if '--changed' in args:
    at = args.index('--changed')
    changed = open(args[at + 1]).read().split()
    del args[at:at + 2]
# A diff of documents only has no test to run; any other file in it keeps every check below.
if changed and all(re.search(r'\.(md|rst|txt)$', f) for f in changed):
    say('PASS', 'docs-only', f'{len(changed)} file(s), all .md/.rst/.txt: no test applies')
    sys.exit(0)
blocks, text = [], ''
for path in args:
    t = open(path).read()
    text += t
    for m in re.finditer(r'^== (.*?) ==\n(.*?)(?=^== |\Z)', t, re.S | re.M):
        blocks.append((f'{path.split("/")[-1]}:{t[:m.start()].count(chr(10)) + 1}', m.group(1), m.group(2)))

if not blocks:
    say('FAIL', '-', 'không có khối "== ... ==" nào: chưa có lần chạy nào được ghi')
for where, title, body in blocks:
    if 'VOID' in body:
        say('FAIL', where, f'{title[:40]!r}: có VOID')
    elif not SUMMARY.search(body) and 'RV::' not in body:
        say('FAIL', where, f'{title[:40]!r}: không có dòng tổng kết pytest hay dòng RV:: của probe')
    rc = re.findall(r'pytest_rc=(\w+)', body)
    if not rc:
        say('FAIL', where, f'{title[:40]!r}: không ghi pytest_rc (chạy bằng run_tests_rc.sh)')
    elif any(r not in ('0', '1') for r in rc):
        say('FAIL', where, f'{title[:40]!r}: pytest_rc={rc} (2 ngắt, 3 lỗi nội bộ, 4 sai tham số, 5 không có test)')
    else:
        say('PASS', where, f'{title[:40]!r}: rc={rc}')

scope = text
mine = blocks
if head:
    starts = [m.start() for m in re.finditer(rf'^== (?=[^\n]*{head})(?=[^\n]*[Tt]rial)[^\n]*==$', text, re.M)]
    scope = text[starts[-1]:] if starts else ''
    mine = [b for b in blocks if head in b[1]]
m = re.search(r'only on trial: (\d+)', scope)
say('PASS' if m else 'FAIL', 'trial-vs-develop', f'only on trial = {m.group(1)}' if m else f'không có khối trial trên head {head} kèm dòng "only on trial: N"' if head else 'không có dòng "only on trial: N" (trial với develop)')
dev = [b for b in mine if re.search(r'(?i)on develop|develop code', b[1]) and re.search(r'\b[1-9]\d* failed', b[2])]
say('PASS' if dev else 'FAIL', 'new-tests-on-develop', f'{dev[0][0]}' if dev else f'không có khối "test mới chạy trên develop" có failed > 0{f" trên head {head}" if head else ""}')
sys.exit(1 if fails else 0)
