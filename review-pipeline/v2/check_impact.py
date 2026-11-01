"""Gate 02: impact-map.txt exists, has every section, and was made for the head under review.

A map for another range, or one a failed git call left empty, still has every `## ` heading, so counting
headings alone passed it. The header line `# Impact map <base10>..<head10>` names the range; a map whose head is
not the PR's current head fails. A different base is only a warning: a stacked PR is based on its parent's branch.
A header with ref names instead of shas (the Go map) cannot be checked and says so.
"""
import argparse
import pathlib
import re
import sys

HEADER = re.compile(r'^# Impact map (?:\([A-Za-z]+\) )?([0-9a-f]{10})\.\.([0-9a-f]{10})$', re.M)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('map')
    ap.add_argument('--head', required=True)
    ap.add_argument('--base', required=True)
    ap.add_argument('--sections', type=int, default=8)
    args = ap.parse_args()
    path = pathlib.Path(args.map)
    if not path.is_file():
        print(f'MAP: FAIL no {path} (impact map not run, or run without saving)')
        return 1
    text = path.read_text()
    n = len(re.findall(r'^## ', text, re.M))
    if n < args.sections:
        print(f'MAP: FAIL only {n}/{args.sections} sections: the tool broke?')
        return 1
    m = HEADER.search(text)
    if not m:
        print(f'WARN MAP: the header has no shas, so the map cannot be tied to a head ({n} sections)')
        return 0
    base, head = m.groups()
    if head != args.head[:10]:
        print(f'MAP: FAIL the map was made for head {head}, the PR is at {args.head[:10]}: run it again')
        return 1
    if base != args.base[:10]:
        print(f'WARN MAP: base {base} is not the merge-base with the target branch ({args.base[:10]}); fine for a stacked PR')
    print(f'MAP: PASS {n} sections, {base}..{head}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
