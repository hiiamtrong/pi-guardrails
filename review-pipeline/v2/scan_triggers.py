"""Bật các mục bắt buộc của bản nháp từ diff, không từ mô tả: #19233 tự gọi là "keep conversations" mà vẫn xoá dữ liệu.

Usage: python3.12 scan_triggers.py <worktree> <base> <head> [description.txt]   (chỉ git diff / git show)
Mô tả chỉ được thêm trigger, không bớt: bước index chạy tay của #18729 chỉ nằm trong Rollout Plan.
TSV: trigger, path:line, hàm bao quanh, code. Không có gì thì in NONE.
"""
import ast
import re
import subprocess
import sys
import warnings

DELETE = re.compile(r'(?i)(delete|\bdrop|_drop|prune|purge|truncate|\bremove|_remove|cleanup|clean_up|discard|\$unset|\$pull|re-?key|expire\()')
ROLLOUT_PATH = re.compile(r'^(alembic/|deploy/|.*/jobs/.*\.ya?ml$|charts?/|.*values[^/]*\.ya?ml$|.*\.sql$)')
ROLLOUT_LINE = re.compile(r'(create_index|createIndex|ensure_index|CREATE (UNIQUE )?INDEX|\.command\(|@click\.command|add_column|op\.execute)')
CROSS = re.compile(r'(go_chat|openim|OpenIM|SwagServerClient|outbox|pusher|Pusher)')
# Whole-file scan: Mongo's Outbox model and Pusher sit in many files, so only names that mean our Go/OpenIM side.
CROSS_FILE = re.compile(r'(go_chat|openim|OpenIM|SwagServerClient)')
DESC_ROLLOUT = re.compile(r'(?i)(createIndex|create_index|manually|by hand|pre-deploy|post-deploy|before deploy|after deploy|run (it )?once|one-off)')
# Go side (swag-openim): "openim" is in every import path there, so cross-service means a call to swag-server.
GO_CROSS = re.compile(r'(SwagServerClient|swag_server|swagServer|send/validate|webhooks/(afterSend|sendFailed|shareFailed|shareDeliveryCompleted))')
GO_CROSS_DIR = re.compile(r'^internal/infrastructure/client/')
FLAG = re.compile(r'(?i)(migration_state|MigrationState|growthbook|kill_switch|ledger|wallet|payment|points\.|escrow)')

# Dòng đọc một giá trị rồi xử lý rỗng hoặc đặt mặc định: nơi một giả định về dữ liệu thật nằm.
GUARD = re.compile(r"""(?x)
    \bor\s+(?:['"\d\[\{]|None\b|True\b|False\b|[A-Z]\w*\.[A-Z_]+)
  | \band\b
  | \bif\b.+\belse\b
  | \.get\(\s*['"]\w+['"]\s*,
  | getattr\([^,()]+,\s*['"]\w+['"]\s*,
  | \bis\s+(?:not\s+)?None\b
  | \bOptional\[
  | \|\s*None\b
  | =\s*None\b
  | nullable\s*=\s*True
""")
KEYED = re.compile(r"""(?:\[\s*['"]|\.get\(\s*['"]|getattr\([^,()]+,\s*['"])([A-Za-z_]\w{2,})\b""")
CHAIN = re.compile(r'\b[A-Za-z_]\w*((?:\.[A-Za-z_]\w*)+)')
GENERIC = {'self', 'cls', 'get', 'items', 'keys', 'values', 'datetime'}


def git(wt, *args):
    return subprocess.run(['git', '-C', wt, *args], capture_output=True, text=True, check=True).stdout


def code_part(line):
    s = line.strip()
    return '' if s.startswith(('#', '//', '"', "'", 'def ', 'async def ', 'func ')) else s.split('  #', 1)[0]


def enclosing(lines, n):
    for i in range(min(n, len(lines)) - 1, -1, -1):
        if m := re.match(r'\s*(?:async\s+)?def\s+(\w+)|func\s+(?:\([^)]*\)\s*)?(\w+)', lines[i]):
            return m.group(1) or m.group(2)
    return '-'


def scan_hunk(wt, head, path, hunk, cache, out):
    if path.startswith('tests/') or path.endswith('_test.go'):
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
        if k != ' ' and (GO_CROSS if path.endswith('.go') else CROSS).search(c):
            out.append(('CROSS_SERVICE', loc, fn, c[:120]))
        if k != ' ' and FLAG.search(c):
            out.append(('FLAG_SLACK', loc, fn, c[:120]))


def reads(text):
    """Đường dẫn thuộc tính bỏ biến đầu: `session.mode.nbf` cho `mode` và `mode.nbf`, nên `show.nbf` ở chỗ khác trong file không che nó."""
    keys = set(KEYED.findall(text))
    for m in CHAIN.finditer(text):
        parts = m.group(1).split('.')[1:]
        if text[m.end():m.end() + 1] == '(':
            parts = parts[:-1]
        keys.update('.'.join(parts[:i]) for i in range(1, len(parts) + 1))
    return {k for k in keys if len(k.split('.')[-1]) >= 3 and k.split('.')[-1] not in GENERIC and not k.split('.')[-1][:1].isupper()}


def show(wt, rev, path):
    try:
        return git(wt, 'show', f'{rev}:{path}')
    except subprocess.CalledProcessError:
        return ''  # file mới của PR chưa có ở base


def docstring_lines(src):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            tree = ast.parse(src)
    except SyntaxError:
        return set()
    return {n for node in ast.walk(tree) if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str) for n in range(node.lineno, node.end_lineno + 1)}


def writers(wt, head, ident, near, skip):
    """Chỗ ghi `ident` trong code không phải test. Lệnh ghi vào DB (`set_on_insert__mode=`, `set__mode__nbf=` của MongoEngine) đứng
    trước, rồi file cùng thư mục với dòng đang xét: một giá trị như `mode` có hàng chục chỗ ghi, chỗ tạo ra bản ghi mới mới là chỗ cần mở."""
    pat = re.compile(rf'(?:(?<!\w)|(?<=__)){ident}(?:__\w+)?\s*=[^=]|[\'"]{ident}[\'"]\s*:')
    persist = re.compile(rf'__{ident}(?:__\w+)?\s*=[^=]')
    found = []
    for row in git(wt, 'grep', '-n', '-F', ident, head, '--', '*.py', ':!tests').splitlines():
        f, ln, text = row.removeprefix(head + ':').split(':', 2)
        if (f, int(ln)) not in skip and pat.search(text):
            found.append((f, int(ln), bool(persist.search(text))))
    prefix = '/'.join(near.split('/')[:3])
    found.sort(key=lambda w: (not w[2], not w[0].startswith(prefix), w[0], w[1]))
    return [f'{f}:{n}' for f, n, _ in found]


def added_lines(wt, base, head):
    path, n, out = None, 0, []
    for line in git(wt, 'diff', '-U0', base, head, '--', '*.py').splitlines():
        if line.startswith('+++ '):
            path = line[6:] if line.startswith('+++ b/') else None
        elif line.startswith('@@'):
            n = int(re.match(r'@@ -\S+ \+(\d+)', line).group(1))
        elif path and line.startswith('+') and not line.startswith('+++'):
            if not path.startswith('tests/'):
                out.append((path, n, line[1:]))
            n += 1
    return out


def value_origins(wt, base, head):
    """Giá trị PR bắt đầu đọc trong một file, trên dòng có xử lý rỗng hoặc mặc định, kèm nơi code khác ghi ra nó.
    #19308 đọc session.mode.nbf và test dựng session không có mode; activate_session ghi mode=free, nbf=now thì không ai mở.
    Heuristic để buộc truy về chỗ ghi, không phải phán quyết."""
    rows = added_lines(wt, base, head)
    skip = {(p, n) for p, n, _ in rows}
    old, src, doc, seen = {}, {}, {}, {}
    for path, n, text in rows:
        if path not in src:
            src[path] = show(wt, head, path)
            doc[path] = docstring_lines(src[path])
            old[path] = reads(show(wt, base, path))
        c = text.strip().split('  #', 1)[0]
        if not c or c.startswith('#') or n in doc[path] or not GUARD.search(c):
            continue
        for key in sorted(reads(c) - old[path]):
            seen.setdefault(key.split('.')[-1], (path, n, c))
    out = []
    for ident, (path, n, c) in seen.items():
        found = writers(wt, head, ident, path, skip)
        where = ('ghi ở ' + ', '.join(found[:3]) + (f' (+{len(found) - 3})' if len(found) > 3 else '')) if found else 'không có chỗ ghi trong code'
        out.append(('VALUE_ORIGIN', f'{path}:{n}', enclosing(src[path].splitlines(), n), f'{ident} | {where} | {c[:80]}'))
    return out


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
        if GO_CROSS_DIR.match(p) and not p.endswith('_test.go'):
            out.append(('CROSS_SERVICE', f'{p}:1', '-', '(swag-server client)'))
    for n, line in enumerate(open(desc).read().splitlines() if desc else [], 1):
        if DESC_ROLLOUT.search(line):
            out.append(('ROLLOUT_MANUAL', f'description:{n}', '-', line.strip()[:120]))
    path, hunk, cache, new_no, old_no = None, [], {}, 0, 0
    for line in git(wt, 'diff', '-U3', base, head, '--', '*.py', '*.go').splitlines():
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
    out.extend(value_origins(wt, base, head))
    seen = set()
    for row in out:
        if row[:2] not in seen:
            seen.add(row[:2])
            print('\t'.join(row))
    if not out:
        print('NONE')


if __name__ == '__main__':
    main(*sys.argv[1:5])
