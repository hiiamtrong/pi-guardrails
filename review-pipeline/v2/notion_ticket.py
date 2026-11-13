"""notion_ticket.py <page-id> <out.md>   A Notion page as markdown over the public API, for a pod with no browser.

notion2md reads the page through a logged-in Chrome profile, which the review pod does not have. This reads the API instead: the token comes from
NOTION_TOKEN, the page must be shared with that integration, and the output keeps the two lines fetch_ticket.sh checks (Task ID, title).
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = 'https://api.notion.com/v1'
VERSION = '2022-06-28'


def call(path, token):
    req = urllib.request.Request(f'{API}/{path}', headers={'Authorization': f'Bearer {token}', 'Notion-Version': VERSION})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError:
        raise
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
        sys.exit(f'TICKET: FAIL  gọi Notion lỗi: {err}')


def children(block_id, token):
    """Every child block: Notion answers at most 100 per call and says has_more, and a ticket that loses its tail loses requirements."""
    out, cursor = [], None
    while True:
        path = f'blocks/{block_id}/children?page_size=100' + (f'&start_cursor={cursor}' if cursor else '')
        page = call(path, token)
        out += page['results']
        cursor = page.get('next_cursor')
        if not page.get('has_more') or not cursor:
            return out


def text(rich):
    return ''.join(part.get('plain_text', '') for part in rich or []).strip()


def task_id(page):
    """GENP-6663 lives in a unique_id or a number property; the prefix is the ticket key, the number the Task ID."""
    for name, prop in (page.get('properties') or {}).items():
        kind = prop.get('type')
        if kind == 'unique_id' and prop['unique_id']:
            return prop['unique_id'].get('prefix'), prop['unique_id']['number']
        if kind == 'number' and prop.get('number') is not None and 'id' in name.lower():
            return None, int(prop['number'])
    return None, None


def title_of(page):
    for prop in (page.get('properties') or {}).values():
        if prop.get('type') == 'title':
            return text(prop['title'])
    return ''


def render(blocks, token, depth=0):
    lines = []
    for block in blocks:
        kind = block['type']
        body = block.get(kind, {})
        pad = '  ' * depth
        if kind == 'child_page':
            lines.append(f'{pad}- **{body.get("title", "")}**')
            continue
        if kind in ('paragraph', 'quote', 'callout'):
            if t := text(body.get('rich_text')):
                lines.append(f'{pad}{"> " if kind == "quote" else ""}{t}')
        elif kind in ('heading_1', 'heading_2', 'heading_3'):
            if t := text(body.get('rich_text')):
                lines.append(f'{pad}{"#" * int(kind[-1])} {t}')
        elif kind == 'bulleted_list_item':
            lines.append(f'{pad}- {text(body.get("rich_text"))}')
        elif kind == 'numbered_list_item':
            lines.append(f'{pad}1. {text(body.get("rich_text"))}')
        elif kind == 'to_do':
            lines.append(f'{pad}- [{"x" if body.get("checked") else " "}] {text(body.get("rich_text"))}')
        elif kind == 'code':
            lines.append(f'{pad}```' + (body.get('language') or ''))
            lines.append(text(body.get('rich_text')))
            lines.append(f'{pad}```')
        elif kind == 'divider':
            lines.append(f'{pad}---')
        elif kind == 'table_row':
            lines.append(f'{pad}| ' + ' | '.join(text(cell) for cell in body.get('cells', [])) + ' |')
        elif kind == 'table':
            for row in render(children(block['id'], token), token, depth + 1).splitlines():
                lines.append(f'{pad}{row}')
        elif block.get('has_children'):
            first = text(body.get('rich_text'))
            if first:
                lines.append(f'{pad}- {first}')
            lines.extend(render(children(block['id'], token), token, depth + 1).splitlines())
    return '\n'.join(lines)


def main():
    page_id, out = sys.argv[1], sys.argv[2]
    token = os.environ.get('NOTION_TOKEN', '')
    if not token:
        sys.exit('TICKET: ABORT NOTION_TOKEN trống')
    try:
        page = call(f'pages/{page_id}', token)
    except urllib.error.HTTPError as err:
        # Notion answers 404 both for a missing page and for one the integration was never given access to.
        sys.exit(f'TICKET: FAIL  API {err.code} cho page {page_id}: chia sẻ trang đó với integration của NOTION_TOKEN (Notion: ... > Connections)')
    prefix, number = task_id(page)
    head = [f'# {title_of(page) or page_id}', '']
    if number is not None:
        head.append(f'- **Ticket:** {prefix + "-" if prefix else ""}{number}')
        head.append(f'- **Task ID:** {number}')
    else:
        head.append(f'- **Notion page:** https://www.notion.so/{page_id.replace("-", "")}')
    doc = '\n'.join(head) + '\n\n' + render(children(page_id, token), token) + '\n'
    try:
        with open(out, 'w') as file:
            file.write(doc)
    except OSError as err:
        sys.exit(f'TICKET: FAIL  không ghi được {out}: {err}')
    print(f'TICKET: PASS   {prefix or "?"}-{number} -> {out} ({doc.count(chr(10))} lines)')


if __name__ == '__main__':
    main()
