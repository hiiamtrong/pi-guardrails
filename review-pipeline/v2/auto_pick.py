"""auto_pick.py --state FILE [--settle MINUTES] [--limit N] [--dry-run] [--baseline] < board.json

Reads the rows of `review_board.py --json` on stdin and prints, one per line, the PR numbers that should get a review run now.
A PR is picked when the board says it needs me (unreviewed, stale, reply), it is not a draft, and what the board shows for it
has been the same for the settle time (an author who pushes three commits in ten minutes gets one run, on the last).
What was picked is recorded in the state file, so the same head with the same replies never runs twice.

--baseline records every PR on the board as already run without picking any: use it once, so turning the poller on does not
start a review of every old open PR. --dry-run prints without writing the state.
"""
import argparse
import datetime
import json
import os
import pathlib
import sys

WANTED = ('unreviewed', 'stale', 'reply')


def identity(row):
    """What the board shows that a new run would answer: the head, my last review, the newest human reply after it."""
    return f'{row["head"]}:{row["at"] or ""}:{row["reply_at"] or ""}'


def pick(rows, state, now, settle, limit, baseline=False):
    """Returns the picked numbers and updates `state` in place. settle is in seconds."""
    picked = []
    for row in sorted(rows, key=lambda r: r['number']):
        if row['bucket'] not in WANTED or row['draft']:
            continue
        key, ident = str(row['number']), identity(row)
        entry = state.setdefault(key, {})
        if entry.get('seen') != ident:
            entry.update(seen=ident, since=now.isoformat())
        if baseline:
            entry['ran'] = ident
        elif entry.get('ran') != ident and len(picked) < limit and (now - datetime.datetime.fromisoformat(entry['since'])).total_seconds() >= settle:
            entry['ran'] = ident
            picked.append(row['number'])
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', required=True)
    ap.add_argument('--settle', type=float, default=10, help='minutes the board must stay the same (default 10)')
    ap.add_argument('--limit', type=int, default=2, help='most PRs picked in one run (default 2)')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--baseline', action='store_true')
    args = ap.parse_args()
    path = pathlib.Path(args.state)
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError:
        state = {}
    # shortcut: a launch is recorded when picked, not when it succeeds, so a failed launch is not retried; delete its key from the state to retry.
    raw = sys.stdin.read().strip()
    # A board that could not reach GitHub prints nothing: no rows means nothing to pick, not a crash every five minutes.
    try:
        rows = json.loads(raw) if raw else []
    except json.JSONDecodeError as err:
        sys.exit(f'auto_pick: board không phải JSON ({err}): bỏ lượt này thay vì đoán')
    picked = pick(rows, state, datetime.datetime.now(datetime.UTC), args.settle * 60, args.limit, args.baseline)
    if not args.dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Replace, not rewrite: a run killed mid-write must not leave a half file that stops every later poll.
        tmp = path.with_name(path.name + '.tmp')
        tmp.write_text(json.dumps(state, indent=1, sort_keys=True) + '\n')
        os.replace(tmp, path)
    for number in picked:
        print(number)


if __name__ == '__main__':
    main()
