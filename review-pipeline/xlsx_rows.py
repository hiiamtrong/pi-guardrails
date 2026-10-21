"""Dump every sheet of an .xlsx as JSON: {sheet: [[row_number, {column: value}], ...]}.

Usage: python3.12 reports/reviews/tools/xlsx_rows.py <file.xlsx> > rows.json
"""
import json
import sys
import xml.etree.ElementTree as ET
import zipfile

M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def text(node):
    return ''.join(t.text or '' for t in node.iter(f'{M}t'))


def read(path):
    z = zipfile.ZipFile(path)
    shared = [text(si) for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(f'{M}si')] if 'xl/sharedStrings.xml' in z.namelist() else []
    targets = {rel.get('Id'): rel.get('Target') for rel in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    sheets = {}
    for sheet in ET.fromstring(z.read('xl/workbook.xml')).iter(f'{M}sheet'):
        target = targets[sheet.get(f'{R}id')].lstrip('/')
        rows = []
        for row in ET.fromstring(z.read(target if target.startswith('xl/') else f'xl/{target}')).iter(f'{M}row'):
            cells = {}
            for c in row.iter(f'{M}c'):
                v = c.find(f'{M}v')
                kind = c.get('t')
                value = shared[int(v.text)] if kind == 's' and v is not None else text(c) if kind == 'inlineStr' else (v.text if v is not None else '')
                if value != '':
                    cells[c.get('r').rstrip('0123456789')] = value
            if cells:
                rows.append([int(row.get('r')), cells])
        sheets[sheet.get('name')] = rows
    return sheets


json.dump(read(sys.argv[1]), sys.stdout, ensure_ascii=False, indent=1)
