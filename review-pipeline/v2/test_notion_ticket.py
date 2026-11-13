import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import notion_ticket

PAGE = {
    'object': 'page',
    'properties': {
        'Name': {'type': 'title', 'title': [{'plain_text': 'Wave 2 M2'}]},
        'Task ID': {'type': 'unique_id', 'unique_id': {'prefix': 'GENP', 'number': 6663}},
    },
}
FIRST = {
    'results': [
        {'type': 'heading_2', 'heading_2': {'rich_text': [{'plain_text': 'Scope of Work'}]}},
        {'type': 'bulleted_list_item', 'bulleted_list_item': {'rich_text': [{'plain_text': 'split per scenario'}]}},
    ],
    'has_more': True,
    'next_cursor': 'c1',
}
SECOND = {
    'results': [
        {'type': 'to_do', 'to_do': {'checked': True, 'rich_text': [{'plain_text': 'R2 dry run'}]}},
        {'type': 'to_do', 'to_do': {'checked': False, 'rich_text': [{'plain_text': 'R3 dry run'}]}},
        {'type': 'child_page', 'child_page': {'title': 'Rehearsal notes'}},
        {'id': 'B9', 'type': 'toggle', 'has_children': True, 'toggle': {'rich_text': [{'plain_text': 'Acceptance criteria'}]}},
    ],
    'has_more': False,
    'next_cursor': None,
}
NESTED = {
    'results': [
        {'type': 'paragraph', 'paragraph': {'rich_text': [{'plain_text': 'AC-5 verified on DEV'}]}},
        {'type': 'code', 'code': {'language': 'bash', 'rich_text': [{'plain_text': 'pytest -q'}]}},
    ],
    'has_more': False,
    'next_cursor': None,
}


def fake_api(path):
    if path.startswith('pages/'):
        return PAGE
    if path.endswith('start_cursor=c1'):
        return SECOND
    if 'B9/children' in path:
        return NESTED
    return FIRST


class Render(unittest.TestCase):
    def test_a_page_is_read_across_pages_of_blocks_with_its_task_id_and_tail(self):
        with mock.patch.object(notion_ticket, 'call', side_effect=lambda path, token: fake_api(path)):
            blocks = notion_ticket.children('P1', 'token')
            doc = notion_ticket.render(blocks, 'token')
        self.assertIn('R2 dry run', doc)
        self.assertIn('- [x] R2 dry run', doc)
        self.assertIn('- [ ] R3 dry run', doc)
        self.assertIn('## Scope of Work', doc)
        self.assertIn('- **Rehearsal notes**', doc)
        self.assertIn('AC-5 verified on DEV', doc)
        self.assertIn('```bash', doc)
        self.assertEqual(notion_ticket.task_id(PAGE), ('GENP', 6663))

    def test_a_table_row_keeps_its_cells(self):
        blocks = [{'id': 'T1', 'type': 'table', 'has_children': True, 'table': {}}]
        rows = [
            {'type': 'table_row', 'table_row': {'cells': [[{'plain_text': 'AC'}], [{'plain_text': 'Result'}]]}},
            {'type': 'table_row', 'table_row': {'cells': [[{'plain_text': 'AC-5'}], [{'plain_text': 'verified on DEV'}]]}},
        ]
        with mock.patch.object(notion_ticket, 'call', return_value={'results': rows, 'has_more': False, 'next_cursor': None}):
            doc = notion_ticket.render(blocks, 'token')
        self.assertIn('| AC-5 | verified on DEV |', doc)
        self.assertIn('| AC | Result |', doc)

    def test_the_written_file_carries_the_task_id_line_fetch_ticket_checks(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(notion_ticket, 'call', side_effect=lambda path, token: fake_api(path)), \
                mock.patch.dict(os.environ, {'NOTION_TOKEN': 'token'}), \
                mock.patch.object(sys, 'argv', ['notion_ticket.py', 'P1', str(pathlib.Path(tmp) / 't.md')]):
            notion_ticket.main()
            text = (pathlib.Path(tmp) / 't.md').read_text()
        self.assertIn('# Wave 2 M2', text)
        self.assertIn('- **Task ID:** 6663', text)
        self.assertIn('- **Ticket:** GENP-6663', text)

    def test_a_page_without_a_task_id_still_writes_the_link(self):
        page = {'properties': {'Name': {'type': 'title', 'title': [{'plain_text': 'No id'}]}}}
        self.assertEqual(notion_ticket.task_id(page), (None, None))
        self.assertEqual(notion_ticket.title_of(page), 'No id')


if __name__ == '__main__':
    unittest.main()
