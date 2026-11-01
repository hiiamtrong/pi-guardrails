import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
HEAD = 'e008ae0769'
OLD = '6cfa543ec1'


def block(title, body):
    return f'== {title}, 18:00 ICT ==\n{body}\npytest_rc=1\n'


def check_runs(log, head, changed=None):
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / 'runs.txt'
        path.write_text(log)
        extra = []
        if changed is not None:
            listing = pathlib.Path(tmp) / 'changed.txt'
            listing.write_text('\n'.join(changed))
            extra = ['--changed', str(listing)]
        done = subprocess.run([sys.executable, '-I', str(HERE / 'check_runs.py'), '--head', head, *extra, str(path)],
                              capture_output=True, text=True)
    return done.returncode, done.stdout


class CheckRunsHead(unittest.TestCase):
    def logs(self, head):
        return (block(f'#1 trial merge {head} (tests)', '9 failed, 600 passed')
                + block(f'#1 the new test file (head {head}) on DEVELOP code', '5 failed, 31 passed')
                + 'only on trial: 0 | only on develop: 0\n')

    def test_log_of_the_current_head_passes(self):
        code, out = check_runs(self.logs(HEAD), HEAD)
        self.assertEqual(code, 0, out)

    def test_log_of_an_older_head_fails_both_head_bound_checks(self):
        code, out = check_runs(self.logs(OLD), HEAD)
        self.assertEqual(code, 1)
        self.assertIn(f'không có khối trial trên head {HEAD}', out)
        self.assertIn(f'có failed > 0 trên head {HEAD}', out)

    def test_old_trial_line_does_not_count_for_the_new_head(self):
        log = self.logs(OLD) + block(f'#1 new test file (head {HEAD}) on DEVELOP code', '5 failed, 31 passed')
        code, out = check_runs(log, HEAD)
        self.assertEqual(code, 1)
        self.assertIn('trial-vs-develop', out)


class DocsOnly(unittest.TestCase):
    def test_a_diff_of_documents_needs_no_test_run(self):
        code, out = check_runs('', HEAD, changed=['docs/dm-migration/30-hide.md', 'README.rst', 'notes.txt'])
        self.assertEqual(code, 0, out)
        self.assertIn('docs-only', out)

    def test_one_code_file_keeps_every_check(self):
        code, out = check_runs('', HEAD, changed=['docs/a.md', 'swag/a.py'])
        self.assertEqual(code, 1)
        self.assertNotIn('docs-only', out)

    def test_a_deploy_file_is_not_a_document(self):
        code, _ = check_runs('', HEAD, changed=['deploy/chat-backfill/README.md', 'deploy/job.yaml'])
        self.assertEqual(code, 1)

    def test_an_empty_change_list_is_not_docs_only(self):
        code, _ = check_runs('', HEAD, changed=[])
        self.assertEqual(code, 1)


class ParallelNotes(unittest.TestCase):
    def test_forty_notes_at_once_all_succeed_and_all_land(self):
        with tempfile.TemporaryDirectory() as rv:
            env = {'RV': rv, 'PATH': '/usr/bin:/bin'}
            procs = [subprocess.Popen([sys.executable, '-I', str(HERE / 'pipeline_step.py'), 'note', '1', '00', '--msg', f'n{i}'],
                                      env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(40)]
            results = [(p.wait(), p.stderr.read()) for p in procs]
            work = pathlib.Path(rv, 'reports', 'reviews', 'evidence', '1', 'gates')
            events = [json.loads(line) for line in (work / 'events.jsonl').read_text().splitlines()]
            leftovers = [p.name for p in work.iterdir() if p.name.endswith('.tmp')]
        self.assertEqual([r for r in results if r[0] != 0], [])
        self.assertEqual(len(events), 40)
        self.assertEqual(leftovers, [])



sys.path.insert(0, str(HERE))
import pipeline_ui


def step(rv, *args, check=True):
    done = subprocess.run([sys.executable, '-I', str(HERE / 'pipeline_step.py'), *args],
                          env={'RV': rv, 'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
    if check:
        assert done.returncode == 0, done.stderr
    return done


def begin(rv, pr, *flags):
    done = step(rv, 'begin', pr, '--no-open', *flags, check=False)
    return done, (json.loads(done.stdout.strip().splitlines()[-1]) if done.returncode == 0 else None)


def gates(rv, pr):
    return pathlib.Path(rv, 'reports', 'reviews', 'evidence', pr, 'gates')


def title(rv, pr):
    port = int(gates(rv, pr).joinpath('ui.port').read_text())
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=3) as page:
        return page.read().decode().split('<title>')[1].split('</title>')[0]


class Session(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rv = self.tmp.name
        self.sleepers = []

    def tearDown(self):
        for pr in ('1', '2'):
            step(self.rv, 'stop', pr, check=False)
        for proc in self.sleepers:
            proc.kill()
        self.tmp.cleanup()

    def sleeper(self):
        proc = subprocess.Popen(['sleep', '300'])
        self.sleepers.append(proc)
        return proc.pid


class Resume(Session):
    def test_second_begin_keeps_the_progress_and_names_the_next_step(self):
        begin(self.rv, '1')
        step(self.rv, 'start', '1', '00')
        _, first = begin(self.rv, '1')
        self.assertTrue(first['resumed'])
        self.assertEqual(first['next'], '00')
        events = gates(self.rv, '1') / 'events.jsonl'
        self.assertEqual([e['state'] for e in map(json.loads, events.read_text().splitlines())], ['begin', 'start', 'resume'])
        self.assertEqual([p.name for p in gates(self.rv, '1').glob('events-*')], [])

    def test_restart_archives_the_old_progress(self):
        begin(self.rv, '1')
        step(self.rv, 'start', '1', '00')
        _, fresh = begin(self.rv, '1', '--restart')
        self.assertFalse(fresh['resumed'])
        self.assertEqual(len(list(gates(self.rv, '1').glob('events-*'))), 1)

    def test_a_finished_review_starts_fresh_without_a_flag(self):
        begin(self.rv, '1')
        step(self.rv, 'end', '1')
        _, again = begin(self.rv, '1')
        self.assertFalse(again['resumed'])


class Owner(Session):
    def test_second_live_owner_is_refused_and_takeover_gets_through(self):
        mine, theirs = self.sleeper(), self.sleeper()
        self.assertEqual(begin(self.rv, '1', '--owner', str(mine))[0].returncode, 0)
        refused, _ = begin(self.rv, '1', '--owner', str(theirs))
        self.assertEqual(refused.returncode, 3)
        self.assertIn(f'tiến trình pi {mine}', refused.stderr)
        self.assertEqual(len((gates(self.rv, '1') / 'events.jsonl').read_text().splitlines()), 1)
        taken, data = begin(self.rv, '1', '--owner', str(theirs), '--takeover')
        self.assertEqual(taken.returncode, 0)
        self.assertTrue(data['resumed'])

    def test_a_dead_owner_does_not_block(self):
        dead = subprocess.Popen(['true'])
        dead.wait()
        begin(self.rv, '1', '--owner', str(dead.pid))
        done, data = begin(self.rv, '1', '--owner', str(self.sleeper()))
        self.assertEqual(done.returncode, 0)
        self.assertTrue(data['resumed'])


class Server(Session):
    def test_two_reviews_started_at_once_each_get_their_own_page(self):
        for _ in range(4):
            procs = [subprocess.Popen([sys.executable, '-I', str(HERE / 'pipeline_step.py'), 'begin', pr, '--no-open'],
                                      env={'RV': self.rv, 'PYTHONDONTWRITEBYTECODE': '1'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                     for pr in ('1', '2')]
            for proc in procs:
                proc.communicate()
            self.assertEqual([proc.returncode for proc in procs], [0, 0])
            self.assertEqual((title(self.rv, '1'), title(self.rv, '2')), ('Review #1', 'Review #2'))
            ports = {gates(self.rv, pr).joinpath('ui.port').read_text() for pr in ('1', '2')}
            self.assertEqual(len(ports), 2)
            for pr in ('1', '2'):
                step(self.rv, 'stop', pr)
                step(self.rv, 'end', pr)
                (gates(self.rv, pr) / 'events.jsonl').unlink()

    def test_two_begins_for_the_same_review_at_once_start_one_server(self):
        for _ in range(4):
            procs = [subprocess.Popen([sys.executable, '-I', str(HERE / 'pipeline_step.py'), 'begin', '1', '--no-open'],
                                      env={'RV': self.rv, 'PYTHONDONTWRITEBYTECODE': '1'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                     for _ in range(2)]
            for proc in procs:
                proc.communicate()
            self.assertEqual([proc.returncode for proc in procs], [0, 0])
            servers = [line for line in subprocess.run(['ps', '-axo', 'command='], capture_output=True, text=True).stdout.splitlines()
                       if 'pipeline_ui.py 1 --work' in line and self.rv in line]
            self.assertEqual(len(servers), 1, servers)
            step(self.rv, 'stop', '1')
            step(self.rv, 'end', '1')
            (gates(self.rv, '1') / 'events.jsonl').unlink()

    def test_stop_leaves_an_unrelated_process_alone(self):
        victim = self.sleeper()
        begin(self.rv, '1')
        step(self.rv, 'stop', '1')
        gates(self.rv, '1').joinpath('ui.pid').write_text(str(victim))
        out = step(self.rv, 'stop', '1').stdout
        self.assertIn('không phải server UI', out)
        time.sleep(0.2)
        self.assertEqual(subprocess.run(['kill', '-0', str(victim)]).returncode, 0)

    def test_a_dead_server_comes_back_on_the_next_note(self):
        begin(self.rv, '1')
        step(self.rv, 'start', '1', '00')
        subprocess.run(['kill', '-9', gates(self.rv, '1').joinpath('ui.pid').read_text()])
        time.sleep(0.3)
        step(self.rv, 'note', '1', '00', '--msg', 'sau khi chết')
        self.assertEqual(title(self.rv, '1'), 'Review #1')


class WaitingStep(Session):
    def seed(self, verdicts):
        work = gates(self.rv, '1')
        work.mkdir(parents=True, exist_ok=True)
        now = time.time() - 600
        events = [{'ts': now, 'step': '-', 'state': 'begin', 'msg': ''}]
        for index, (num, verdict) in enumerate(verdicts):
            events.append({'ts': now + index, 'step': num, 'state': 'start', 'msg': ''})
            events.append({'ts': now + index + 0.5, 'step': num, 'state': 'done', 'verdict': verdict, 'items': []})
        (work / 'events.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))

    def test_manual_step_is_next_and_waiting_not_done(self):
        self.seed([(n, 'pass') for n in ('00', '01', '02', '03', '04')] + [('05', 'manual')])
        _, data = begin(self.rv, '1')
        self.assertEqual(data['done'], ['00', '01', '02', '03', '04'])
        self.assertEqual((data['next'], data['waiting']), ('05', '05'))

    def test_a_gap_before_the_manual_step_is_next_and_nothing_waits(self):
        self.seed([('00', 'pass'), ('01', 'pass'), ('05', 'manual')])
        _, data = begin(self.rv, '1')
        self.assertEqual(data['done'], ['00', '01'])
        self.assertEqual((data['next'], data['waiting']), ('02', None))

    def test_a_fresh_begin_has_nothing_waiting(self):
        _, data = begin(self.rv, '1')
        self.assertEqual((data['next'], data['waiting'], data['done']), ('00', None, []))


class PortBinding(unittest.TestCase):
    def test_a_port_held_on_every_address_is_skipped(self):
        import socket
        for _ in range(20):
            probe = socket.socket()
            probe.bind(('127.0.0.1', 0))
            first = probe.getsockname()[1]
            probe.close()
            wildcard = socket.socket()
            wildcard.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                wildcard.bind(('0.0.0.0', first))
            except OSError:
                wildcard.close()
                continue
            wildcard.listen(1)
            break
        else:
            self.skipTest('no free port')
        saved = pipeline_ui.PORTS
        pipeline_ui.PORTS = range(first, first + 2)
        try:
            server = pipeline_ui.bind(None, 0)
        finally:
            pipeline_ui.PORTS = saved
            wildcard.close()
        try:
            self.assertEqual(server.server_address[1], first + 1)
        finally:
            server.server_close()


class IdleBanner(unittest.TestCase):
    def banner(self, idle):
        now = 10_000.0
        events = [{'ts': now - idle - 5, 'step': '-', 'state': 'begin'}, {'ts': now - idle - 4, 'step': '03', 'state': 'start', 'msg': 'chạy'},
                  {'ts': now - idle, 'step': '03', 'state': 'note', 'msg': 'M3 xong'}]
        steps, meta = pipeline_ui.model(events)
        return pipeline_ui.banner_of(steps, meta, now)

    def test_recent_activity_shows_the_running_step(self):
        kind, text = self.banner(60)
        self.assertEqual(kind, 'run')
        self.assertIn('Đang ở bước 03', text)

    def test_five_minutes_of_silence_warns_and_keeps_the_last_note(self):
        kind, text = self.banner(300)
        self.assertEqual(kind, 'wait')
        self.assertIn('chưa có ghi chú mới', text)
        self.assertIn('M3 xong', text)

    def test_a_step_waiting_for_the_human_says_who_and_what(self):
        events = [{'ts': 1, 'step': '05', 'state': 'start'}, {'ts': 2, 'step': '05', 'state': 'done', 'verdict': 'manual', 'items': []}]
        steps, meta = pipeline_ui.model(events)
        self.assertIn('OK post', pipeline_ui.banner_of(steps, meta, 3)[1])


class DescriptionHash(unittest.TestCase):
    def test_the_guard_hashes_raw_bytes_so_it_matches_shasum_on_a_crlf_description(self):
        template = (HERE / 'post_guard.template.sh').read_text()
        snippet = re.search(r'python3\.12 -c "(import hashlib[^"]*)"', template).group(1)
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'desc.txt'
            path.write_bytes(b'## PR\r\nline two\r\n')
            guard = subprocess.run([sys.executable, '-I', '-c', snippet.replace("$OUT/$D-desc.txt", str(path))],
                                   capture_output=True, text=True, check=True).stdout.strip()
            shasum = subprocess.run(['shasum', '-a', '256', str(path)], capture_output=True, text=True, check=True).stdout[:16]
        self.assertEqual(guard, shasum)



class StackedBase(unittest.TestCase):
    """gate_intake.sh against a fake gh: the base of a stacked PR is the head ref of the parent PR named in its description."""

    FAKE_GH = """#!/usr/bin/env python3
import os, sys
a = sys.argv[1:]
if a[:2] == ['auth', 'token']:
    print('token')
elif 'pulls/9' in a[1] and '.base.ref' in ' '.join(a):
    print('open false null Sotatek-X ' + os.environ['FAKE_HEAD'] + ' ' + os.environ['FAKE_BASE'])
elif a[1].endswith('pulls/9') and '.body' in a:
    print(os.environ['FAKE_BODY'])
elif a[1].endswith('pulls/5'):
    print(os.environ.get('FAKE_PARENT_REF', ''))
elif 'branches/develop' in a[1]:
    print(os.environ['FAKE_HEAD'])
elif 'issues/9' in a[1]:
    print('type/feature')
"""

    def run_gate(self, base, body, parent_ref, work=None):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            repo = tmp / 'repo'
            repo.mkdir()
            git = lambda *args: subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()
            git('init', '-q')
            git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
            head = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/remotes/pr/9', head)
            git('update-ref', 'refs/remotes/origin/develop', head)
            bin_dir = tmp / 'bin'
            bin_dir.mkdir()
            (bin_dir / 'gh').write_text(self.FAKE_GH)
            (bin_dir / 'gh').chmod(0o755)
            handbook = tmp / 'handbook.md'
            handbook.write_text('x')
            env = {'PATH': f'{bin_dir}:/usr/bin:/bin', 'RV': str(repo), 'HANDBOOK': str(handbook), 'REVIEWER': 'r', 'REPO': 'o/r',
                   'WT_PREFIX': 'wt-', 'FAKE_HEAD': head, 'FAKE_BASE': base, 'FAKE_BODY': body, 'FAKE_PARENT_REF': parent_ref,
                   **({'WORK': str(work)} if work else {})}
            done = subprocess.run(['/bin/bash', str(HERE / 'gate_intake.sh'), '9', str(repo)], capture_output=True, text=True, env=env)
        return done.returncode, done.stdout

    def test_the_head_it_saw_is_recorded_for_the_later_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp) / 'gates'
            self.run_gate('develop', '', '', work)
            self.assertRegex((work / 'head.sha').read_text(), r'^[0-9a-f]{40}\n$')

    def test_develop_passes(self):
        code, out = self.run_gate('develop', '## PR Dependencies\n- None\n', '')
        self.assertIn('PASS   base=develop', out)

    def test_a_parent_pr_branch_named_in_the_dependencies_passes(self):
        code, out = self.run_gate('feat/parent', '## PR Dependencies\n- #5\n\n## Description\nx', 'feat/parent')
        self.assertIn('PASS   base=feat/parent (stacked on open #5', out)

    def test_a_branch_nobody_named_fails(self):
        code, out = self.run_gate('feat/parent', '## PR Dependencies\n- None\n\n## Description\nx', 'feat/parent')
        self.assertIn('FAIL   base=feat/parent', out)
        self.assertEqual(code, 1)

    def test_a_named_parent_with_a_different_head_ref_fails(self):
        code, out = self.run_gate('feat/parent', '## PR Dependencies\n- #5\n', 'feat/other')
        self.assertIn('FAIL   base=feat/parent', out)

    def test_a_closed_parent_fails(self):
        code, out = self.run_gate('feat/parent', '## PR Dependencies\n- #5\n', '')
        self.assertIn('FAIL   base=feat/parent', out)

    def test_a_pr_mentioned_after_the_dependencies_section_does_not_count(self):
        code, out = self.run_gate('feat/parent', '## PR Dependencies\n- None\n\n## Description\nfollows #5', 'feat/parent')
        self.assertIn('FAIL   base=feat/parent', out)


class HeadMoved(unittest.TestCase):
    """The author pushes while a runner works: later steps stop instead of judging a head nobody reviewed."""

    FAKE_GH = """#!/bin/sh
case "$1" in
  auth) echo token ;;
  api) [ -z "$FAKE_GH_DOWN" ] || exit 1; echo "$FAKE_HEAD" ;;
esac
"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rv = self.tmp.name
        bin_dir = pathlib.Path(self.rv, 'bin')
        bin_dir.mkdir()
        (bin_dir / 'gh').write_text(self.FAKE_GH)
        (bin_dir / 'gh').chmod(0o755)
        self.work = gates(self.rv, '9')
        self.work.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def run_step(self, action, step_no, now_head, down=False):
        env = {'RV': self.rv, 'PATH': f'{self.rv}/bin:/usr/bin:/bin', 'REPO': 'o/r', 'REVIEWER': 'r', 'FAKE_HEAD': now_head,
               'PYTHONDONTWRITEBYTECODE': '1', **({'FAKE_GH_DOWN': '1'} if down else {})}
        return subprocess.run([sys.executable, '-I', str(HERE / 'pipeline_step.py'), action, '9', step_no], env=env, capture_output=True, text=True)

    def test_a_step_after_00_stops_when_github_has_a_newer_head(self):
        (self.work / 'head.sha').write_text('a' * 40 + '\n')
        done = self.run_step('start', '01', 'b' * 40)
        self.assertEqual(done.returncode, 5)
        self.assertIn('HEAD_MOVED', done.stderr)
        self.assertIn('aaaaaaaaaa', done.stderr)
        self.assertEqual(json.loads((self.work / 'events.jsonl').read_text().splitlines()[-1])['state'], 'note')

    def test_done_stops_too_so_a_gate_does_not_pass_on_the_old_head(self):
        (self.work / 'head.sha').write_text('a' * 40 + '\n')
        self.assertEqual(self.run_step('done', '03', 'b' * 40).returncode, 5)

    def test_the_same_head_lets_the_step_run(self):
        (self.work / 'head.sha').write_text('a' * 40 + '\n')
        self.assertEqual(self.run_step('start', '01', 'a' * 40).returncode, 0)

    def test_step_00_is_how_a_review_takes_the_new_head_so_it_is_never_stopped(self):
        (self.work / 'head.sha').write_text('a' * 40 + '\n')
        self.assertEqual(self.run_step('start', '00', 'b' * 40).returncode, 0)

    def test_no_recorded_head_or_a_github_that_does_not_answer_does_not_stop_the_review(self):
        self.assertEqual(self.run_step('start', '01', 'b' * 40).returncode, 0)
        (self.work / 'head.sha').write_text('a' * 40 + '\n')
        self.assertEqual(self.run_step('start', '01', 'b' * 40, down=True).returncode, 0)


class ValueOrigin(unittest.TestCase):
    """scan_triggers VALUE_ORIGIN and check_draft origin: a value the PR starts reading with a None/default guard must be traced to
    the code that writes it (#19308: the test built a session without a mode, activate_session always writes one)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(HERE))
        import check_draft
        import scan_triggers
        cls.cd, cls.st = check_draft, scan_triggers

    def repo(self, files_base, files_head):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)

        def commit(files, msg):
            for name, text in files.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(text)
            subprocess.run(['git', '-C', str(root), 'add', '-A'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], check=True)
            return subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()

        subprocess.run(['git', '-C', str(root), 'init', '-q'], check=True)
        base = commit(files_base, 'base')
        return str(root), base, commit(files_head, 'head')

    STATE_BASE = 'def build(session):\n    return {"title": session.title}\n'
    STATE_HEAD = (
        'def build(session):\n'
        '    """The room as web reads it: session.deadline and session.mode, or a default when there is none."""\n'
        '    return {\n'
        '        "title": session.title,\n'
        '        "mode": session.mode.name if session.mode else FREE,\n'
        '        "label": session.title or "x",\n'
        '    }\n')
    TASKS = ('def activate(now):\n'
             '    return Session.objects.modify(set_on_insert__mode=Mode(name="free", nbf=now))\n')
    NOISE = 'def other():\n    return open("f", mode="rb")\n'
    NEIGHBOUR = 'def call():\n    return build(mode="x")\n'

    def rows(self, head_files=None):
        root, base, head = self.repo(
            {'app/live/state.py': self.STATE_BASE, 'app/live/tasks.py': self.TASKS, 'app/live/aaa.py': self.NEIGHBOUR, 'app/other.py': self.NOISE},
            {'app/live/state.py': self.STATE_HEAD, 'app/live/tasks.py': self.TASKS, 'app/live/aaa.py': self.NEIGHBOUR, 'app/other.py': self.NOISE,
             **(head_files or {})})
        return self.st.value_origins(root, base, head)

    def test_a_value_the_pr_starts_reading_with_a_guard_is_traced_to_where_it_is_written(self):
        rows = self.rows()
        mode = [r for r in rows if r[3].startswith('mode | ')]
        self.assertEqual(len(mode), 1)
        self.assertEqual(mode[0][0], 'VALUE_ORIGIN')
        self.assertEqual(mode[0][1], 'app/live/state.py:5')
        self.assertIn('ghi ở app/live/tasks.py:2', mode[0][3])

    def test_the_database_write_comes_before_a_plain_keyword_of_the_same_name_even_in_a_file_that_sorts_first(self):
        where = [r for r in self.rows() if r[3].startswith('mode | ')][0][3]
        self.assertIn('app/live/aaa.py:2', where)
        self.assertLess(where.index('app/live/tasks.py:2'), where.index('app/live/aaa.py:2'))
        self.assertLess(where.index('app/live/aaa.py:2'), where.index('app/other.py:2'))

    def test_a_value_the_file_already_read_before_the_pr_is_not_listed(self):
        self.assertFalse([r for r in self.rows() if r[3].startswith('title | ')])

    def test_prose_in_a_docstring_and_a_default_constant_are_not_values(self):
        idents = {r[3].split(' | ')[0] for r in self.rows()}
        self.assertIn('mode', idents)
        self.assertNotIn('deadline', idents)
        self.assertNotIn('FREE', idents)

    def test_a_value_nobody_writes_says_so(self):
        head = {'app/live/state.py': 'def build(r):\n    return r.retry_after or 0\n'}
        root, base, head = self.repo({'app/live/state.py': 'def build(r):\n    return 1\n'}, head)
        rows = self.st.value_origins(root, base, head)
        self.assertEqual([r[3].split(' | ')[:2] for r in rows], [['retry_after', 'không có chỗ ghi trong code']])

    def test_a_test_file_and_a_new_file_are_handled(self):
        head = {'app/new.py': 'def f(s):\n    return s.expiry or 0\n', 'tests/test_x.py': 'def test_a(s):\n    assert s.only_in_tests or 1\n'}
        idents = {r[3].split(' | ')[0] for r in self.rows(head)}
        self.assertIn('expiry', idents)
        self.assertNotIn('only_in_tests', idents)

    def test_a_name_the_file_read_on_another_object_does_not_hide_the_new_path(self):
        base = {'app/live/state.py': 'def build(show):\n    return {"nbf": show.nbf}\n', 'app/live/tasks.py': self.TASKS}
        head = {'app/live/state.py': 'def build(show, session):\n    return {"nbf": show.nbf, "m": session.mode and session.mode.nbf}\n', 'app/live/tasks.py': self.TASKS}
        root, b, h = self.repo(base, head)
        idents = {r[3].split(' | ')[0] for r in self.st.value_origins(root, b, h)}
        self.assertTrue({'mode', 'nbf'} <= idents)

    def test_the_same_path_under_another_variable_name_is_still_old(self):
        base = {'app/live/state.py': 'def build(a):\n    return a.mode.nbf\n'}
        head = {'app/live/state.py': 'def build(a, session):\n    return a.mode.nbf, session.mode and session.mode.nbf\n'}
        root, b, h = self.repo(base, head)
        self.assertEqual(self.st.value_origins(root, b, h), [])

    def test_class_enum_and_constant_names_are_not_values(self):
        self.assertEqual(self.st.reads('Session.SessionStatus.preset or ModeEnum.FREE or models.Goal'), {'SessionStatus.preset'})
        root, b, h = self.repo({'app/a.py': 'x = 1\n'}, {'app/a.py': 'def f(x: models.Goal | None):\n    return x\n'})
        self.assertEqual(self.st.value_origins(root, b, h), [])

    def test_a_method_call_ends_the_path(self):
        self.assertEqual(self.st.reads('x = utils.as_utc(session.mode.nbf).isoformat()'), {'mode', 'mode.nbf'})

    def worktree(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        wt = pathlib.Path(tmp.name)
        (wt / 'app').mkdir()
        (wt / 'app/tasks.py').write_text('def activate(now):\n    return Session.objects.modify(\n        set_on_insert__mode=Mode(nbf=now),\n    )\n' + '\n' * 20 + 'x = 1\n')
        return str(wt)

    ROW = [('VALUE_ORIGIN', 'a.py:1', 'f', 'mode | ghi ở app/tasks.py:3 | x')]

    def test_the_draft_needs_a_line_naming_the_value_and_citing_the_place_that_writes_it(self):
        wt = self.worktree()
        rows = self.ROW + [('VALUE_ORIGIN', 'a.py:2', 'f', 'retry_after | không có chỗ ghi trong code | y')]
        self.assertEqual(self.cd.origin_missing('', rows, wt), ['mode', 'retry_after'])
        sec = '- `mode`: ghi ở app/tasks.py:3 với nbf now; test dựng qua activate.\n- `retry_after`: không có chỗ ghi trong code, đến từ thư viện.\n'
        self.assertEqual(self.cd.origin_missing(sec, rows, wt), [])

    def test_a_line_with_only_the_name_or_only_a_location_does_not_count(self):
        wt = self.worktree()
        self.assertEqual(self.cd.origin_missing('- mode: đã xem, không sao\n', self.ROW, wt), ['mode'])
        self.assertEqual(self.cd.origin_missing('- ghi ở app/tasks.py:3\n', self.ROW, wt), ['mode'])
        self.assertEqual(self.cd.origin_missing('- model: ghi ở app/tasks.py:3\n', self.ROW, wt), ['mode'])

    def test_a_made_up_location_does_not_count(self):
        wt = self.worktree()
        for line in (
            '- mode: ghi ở zzz_unrelated.py:1',
            '- mode: ghi ở app/missing.py:3',
            '- mode: ghi ở app/tasks.py:3999',
            '- mode: ghi ở app/tasks.py:25',
        ):
            with self.subTest(line=line):
                self.assertEqual(self.cd.origin_missing(line + '\n', self.ROW, wt), ['mode'])

    def test_a_location_a_couple_of_lines_off_and_an_absolute_path_both_count(self):
        wt = self.worktree()
        self.assertEqual(self.cd.origin_missing('- mode: ghi ở app/tasks.py:1\n', self.ROW, wt), [])
        self.assertEqual(self.cd.origin_missing('- mode: ghi ở app/tasks.py:5\n', self.ROW, wt), [])
        self.assertEqual(self.cd.origin_missing(f'- mode: ghi ở {wt}/app/tasks.py:3\n', self.ROW, wt), [])

    def test_names_that_often_carry_a_default_are_reported(self):
        idents = {r[3].split(' | ')[0] for r in self.rows({'app/new.py': 'def f(s):\n    return s.status or s.owner or 0\n'})}
        self.assertTrue({'status', 'owner'} <= idents)

    def test_a_pr_with_many_guarded_reads_gets_a_row_for_each(self):
        body = ''.join(f'    a{i:02} = s.attr{i:02} or 0\n' for i in range(15))
        rows = self.rows({'app/many.py': 'def f(s):\n' + body})
        self.assertEqual(len([r for r in rows if r[1].startswith('app/many.py')]), 15)

    def test_a_source_with_an_invalid_escape_is_scanned_without_a_warning(self):
        import warnings
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            self.st.docstring_lines('pattern = "\\.py"\n')
        self.assertEqual(caught, [])


class InlineGate(unittest.TestCase):
    """check_draft inline: a finding tied to a line must not live only in the body (#19323 sat four reviews with 0 inline comments)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(HERE))
        import check_draft
        cls.cd = check_draft

    BLOCK = ('### 1. `app/mod.py` L12 (RIGHT)\n\n**Comment (EN, sẽ post):**\n\nUse the house sentinel:\n\n```suggestion\nX = UNSET\n```\n\n'
             '**Vì sao:** conventions.\n')

    def gate(self, text, body):
        import contextlib
        import io
        self.cd.results.clear()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.cd.check_inline(text, body)
        return out.getvalue()

    def gate_event(self, text, body, event):
        import contextlib
        import io
        self.cd.results.clear()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.cd.check_inline(text, body, event)
        return out.getvalue()

    def points(self, five):
        return '\n'.join(f'{i}. {label}: {five if i == 5 else "No"}' for i, label in enumerate(self.cd.POINTS, 1))

    def test_a_yes_with_no_inline_comment_is_left_to_the_human(self):
        body = self.points('Yes. `Any` is back.')
        self.assertIn('MANUAL inline', self.gate(body, body).replace('  ', ' '))

    def test_a_body_that_cites_a_line_with_no_inline_comment_is_left_to_the_human(self):
        body = self.points('No') + '\nSee `app/mod.py:12`.'
        self.assertIn('body trỏ `app/mod.py:12`', self.gate(body, body))

    def test_an_inline_block_passes_even_with_a_yes(self):
        body = self.points('Yes. The sentinel.')
        out = self.gate(body + '\n\n' + self.BLOCK, body)
        self.assertIn('PASS   inline', out)
        self.assertNotIn('MANUAL', out)

    def test_all_no_and_no_citation_needs_no_inline_comment(self):
        body = self.points('No')
        self.assertIn('PASS   inline', self.gate(body, body))

    def test_a_yes_on_the_description_point_is_pr_level_and_ignored(self):
        body = self.points('No').replace('7. Hard to follow: No', '7. Hard to follow: Yes. The description is empty.')
        self.assertIn('PASS   inline', self.gate(body, body))

    def test_a_request_changes_with_no_inline_comment_is_left_to_the_human_even_when_every_point_is_no(self):
        body = self.points('No').replace('7. Hard to follow: No', '7. Hard to follow: Yes. The description is out of date.')
        out = self.gate_event(body, body, 'REQUEST_CHANGES')
        self.assertIn('MANUAL inline', out)
        self.assertIn('event REQUEST_CHANGES', out)

    def test_an_approve_with_nothing_to_anchor_still_passes(self):
        body = self.points('No')
        self.assertIn('PASS   inline', self.gate_event(body, body, 'APPROVE'))

    def test_a_request_changes_with_an_inline_block_passes(self):
        body = self.points('Yes. The sentinel.')
        self.assertIn('PASS   inline', self.gate_event(body + '\n\n' + self.BLOCK, body, 'REQUEST_CHANGES'))

    def test_the_indented_example_in_the_template_is_not_a_block(self):
        example = '    ### 1. `p.py` L1 (RIGHT)\n\n    **Comment (EN, sẽ post):**\n\n    text\n\n    **Vì sao:** x\n'
        body = self.points('No')
        self.assertNotIn('FAIL', self.gate(body + '\n\n' + example, body))

    def test_a_block_build_payload_would_drop_fails(self):
        bad = self.BLOCK.replace('### 1. `app/mod.py` L12 (RIGHT)', '### 1. app/mod.py line 12')
        body = self.points('No')
        self.assertIn('FAIL   inline-form', self.gate(body + '\n\n' + bad, body))


if __name__ == '__main__':
    unittest.main()


class DraftVoice(unittest.TestCase):
    """check_draft: a body that reads like a colleague, and a gate that does not force odd sentences into it."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(HERE))
        import check_draft
        cls.cd = check_draft

    def hits(self, text):
        return [name for pat, name in self.cd.BANNED if re.search(pat, text)]

    def test_quote_ignores_case_backticks_and_full_stop(self):
        body = 'Your tests pass. The unlink still removes only the `provider` that was asked for.'
        self.assertTrue(self.cd.quote_in_body('the unlink still removes only the provider that was asked for', body))
        self.assertTrue(self.cd.quote_in_body('The unlink still removes only the provider that was asked for.', body))

    def test_quote_must_still_be_in_the_body(self):
        self.assertFalse(self.cd.quote_in_body('the unlink deletes the PG provider row', 'Your tests pass.'))
        self.assertFalse(self.cd.quote_in_body('', 'Your tests pass.'))
        self.assertFalse(self.cd.quote_in_body(' ` ', 'Your tests pass.'))

    def test_tool_narration_is_banned(self):
        for text in (
            'The tests cover the unlink and the guard in several ways.',
            'I broke the unlink and the guard on purpose and your tests caught both.',
            'I broke each fix on purpose and your tests caught every one.',
            'It still lacks the PG retry, which we agreed to leave.',
            "Bingyang's and Han's approvals were dismissed too, so those are still needed.",
        ):
            with self.subTest(text=text):
                self.assertTrue(self.hits(text))

    def test_plain_findings_are_not_banned(self):
        for text in (
            'I removed is_primary from the facade call and every test stayed green.',
            'Your tests still catch the cases I tried against the guard and the unlink.',
            'Joel\'s change request is still on the old commit, so he needs to look again.',
        ):
            with self.subTest(text=text):
                self.assertEqual(self.hits(text), [])

    def test_repeated_idea_is_found(self):
        body = ('3. Serious bug: No. The code is the same as the version I approved, rebased onto develop.\n\n'
                'Approving again. The code is the same as the version I approved, and your tests pass.')
        self.assertTrue(self.cd.repeated_phrase(body))

    def test_repeats_that_are_not_ideas_are_left_alone(self):
        self.assertIsNone(self.cd.repeated_phrase('1. No. 2. No issue. 3. No. Heads up that this is DM. Heads up that this is DM.'))
        call = 'some_long_call(first_argument, second_argument, third_argument, fourth_argument, fifth_argument, sixth_argument, seventh_argument, eighth_argument, ninth_argument)'
        code = f'```\\n{call}\\n{call}\\n```'
        self.assertIsNone(self.cd.repeated_phrase('Please add this test.\n' + code))
