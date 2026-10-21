"""Sinh danh sách id cho guard từ bảng "## Comment đã có" của bản nháp, thay cho `comments_seen.sh --ids` (lệnh đó
ghi mọi id đang có, kể cả cái chưa ai đọc, nên guard xanh ngay). Đồng thời kiểm từng dòng đã xếp loại thật.

Usage: python3.12 seen_from_table.py <draft.md>      in "kind:id" đã sort (LC_ALL=C) ra stdout; lỗi ra stderr
Exit 1 nếu thiếu bảng, bảng ghi "điền sau", hoặc có dòng xếp loại không hợp lệ.
"""
import re
import sys

KINDS = ('đúng', 'vô hại', 'không thuộc pr này', 'chưa kiểm')
ONLY_READ = re.compile(r'(?i)(chưa chạy|chỉ đọc|not run|only read)')


def rows(text):
    m = re.search(r'^## Comment đã có[^\n]*\n(.*?)(?=^## |\Z)', text, re.S | re.M)
    if not m:
        return None, []
    head = text[m.start():text.index('\n', m.start())]
    out = []
    for line in m.group(1).splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 5 or set(cells[0]) <= set('-: ') or cells[0] == 'id':
            continue
        out.append((line, cells))
    return head, out


def main(path):
    text = open(path).read()
    head, table = rows(text)
    errors, ids = [], []
    if head is None:
        errors.append('thiếu mục "## Comment đã có"')
    elif re.search(r'(?i)điền sau', head):
        errors.append(f'tiêu đề bảng hoãn việc đọc: {head!r}')
    for line, cells in table:
        idm = re.match(r'(inline|review|conv)\W+(\d+)', cells[0].replace('`', ' '))
        if not idm:
            errors.append(f'không đọc được id: {cells[0]!r}')
            continue
        kind = cells[3].replace('*', '').strip().lower()
        label = next((k for k in KINDS if kind.startswith(k)), None)
        evidence = cells[4]
        if label is None:
            errors.append(f'{idm.group(1)}:{idm.group(2)} loại {cells[3]!r} không thuộc {KINDS}')
        elif label in ('đúng', 'vô hại') and not evidence:
            errors.append(f'{idm.group(1)}:{idm.group(2)} xếp "{label}" mà không có bằng chứng')
        elif label == 'vô hại' and ONLY_READ.search(evidence):
            errors.append(f'{idm.group(1)}:{idm.group(2)} xếp "vô hại" chỉ bằng đọc code ({evidence[:60]!r}): chạy thử, hoặc đổi thành "chưa kiểm"')
        ids.append(f'{idm.group(1)}:{idm.group(2)}')
    for e in errors:
        print(f'TABLE: {e}', file=sys.stderr)
    print('\n'.join(sorted(set(ids), key=lambda s: s.encode())))
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main(sys.argv[1])
