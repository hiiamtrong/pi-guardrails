import datetime
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import review_board
from review_board import age, classify, render

ME = 'reviewer'
OLD, HEAD = 'a' * 40, 'b' * 40


def user(login, kind='User'):
    return {'login': login, 'type': kind}


def review(state, commit, at, who=ME, body='x', kind='User'):
    return {'user': user(who, kind), 'state': state, 'commit_id': commit, 'submitted_at': at, 'body': body}


def comment(who, at, body='reply', kind='User'):
    return {'user': user(who, kind), 'created_at': at, 'body': body}


def board(reviews=(), inline=(), conversation=(), commits=(OLD, HEAD), draft=False):
    pr = {'number': 1, 'user': user('author'), 'title': 't', 'draft': draft, 'head': {'sha': HEAD}}
    return classify(pr, list(reviews), list(inline), list(conversation), [{'sha': s} for s in commits], ME)


class Classify(unittest.TestCase):
    def test_no_review_of_mine_is_unreviewed(self):
        self.assertEqual(board()['bucket'], 'unreviewed')

    def test_a_pending_review_does_not_count(self):
        self.assertEqual(board([review('PENDING', HEAD, '2026-01-01T00:00:00Z')])['bucket'], 'unreviewed')

    def test_approve_on_the_current_head_is_done(self):
        self.assertEqual(board([review('APPROVED', HEAD, '2026-01-01T00:00:00Z')])['bucket'], 'done')

    def test_changes_requested_on_the_current_head_waits_for_the_author(self):
        self.assertEqual(board([review('CHANGES_REQUESTED', HEAD, '2026-01-01T00:00:00Z')])['bucket'], 'waiting')

    def test_a_commit_after_my_review_makes_it_stale_and_counts_the_commits(self):
        row = board([review('APPROVED', OLD, '2026-01-01T00:00:00Z')])
        self.assertEqual((row['bucket'], row['behind']), ('stale', 1))

    def test_a_dismissed_review_is_stale_even_on_the_head(self):
        self.assertEqual(board([review('DISMISSED', HEAD, '2026-01-01T00:00:00Z')])['bucket'], 'stale')

    def test_a_force_pushed_away_commit_is_stale_with_unknown_distance(self):
        row = board([review('APPROVED', 'c' * 40, '2026-01-01T00:00:00Z')])
        self.assertEqual((row['bucket'], row['behind']), ('stale', None))

    def test_the_latest_review_decides(self):
        row = board([review('CHANGES_REQUESTED', OLD, '2026-01-01T00:00:00Z'), review('APPROVED', HEAD, '2026-01-02T00:00:00Z')])
        self.assertEqual(row['bucket'], 'done')

    def test_a_human_reply_after_my_review_needs_me(self):
        row = board([review('APPROVED', HEAD, '2026-01-01T00:00:00Z')], inline=[comment('author', '2026-01-02T00:00:00Z')])
        self.assertEqual((row['bucket'], row['human']), ('reply', 1))

    def test_a_reply_before_my_review_is_old_news(self):
        row = board([review('APPROVED', HEAD, '2026-01-02T00:00:00Z')], inline=[comment('author', '2026-01-01T00:00:00Z')])
        self.assertEqual(row['bucket'], 'done')

    def test_bot_comments_are_counted_apart_and_do_not_reopen_the_review(self):
        row = board([review('APPROVED', HEAD, '2026-01-01T00:00:00Z')], conversation=[comment('bot', '2026-01-02T00:00:00Z', kind='Bot')])
        self.assertEqual((row['bucket'], row['human'], row['bots']), ('done', 0, 1))

    def test_an_empty_review_wrapper_is_not_a_reply(self):
        wrapper = review('COMMENTED', HEAD, '2026-01-02T00:00:00Z', who='author', body='')
        self.assertEqual(board([review('APPROVED', HEAD, '2026-01-01T00:00:00Z'), wrapper])['bucket'], 'done')

    def test_replying_in_a_thread_does_not_hide_a_stale_approve(self):
        wrapper = review('COMMENTED', HEAD, '2026-01-03T00:00:00Z', body='')
        row = board([review('APPROVED', OLD, '2026-01-01T00:00:00Z'), wrapper])
        self.assertEqual((row['bucket'], row['state']), ('stale', 'APPROVED'))

    def test_a_comment_from_a_deleted_account_is_a_human_reply_not_a_crash(self):
        ghost = {'user': None, 'created_at': '2026-01-02T00:00:00Z', 'body': 'left before the account was deleted'}
        row = board([review('APPROVED', HEAD, '2026-01-01T00:00:00Z')], inline=[ghost])
        self.assertEqual((row['bucket'], row['human'], row['bots']), ('reply', 1, 0))

    def test_a_pr_from_a_deleted_account_still_lists(self):
        pr = {'number': 1, 'user': None, 'title': 't', 'draft': False, 'head': {'sha': HEAD}}
        self.assertEqual(classify(pr, [], [], [], [], ME)['author'], 'ghost')

    def test_my_own_comments_are_not_replies(self):
        row = board([review('COMMENTED', HEAD, '2026-01-01T00:00:00Z')], inline=[comment(ME, '2026-01-02T00:00:00Z')])
        self.assertEqual(row['bucket'], 'waiting')


def board_acked(acked, reviews=(), inline=(), commits=(OLD, HEAD)):
    pr = {'number': 1, 'user': user('author'), 'title': 't', 'draft': False, 'head': {'sha': HEAD}}
    return classify(pr, list(reviews), list(inline), [], [{'sha': s} for s in commits], ME, acked)


class Acknowledged(unittest.TestCase):
    APPROVE = review('APPROVED', HEAD, '2026-01-01T00:00:00Z')

    def test_a_reply_up_to_the_ack_is_read_and_stops_reopening_the_pr(self):
        row = board_acked('2026-01-03T00:00:00Z', [self.APPROVE], [comment('author', '2026-01-02T00:00:00Z'), comment('author', '2026-01-03T00:00:00Z')])
        self.assertEqual((row['bucket'], row['human']), ('done', 0))

    def test_a_reply_after_the_ack_brings_the_pr_back(self):
        row = board_acked('2026-01-02T00:00:00Z', [self.APPROVE], [comment('author', '2026-01-02T00:00:00Z'), comment('author', '2026-01-04T00:00:00Z')])
        self.assertEqual((row['bucket'], row['human']), ('reply', 1))

    def test_an_ack_older_than_my_review_changes_nothing(self):
        approve = review('APPROVED', HEAD, '2026-01-05T00:00:00Z')
        old_news = board_acked('2025-12-01T00:00:00Z', [approve], [comment('author', '2026-01-02T00:00:00Z')])
        new_reply = board_acked('2025-12-01T00:00:00Z', [approve], [comment('author', '2026-01-06T00:00:00Z')])
        self.assertEqual((old_news['bucket'], new_reply['bucket']), ('done', 'reply'))

    def test_an_ack_never_hides_a_new_commit(self):
        row = board_acked('2026-02-01T00:00:00Z', [review('APPROVED', OLD, '2026-01-01T00:00:00Z')])
        self.assertEqual(row['bucket'], 'stale')

    def test_without_an_ack_nothing_changes(self):
        row = board_acked(None, [self.APPROVE], [comment('author', '2026-01-02T00:00:00Z')])
        self.assertEqual((row['bucket'], row['human']), ('reply', 1))

    def test_ack_stores_the_newest_reply_of_others_not_my_own_or_empty_ones(self):
        reviews = [review('APPROVED', HEAD, '2026-01-01T00:00:00Z'), review('COMMENTED', HEAD, '2026-01-09T00:00:00Z', who='author', body='')]
        inline = [comment('author', '2026-01-02T00:00:00Z'), comment(ME, '2026-01-08T00:00:00Z'), comment('bot', '2026-01-05T00:00:00Z', kind='Bot')]
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'sub' / 'ack.json'
            with mock.patch.object(review_board, 'fetch_replies', return_value=(reviews, inline, [])):
                review_board.ack({}, 'o/r', [7], ME, path)
            self.assertEqual(review_board.read_acks(path), {'o/r#7': '2026-01-05T00:00:00Z'})

    def test_ack_keeps_the_marks_of_other_prs_and_skips_a_pr_without_replies(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'ack.json'
            path.write_text('{"o/r#1": "2026-01-01T00:00:00Z"}')
            with mock.patch.object(review_board, 'fetch_replies', return_value=([self.APPROVE], [], [])):
                review_board.ack({}, 'o/r', [2], ME, path)
            self.assertEqual(review_board.read_acks(path), {'o/r#1': '2026-01-01T00:00:00Z'})

    def test_one_unreadable_pr_does_not_drop_the_acks_of_the_others(self):
        replies = ([self.APPROVE], [comment('author', '2026-01-02T00:00:00Z')], [])

        def fetch_replies(env, repo, number):
            if number == 99:
                raise RuntimeError('gh api: HTTP 404')
            return replies

        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'ack.json'
            with mock.patch.object(review_board, 'fetch_replies', side_effect=fetch_replies), self.assertRaises(SystemExit) as stop:
                review_board.ack({}, 'o/r', [1, 99, 2], ME, path)
            self.assertEqual(stop.exception.code, 1)
            self.assertEqual(review_board.read_acks(path), {'o/r#1': '2026-01-02T00:00:00Z', 'o/r#2': '2026-01-02T00:00:00Z'})

    def test_a_write_cut_in_the_middle_leaves_the_old_file_readable(self):
        def cut_write(self, text, *args, **kwargs):
            with open(self, 'w') as f:
                f.write(text[:10])
            raise OSError('disk full')

        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'ack.json'
            path.write_text('{"o/r#1": "2026-01-01T00:00:00Z"}')
            with mock.patch.object(review_board, 'fetch_replies', return_value=([self.APPROVE], [comment('author', '2026-01-02T00:00:00Z')], [])), \
                    mock.patch.object(pathlib.Path, 'write_text', cut_write), self.assertRaises(OSError):
                review_board.ack({}, 'o/r', [2], ME, path)
            self.assertEqual(review_board.read_acks(path), {'o/r#1': '2026-01-01T00:00:00Z'})

    def test_ack_leaves_no_temporary_file_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'ack.json'
            with mock.patch.object(review_board, 'fetch_replies', return_value=([self.APPROVE], [comment('author', '2026-01-02T00:00:00Z')], [])):
                review_board.ack({}, 'o/r', [2], ME, path)
            self.assertEqual(sorted(x.name for x in pathlib.Path(tmp).iterdir()), ['ack.json'])

    def test_the_ack_flag_asks_github_for_a_token_and_the_replies_but_never_searches(self):
        calls = []

        def gh(env, *args):
            calls.append(args[0])
            return 'token\n'

        argv = ['review_board.py', '--repo', 'o/r', '--reviewer', ME, '--ack', '5', '6']
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(review_board, 'gh', gh), \
                mock.patch.object(review_board, 'ack') as ack, mock.patch.object(review_board, 'fetch', side_effect=AssertionError('fetch is for the board')):
            review_board.main()
        self.assertEqual((calls, ack.call_args.args[1:]), (['auth'], ('o/r', [5, 6], ME)))

    def test_a_missing_ack_file_is_an_empty_board_memory(self):
        self.assertEqual(review_board.read_acks(pathlib.Path('/nonexistent/ack.json')), {})

    def test_load_applies_the_ack_of_its_own_pr_only(self):
        reviews, inline = [self.APPROVE], [comment('author', '2026-01-02T00:00:00Z')]
        pr = {'number': 7, 'user': user('author'), 'title': 't', 'draft': False, 'head': {'sha': HEAD}}
        with mock.patch.object(review_board, 'fetch', return_value=(pr, reviews, inline, [], [{'sha': HEAD}])):
            self.assertEqual(review_board.load({}, 'o/r', 7, ME, {'o/r#7': '2026-01-03T00:00:00Z'})['bucket'], 'done')
            self.assertEqual(review_board.load({}, 'o/r', 7, ME, {'o/r#8': '2026-01-03T00:00:00Z'})['bucket'], 'reply')


class Render(unittest.TestCase):
    NOW = datetime.datetime(2026, 1, 3, tzinfo=datetime.UTC)

    def test_age_picks_the_largest_unit(self):
        self.assertEqual([age(t, self.NOW) for t in ('2026-01-02T23:30:00Z', '2026-01-02T20:00:00Z', '2025-12-30T00:00:00Z', None)], ['30m', '4h', '4d', ''])

    def test_a_pr_never_reviewed_shows_a_dash_not_no_new_commits(self):
        text = render([board()], self.NOW, False, 100, 'head')
        self.assertRegex(text, r'#1\s+author\s+-\s+-\s')

    def test_a_long_author_name_does_not_run_into_the_next_column(self):
        row = {**board([review('COMMENTED', HEAD, '2026-01-01T00:00:00Z')]), 'author': 'liamnguyen4-source'}
        text = render([row], datetime.datetime(2026, 1, 2, tzinfo=datetime.UTC), False, 120, 'h')
        self.assertNotIn('liamnguyen4-sourceCOMMENTED', text)
        self.assertIn('COMMENTED', text)

    def test_the_summary_uses_the_short_group_names(self):
        text = render([board([review('APPROVED', HEAD, '2026-01-01T00:00:00Z')])], self.NOW, False, 100, 'head')
        self.assertIn('Xong 1', text.splitlines()[1])

    def test_empty_groups_are_skipped_and_the_summary_counts_the_rest(self):
        rows = [board([review('APPROVED', OLD, '2026-01-01T00:00:00Z')], draft=True)]
        text = render(rows, self.NOW, False, 100, 'head')
        self.assertIn('Review lại', text)
        self.assertIn('DRAFT', text)
        self.assertNotIn('Chưa review (', text)
        self.assertIn('+1', text)


class Load(unittest.TestCase):
    def test_a_pr_that_cannot_be_read_becomes_an_error_row(self):
        with mock.patch.object(review_board, 'fetch', side_effect=RuntimeError('gh api: HTTP 404')):
            self.assertEqual(review_board.load({}, 'o/r', 7, ME), {'number': 7, 'error': 'gh api: HTTP 404'})


class EnvFile(unittest.TestCase):
    def test_values_are_read_the_way_the_extension_quotes_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / '.pipeline-env'
            path.write_text("export EMPTY=''\nexport PATTERN='^(Sotatek-.*|it'\\''s)$'\n")
            self.assertEqual(review_board.read_env_file(path), {'EMPTY': '', 'PATTERN': "^(Sotatek-.*|it's)$"})


if __name__ == '__main__':
    unittest.main()
