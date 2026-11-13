#!/bin/bash
# agent_state.sh [projects.json]   What the k3s review agent knows about each pull request, as JSON on stdout:
#   {"<owner/repo>": {"<PR>": {"state": "reviewing"|"draft"|"posted", "at": <epoch seconds>,
#                              "event": "APPROVE", "gates": ["00 intake PASS", ...], "summary": ["...", ...]}}}
# "reviewing" is a Job still running, "draft" a draft on the volume that nobody posted, "posted" a step 06 that passed; event, gates and
# summary come from the newest draft, so plugboard can show what that draft will post without a second round trip.
# Read-only: it lists files in the pod and Jobs on the node, and writes nothing.
set -eu
CFG=${PROJECTS:-$HOME/.pi/agent/review-pipeline/agent-projects.json}
RULES=${REVIEW_PIPELINE_HOME:-$HOME/.pi/agent/review-pipeline}
# plugboard runs this from a launchd app with no shell environment: the node is the one the rules already name.
if [ -z "${K3S_SSH:-}" ]; then
  K3S_SSH=$(jq -r '.k3sHost // empty' "$RULES"/projects/*/pipeline.json 2>/dev/null | grep -v '^local$' | head -1)
fi
K3S_SSH=${K3S_SSH:?set K3S_SSH (user@host of the k3s node)}

pairs=$(jq -r 'to_entries[] | select(.value|type == "object") | "\(.value.repo) \(.value.dir)"' "$CFG")
[ -n "$pairs" ] || { echo '{}'; exit 0; }
# A Job is labelled with the project name, the listing with owner/repo: both must end up on the same key.
names=$(jq -r 'to_entries[] | select(.value|type == "object") | "\(.key) \(.value.repo)"' "$CFG")

read -r -d '' REMOTE <<'PY' || true
import glob, json, os, re, sys
for repo, root in json.loads(sys.argv[1]):
    reviews = os.path.join(root, "reports", "reviews")
    for path in glob.glob(os.path.join(reviews, "*.md")):
        pr = re.sub(r"-r[0-9]+$", "", os.path.basename(path)[:-3])
        if not pr.isdigit():
            continue
        text = open(path, errors="replace").read()
        event = re.search(r"Planned event: `([A-Z_]+)`", text)
        summary, grab = [], False
        for line in text.splitlines():
            if line.startswith("## "):
                grab = line.startswith("## Tóm tắt")
                continue
            line = re.sub(r"\*\*|`", "", line.strip())
            if grab and line and not line.startswith("|") and len(summary) < 8:
                summary.append(line[:200])
        status = os.path.join(reviews, "evidence", pr, "auto-status.txt")
        gates = []
        if os.path.exists(status):
            gates = [" ".join(re.sub(r"\s+", " ", l).split()[:3]) for l in open(status, errors="replace") if re.match(r"^\d\d ", l)]
        print(json.dumps({"repo": repo, "pr": pr, "kind": "draft", "at": int(os.path.getmtime(path)),
                          "event": event[1] if event else "", "gates": gates, "summary": summary}))
    for path in glob.glob(os.path.join(reviews, "evidence", "*", "post.txt")):
        pr = os.path.basename(os.path.dirname(path))
        if pr.isdigit():
            print(json.dumps({"repo": repo, "pr": pr, "kind": "posted", "at": int(os.path.getmtime(path))}))
PY

pair_json=$(printf '%s\n' "$pairs" | python3 -c 'import json,sys; print(json.dumps([l.split(" ",1) for l in sys.stdin.read().splitlines() if l.strip()]))')
listing=$(printf '%s' "$REMOTE" | ssh -o BatchMode=yes -o ConnectTimeout=15 "$K3S_SSH" "kubectl -n review-agent exec -i deploy/agent-files -- python3 - '$pair_json'" 2>/dev/null || true)
jobs=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$K3S_SSH" "kubectl -n review-agent get jobs -l app=rv-agent -o jsonpath='{range .items[*]}{.metadata.labels.rv/project}{\" \"}{.metadata.labels.rv/pr}{\" \"}{.status.active}{\"\\n\"}{end}'" 2>/dev/null || true)

LISTING=$listing JOBS=$jobs NAMES=$names python3 - <<'PY2'
import json, os
name_to_repo = dict(line.split(maxsplit=1) for line in os.environ['NAMES'].splitlines() if len(line.split()) == 2)
projects = {}

# The newest evidence wins, whichever kind it is: a draft written after the post is the round that is waiting for you now.
for line in os.environ['LISTING'].splitlines():
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    repo, pr, kind, at = entry['repo'], entry['pr'], entry['kind'], int(entry.get('at') or 0)
    known = projects.setdefault(repo, {}).get(pr, {})
    if kind == 'posted':
        if at >= known.get('at', -1):
            projects[repo][pr] = {'state': 'posted', 'at': at}
    elif at > known.get('at', -1):
        projects[repo][pr] = {'state': 'draft', 'at': at, 'event': entry.get('event', ''),
                              'gates': entry.get('gates', []), 'summary': entry.get('summary', [])}

# A Job still running is the newest word on the pull request.
for line in os.environ['JOBS'].splitlines():
    parts = line.split()
    if len(parts) >= 3 and parts[1].isdigit() and parts[2] not in ('', '0'):
        repo = name_to_repo.get(parts[0], parts[0])
        projects.setdefault(repo, {})[parts[1]] = {'state': 'reviewing', 'at': 0}

print(json.dumps({repo: prs for repo, prs in projects.items() if prs}, separators=(',', ':')))
PY2
