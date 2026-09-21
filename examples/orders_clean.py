#!/usr/bin/env python3
"""De-duplicate orders.csv, keeping the most recent row per order id.

The deliverable for the engagement the walkthroughs grade. It is committed to
this repository so it has a stable public URL, which is what makes it a
*validator-retrievable artifact*: the graders fetch these exact bytes and
compare them against the digest the provider committed on chain.

Usage:
    python orders_clean.py orders.csv orders_clean.csv

Malformed rows -- missing an order id, or carrying a timestamp that cannot be
parsed -- are written to stderr and skipped rather than guessed at, so a bad
row never silently displaces a good one.
"""

from __future__ import annotations

import csv
import sys
from datetime import datetime


def parse_timestamp(raw: str) -> datetime | None:
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw.strip(), fmt)
        except ValueError:
            continue
    return None


def deduplicate(rows: list[dict]) -> list[dict]:
    """Latest row per order id, by timestamp. Ties keep the later row read."""
    latest: dict[str, tuple[datetime, dict]] = {}
    for line, row in enumerate(rows, start=2):
        order_id = (row.get("order_id") or "").strip()
        if not order_id:
            print(f"line {line}: no order id, skipped", file=sys.stderr)
            continue
        stamp = parse_timestamp(row.get("timestamp") or "")
        if stamp is None:
            print(f"line {line}: unreadable timestamp, skipped", file=sys.stderr)
            continue
        seen = latest.get(order_id)
        if seen is None or stamp >= seen[0]:
            latest[order_id] = (stamp, row)
    return [row for _, row in sorted(latest.items())]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    with open(argv[1], newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        rows = list(reader)
    cleaned = deduplicate(rows)
    with open(argv[2], "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(cleaned)
    print(f"{len(rows)} rows in, {len(cleaned)} out")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
