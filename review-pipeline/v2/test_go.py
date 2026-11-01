import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
# What swag-openim's pipeline.json declares: the engine itself names no service.
OPENIM = {'crossByExt': {'.go': r'(SwagServerClient|swag_server|swagServer|send/validate|webhooks/(afterSend|sendFailed|shareFailed|shareDeliveryCompleted))'},
          'crossDirs': r'^internal/infrastructure/client/'}


def git(wt, *args):
    subprocess.run(['git', '-C', str(wt), '-c', 'user.name=t', '-c', 'user.email=t@t', *args], check=True, capture_output=True)


class GoTriggersTest(unittest.TestCase):
    def scan(self, before, after, path='internal/app/x.go'):
        with tempfile.TemporaryDirectory() as tmp:
            wt = pathlib.Path(tmp)
            git(wt, 'init', '-q')
            (wt / path).parent.mkdir(parents=True, exist_ok=True)
            (wt / path).write_text(before)
            git(wt, 'add', '-A')
            git(wt, 'commit', '-qm', 'base')
            (wt / path).write_text(after)
            git(wt, 'commit', '-qam', 'head')
            r = subprocess.run([sys.executable, str(HERE / 'scan_triggers.py'), str(wt), 'HEAD~1', 'HEAD'], capture_output=True, text=True, check=True,
                               env={**os.environ, 'TRIGGERS': json.dumps(OPENIM)})
            return [line.split('\t') for line in r.stdout.splitlines()]

    def test_a_go_delete_names_its_function(self):
        rows = self.scan('package x\n\nfunc purge() {\n\tdb.Exec("SELECT 1")\n}\n', 'package x\n\nfunc purge() {\n\tdb.Exec("DELETE FROM outbox")\n}\n')
        self.assertEqual([(r[0], r[2]) for r in rows], [('DATA_DELETE', 'purge')])

    def test_a_method_receiver_is_skipped_when_naming_the_function(self):
        rows = self.scan('package x\n\nfunc (s *Svc) Sweep() {\n\ta()\n}\n', 'package x\n\nfunc (s *Svc) Sweep() {\n\ts.cleanup()\n}\n')
        self.assertEqual([(r[0], r[2]) for r in rows], [('DATA_DELETE', 'Sweep')])

    def test_import_paths_naming_openim_are_not_cross_service(self):
        rows = self.scan('package x\n', 'package x\n\nimport "github.com/swaglive/swag-openim/internal/apperr"\n')
        self.assertEqual(rows, [['NONE']])

    def test_a_call_to_swag_server_is_cross_service_and_a_comment_or_test_file_is_not(self):
        rows = self.scan('package x\n', 'package x\n\n// calls SwagServerClient\nvar _ = SwagServerClient{}\n')
        self.assertEqual([r[0] for r in rows], ['CROSS_SERVICE'])
        self.assertEqual(self.scan('package x\n', 'package x\n\nvar _ = SwagServerClient{}\n', 'internal/app/x_test.go'), [['NONE']])

    def test_the_swag_server_client_package_is_always_cross_service(self):
        rows = self.scan('package client\n', 'package client\n\nvar a = 1\n', 'internal/infrastructure/client/c.go')
        self.assertEqual([r[0] for r in rows], ['CROSS_SERVICE'])

    def test_a_new_sql_migration_is_a_manual_rollout_step(self):
        rows = self.scan('', 'CREATE INDEX i ON t (a);\n', 'internal/infrastructure/postgres/migrations/00009_x.sql')
        self.assertEqual([r[0] for r in rows], ['ROLLOUT_MANUAL'])


class DraftDefTest(unittest.TestCase):
    def found(self, source, name):
        with tempfile.TemporaryDirectory() as tmp:
            wt = pathlib.Path(tmp)
            git(wt, 'init', '-q')
            (wt / 'f').write_text(source)
            git(wt, 'add', '-A')
            git(wt, 'commit', '-qm', 'x')
            sys.path.insert(0, str(HERE))
            import check_draft
            return subprocess.run(['git', '-C', str(wt), 'grep', '-q', '-P', check_draft.source_def(name), 'HEAD']).returncode == 0

    def test_a_python_def_a_go_func_and_a_go_method_are_all_definitions(self):
        self.assertTrue(self.found('def purge(x):\n', 'purge'))
        self.assertTrue(self.found('func purge(x int) {\n', 'purge'))
        self.assertTrue(self.found('func (s *Svc) purge(x int) {\n', 'purge'))

    def test_a_call_or_a_longer_name_is_not_a_definition(self):
        self.assertFalse(self.found('x := purge(1)\n', 'purge'))
        self.assertFalse(self.found('func purgeAll() {\n', 'purge'))


if __name__ == '__main__':
    unittest.main()
