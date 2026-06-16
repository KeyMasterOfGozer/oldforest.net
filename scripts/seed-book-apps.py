#!/usr/bin/env python3
"""
Seed the two BookTimeLine app cards into the oldforest-apps DynamoDB table.

Usage
-----
# Dry run (no writes)
AWS_PROFILE=oldforest python3 scripts/seed-book-apps.py --dry-run

# For real
AWS_PROFILE=oldforest python3 scripts/seed-book-apps.py
"""

import argparse
import uuid
import boto3

APPS = [
    {
        'name':        'Book Timeline',
        'icon':        '📚',
        'description': 'Reading history timeline — browse books read over the years, '
                       'colored by format (owned, Kindle, borrowed). Drag to scroll, scroll to zoom.',
        'url':         '/apps/booktimeline/index.html',
        'visibility':  'public',
        'external':    False,
        'order':       10,
    },
    {
        'name':        'Book Stats & CSV',
        'icon':        '📊',
        'description': 'Yearly reading stats with average days per book, '
                       'plus a sortable table and downloadable CSV of all reading dates.',
        'url':         '/apps/bookcsvgen/index.html',
        'visibility':  'public',
        'external':    False,
        'order':       20,
    },
]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--table',   default='oldforest-apps', help='DynamoDB table name')
    ap.add_argument('--dry-run', action='store_true',      help='Print items without writing')
    args = ap.parse_args()

    if not args.dry_run:
        dynamo = boto3.resource('dynamodb', region_name='us-east-1')
        table  = dynamo.Table(args.table)

    print(f"{'DRY RUN — ' if args.dry_run else ''}Seeding {len(APPS)} apps into '{args.table}':\n")

    for app in APPS:
        item = {'appId': str(uuid.uuid4()), **app}
        print(f"  {item['icon']}  {item['name']}")
        print(f"     url={item['url']}  visibility={item['visibility']}")
        if not args.dry_run:
            table.put_item(Item=item)
            print(f"     ✓ written (appId={item['appId']})")
        print()

    if args.dry_run:
        print('Dry run complete — no writes made.')
    else:
        print(f'Done — {len(APPS)} app cards seeded.')


if __name__ == '__main__':
    main()
