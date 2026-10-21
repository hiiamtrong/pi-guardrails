"""review_board.py [--repo OWNER/NAME] [--reviewer LOGIN] [--author-pattern REGEX] [--no-color]

One terminal screen for "which PR needs me next": every open PR the reviewer has reviewed or was asked to review,
grouped by the next action. Read-only on GitHub (GET and search only). A review is stale when the PR head moved since it
(the repo dismisses approvals on push, so DISMISSED counts too); replies are counted after the reviewer's last review or
after the last acknowledgement, whichever is later.

`--ack N [N ...]` records that the replies on those PRs have been read (by the reviewer or by an agent) in
reports/reviews/.board-ack.json. A reply that arrives later, or a new commit, brings the PR back.

Settings come from the flags, then REPO / REVIEWER / AUTHOR_PATTERN in the environment, then
reports/reviews/tools/.pipeline-env in the current directory (written by /review-pr).
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys

BUCKETS = [
    ('stale', 'Review lại', 'Review lại: có commit mới hoặc review bị dismiss', '31'),
    ('unreviewed', 'Chưa review', 'Chưa review', '33'),
    ('reply', 'Có phản hồi', 'Có phản hồi mới sau review của bạn', '35'),
    ('waiting', 'Chờ tác giả', 'Chờ tác giả', '36'),
    ('done', 'Xong', 'Xong: approve trên đúng head', '32'),
]
SHORT_STATE = {'APPROVED': 'APPROVED', 'CHANGES_REQUESTED': 'CHANGES', 'COMMENTED': 'COMMENTED', 'DISMISSED': 'DISMISSED'}


def author(item):
    # GitHub sends user: null for a deleted account.
    return item['user'] or {}


def others(reviews, inline, conversation, me):
    # An empty review body is only the wrapper of an inline reply, which is counted on its own.
    return [x for x in (*reviews, *inline, *conversation) if author(x).get('login') != me and (x['body'] or '').strip()]


def stamp(item):
    return item.get('submitted_at') or item['created_at']


def classify(pr, reviews, inline, conversation, commits, me, acked=None):
    # Replying in a thread makes GitHub add an empty COMMENTED review on the current commit; it is not a verdict and would hide a stale approve.
    # shortcut: so my own inline-only review (empty body) reads as unreviewed, upgrade if I start sending those.
    mine = [r for r in reviews if author(r).get('login') == me and r['state'] != 'PENDING' and (r['state'] != 'COMMENTED' or (r['body'] or '').strip())]
    last = max(mine, key=lambda r: r['submitted_at'], default=None)
    head = pr['head']['sha']
    row = {'number': pr['number'], 'author': author(pr).get('login', 'ghost'), 'title': pr['title'], 'draft': pr['draft'],
           'state': last and last['state'], 'at': last and last['submitted_at'], 'behind': 0, 'human': 0, 'bots': 0}
    if not last:
        return {**row, 'bucket': 'unreviewed'}
    seen_until = max(last['submitted_at'], acked or '')
    newer = [x for x in others(reviews, inline, conversation, me) if stamp(x) > seen_until]
    row['bots'] = sum(author(x).get('type') == 'Bot' for x in newer)
    row['human'] = len(newer) - row['bots']
    shas = [c['sha'] for c in commits]
    # None = the reviewed commit is gone from the branch (force-push or rebase).
    row['behind'] = len(shas) - 1 - shas.index(last['commit_id']) if last['commit_id'] in shas else None
    if last['state'] == 'DISMISSED' or last['commit_id'] != head:
        row['bucket'] = 'stale'
    elif row['human']:
        row['bucket'] = 'reply'
    else:
        row['bucket'] = 'done' if last['state'] == 'APPROVED' else 'waiting'
    return row


def age(timestamp, now):
    if not timestamp:
        return ''
    seconds = (now - datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))).total_seconds()
    return f'{seconds // 86400:.0f}d' if seconds >= 86400 else f'{seconds // 3600:.0f}h' if seconds >= 3600 else f'{seconds // 60:.0f}m'


def render(rows, now, color, width, header):
    paint = (lambda code, text: f'\033[{code}m{text}\033[0m') if color else (lambda code, text: text)
    counts = ' · '.join(f'{short} {n}' for key, short, _, _ in BUCKETS if (n := sum(r['bucket'] == key for r in rows)))
    lines = [paint('1', header), counts or 'không có PR nào', '']
    for key, _, label, code in BUCKETS:
        group = sorted((r for r in rows if r['bucket'] == key), key=lambda r: r['number'])
        if not group:
            continue
        lines.append(paint(f'1;{code}', f'{label} ({len(group)})'))
        for r in group:
            behind = '-' if r['state'] is None else '=' if r['behind'] == 0 else '+?' if r['behind'] is None else f'+{r["behind"]}'
            replies = f'{r["human"]}' + (f' +{r["bots"]}bot' if r['bots'] else '')
            head = (f'  #{r["number"]:<6}{r["author"].removeprefix("Sotatek-")[:13]:<14}{SHORT_STATE.get(r["state"], "-"):<10}'
                    f'{age(r["at"], now):>4} {behind:>3} {replies:>9}  {"DRAFT " if r["draft"] else ""}')
            lines.append(head + r['title'][:max(10, width - len(head))])
        lines.append('')
    lines.append(paint('2', 'cột: PR, tác giả, review cuối của bạn, tuổi, commit mới sau đó (= không có, +? bị force-push), phản hồi mới'))
    return '\n'.join(lines)


def read_env_file(path):
    values = {}
    for line in path.read_text().splitlines():
        if line.startswith('export ') and '=' in line:
            key, _, value = line[len('export '):].partition('=')
            values[key] = shlex.split(value)[0] if value else ''
    return values


def gh(env, *args):
    done = subprocess.run(['gh', *args], capture_output=True, text=True, env=env)
    if done.returncode:
        raise RuntimeError(f'gh {" ".join(args[:2])}: {done.stderr.strip()}')
    return done.stdout


def gh_list(env, endpoint):
    return [json.loads(line) for line in gh(env, 'api', '--paginate', endpoint, '--jq', '.[]').splitlines()]


def fetch_replies(env, repo, number):
    base = f'repos/{repo}'
    return (gh_list(env, f'{base}/pulls/{number}/reviews?per_page=100'), gh_list(env, f'{base}/pulls/{number}/comments?per_page=100'),
            gh_list(env, f'{base}/issues/{number}/comments?per_page=100'))


def fetch(env, repo, number):
    base = f'repos/{repo}'
    return (json.loads(gh(env, 'api', f'{base}/pulls/{number}')), *fetch_replies(env, repo, number),
            gh_list(env, f'{base}/pulls/{number}/commits?per_page=100'))


ACK_FILE = pathlib.Path('reports/reviews/.board-ack.json')


def read_acks(path=ACK_FILE):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def ack(env, repo, numbers, me, path=ACK_FILE):
    """Remember the newest reply on each PR; later replies still count."""
    acks = read_acks(path)
    failed = False
    for number in numbers:
        # One PR that cannot be read must not drop the acks of the others.
        try:
            latest = max((stamp(x) for x in others(*fetch_replies(env, repo, number), me)), default=None)
        except RuntimeError as err:
            print(f'#{number}: không đọc được ({err})', file=sys.stderr)
            failed = True
            continue
        if latest:
            acks[f'{repo}#{number}'] = latest
        print(f'#{number}: ' + (f'đã ghi nhận phản hồi đến {latest}' if latest else 'chưa có phản hồi nào của người khác'))
    path.parent.mkdir(parents=True, exist_ok=True)
    # Replace, not rewrite: a run killed mid-write must not leave a half file that stops every later board run.
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(acks, indent=1, sort_keys=True) + '\n')
    os.replace(tmp, path)
    if failed:
        sys.exit(1)


def load(env, repo, number, me, acks=None):
    # One PR that cannot be read (deleted, timeout) must not blank the whole board.
    try:
        return classify(*fetch(env, repo, number), me, (acks or {}).get(f'{repo}#{number}'))
    except RuntimeError as err:
        return {'number': number, 'error': str(err)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo')
    ap.add_argument('--reviewer')
    ap.add_argument('--author-pattern')
    ap.add_argument('--no-color', action='store_true')
    ap.add_argument('--ack', nargs='+', type=int, metavar='N', help='mark the replies on these PRs as read')
    args = ap.parse_args()
    env_file = pathlib.Path('reports/reviews/tools/.pipeline-env')
    saved = read_env_file(env_file) if env_file.exists() else {}
    pick = lambda flag, key: flag or os.environ.get(key) or saved.get(key)
    repo, me, pattern = pick(args.repo, 'REPO'), pick(args.reviewer, 'REVIEWER'), pick(args.author_pattern, 'AUTHOR_PATTERN')
    if not (repo and me):
        sys.exit('thiếu REPO và REVIEWER: truyền --repo/--reviewer, hoặc chạy trong thư mục review đã có reports/reviews/tools/.pipeline-env')
    try:
        env = {**os.environ, 'GH_TOKEN': gh(os.environ, 'auth', 'token', '-h', 'github.com', '-u', me).strip()}
        if args.ack:
            return ack(env, repo, args.ack, me)
        found = {}
        for flag in ('--reviewed-by', '--review-requested'):
            for item in json.loads(gh(env, 'search', 'prs', '--repo', repo, '--state', 'open', '--limit', '100', flag, me, '--json', 'number,author')):
                found[item['number']] = item['author']['login']
    except RuntimeError as err:
        sys.exit(str(err))
    numbers = sorted(n for n, author in found.items() if not pattern or re.search(pattern, author))
    acks = read_acks()
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        loaded = list(pool.map(lambda n: load(env, repo, n, me, acks), numbers))
    rows = [r for r in loaded if 'error' not in r]
    now = datetime.datetime.now(datetime.UTC)
    header = f'{repo} · {me} · {now.astimezone():%d/%m %H:%M}'
    print(render(rows, now, sys.stdout.isatty() and not args.no_color and 'NO_COLOR' not in os.environ,
                 shutil.get_terminal_size((120, 20)).columns, header))
    for r in loaded:
        if 'error' in r:
            print(f'#{r["number"]}: không đọc được ({r["error"]})', file=sys.stderr)


if __name__ == '__main__':
    main()
