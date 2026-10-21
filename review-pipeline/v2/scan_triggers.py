"""Bật các mục bắt buộc của bản nháp từ diff, không từ mô tả: #19233 tự gọi là "keep conversations" mà vẫn xoá dữ liệu.

Usage: python3.12 scan_triggers.py <worktree> <base> <head> [description.txt]   (chỉ git diff / git show)
Mô tả chỉ được thêm trigger, không bớt: bước index chạy tay của #18729 chỉ nằm trong Rollout Plan.
TSV: trigger, path:line, hàm bao quanh, code. Không có gì thì in NONE.
"""
import re
import subprocess
import sys

DELETE = re.compile(r'(?i)(delete|\bdrop|_drop|prune|purge|truncate|\bremove|_remove|cleanup|clean_up|discard|\$unset|\$pull|re-?key|expire\()')
ROLLOUT_PATH = re.compile(r'^(alembic/|deploy/|.*/jobs/.*\.ya?ml$|charts?/|.*values[^/]*\.ya?ml$|.*\.sql$)')
ROLLOUT_LINE = re.compile(r'(create_index|createIndex|ensure_index|CREATE (UNIQUE )?INDEX|\.command\(|@click\.command|add_column|op\.execute)')
CROSS = re.compile(r'(go_chat|openim|OpenIM|SwagServerClient|outbox|pusher|Pusher)')
# Whole-file scan: Mongo's Outbox model and Pusher sit in many files, so only names that mean our Go/OpenIM side.
CROSS_FILE = re.compile(r'(go_chat|openim|OpenIM|SwagServerClient)')
DESC_ROLLOUT = re.compile(r'(?i)(createIndex|create_index|manually|by hand|pre-deploy|post-deploy|before deploy|after deploy|run (it )?once|one-off)')
FLAG = re.compile(r'(?i)(migration_state|MigrationState|growthbook|kill_switch|ledger|wallet|payment|points\.|escrow)')


def git(wt, *args):
    return subprocess.run(['git', '-C', wt, *args], capture_output=True, text=True, check=True).stdout


def code_part(line):
    s = line.strip()
    return '' if s.startswith(('#', '"', "'", 'def ', 'async def ')) else s.split('  #', 1)[0]


def enclosing(lines, n):
    for i in range(min(n, len(lines)) - 1, -1, -1):
        if m := re.match(r'\s*(?:async\s+)?def\s+(\w+)', lines[i]):
            return m.group(1)
    return '-'


def scan_hunk(wt, head, path, hunk, cache, out):
    if path.startswith('tests/'):
        return
    src = cache.setdefault(path, git(wt, 'show', f'{head}:{path}').splitlines())
    for i, (k, n, t) in enumerate(hunk):
        c = code_part(t)
        if not c:
            continue
        fn = enclosing(src, n) if k != '-' else '-'
        loc = f'{path}:{n}' if k != '-' else f'{path}:-{n}'
        if k != ' ' and DELETE.search(c):
            out.append(('DATA_DELETE', loc, fn, c[:120]))
        # An unchanged delete under a changed condition still changes what gets deleted.
        if k == ' ' and DELETE.search(c) and any(kk == '+' and code_part(tt) for kk, _, tt in hunk[max(0, i - 3):i]):
            out.append(('DATA_DELETE', loc, fn, '(guarded by a changed line) ' + c[:100]))
        if k == '+' and ROLLOUT_LINE.search(c):
            out.append(('ROLLOUT_MANUAL', loc, fn, c[:120]))
        if k != ' ' and CROSS.search(c):
            out.append(('CROSS_SERVICE', loc, fn, c[:120]))
        if k != ' ' and FLAG.search(c):
            out.append(('FLAG_SLACK', loc, fn, c[:120]))


def main(wt, base, head, desc=None):
    out = []
    for p in git(wt, 'diff', '--name-only', '--diff-filter=d', base, head).split():
        if ROLLOUT_PATH.match(p):
            out.append(('ROLLOUT_MANUAL', f'{p}:1', '-', '(deploy file)'))
        if p.startswith('swag/migration/'):
            out.append(('FLAG_SLACK', f'{p}:1', '-', '(under swag/migration/)'))
        # #19011 changed only lines inside a file that already calls Go; the changed lines named nothing cross-service.
        if p.endswith('.py') and not p.startswith('tests/') and (m := CROSS_FILE.search(git(wt, 'show', f'{head}:{p}'))):
            out.append(('CROSS_SERVICE', f'{p}:1', '-', f'(file uses {m.group(0)})'))
    for n, line in enumerate(open(desc).read().splitlines() if desc else [], 1):
        if DESC_ROLLOUT.search(line):
            out.append(('ROLLOUT_MANUAL', f'description:{n}', '-', line.strip()[:120]))
    path, hunk, cache, new_no, old_no = None, [], {}, 0, 0
    for line in git(wt, 'diff', '-U3', base, head, '--', '*.py').splitlines():
        if line.startswith('diff --git'):
            if path and hunk:
                scan_hunk(wt, head, path, hunk, cache, out)
            path, hunk = None, []
        elif line.startswith('+++ '):
            path = line[6:] if line.startswith('+++ b/') else None
        elif line.startswith('--- '):
            continue
        elif line.startswith('@@'):
            if path and hunk:
                scan_hunk(wt, head, path, hunk, cache, out)
            m = re.match(r'@@ -(\d+)(?:,\d+)? \+(\d+)', line)
            hunk, old_no, new_no = [], int(m.group(1)), int(m.group(2))
        elif path and line[:1] == '-':
            hunk.append(('-', old_no, line[1:]))
            old_no += 1
        elif path and line[:1] in '+ ':
            hunk.append((line[0], new_no, line[1:]))
            new_no += 1
            old_no += line[0] == ' '
    if path and hunk:
        scan_hunk(wt, head, path, hunk, cache, out)
    seen = set()
    for row in out:
        if row[:2] not in seen:
            seen.add(row[:2])
            print('\t'.join(row))
    if not out:
        print('NONE')


if __name__ == '__main__':
    main(*sys.argv[1:5])
