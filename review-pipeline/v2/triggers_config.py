"""The words the step 04 triggers look for, shared by scan_triggers.py and check_draft.py.

The defaults name no repo and no language. A repo adds its own words under `triggers` in pipeline.json; the
extension exports the merged object as TRIGGERS, and every key replaces the default of the same name. A
regex is Python syntax and is compiled here, so a typo stops the run with a message instead of silently
turning a trigger off.
"""
import json
import os
import re
import sys
from types import SimpleNamespace

SOURCE_EXT = ['py', 'go', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'scala', 'rs', 'rb', 'php', 'cs', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'sql']
CONFIG_EXT = ['yaml', 'yml', 'toml', 'ini', 'env', 'properties']

DEFAULTS = {
    # Bare `.remove(` and `.pop(` are not matched: they are usually an in-memory list or dict. A repo whose ORM removes that way adds the word.
    'delete': r'''(?ix)
        \b\w*(?:delete|drop|prune|purge|truncate|destroy|unlink|rmtree|evict|erase|cleanup|clean_up)\w*(?:\.\w+)?\s*\(
      | \bDELETE\s+FROM\b
      | \bDROP\s+(?:TABLE|INDEX|COLUMN|CONSTRAINT|DATABASE|SCHEMA)\b
      | \bTRUNCATE\s+TABLE\b
      | \$(?:unset|pull|pullAll)\b
      | \b(?:unset|pull|pull_all)__\w+
      | \bexpireAfterSeconds\b
      | \bexpire\w*\s*\(
      | \bre-?key\b
      | \bos\.remove\b
      | \.deleted_count\b
      | \b(?:is_deleted|deleted_at|soft_delete\w*)\s*=\s*+(?!False\b|None\b|0\b|null\b)
    ''',
    'rolloutPath': r'^(?:alembic/|(?:.*/)?migrations?/|db/migrate/|deploy/|charts?/|helm/|k8s/|.*/jobs/.*\.ya?ml$|.*values[^/]*\.ya?ml$|.*\.sql$)',
    'rolloutLine': r'''(?i)(create_index|createIndex|ensure_index|add_index|drop_index|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE|\.command\(|@click\.command|add_column|drop_column|op\.execute|['"]indexes['"]\s*:|expireAfterSeconds)''',
    'descRollout': r'(?i)(createIndex|create_index|manually|by hand|pre-deploy|post-deploy|before deploy|after deploy|run (it )?once|one-off)',
    'flag': r'(?i)(feature[_ -]?(flag|toggle)s?|kill[_ -]?switch|growthbook|launchdarkly|unleash|migration_state|rollout[_ -]?percent)',
    'cross': None,
    'crossFile': None,
    'crossDirs': None,
    'flagPaths': None,
    'crossByExt': {},
    'sourceExt': SOURCE_EXT,
    'configExt': CONFIG_EXT,
}
REGEX_KEYS = ('delete', 'rolloutPath', 'rolloutLine', 'descRollout', 'flag', 'cross', 'crossFile', 'crossDirs', 'flagPaths')
LIST_KEYS = ('sourceExt', 'configExt')
TEST_PATH = re.compile(r'(^|/)(tests?|__tests__|spec)/|(_test|\.test|\.spec)\.\w+$|(^|/)test_[^/]*$')


def _compile(key, value):
    try:
        return re.compile(value)
    except re.error as error:
        sys.exit(f'ABORT: pipeline.json "triggers.{key}" is not a valid Python regex: {error}')


def load(raw=None):
    """The merged vocabulary as an object with compiled patterns (a pattern that is not set is None)."""
    raw = os.environ.get('TRIGGERS') if raw is None else raw
    given = {}
    if raw:
        try:
            given = json.loads(raw)
        except ValueError as error:
            sys.exit(f'ABORT: TRIGGERS is not JSON: {error}')
    unknown = sorted(set(given) - set(DEFAULTS))
    if unknown:
        sys.exit(f'ABORT: pipeline.json "triggers" has unknown keys {unknown}; known: {sorted(DEFAULTS)}')
    merged = {**DEFAULTS, **given}
    for key in REGEX_KEYS:
        if merged[key] is not None and not isinstance(merged[key], str):
            sys.exit(f'ABORT: pipeline.json "triggers.{key}" must be a string')
    for key in LIST_KEYS:
        if not (isinstance(merged[key], list) and all(isinstance(e, str) and re.fullmatch(r'\w+', e) for e in merged[key])):
            sys.exit(f'ABORT: pipeline.json "triggers.{key}" must be a list of extensions without a dot')
    if not (isinstance(merged['crossByExt'], dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in merged['crossByExt'].items())):
        sys.exit('ABORT: pipeline.json "triggers.crossByExt" must map an extension (".go") to a regex')
    ns = {k: (_compile(k, merged[k]) if merged[k] is not None else None) for k in REGEX_KEYS}
    ns['crossByExt'] = {k.lstrip('.'): _compile(f'crossByExt.{k}', v) for k, v in merged['crossByExt'].items()}
    ns['sourceExt'] = set(merged['sourceExt'])
    ns['configExt'] = set(merged['configExt'])
    return SimpleNamespace(**ns)


def ext(path):
    return path.rsplit('.', 1)[-1] if '.' in path.rsplit('/', 1)[-1] else ''


def is_test(path):
    return bool(TEST_PATH.search(path))
