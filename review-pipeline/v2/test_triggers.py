import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import triggers_config as tc


def git(wt, *args):
    subprocess.run(['git', '-C', str(wt), '-c', 'user.name=t', '-c', 'user.email=t@t', *args], check=True, capture_output=True)


def scan(before, after, path='app/x.py', triggers=None, extra=None):
    """Rows of triggers.tsv for a one-file change, with the repo's vocabulary in `triggers`."""
    with tempfile.TemporaryDirectory() as tmp:
        wt = pathlib.Path(tmp)
        git(wt, 'init', '-q')
        for p, text in {path: before, **(extra or {}).get('before', {})}.items():
            (wt / p).parent.mkdir(parents=True, exist_ok=True)
            (wt / p).write_text(text)
        git(wt, 'add', '-A')
        git(wt, 'commit', '-qm', 'base')
        for p, text in {path: after, **(extra or {}).get('after', {})}.items():
            (wt / p).parent.mkdir(parents=True, exist_ok=True)
            (wt / p).write_text(text)
        git(wt, 'add', '-A')
        git(wt, 'commit', '-qm', 'head')
        env = {k: v for k, v in os.environ.items() if k != 'TRIGGERS'}
        if triggers is not None:
            env['TRIGGERS'] = json.dumps(triggers)
        r = subprocess.run([sys.executable, str(HERE / 'scan_triggers.py'), str(wt), 'HEAD~1', 'HEAD'], capture_output=True, text=True, env=env)
        return r, [line.split('\t') for line in r.stdout.splitlines()]


def kinds(rows):
    return sorted({r[0] for r in rows})


def deletes(after_line, path='app/x.py'):
    _, rows = scan('def f(a):\n    return 1\n', f'def f(a):\n    {after_line}\n    return 1\n', path)
    return any(r[0] == 'DATA_DELETE' for r in rows)


class DeleteVocabulary(unittest.TestCase):
    def test_real_removals_in_any_orm_or_language_are_found(self):
        for line in ['Doc.objects(id=i).update(unset__tags=1)', 'Doc.objects(id=i).update(pull__items=x)', 'Doc.objects(id=i).delete()',
                     "meta = {'indexes': [{'fields': ['at'], 'expireAfterSeconds': 60}]}", 'ops = [DeleteOne({"_id": i})]',
                     'doc.is_deleted = True', 'n = Doc.objects.bulk_write(ops).deleted_count', 'shutil.rmtree(path)', 'os.unlink(path)', "db.coll.update({}, {'$unset': {'a': 1}})",
                     'cursor.execute("DELETE FROM jobs WHERE id = 1")', 'redis.expire(key, 60)', 'cleanup_devices.apply_async(args=[1])']:
            self.assertTrue(deletes(line), line)

    def test_a_word_inside_a_name_or_a_string_is_not_a_removal(self):
        for line in ['is_truncated = False', "methods = ['DELETE']", "name = name.removeprefix('x')", 'doc.is_deleted = False',
                     'target_cleanup_keys = {a: None}', 'deleted_count = 0']:
            self.assertFalse(deletes(line), line)

    def test_other_languages_name_their_function_and_are_scanned(self):
        _, rows = scan('export function f() {\n  return 1\n}\n', 'export function f() {\n  repo.deleteById(id)\n  return 1\n}\n', 'src/a.ts')
        self.assertEqual([(r[0], r[2]) for r in rows], [('DATA_DELETE', 'f')])
        _, rows = scan('fn f() {\n}\n', 'fn f() {\n    db.truncate_table();\n}\n', 'src/a.rs')
        self.assertEqual([(r[0], r[2]) for r in rows], [('DATA_DELETE', 'f')])
        _, rows = scan('const f = (x) => {\n  return 1\n}\n', 'const f = (x) => {\n  store.destroy(x)\n  return 1\n}\n', 'src/b.js')
        self.assertEqual([(r[0], r[2]) for r in rows], [('DATA_DELETE', 'f')])

    def test_a_test_file_is_never_scanned(self):
        _, rows = scan('x = 1\n', 'Doc.objects.delete()\n', 'tests/test_a.py')
        self.assertEqual(rows, [['NONE']])
        _, rows = scan('x = 1\n', 'repo.deleteById(1)\n', 'src/a.test.ts')
        self.assertEqual(rows, [['NONE']])


class RepoVocabulary(unittest.TestCase):
    def test_the_defaults_name_no_service_so_nothing_is_cross_service_without_a_declaration(self):
        _, rows = scan('x = 1\n', 'client = OpenIMClient()\n')
        self.assertEqual(rows, [['NONE']])

    def test_a_repo_declares_its_own_service_names_and_flag_words(self):
        vocab = {'cross': r'(PaymentGateway)', 'crossFile': r'(PaymentGateway)', 'flag': r'(?i)(loyalty_points)'}
        _, rows = scan('x = 1\n', 'g = PaymentGateway()\npts = loyalty_points\n', triggers=vocab)
        self.assertEqual(kinds(rows), ['CROSS_FILE', 'CROSS_SERVICE', 'FLAG_SLACK'])

    def test_cross_by_extension_and_directory(self):
        vocab = {'crossByExt': {'.go': r'(billing\.Client)'}, 'crossDirs': r'^internal/clients/'}
        _, rows = scan('package x\n', 'package x\n\nvar c = billing.Client{}\n', 'internal/app/x.go', triggers=vocab)
        self.assertEqual(kinds(rows), ['CROSS_SERVICE'])
        _, rows = scan('package x\n', 'package x\n\nvar n = 1\n', 'internal/clients/y.go', triggers=vocab)
        self.assertEqual([(r[0], r[1]) for r in rows], [('CROSS_SERVICE', 'internal/clients/y.go:1')])

    def test_a_flag_word_gives_at_most_three_rows_per_file(self):
        flags = ''.join(f'x{i} = growthbook.get({i})\n' for i in range(8))
        _, rows = scan('a = 1\n', flags)
        self.assertEqual(sum(r[0] == 'FLAG_SLACK' for r in rows), 3)

    def test_a_bad_regex_or_an_unknown_key_stops_the_run_with_a_message(self):
        for bad, text in [({'delete': '('}, 'valid Python regex'), ({'deleet': 'x'}, 'unknown keys'), ({'sourceExt': 'py'}, 'list of extensions'),
                          ({'crossByExt': {'.go': 3}}, 'crossByExt')]:
            r, _ = scan('a = 1\n', 'a = 2\n', triggers=bad)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(text, r.stderr)
            self.assertEqual(r.stdout, '')


class ConfigUnread(unittest.TestCase):
    def test_a_setting_nobody_reads_is_listed_and_one_that_code_reads_is_not(self):
        _, rows = scan('app = 1\n', "READ_TIMEOUT = os.environ['READ_TIMEOUT']\n", 'app/code.py',
                       extra={'after': {'config/app.yaml': 'read_timeout_sec: 10\nREAD_TIMEOUT: 5\nname: x\n'}})
        unread = [(r[0], r[3]) for r in rows if r[0] == 'CONFIG_UNREAD']
        self.assertEqual(unread, [('CONFIG_UNREAD', 'read_timeout_sec')])

    def test_a_helm_value_read_by_a_template_counts_as_read(self):
        _, rows = scan('a = 1\n', 'a = 2\n',
                       extra={'after': {'charts/app/values.yaml': 'maxConnections: 5\nunusedSetting: 1\n',
                                        'charts/app/templates/dep.yaml': 'x: {{ .Values.maxConnections }}\n'}})
        self.assertEqual([r[3] for r in rows if r[0] == 'CONFIG_UNREAD'], ['unusedSetting'])

    def test_ci_files_and_plain_words_are_left_alone(self):
        _, rows = scan('a = 1\n', 'a = 2\n', extra={'after': {'.github/workflows/ci.yml': 'timeout_minutes: 5\n', 'config/app.yaml': 'name: x\nreplicas: 2\n'}})
        self.assertFalse([r for r in rows if r[0] == 'CONFIG_UNREAD'])


def load_check_draft():
    spec = importlib.util.spec_from_file_location('check_draft', HERE / 'check_draft.py')
    module = importlib.util.module_from_spec(spec)
    old = sys.argv
    sys.argv = ['x']
    try:
        spec.loader.exec_module(module)
    finally:
        sys.argv = old
    return module


class DraftGate(unittest.TestCase):
    """check_deletes on a throwaway worktree whose `purge_old` really deletes and whose `activate` does not."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.wt = pathlib.Path(cls.tmp.name) / 'wt'
        cls.wt.mkdir()
        git(cls.wt, 'init', '-q')
        (cls.wt / 'svc.py').write_text('def purge_old(db):\n    db.execute("x")\n    db.messages.delete_many({})\n\n\ndef activate(db):\n    return db.get(1)\n')
        git(cls.wt, 'add', '-A')
        git(cls.wt, 'commit', '-qm', 'x')
        cls.root = pathlib.Path(cls.tmp.name) / 'reviews'
        (cls.root / 'evidence').mkdir(parents=True)
        (cls.root / 'evidence' / 'both.txt').write_text('before: 7 messages\nafter: 3 messages\n')
        (cls.root / 'evidence' / 'words.txt').write_text('before after\n')
        cls.cd = load_check_draft()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_rows(self, fn='purge_old', truth='đồng ý: https://slack/x', evidence='evidence/both.txt', event='APPROVE', final=True):
        row = f'| svc.py:3 | chat | 7 → 3 | 7 → 0 | `{fn}` | {truth} | This is accepted. | {evidence} |'
        text = '## Dữ liệu bị xoá hoặc drop\n\n| điểm xoá | kịch bản | PR head trước → sau | develop trước → sau | lệnh xoá ở nguồn | nguồn thật | body nói | bằng chứng |\n|---|---|---|---|---|---|---|---|\n' + row + '\n'
        out = io.StringIO()
        with redirect_stdout(out):
            self.cd.check_deletes(text, 'This is accepted.', [('DATA_DELETE', 'svc.py:3', 'purge_old', 'x')], str(self.wt), str(self.root), event, False, final)
        return out.getvalue()

    def test_a_complete_row_passes(self):
        self.assertNotIn('FAIL', self.run_rows())

    def test_a_real_function_that_deletes_nothing_does_not_count_as_the_source_of_the_deletion(self):
        self.assertIn('FAIL   data-source', self.run_rows(fn='activate'))

    def test_a_row_marked_na_needs_the_name_to_exist_but_not_to_delete(self):
        self.assertNotIn('FAIL   data-source', self.run_rows(fn='activate', truth='N/A: không xoá ở nguồn, chỉ là cờ'))
        self.assertIn('không tìm thấy def', self.run_rows(fn='ghost', truth='N/A: không xoá ở nguồn'))

    def test_a_name_that_does_not_exist_fails(self):
        self.assertIn('không tìm thấy def', self.run_rows(fn='ghost'))

    def test_agreement_must_point_somewhere(self):
        for truth in ['đồng ý: asked nobody', 'đồng ý: đã hỏi Joel trên Slack', 'đồng ý: v2 ok', 'đồng ý: the note was defaced']:
            self.assertIn('FAIL   data-agree', self.run_rows(truth=truth), truth)
        for truth in ['đồng ý: svc.py:3', 'đồng ý: đề nghị của Joey (inline `4347762964`), Joel làm ở `63fe1a7`', 'đồng ý: design note v2 mục 5 (Theo duyệt 2026-10-20)', 'đồng ý: PR #19233 mô tả']:
            self.assertNotIn('data-agree', self.run_rows(truth=truth), truth)

    def test_evidence_must_hold_the_numbers_of_the_loss(self):
        out = self.run_rows(evidence='evidence/words.txt', truth='đồng ý: https://slack/x')
        self.assertIn('FAIL   data-evid', out)
        self.assertIn("thiếu số ['3', '7']", out)

    def test_an_unknown_source_of_truth_blocks_approve_but_not_a_comment(self):
        self.assertIn('FAIL   data-truth', self.run_rows(truth='chưa kiểm', evidence='evidence/both.txt'))
        self.assertNotIn('FAIL   data-truth', self.run_rows(truth='chưa kiểm', event='COMMENT'))

    def test_before_the_body_exists_the_body_check_waits(self):
        self.assertNotIn('data-body', self.run_rows(final=False))
        self.assertIn('data-body', self.run_rows(final=True))

    def run_cli(self, draft_text, rows):
        tsvf = pathlib.Path(self.tmp.name) / 'triggers.tsv'
        tsvf.write_text('\n'.join('\t'.join(r) for r in rows) + '\n')
        exp = pathlib.Path(self.tmp.name) / 'expected.tsv'
        exp.write_text('NONE\n')
        draft = pathlib.Path(self.tmp.name) / 'draft.md'
        draft.write_text(draft_text)
        return subprocess.run([sys.executable, str(HERE / 'check_draft.py'), str(draft), '--step', '04', '--triggers', str(tsvf), '--expected', str(exp),
                               '--wt', str(self.wt), '--rv', str(self.root.parent), '--evid-root', str(self.root)], capture_output=True, text=True)

    TABLE = ('## Dữ liệu bị xoá hoặc drop\n\n| điểm xoá | kịch bản | PR head trước → sau | develop trước → sau | lệnh xoá ở nguồn | nguồn thật | body nói | bằng chứng |\n'
             '|---|---|---|---|---|---|---|---|\n| svc.py:3 | chat | 7 → 3 | 7 → 0 | `purge_old` | đồng ý: svc.py:3 | Accepted. | evidence/both.txt |\n')

    def test_gate_04_runs_before_the_draft_has_an_event_a_head_or_a_body(self):
        rows = [['DATA_DELETE', 'svc.py:3', 'purge_old', 'x']]
        done = self.run_cli(self.TABLE, rows)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertNotRegex(done.stdout, r'DRAFT: \w+\s+(event|head|7points)\s')
        self.assertNotIn('data-body', done.stdout)

    def test_gate_04_fails_when_a_delete_has_no_table_yet(self):
        done = self.run_cli('## Something else\n', [['DATA_DELETE', 'svc.py:3', 'purge_old', 'x']])
        self.assertEqual(done.returncode, 1)
        self.assertIn('data-delete', done.stdout)

    def test_a_file_that_calls_another_service_needs_a_reason_or_a_trace(self):
        rows = [['CROSS_FILE', 'app/chat.py:1', '-', '(file uses go_chat)'], ['CROSS_FILE', 'app/dm/chat.py:1', '-', '(file uses go_chat)']]
        out = io.StringIO()
        with redirect_stdout(out):
            self.cd.check_cross_file('## Request thật qua service kia\n\n- app/chat.py: không đụng đường gọi Go, chỉ đổi định dạng thông báo\n', rows, 'APPROVE', False)
        # a line naming app/chat.py does not cover dm/chat.py: one reason per file
        self.assertEqual(out.getvalue().count('FAIL   cross-file'), 1, out.getvalue())
        self.assertIn('"dm/chat.py"', out.getvalue())
        out = io.StringIO()
        with redirect_stdout(out):
            self.cd.check_cross_file('## Request thật qua service kia\n\n- chat.py: ổn\n', rows, 'APPROVE', False)
        self.assertIn('FAIL   cross-file', out.getvalue())

    def test_a_setting_nobody_reads_needs_the_place_that_reads_it(self):
        rows = [['CONFIG_UNREAD', 'config/app.yaml:1', '-', 'read_timeout_sec']]
        for text, fail in [('## Cấu hình khai báo mà code không đọc\n\n- read_timeout_sec: đọc ở app/server.py:40\n', False),
                           ('## Cấu hình khai báo mà code không đọc\n\n- read_timeout_sec: chắc là dùng\n', True), ('## Other\n', True),
                           ('## Cấu hình khai báo mà code không đọc\n\n- read_timeout_sec: không ai đọc\n', False)]:
            out = io.StringIO()
            with redirect_stdout(out):
                self.cd.check_config(text, rows, 'COMMENT', False)
            self.assertEqual('FAIL' in out.getvalue(), fail, text)
        out = io.StringIO()
        with redirect_stdout(out):
            self.cd.check_config('## Cấu hình khai báo mà code không đọc\n\n- read_timeout_sec: không ai đọc\n', rows, 'APPROVE', False)
        self.assertIn('FAIL   config-gap', out.getvalue())


if __name__ == '__main__':
    unittest.main()
