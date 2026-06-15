#!/usr/bin/env python3
"""
Fix authorSub for personal posts after a Cognito pool migration.

The old pool sub no longer matches what API Gateway puts in the JWT, so
personal posts are invisible to the list-posts editor filter.  This script
looks up the user's CURRENT Cognito sub and stamps it on every personal post.

Usage
-----
# 1. Dry-run first (no writes)
AWS_PROFILE=oldforest python3 scripts/fix-personal-posts.py \
    --user-pool-id us-east-1_jP6qH36Wk \
    --email mgreene@onevizion.com \
    --dry-run

# 2. For real
AWS_PROFILE=oldforest python3 scripts/fix-personal-posts.py \
    --user-pool-id us-east-1_jP6qH36Wk \
    --email mgreene@onevizion.com
"""

import argparse
import boto3
from boto3.dynamodb.conditions import Attr


def get_sub(cognito, user_pool_id, email):
    resp = cognito.list_users(
        UserPoolId=user_pool_id,
        Filter=f'email = "{email}"',
    )
    users = resp.get('Users', [])
    if not users:
        raise SystemExit(f'No Cognito user found with email: {email}')
    attrs = {a['Name']: a['Value'] for a in users[0]['Attributes']}
    sub = attrs.get('sub')
    if not sub:
        raise SystemExit('User found but has no sub attribute')
    return sub, users[0]['Username']


def scan_personal_posts(table):
    items = []
    kwargs = {
        'FilterExpression': Attr('visibility').eq('personal'),
        'ProjectionExpression': 'postId, title, authorSub',
    }
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get('Items', []))
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--user-pool-id', required=True, help='Cognito user pool ID')
    ap.add_argument('--email',        required=True, help='Your account email')
    ap.add_argument('--table',        default='oldforest-posts', help='DynamoDB table')
    ap.add_argument('--dry-run',      action='store_true', help='No writes')
    args = ap.parse_args()

    cognito = boto3.client('cognito-idp', region_name='us-east-1')
    dynamo  = boto3.resource('dynamodb',  region_name='us-east-1')
    table   = dynamo.Table(args.table)

    sub, username = get_sub(cognito, args.user_pool_id, args.email)
    print(f'User : {username}')
    print(f'Sub  : {sub}')
    print()

    items = scan_personal_posts(table)
    if not items:
        print('No personal posts found — nothing to do.')
        return

    print(f'Found {len(items)} personal post(s):')
    for p in items:
        old = p.get('authorSub', '(none)')
        match = '✓ already matches' if old == sub else f'✗ was: {old}'
        print(f'  [{p["postId"][:8]}]  "{p.get("title","Untitled")}"  — {match}')

    needs_fix = [p for p in items if p.get('authorSub') != sub]
    if not needs_fix:
        print('\nAll personal posts already have the correct authorSub.')
        return

    if args.dry_run:
        print(f'\nDry run — would update {len(needs_fix)} post(s) to sub: {sub}')
        return

    print(f'\nUpdating {len(needs_fix)} post(s)…')
    for p in needs_fix:
        table.update_item(
            Key={'postId': p['postId']},
            UpdateExpression='SET authorSub = :sub',
            ExpressionAttributeValues={':sub': sub},
        )
        print(f'  ✓ "{p.get("title","Untitled")}"')

    print(f'\nDone — {len(needs_fix)} post(s) fixed.')


if __name__ == '__main__':
    main()
