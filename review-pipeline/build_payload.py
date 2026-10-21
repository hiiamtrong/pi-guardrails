"""Build GitHub review payloads from a draft in reports/reviews/<PR>.md.

Usage: python3 reports/reviews/tools/build_payload.py <PR>
Writes /tmp/rv/post/<PR>.review.json and /tmp/rv/post/<PR>.reply-<comment_id>.json,
then prints a preview. Posting stays a separate, manual `gh api` step.
"""
import json
import pathlib
import re
import os
import sys

n = sys.argv[1]
draft = pathlib.Path(os.path.abspath(__file__)).parent.parent / f'{n}.md'
out = pathlib.Path('/tmp/rv/post')
out.mkdir(parents=True, exist_ok=True)
t = draft.read_text()

if '## Comment đã có' not in t:
    print(f"WARNING: {n}.md has no '## Comment đã có' section: list every review and comment incl. bots with tools/comments_seen.sh before posting", file=sys.stderr)

sha = re.search(r'Reviewed head: `([0-9a-f]{40})`', t).group(1)
event = re.search(r'(?:Planned event|Event): `(\w+)`', t).group(1)

comments = []
for m in re.finditer(
    r'^### \d+\. `([^`]+)` L(\d+)(?:-L(\d+))? \((RIGHT|LEFT)\)\s*\n\n'
    r'\*\*Comment \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao',
    t, re.S | re.M,
):
    path, a, b, side, body = m.groups()
    c = {'path': path, 'side': side, 'body': body.strip(), 'line': int(b or a)}
    if b:
        c.update(start_line=int(a), start_side=side)
    comments.append(c)

review = {'commit_id': sha, 'event': event, 'comments': comments}
if (bm := re.search(r'\*\*Body \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao', t, re.S)):
    review['body'] = bm.group(1).strip()
(out / f'{n}.review.json').write_text(json.dumps(review, ensure_ascii=False, indent=2))

replies = re.findall(
    r'Reply to [^`\n]*comment `(\d+)`.*?\*\*Reply \(EN, sẽ post\):\*\*\n\n(.*?)\n\n\*\*Vì sao',
    t, re.S,
)
for cid, body in replies:
    (out / f'{n}.reply-{cid}.json').write_text(json.dumps({'body': body.strip()}, ensure_ascii=False))

print(f"#{n} commit={sha[:10]} event={event} body={'(empty)' if 'body' not in review else repr(review['body'][:70])}")
for c in comments:
    rng = f"L{c['start_line']}-L{c['line']}" if 'start_line' in c else f"L{c['line']}"
    print(f"  inline {c['path']} {rng} {c['side']} ({len(c['body'])} chars)")
for cid, body in replies:
    print(f"  reply  -> {cid} ({len(body.strip())} chars)")
