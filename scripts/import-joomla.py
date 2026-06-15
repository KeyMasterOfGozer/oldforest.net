#!/usr/bin/env python3
"""
Import Joomla jos_content MySQL dump into the oldforest.net blog.

Reads ContentTable.sql, parses every published post, uploads the HTML body
to S3 (posts/{uuid}/body.md), and writes a DynamoDB record.

The blog's Markdown renderer (marked.js) passes through raw HTML, so Joomla's
HTML content renders correctly without conversion.

Usage
-----
# 1. Get your bucket name
cd infra && AWS_PROFILE=oldforest terraform output -raw content_bucket_name

# 2. Dry-run first (no AWS writes)
AWS_PROFILE=oldforest python3 scripts/import-joomla.py \\
    --sql ContentTable.sql \\
    --bucket <content-bucket-name> \\
    --dry-run

# 3. For real
AWS_PROFILE=oldforest python3 scripts/import-joomla.py \\
    --sql ContentTable.sql \\
    --bucket <content-bucket-name>

Optional flags
--------------
--table   DynamoDB table name  (default: oldforest-posts)
--author  Default author name  (default: Mike Greene)
--all     Also import unpublished / state=None posts (default: published only)
"""

import argparse
import re
import sys
import uuid
from datetime import datetime, timezone


# ── SQL parser ────────────────────────────────────────────────────────────────

def _parse_values_block(values_text: str) -> list[list]:
    """Parse the rows from a single VALUES (...),(...),...; block."""
    rows = []
    i = 0
    n = len(values_text)

    while i < n:
        # Skip whitespace and commas between rows
        while i < n and values_text[i] in ' \t\n\r,':
            i += 1
        if i >= n or values_text[i] != '(':
            break

        i += 1  # skip opening '('
        row = []

        while i < n and values_text[i] != ')':
            # Skip whitespace between fields
            while i < n and values_text[i] in ' \t\n\r':
                i += 1

            if values_text[i] == "'":
                # String literal — collect until unescaped closing quote
                i += 1
                buf = []
                while i < n:
                    c = values_text[i]
                    if c == '\\' and i + 1 < n:
                        nc = values_text[i + 1]
                        if nc == "'":
                            buf.append("'")
                        elif nc == '\\':
                            buf.append('\\')
                        elif nc == 'n':
                            buf.append('\n')
                        elif nc == 'r':
                            buf.append('\r')
                        elif nc == '"':
                            buf.append('"')
                        else:
                            buf.append(nc)
                        i += 2
                    elif c == "'":
                        i += 1
                        break
                    else:
                        buf.append(c)
                        i += 1
                row.append(''.join(buf))
            elif values_text[i:i+4] == 'NULL':
                row.append(None)
                i += 4
            else:
                # Number (possibly negative)
                j = i
                if values_text[j] == '-':
                    j += 1
                while j < n and values_text[j].isdigit():
                    j += 1
                row.append(int(values_text[i:j]))
                i = j

            # Skip comma between fields
            while i < n and values_text[i] in ' \t\n\r':
                i += 1
            if i < n and values_text[i] == ',':
                i += 1

        i += 1  # skip closing ')'
        rows.append(row)

    return rows


def parse_mysql_values(sql_text: str) -> tuple[list[str], list[list]]:
    """
    Extract column names and all value rows from all INSERT statements in the file.
    Handles escaped quotes (\\'  \\\\), NULL, and integer literals.
    """
    cols = None
    all_rows = []

    for m in re.finditer(r'INSERT INTO `\w+`\s*\(([^)]+)\)\s*VALUES\s*', sql_text):
        if cols is None:
            cols = [c.strip().strip('`') for c in m.group(1).split(',')]
        values_text = sql_text[m.end():]
        all_rows.extend(_parse_values_block(values_text))

    if cols is None:
        raise ValueError("Could not find any INSERT INTO statements")

    return cols, all_rows


def load_posts(sql_file: str, include_all: bool = False) -> list[dict]:
    with open(sql_file, encoding='latin-1') as f:
        raw = f.read()

    cols, rows = parse_mysql_values(raw)
    posts = []
    for row in rows:
        p = dict(zip(cols, row))
        state = p.get('state')
        # Include: state=1 (published), and optionally state=None (old pre-CMS posts)
        if include_all:
            if state == -2:  # trashed — always skip
                continue
        else:
            if state != 1 and state is not None:
                continue
            # state=None: old posts without proper state — include them
        posts.append(p)

    return posts


# ── Helpers ───────────────────────────────────────────────────────────────────

def slugify(text: str, existing: set) -> str:
    s = text.lower().strip()
    s = re.sub(r'[^a-z0-9\s\-]', '', s)
    s = re.sub(r'[\s\-]+', '-', s).strip('-')[:80] or 'post'
    base, n = s, 1
    while s in existing:
        s = f'{base}-{n}'
        n += 1
    return s


def to_iso(dt_str) -> str | None:
    if not dt_str or str(dt_str).startswith('0000'):
        return None
    try:
        dt = datetime.fromisoformat(str(dt_str))
        return dt.replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


def strip_joomla_attribs(html: str) -> str:
    """Remove Joomla-specific page attributes sometimes embedded in content."""
    return re.sub(r'\{[^}]+\}', '', html).strip()


# ── Import ────────────────────────────────────────────────────────────────────

def import_posts(sql_file, bucket, table, author, dry_run, include_all):
    posts = load_posts(sql_file, include_all)

    # Sort chronologically for predictable slug assignment
    posts.sort(key=lambda p: (p.get('created') or '0000'))

    print(f"Found {len(posts)} posts to import\n")

    if not dry_run:
        import boto3
        s3     = boto3.client('s3')
        dynamo = boto3.resource('dynamodb').Table(table)

    existing_slugs: set[str] = set()
    errors = []
    skipped = []

    for p in posts:
        title   = (p.get('title') or 'Untitled').strip()
        alias   = (p.get('title_alias') or '').strip()
        content = strip_joomla_attribs(p.get('introtext') or '')

        if not content.strip():
            skipped.append(title)
            print(f"  SKIP  (empty body) — {title}")
            continue

        slug       = slugify(alias or title, existing_slugs)
        existing_slugs.add(slug)

        created_at = to_iso(p.get('created'))  or datetime.now(timezone.utc).isoformat()
        updated_at = to_iso(p.get('modified')) or created_at

        # Joomla access: 0=public, 2=registered
        visibility = 'members' if p.get('access') == 2 else 'public'

        post_author = (p.get('created_by_alias') or '').strip() or author

        post_id     = str(uuid.uuid4())
        content_key = f'posts/{post_id}/body.md'

        item = {
            'postId':      post_id,
            'slug':        slug,
            'title':       title,
            'summary':     '',          # Joomla had no summary field; can be edited later
            'author':      post_author,
            'authorSub':   'imported',  # not a real Cognito user sub
            'createdAt':   created_at,
            'updatedAt':   updated_at,
            'status':      'published',
            'visibility':  visibility,
            'tags':        [],
            'thumbnail':   '',
            'contentKey':  content_key,
        }

        state_label = p.get('state')
        print(f"  {'DRY ' if dry_run else '    '}{p['id']:>3}  {created_at[:10]}  {title[:55]}")
        print(f"        slug={slug}  vis={visibility}  state={state_label}  {len(content)} chars")

        if dry_run:
            continue

        try:
            s3.put_object(
                Bucket=bucket,
                Key=content_key,
                Body=content.encode('utf-8'),
                ContentType='text/html; charset=utf-8',
            )
            dynamo.put_item(Item=item)
        except Exception as e:
            errors.append((title, str(e)))
            print(f"        ERROR: {e}", file=sys.stderr)

    print()
    if skipped:
        print(f"Skipped {len(skipped)} empty posts: {', '.join(skipped)}")
    if errors:
        print(f"\n{len(errors)} errors:", file=sys.stderr)
        for t, e in errors:
            print(f"  {t}: {e}", file=sys.stderr)
        sys.exit(1)
    elif not dry_run:
        imported = len(posts) - len(skipped) - len(errors)
        print(f"Done — {imported} posts imported to DynamoDB table '{table}' and S3 bucket '{bucket}'.")
    else:
        print(f"Dry run complete — {len(posts) - len(skipped)} posts would be imported.")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--sql',    required=True,            help='Path to ContentTable.sql')
    ap.add_argument('--bucket', required=True,            help='Content S3 bucket name')
    ap.add_argument('--table',  default='oldforest-posts',help='DynamoDB table name')
    ap.add_argument('--author', default='Mike Greene',    help='Default author name')
    ap.add_argument('--dry-run', action='store_true',     help='Parse only, no AWS writes')
    ap.add_argument('--all',     action='store_true',     help='Include unpublished posts')
    args = ap.parse_args()

    import_posts(
        sql_file    = args.sql,
        bucket      = args.bucket,
        table       = args.table,
        author      = args.author,
        dry_run     = args.dry_run,
        include_all = args.all,
    )


if __name__ == '__main__':
    main()
