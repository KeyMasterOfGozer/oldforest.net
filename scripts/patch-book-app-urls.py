#!/usr/bin/env python3
"""
Patch the URL fields for the two BookTimeLine app cards already in DynamoDB.
Fixes the CloudFront subdirectory routing issue by using explicit index.html paths.

Usage
-----
AWS_PROFILE=oldforest python3 scripts/patch-book-app-urls.py
"""

import boto3
from boto3.dynamodb.conditions import Attr

PATCHES = {
    'Book Timeline':    '/apps/booktimeline/index.html',
    'Book Stats & CSV': '/apps/bookcsvgen/index.html',
}

def main():
    dynamo = boto3.resource('dynamodb', region_name='us-east-1')
    table  = dynamo.Table('oldforest-apps')

    resp  = table.scan()
    items = resp.get('Items', [])

    updated = 0
    for item in items:
        name    = item.get('name', '')
        new_url = PATCHES.get(name)
        if not new_url:
            continue
        old_url = item.get('url', '')
        if old_url == new_url:
            print(f'  ✓ {name} — already correct ({new_url})')
            continue
        table.update_item(
            Key={'appId': item['appId']},
            UpdateExpression='SET #u = :url',
            ExpressionAttributeNames={'#u': 'url'},
            ExpressionAttributeValues={':url': new_url},
        )
        print(f'  ✓ {name}')
        print(f'    {old_url}  →  {new_url}')
        updated += 1

    if updated:
        print(f'\nDone — {updated} record(s) patched.')
    else:
        print('\nNo records needed patching.')

if __name__ == '__main__':
    main()
