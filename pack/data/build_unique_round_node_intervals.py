#!/usr/bin/env python3
"""Collapse final_path_round_node_intervals.tsv to one row per round node."""
from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent
IN_TSV = BASE / 'final_path_round_node_intervals.tsv'
OUT_TSV = BASE / 'unique_round_node_intervals.tsv'
OUT_JSON = BASE / 'unique_round_node_intervals.json'


def numeric_round_node_key(node_id: str):
    parts = node_id.replace('round_', '').split('_')
    out = []
    for p in parts:
        try:
            out.append(int(p))
        except ValueError:
            out.append(p)
    return out


def main() -> None:
    with IN_TSV.open(newline='') as fh:
        rows = list(csv.DictReader(fh, delimiter='\t'))

    by_node: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_node[row['round_node']].append(row)

    out_rows = []
    out_json = {}
    invariant_fields = [
        'round_node', 'node_ref_len', 'previous_ref_len',
        'added_start_1based', 'added_end_1based', 'added_len',
        'final_ref_start_1based', 'final_ref_end_1based',
        'prefix_of_final_ref', 'extends_previous_ref', 'interval_valid',
        'round_ref_fa',
    ]

    for node_id in sorted(by_node, key=numeric_round_node_key):
        node_rows = by_node[node_id]
        first = node_rows[0]
        final_paths = sorted({r['final_path'] for r in node_rows})
        internal_path_ids = sorted({r['internal_path_id'] for r in node_rows})
        statuses = sorted({r['final_status'] for r in node_rows})

        row = {field: first[field] for field in invariant_fields}
        row.update({
            'num_final_paths': len(final_paths),
            'final_paths': ','.join(final_paths),
            'internal_path_ids': ','.join(internal_path_ids),
            'final_statuses': ','.join(statuses),
            'representative_final_path': first['final_path'],
            'representative_final_ref_fa': first['final_ref_fa'],
            'representative_final_bam': first['final_bam'],
            'representative_final_bai': first['final_bai'],
        })
        out_rows.append(row)

        out_json[node_id] = {
            **row,
            'final_paths': final_paths,
            'internal_path_ids': internal_path_ids,
            'final_statuses': statuses,
            'per_final_path': [
                {
                    'final_path': r['final_path'],
                    'internal_path_id': r['internal_path_id'],
                    'final_status': r['final_status'],
                    'end_round': r['end_round'],
                    'round_order': int(r['round_order']),
                    'final_ref_fa': r['final_ref_fa'],
                    'final_bam': r['final_bam'],
                    'final_bai': r['final_bai'],
                    'final_ref_len': int(r['final_ref_len']),
                }
                for r in sorted(node_rows, key=lambda x: x['final_path'])
            ],
        }

    fieldnames = [
        'round_node', 'node_ref_len', 'previous_ref_len',
        'added_start_1based', 'added_end_1based', 'added_len',
        'final_ref_start_1based', 'final_ref_end_1based',
        'prefix_of_final_ref', 'extends_previous_ref', 'interval_valid',
        'round_ref_fa', 'num_final_paths', 'final_paths', 'internal_path_ids',
        'final_statuses', 'representative_final_path', 'representative_final_ref_fa',
        'representative_final_bam', 'representative_final_bai',
    ]
    with OUT_TSV.open('w', newline='') as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, delimiter='\t')
        writer.writeheader()
        writer.writerows(out_rows)

    with OUT_JSON.open('w') as fh:
        json.dump(out_json, fh, indent=2, ensure_ascii=False)

    print(f'input rows: {len(rows)}')
    print(f'unique round nodes: {len(out_rows)}')
    print(f'wrote {OUT_TSV}')
    print(f'wrote {OUT_JSON}')


if __name__ == '__main__':
    main()
