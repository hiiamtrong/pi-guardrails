import html, re, sys

def inline(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    return re.sub(r'\*([^*]+)\*', r'<b>\1</b>', text)

blocks, items = [], []
for line in open(sys.argv[1], encoding='utf-8').read().split('\n'):
    if line.startswith('• '):
        items.append(inline(line[2:]))
        continue
    if items:
        blocks.append('<ul>' + ''.join(f'<li>{item}</li>' for item in items) + '</ul>')
        items = []
    if line.strip():
        blocks.append(f'<p>{inline(line)}</p>')
if items:
    blocks.append('<ul>' + ''.join(f'<li>{item}</li>' for item in items) + '</ul>')
sys.stdout.write('<meta charset="utf-8">' + ''.join(blocks))
