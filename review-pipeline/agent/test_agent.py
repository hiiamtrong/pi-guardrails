import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent


def run(*args, env=None, **kwargs):
    return subprocess.run(*args, capture_output=True, text=True, env={**os.environ, **(env or {})}, **kwargs)


def git(dir_, *args):
    return run(['git', '-C', str(dir_), *args], check=True)


SHELL_STUB = '''#!/bin/bash
for a; do cmd="$a"; done
echo "$cmd" >> @CALLS@
@MAP@
case "$cmd" in
  *"create -f -"*) cat > @JOB@; exit 0 ;;
  *"get jobs"*) printf '%s\\n' '@JOBS@'; exit 0 ;;
  *" exec "*) inner="${cmd#*-- }"; HOME=@HOME@ exec bash -c "$inner" ;;
esac
exit 0
'''


GH_STUB = '''#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
if args[:1] == ['auth']:
    print('token')
    sys.exit(0)
path = next(a for a in args if a.startswith('repos/'))
if '-X' in args and args[args.index('-X') + 1] == 'POST':
    open(os.environ['CALLS'], 'a').write('SENT\\n')
    print(json.dumps({'id': 99}))
    sys.exit(0)
data = json.load(open(os.environ['REVIEWS' if path.endswith('/reviews?per_page=100') else 'PULL']))
if '--jq' not in args:
    print(json.dumps(data))
    sys.exit(0)
out = subprocess.run(['jq', '-r', args[args.index('--jq') + 1]], input=json.dumps(data), capture_output=True, text=True)
sys.stdout.write(out.stdout)
sys.exit(out.returncode)
'''

BUILD_PAYLOAD = '''import pathlib, sys
out = pathlib.Path('/tmp/rv/post')
out.mkdir(parents=True, exist_ok=True)
(out / f'{sys.argv[1]}.review.json').write_text('{"event": "APPROVE"}')
'''

POST_URL = 'https://github.com/o/r/pull/9901'
HEAD, OLD = 'a' * 40, 'b' * 40


def clean_post_files():
    for path in pathlib.Path('/tmp/rv/post').glob('9901.*'):
        shutil.rmtree(path) if path.is_dir() else path.unlink()


class AgentScripts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.origin = self.root / 'origin'
        run(['git', 'init', '-q', str(self.origin)], check=True)
        (self.origin / 'file.txt').write_text('base\n')
        git(self.origin, 'add', 'file.txt')
        git(self.origin, '-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-q', '-m', 'base')
        git(self.origin, 'branch', '-M', 'develop')

    def tearDown(self):
        self.tmp.cleanup()

    @unittest.skipUnless(shutil.which('flock'), 'flock is in the agent image, not in macOS')
    def test_two_checkouts_of_one_directory_wait_for_each_other(self):
        script = self.root / 'two.sh'
        script.write_text(f'''#!/bin/bash
set -eu
. {HERE}/lib.sh
for round in 1 2 3 4 5 6 7 8 9 10 11 12; do
  checkout {self.root}/checkout {self.origin} reviewer develop & p1=$!
  checkout {self.root}/checkout {self.origin} reviewer develop & p2=$!
  wait $p1
  wait $p2
done
''')
        result = run(['bash', str(script)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git(self.root / 'checkout', 'remote', 'get-url', 'origin').stdout.strip(), str(self.origin))

    def test_cleanup_removes_only_the_exact_prs_worktrees(self):
        main = self.root / 'main'
        run(['git', 'clone', '-q', str(self.origin), str(main)], check=True)
        for pr in (10, 100):
            git(main, 'worktree', 'add', '-q', '--detach', str(self.root / f'swag-pr-{pr}'), 'origin/develop')
        (main / 'reports').mkdir()
        result = run(['bash', '-c', f'. {HERE}/lib.sh; remove_pr_worktrees {main} 10'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / 'swag-pr-10').exists())
        self.assertTrue((self.root / 'swag-pr-100').exists())
        self.assertTrue((main / 'reports').is_dir())

    def fixture(self):
        home = self.root / 'home'
        state = home / '.pi/agent/review-pipeline'
        state.mkdir(parents=True)
        (state / 'agent-projects.json').write_text(json.dumps({
            'p': {'repo': 'o/r', 'reviewer': 'me', 'tokenVar': 'GH_TOKEN_THEO', 'dir': str(self.root / 'review'), 'needs': []}
        }))
        key = str(self.root / 'review').replace('/', '-')
        rules = state / 'projects' / key
        rules.mkdir(parents=True)
        (rules / 'pipeline.json').write_text('{"baseBranch":"develop"}')
        (self.root / 'review').mkdir(exist_ok=True)
        return home

    def test_poll_uses_the_readable_rows_and_forgets_a_job_it_could_not_create(self):
        home = self.fixture()
        state = home / '.pi/agent/review-pipeline/state'
        state.mkdir()
        (state / 'p.json').write_text('{}')
        rows = [{'number': n, 'bucket': 'unreviewed', 'head': str(n), 'at': None, 'reply_at': None, 'draft': False} for n in (7, 8)]
        (self.root / 'board.json').write_text(json.dumps(rows))
        bin_ = self.root / 'bin'
        bin_.mkdir()
        (bin_ / 'python3.12').write_text(f'''#!/bin/bash
if [[ "$*" == *review_board.py* ]]; then cat {self.root}/board.json; exit 1; fi
exec {shutil.which('python3.12')} "$@"
''')
        (bin_ / 'kubectl').write_text(f'''#!/bin/bash
cat >> {self.root}/jobs.yaml
grep -q 'rv/pr: "8"' {self.root}/jobs.yaml && exit 1
exit 0
''')
        for f in bin_.iterdir():
            f.chmod(0o755)
        result = run(['bash', str(HERE / 'poll.sh'), 'p'], env={
            'PATH': f'{bin_}:{os.environ["PATH"]}', 'HOME': str(home), 'PROJECTS': str(home / '.pi/agent/review-pipeline/agent-projects.json'),
            'ENGINE': str(HERE.parent), 'GH_TOKEN_THEO': 'token', 'SETTLE': '0', 'JOB_TEMPLATE': str(HERE / 'job.yaml'),
        })
        self.assertEqual(result.returncode, 1, result.stderr)
        jobs = (self.root / 'jobs.yaml').read_text()
        self.assertIn('rv/pr: "7"', jobs)
        self.assertIn('rv/pr: "8"', jobs)
        saved = json.loads((state / 'p.json').read_text())
        self.assertIn('7', saved)
        self.assertNotIn('8', saved)

    def fake_ssh(self, pod_home=None, jobs=(), pod_dir=None, local_dir=None):
        """Plays the node for one `ssh root@node <cmd>` call: kubectl runs the pod's side locally, with the pod's HOME and copy of the checkout."""
        bin_ = self.root / 'ssh-bin'
        bin_.mkdir(exist_ok=True)
        stub = SHELL_STUB
        stub = stub.replace('@CALLS@', str(self.root / 'ssh-calls'))
        stub = stub.replace('@JOB@', str(self.root / 'created-job.yaml'))
        stub = stub.replace('@JOBS@', json.dumps({"items": list(jobs)}))
        stub = stub.replace('@HOME@', str(pod_home or self.root / 'pod-home'))
        stub = stub.replace('@MAP@', f'cmd=$(printf %s "$cmd" | sed \'s|{local_dir}|{pod_dir}|g\')' if pod_dir and local_dir else '')
        (bin_ / 'ssh').write_text(stub)
        (bin_ / 'ssh').chmod(0o755)
        return {'PATH': f'{bin_}:{os.environ["PATH"]}', 'K3S_SSH': 'root@node'}

    def test_secrets_refuses_success_when_a_key_the_jobs_need_is_missing(self):
        env = {**self.fake_ssh(), 'HOME': str(self.root / 'home'), 'GH_TOKEN_THEO': 'token', 'GH_TOKEN_HARVEY': '', 'OPENCODE_API_KEY': ''}
        result = run(['bash', str(HERE / 'rvctl.sh'), 'secrets'], env=env)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('thiếu GH_TOKEN_HARVEY', result.stderr)

    def test_secrets_patches_when_every_required_key_is_there(self):
        env = {**self.fake_ssh(), 'HOME': str(self.root / 'home'), 'GH_TOKEN_THEO': 'token', 'GH_TOKEN_HARVEY': 'token',
               'OPENCODE_API_KEY': 'token', 'NOTION_TOKEN': 'token'}
        result = run(['bash', str(HERE / 'rvctl.sh'), 'secrets'], env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('patch secret agent-secrets --type=merge', (self.root / 'ssh-calls').read_text())

    def agent_state(self, drafts, posts=(), jobs="", statuses=None):
        """Runs agent_state.sh with a fake node: the pod side runs its real python over a throwaway checkout."""
        checkout = self.root / 'co'
        reviews = checkout / 'reports' / 'reviews'
        (reviews / 'evidence').mkdir(parents=True, exist_ok=True)
        for name, (at, text) in drafts.items():
            path = reviews / name
            path.write_text(text)
            os.utime(path, (at, at))
        for pr, at in posts:
            path = reviews / 'evidence' / pr / 'post.txt'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('posted\n')
            os.utime(path, (at, at))
        for pr, lines in (statuses or {}).items():
            path = reviews / 'evidence' / pr / 'auto-status.txt'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('\n'.join(lines) + '\n')
        bindir = self.root / 'as-bin'
        bindir.mkdir(exist_ok=True)
        (self.root / 'jobs.txt').write_text(jobs)
        (bindir / 'ssh').write_text(f'''#!/bin/bash
for a; do cmd="$a"; done
case "$cmd" in
  *jsonpath*) cat {self.root}/jobs.txt ;;
  *"exec -i"*) arg=$(printf %s "$cmd" | sed "s/.*python3 - '//; s/'$//"); python3 - "$arg" ;;
esac
exit 0
''')
        (bindir / 'ssh').chmod(0o755)
        cfg = self.root / 'as-projects.json'
        cfg.write_text(json.dumps({"p": {"repo": "o/r", "dir": str(checkout), "tokenVar": "T"}}))
        result = run(['bash', str(HERE / 'agent_state.sh')], env={'PATH': f'{bindir}:{os.environ["PATH"]}', 'K3S_SSH': 'root@node', 'PROJECTS': str(cfg)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_agent_state_takes_the_newest_draft_or_post(self):
        draft_new = {'7.md': (2000, '# Review\n- Planned event: `APPROVE`\n')}
        draft_old = {'7.md': (1000, '# Review\n- Planned event: `APPROVE`\n')}
        post_new, post_old = (('7', 3000),), (('7', 1000),)
        self.assertEqual(self.agent_state(draft_new)['o/r']['7']['state'], 'draft')
        self.assertEqual(self.agent_state(draft_old, post_new)['o/r']['7']['state'], 'posted')
        self.assertEqual(self.agent_state(draft_new, post_old)['o/r']['7']['state'], 'draft')

    def test_agent_state_reads_a_round_2_draft_as_the_same_pull_request(self):
        states = self.agent_state({'7-r2.md': (3000, '- Planned event: `REQUEST_CHANGES`\n')}, (('7', 1000),))
        self.assertEqual(states['o/r']['7']['state'], 'draft')
        self.assertEqual(states['o/r']['7']['event'], 'REQUEST_CHANGES')

    def test_agent_state_carries_the_gates_and_the_summary_a_popup_shows(self):
        draft = {'7.md': (2000, '- Planned event: `APPROVE`\n## Tóm tắt cho người duyệt\n**Kết luận:** APPROVE: nhỏ\n\n| # | Điểm |\n')}
        status = {'7': ['00 intake PASS', '03 runs FAIL rc=1', '05 draft PASS']}
        entry = self.agent_state(draft, statuses=status)['o/r']['7']
        self.assertEqual(entry['gates'], ['00 intake PASS', '03 runs FAIL', '05 draft PASS'])
        self.assertEqual(entry['summary'], ['Kết luận: APPROVE: nhỏ'])

    def test_agent_state_puts_a_running_job_on_the_same_pull_request_the_listing_names(self):
        # a Job carries the project name ("p"), the listing the repository: both must land on o/r#7
        self.assertEqual(self.agent_state({}, jobs='p 7 1\n')['o/r']['7']['state'], 'reviewing')
        self.assertEqual(self.agent_state({'7.md': (1000, '')}, jobs='p 7 0\n')['o/r']['7']['state'], 'draft')

    def test_memory_diff_is_order_independent_and_reports_pod_writes(self):
        local = self.fixture()
        remote = self.root / 'remote'
        for home in (local, remote):
            memory = home / '.pi/agent/memory/global'
            memory.mkdir(parents=True)
            (memory / 'MEMORY.md').write_text('index\n')
            (memory / 'a.md').write_text('a\n')
        env = {**self.fake_ssh(pod_home=remote), 'HOME': str(local)}
        result = run(['bash', str(HERE / 'rvctl.sh'), 'memory-diff'], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('khớp', result.stdout)
        (remote / '.pi/agent/memory/global/pod.md').write_text('pod note\n')
        result = run(['bash', str(HERE / 'rvctl.sh'), 'memory-diff'], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pod:      ', result.stdout)
        self.assertIn('memory/global/pod.md', result.stdout)

    def test_fetch_takes_only_the_exact_pr_and_never_overwrites_local_work(self):
        home = self.fixture()
        local = self.root / 'review'
        remote = self.root / 'remote-review/reports/reviews'
        (remote / 'evidence/10').mkdir(parents=True)
        for name in ('10.md', '10-r2.md', '100.md'):
            (remote / name).write_text(name)
        (remote / 'evidence/10/run.txt').write_text('run')
        env = {**self.fake_ssh(pod_home=self.root / 'pod-home', pod_dir=remote.parent.parent, local_dir=local), 'HOME': str(home)}
        result = run(['bash', str(HERE / 'rvctl.sh'), 'fetch', 'p', '10'], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((local / 'reports/reviews/10.md').read_text(), '10.md')
        self.assertTrue((local / 'reports/reviews/10-r2.md').exists())
        self.assertFalse((local / 'reports/reviews/100.md').exists())
        self.assertTrue((local / 'reports/reviews/evidence/10/run.txt').exists())

        (local / 'reports/reviews/10.md').write_text('my edit')
        (local / 'reports/reviews/10-r2.md').unlink()
        result = run(['bash', str(HERE / 'rvctl.sh'), 'fetch', 'p', '10'], env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((local / 'reports/reviews/10.md').read_text(), 'my edit')
        self.assertFalse((local / 'reports/reviews/10-r2.md').exists())

    def test_manual_review_refuses_a_pr_that_already_has_a_running_job(self):
        home = self.fixture()
        env = {**self.fake_ssh(jobs=[{'metadata': {'name': 'rv-p-10'}, 'status': {'active': 1}}]), 'HOME': str(home)}
        result = run(['bash', str(HERE / 'rvctl.sh'), 'review', 'p', '10'], env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'created-job.yaml').exists())
        env = {**self.fake_ssh(jobs=[]), 'HOME': str(home)}
        result = run(['bash', str(HERE / 'rvctl.sh'), 'review', 'p', '10'], env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        job = (self.root / 'created-job.yaml').read_text()
        self.assertIn('rv/pr: "10"', job)
        self.assertIn('name: MODEL, value: "router"', job)
        self.assertNotIn('__MODEL__', job)

    def post_fixture(self, reviews=(), pull_head=HEAD):
        home = self.fixture()
        local = self.root / 'review'
        tools = local / 'reports/reviews/tools'
        (tools / 'v2').mkdir(parents=True)
        (local / 'reports/reviews/9901.md').write_text(f'# Review\n\nReviewed head: `{HEAD}`\n\nPlanned event: `APPROVE`\n')
        (tools / '.pipeline-env').write_text('REPO=o/r\nREVIEWER=me\n')
        (tools / 'build_payload.py').write_text(BUILD_PAYLOAD)
        (tools / 'v2/seen_from_table.py').write_text('')
        (self.root / 'pull.json').write_text(json.dumps({'state': 'open', 'head': {'sha': pull_head}}))
        (self.root / 'reviews.json').write_text(json.dumps(list(reviews)))
        bin_ = self.root / 'bin'
        bin_.mkdir()
        (bin_ / 'gh').write_text(GH_STUB)
        (bin_ / 'ssh').write_text('#!/bin/bash\nexit 0\n')
        for f in bin_.iterdir():
            f.chmod(0o755)
        self.addCleanup(clean_post_files)
        return {
            'PATH': f'{bin_}:{os.environ["PATH"]}', 'HOME': str(home), 'K3S_SSH': 'node',
            'CALLS': str(self.root / 'calls.txt'), 'PULL': str(self.root / 'pull.json'), 'REVIEWS': str(self.root / 'reviews.json'),
        }

    def post(self, env, *args):
        return run(['bash', str(HERE / 'rvctl.sh'), 'post', POST_URL, *args], env=env)

    def test_post_is_a_dry_run_until_yes_is_given_in_the_button_position(self):
        env = self.post_fixture()
        dry = self.post(env)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn('dry-run', dry.stdout)
        self.assertFalse((self.root / 'calls.txt').exists())
        sent = self.post(env, '--yes')
        self.assertEqual(sent.returncode, 0, sent.stderr)
        self.assertIn('review=99', sent.stdout)
        self.assertEqual((self.root / 'calls.txt').read_text(), 'SENT\n')
        self.assertFalse(pathlib.Path('/tmp/rv/post/9901.lock').exists())

    def test_post_refuses_a_second_review_on_the_same_head(self):
        env = self.post_fixture(reviews=[{'user': {'login': 'me'}, 'commit_id': HEAD, 'state': 'APPROVED', 'id': 5}])
        sent = self.post(env, '--yes')
        self.assertNotEqual(sent.returncode, 0)
        self.assertIn('không post trùng', sent.stderr)
        self.assertFalse((self.root / 'calls.txt').exists())

    def test_post_still_refuses_when_the_earlier_review_was_dismissed(self):
        env = self.post_fixture(reviews=[{'user': {'login': 'me'}, 'commit_id': HEAD, 'state': 'DISMISSED', 'id': 5}])
        sent = self.post(env, '--yes')
        self.assertNotEqual(sent.returncode, 0)
        self.assertIn('không post trùng', sent.stderr)
        self.assertFalse((self.root / 'calls.txt').exists())

    def test_post_allows_a_review_on_an_older_head(self):
        env = self.post_fixture(reviews=[{'user': {'login': 'me'}, 'commit_id': OLD, 'state': 'APPROVED', 'id': 5}])
        sent = self.post(env, '--yes')
        self.assertEqual(sent.returncode, 0, sent.stderr)
        self.assertEqual((self.root / 'calls.txt').read_text(), 'SENT\n')

    def test_post_refuses_while_another_post_for_the_pr_holds_the_lock(self):
        env = self.post_fixture()
        lock = pathlib.Path('/tmp/rv/post/9901.lock')
        lock.mkdir(parents=True)
        sent = self.post(env, '--yes')
        self.assertNotEqual(sent.returncode, 0)
        self.assertIn('đang được post', sent.stderr)
        self.assertFalse((self.root / 'calls.txt').exists())
        self.assertTrue(lock.exists(), 'the other post still holds its lock')


if __name__ == '__main__':
    unittest.main()
