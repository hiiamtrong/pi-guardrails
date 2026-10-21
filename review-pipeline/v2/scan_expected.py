"""Liệt kê test mới/sửa mà giá trị mong đợi đến từ lời gọi hàm, hoặc là hằng số cần đối chiếu với trạng thái trước
(AGENTS.local.md:351). Heuristic để buộc xếp loại từng test, không phải phán quyết: #19233 L863 dựng expected sau
_rebuild của chính PR, còn số viết cứng (1, 3) ở L869 lại khoá đúng việc 7 message còn 3.

Usage: python3.12 scan_expected.py <worktree> <base> <head>
TSV mỗi test một dòng: path:line, test, from-call=<biến@dòng>, literal=<giá trị@dòng>. Không có thì in NONE.
"""
import ast
import re
import subprocess
import sys


def git(wt, *args):
    return subprocess.run(['git', '-C', wt, *args], capture_output=True, text=True, check=True).stdout


def added_lines(wt, base, head, path):
    rows = set()
    for m in re.finditer(r'^@@ -\S+ \+(\d+)(?:,(\d+))? @@', git(wt, 'diff', '-U0', base, head, '--', path), re.M):
        start, count = int(m.group(1)), int(m.group(2) or 1)
        rows.update(range(start, start + count))
    return rows


def main(wt, base, head):
    files = [p for p in git(wt, 'diff', '--name-only', '--diff-filter=d', base, head).split() if p.startswith('tests/') and p.endswith('.py')]
    found = 0
    for p in files:
        touched = added_lines(wt, base, head, p)
        tree = ast.parse(git(wt, 'show', f'{head}:{p}'))
        for fn in (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name.startswith('test_')):
            if not touched & set(range(fn.lineno, fn.end_lineno + 1)):
                continue
            from_call = {n.targets[0].id: n.lineno for n in ast.walk(fn)
                         if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                         and 'expect' in n.targets[0].id.lower() and any(isinstance(x, ast.Call) for x in ast.walk(n.value))}
            calls, literals = [], []
            for n in ast.walk(fn):
                if isinstance(n, ast.Assert) and isinstance(n.test, ast.Compare):
                    names = {x.id for x in ast.walk(n.test) if isinstance(x, ast.Name)}
                    calls += [f'{v}@L{from_call[v]}' for v in names & from_call.keys()]
                    literals += [f'{ast.unparse(c)}@L{n.lineno}' for c in n.test.comparators if isinstance(c, ast.Tuple)]
            if calls or literals:
                found += 1
                print(f"{p}:{fn.lineno}\t{fn.name}\tfrom-call={','.join(sorted(set(calls))) or '-'}\tliteral={';'.join(literals) or '-'}")
    if not found:
        print('NONE')


if __name__ == '__main__':
    main(*sys.argv[1:4])
