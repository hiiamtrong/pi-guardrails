import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pipeline_step as ps

HERE = pathlib.Path(__file__).resolve().parent


def step(rv, *args, **env):
    full = dict(os.environ, RV=str(rv), HANDBOOK=str(rv / 'AGENTS.md'), REVIEWER='someone', REPO='o/r', WT_PREFIX='wt-', **env)
    return subprocess.run([sys.executable, str(HERE / 'pipeline_step.py'), *args], env=full, capture_output=True, text=True, timeout=60)


def events(rv, pr):
    path = rv / 'reports' / 'reviews' / 'evidence' / pr / 'gates' / 'events.jsonl'
    return [json.loads(line) for line in path.read_text().splitlines()]


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rv = pathlib.Path(self.tmp.name)
        (self.rv / 'AGENTS.md').write_text('# handbook\n')

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_step_whose_gate_is_off_passes_with_an_info_line_and_runs_no_gate(self):
        r = step(self.rv, 'done', '77', '02', GATES='00 06')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('pass (không có gate máy)', r.stdout)
        done = events(self.rv, '77')[-1]
        self.assertEqual((done['step'], done['state'], done['verdict']), ('02', 'done', 'pass'))
        self.assertEqual([i['st'] for i in done['items']], ['INFO'])

    def test_step_04_follows_the_draft_gate(self):
        off = step(self.rv, 'done', '78', '04', GATES='00 06')
        self.assertIn('không có gate máy', off.stdout)
        # with 05 on, 04 goes the normal way and needs pipeline_status.sh, which stops here without a worktree
        on = step(self.rv, 'done', '79', '04', GATES='00 05')
        self.assertNotIn('không có gate máy', on.stdout)

    def test_no_gates_setting_keeps_every_gate(self):
        r = step(self.rv, 'done', '80', '02')
        self.assertNotIn('không có gate máy', r.stdout)

    def test_intake_is_never_switched_off(self):
        r = step(self.rv, 'done', '81', '00', GATES='06')
        self.assertNotIn('không có gate máy', r.stdout)



class WidgetTest(unittest.TestCase):
    NOW = 1000.0

    def lines(self, *events):
        return ps.widget_lines('7', [{'ts': ts, 'step': step, 'state': state, 'msg': '', **extra} for ts, step, state, extra in events], self.NOW)

    def test_a_running_step_carries_a_since_mark_instead_of_a_frozen_time(self):
        lines = self.lines((900.0, '-', 'begin', {}), (940.0, '01', 'start', {}))
        self.assertIn('{{since:940}}', lines[0])
        self.assertNotIn('(0s)', lines[0])
        self.assertIn('▶ 01 comments ({{since:940}})', lines)

    def test_a_finished_step_shows_how_long_it_took_and_one_that_did_not_start_shows_nothing(self):
        lines = self.lines((900.0, '00', 'start', {}), (912.0, '00', 'done', {'verdict': 'pass', 'items': []}),
                           (920.0, '04', 'start', {}), (960.0, '04', 'done', {'verdict': 'fail', 'items': [{'st': 'FAIL'}]}))
        self.assertIn('✔ 00 intake (12s)', lines)
        self.assertIn('✘ 04 outside-diff (40s) (1 gate đỏ)', lines)
        self.assertIn('· 02 map', lines)

    def test_a_step_longer_than_a_minute_uses_minutes(self):
        lines = self.lines((100.0, '03', 'start', {}), (225.0, '03', 'done', {'verdict': 'pass', 'items': []}))
        self.assertIn('✔ 03 verify (2m05s)', lines)


if __name__ == '__main__':
    unittest.main()
