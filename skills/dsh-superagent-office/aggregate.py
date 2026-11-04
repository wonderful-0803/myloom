#!/usr/bin/env python3
"""Reproducible decimal CSV aggregation; inputs and derived artifacts stay in the current task directory."""
import argparse
import csv
from decimal import Decimal, localcontext
import hashlib
import io
import json
from pathlib import Path
import re
import tempfile
from datetime import datetime, timezone


def aggregate(content, spec):
    for key in ('source', 'period', 'unit', 'missing', 'group_by', 'sum', 'dedup_by', 'filters'):
        if key not in spec:
            raise ValueError('Specify ' + key)
    if not all(isinstance(spec[k], str) and spec[k].strip() for k in ('source', 'period', 'unit')):
        raise ValueError('Source, period and unit must be explicit')
    if spec['missing'] not in ('error', 'exclude') or not isinstance(spec['filters'], dict):
        raise ValueError('Declare missing-value handling and exact-match filters')
    reader = csv.DictReader(io.StringIO(content))
    fields = reader.fieldnames or []
    if not fields or len(fields) > 128 or len(set(fields)) != len(fields):
        raise ValueError('Missing, duplicate or excessive columns')
    for key in ('group_by', 'sum', 'dedup_by'):
        if not isinstance(spec[key], list) or len(set(spec[key])) != len(spec[key]) or any(c not in fields for c in spec[key]):
            raise ValueError('Unknown or duplicate columns in ' + key)
    if not spec['sum'] or any(k not in fields or not isinstance(v, str) for k, v in spec['filters'].items()):
        raise ValueError('Declare sum columns and valid exact-match filters')
    counts = {'input': 0, 'included': 0, 'filtered': 0, 'missing': 0, 'duplicates': 0}
    groups, seen = {}, {}
    required = set(spec['group_by'] + spec['sum'] + spec['dedup_by'])
    with localcontext() as context:
        context.prec = 64
        for row in reader:
            counts['input'] += 1
            if counts['input'] > 20000 or None in row or any(v is None for v in row.values()):
                raise ValueError('Too many rows or malformed CSV row')
            if any(row[k] != v for k, v in spec['filters'].items()):
                counts['filtered'] += 1
                continue
            if any(not row[k].strip() for k in required):
                if spec['missing'] == 'error':
                    raise ValueError('Missing required value at input row %d' % counts['input'])
                counts['missing'] += 1
                continue
            if spec['dedup_by']:
                identity = tuple(row[k] for k in spec['dedup_by'])
                if identity in seen:
                    if seen[identity] != row:
                        raise ValueError('Conflicting duplicate at input row %d' % counts['input'])
                    counts['duplicates'] += 1
                    continue
                seen[identity] = row
            values = {}
            for column in spec['sum']:
                raw = row[column].strip()
                if not re.fullmatch(r'[+-]?\d{1,20}(?:\.\d{1,10})?', raw):
                    raise ValueError('Invalid decimal at row %d, column %s' % (counts['input'], column))
                values[column] = Decimal(raw)
            group = tuple(row[k] for k in spec['group_by'])
            result = groups.setdefault(group, {'count': 0, 'sums': {k: Decimal(0) for k in spec['sum']}})
            result['count'] += 1
            for column, value in values.items():
                result['sums'][column] += value
            counts['included'] += 1
        totals = {k: format(sum((r['sums'][k] for r in groups.values()), Decimal(0)), 'f') for k in spec['sum']}
        output = [{'group': dict(zip(spec['group_by'], group)), 'count': result['count'],
                   'sums': {k: format(v, 'f') for k, v in result['sums'].items()}} for group, result in sorted(groups.items())]
    return {'counts': counts, 'groups': output, 'totals': totals, 'spec': spec}


def relative_file(root, name):
    if Path(name).is_absolute():
        raise ValueError('Use a task-relative input path')
    path = (root / name).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError('Input must be a file within the current task, at most 5 MiB')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--spec', required=True)
    args = parser.parse_args()
    root = Path.cwd().resolve()
    raw = relative_file(root, args.input).read_bytes()
    spec = json.loads(relative_file(root, args.spec).read_text())
    result = aggregate(raw.decode('utf-8-sig'), spec)
    output = Path(tempfile.mkdtemp(prefix='office-data-', dir=root))
    files = {'input.csv': raw, 'spec.json': (json.dumps(spec, ensure_ascii=False, indent=2) + '\n').encode(),
             'result.json': (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode()}
    for name, data in files.items():
        (output / name).write_bytes(data)
    manifest = {'created_at': datetime.now(timezone.utc).isoformat(), 'source': spec['source'],
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'artifact_directory': output.name, **result}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, UnicodeError) as error:
        raise SystemExit('Aggregation refused: ' + str(error))
