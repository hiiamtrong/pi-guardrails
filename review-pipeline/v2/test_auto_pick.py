import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

from auto_pick import pick
from review_board import classify

T0 = datetime.datetime(2026, 1, 1, 12, 0, tzinfo=datetime.UTC)
SETTLE = 600


def at(minutes):
    return T0 + datetime.timedelta(minutes=minutes)


def row(number=1, bucket='unreviewed', head='a' * 40, state=None, when=None, reply_at=None, draft=False):
    return {'number': number, 'bucket': bucket, 'head': head, 'state': state, 'at': when, 'reply_at': reply_at, 'draft': draft}


class Pick(unittest.TestCase):
    def test_a_pr_is_picked_only_after_it_has_been_unchanged_for_the_settle_time(self):
        state = {}
        self.assertEqual(pick([row()], state, at(0), SETTLE, 5), [])
        self.assertEqual(pick([row()], state, at(9), SETTLE, 5), [])
        self.assertEqual(pick([row()], state, at(10), SETTLE, 5), [1])

    def test_a_new_push_restarts_the_wait(self):
        state = {}
        pick([row()], state, at(0), SETTLE, 5)
        self.assertEqual(pick([row(head='b' * 40)], state, at(10), SETTLE, 5), [])
        self.assertEqual(pick([row(head='b' * 40)], state, at(20), SETTLE, 5), [1])

    def test_a_run_for_the_same_state_is_never_repeated(self):
        state = {}
        pick([row()], state, at(0), SETTLE, 5)
        self.assertEqual(pick([row()], state, at(10), SETTLE, 5), [1])
        self.assertEqual(pick([row()], state, at(60), SETTLE, 5), [])

    def test_only_prs_that_need_a_review_are_picked(self):
        state = {}
        rows = [row(1, 'unreviewed'), row(2, 'stale'), row(3, 'reply', reply_at='t1'), row(4, 'waiting'), row(5, 'done'), row(6, 'stale', draft=True)]
        pick(rows, state, at(0), SETTLE, 5)
        self.assertEqual(pick(rows, state, at(10), SETTLE, 5), [1, 2, 3])

    def test_a_new_reply_on_the_same_head_is_a_new_trigger(self):
        state = {}
        pick([row(bucket='reply', reply_at='t2', when='t1')], state, at(0), SETTLE, 5)
        pick([row(bucket='reply', reply_at='t2', when='t1')], state, at(10), SETTLE, 5)
        self.assertEqual(pick([row(bucket='reply', reply_at='t3', when='t1')], state, at(11), SETTLE, 5), [])
        self.assertEqual(pick([row(bucket='reply', reply_at='t3', when='t1')], state, at(21), SETTLE, 5), [1])

    def test_a_reply_after_an_ack_is_a_new_trigger_even_though_the_count_is_one_again(self):
        head = 'b' * 40
        user = lambda login: {'login': login, 'type': 'User'}
        pr = {'number': 7, 'user': user('author'), 'title': 't', 'draft': False, 'head': {'sha': head}}
        mine = [{'user': user('me'), 'state': 'APPROVED', 'commit_id': head, 'submitted_at': '2026-01-01T00:00:00Z', 'body': 'x'}]
        reply = lambda at: {'user': user('author'), 'created_at': at, 'body': 'r'}
        first = classify(pr, mine, [reply('2026-01-02T00:00:00Z')], [], [{'sha': head}], 'me')
        state = {}
        self.assertEqual(pick([first], state, at(0), 0, 5), [7])
        second = classify(pr, mine, [reply('2026-01-02T00:00:00Z'), reply('2026-01-05T00:00:00Z')], [], [{'sha': head}], 'me', acked='2026-01-02T00:00:00Z')
        self.assertEqual(second['human'], first['human'])
        self.assertEqual(pick([second], state, at(60), 0, 5), [7])

    def test_the_limit_leaves_the_rest_for_the_next_poll(self):
        state = {}
        rows = [row(1), row(2), row(3)]
        pick(rows, state, at(0), SETTLE, 2)
        self.assertEqual(pick(rows, state, at(10), SETTLE, 2), [1, 2])
        self.assertEqual(pick(rows, state, at(15), SETTLE, 2), [3])

    def test_baseline_marks_everything_as_already_run(self):
        state = {}
        pick([row(1), row(2)], state, at(0), SETTLE, 5, baseline=True)
        self.assertEqual(pick([row(1), row(2)], state, at(60), SETTLE, 5), [])
        self.assertEqual(pick([row(1), row(2, head='c' * 40)], state, at(70), SETTLE, 5), [])
        self.assertEqual(pick([row(1), row(2, head='c' * 40)], state, at(80), SETTLE, 5), [2])


class Cli(unittest.TestCase):
    SCRIPT = pathlib.Path(__file__).resolve().parent / 'auto_pick.py'

    def run_cli(self, rows, state, *args):
        r = subprocess.run([sys.executable, str(self.SCRIPT), '--state', str(state), '--settle', '0', *args],
                           input=json.dumps(rows), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.split()

    def test_state_survives_between_runs_and_dry_run_does_not_write_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = pathlib.Path(tmp) / 'state.json'
            self.assertEqual(self.run_cli([row()], state, '--dry-run'), ['1'])
            self.assertFalse(state.exists())
            self.assertEqual(self.run_cli([row()], state), ['1'])
            self.assertEqual(self.run_cli([row()], state), [])
            self.assertEqual(sorted(os.listdir(tmp)), ['state.json'])

    def test_garbage_from_the_board_stops_the_poll_with_a_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run([sys.executable, str(self.SCRIPT), '--state', str(pathlib.Path(tmp) / 's.json')], input='not json', capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('board không phải JSON', r.stderr)

    def test_an_empty_board_is_no_work_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run([sys.executable, str(self.SCRIPT), '--state', str(pathlib.Path(tmp) / 's.json')], input='', capture_output=True, text=True)
            self.assertEqual((r.returncode, r.stdout), (0, ''))

    def test_nothing_picked_prints_nothing_not_an_empty_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run([sys.executable, str(self.SCRIPT), '--state', str(pathlib.Path(tmp) / 's.json')], input='[]', capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout), (0, ''))


if __name__ == '__main__':
    unittest.main()
