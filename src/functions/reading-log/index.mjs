import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
  BatchWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const BOOKS_TABLE = process.env.BOOKS_TABLE;
const READS_TABLE = process.env.READS_TABLE;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(body, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function err(message, status = 400) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}

function now() {
  return new Date().toISOString();
}

/** Returns true if the JWT claims include editors or admins group */
function isEditor(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const groups = claims['cognito:groups'] ?? '';
  // DEBUG — remove after confirming claims shape
  console.log('DEBUG isEditor claims:', JSON.stringify(claims));
  console.log('DEBUG groups value:', JSON.stringify(groups), 'type:', typeof groups);
  return groups.includes('editors') || groups.includes('admins');
}

// ── Books ─────────────────────────────────────────────────────────────────────

/** GET /v1/reading/books[?q=] — list all books (metadata only) */
async function listBooks(event) {
  const q = event.queryStringParameters?.q?.toLowerCase();

  const result = await dynamo.send(new ScanCommand({ TableName: BOOKS_TABLE }));
  let items = result.Items ?? [];

  if (q) {
    items = items.filter(b =>
      b.title?.toLowerCase().includes(q) ||
      b.author?.toLowerCase().includes(q)
    );
  }

  // Sort by title
  items.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
  return ok({ books: items });
}

/** GET /v1/reading/books/{bookId} — book detail with all reads joined */
async function getBook(event) {
  const { bookId } = event.pathParameters;

  const [bookResult, readsResult] = await Promise.all([
    dynamo.send(new GetCommand({ TableName: BOOKS_TABLE, Key: { bookId } })),
    // Scan with filter instead of querying the byBook GSI — the GSI uses
    // 'finished' as its sort key, so reads without a finish date are excluded
    // from the index. A scan catches all reads for this book regardless.
    dynamo.send(new ScanCommand({
      TableName: READS_TABLE,
      FilterExpression: 'bookId = :bid',
      ExpressionAttributeValues: { ':bid': bookId },
    })),
  ]);

  if (!bookResult.Item) return err('Book not found', 404);

  const book = bookResult.Item;
  book.reads = (readsResult.Items ?? []).sort((a, b) =>
    (a.finished ?? a.started ?? '').localeCompare(b.finished ?? b.started ?? '')
  );

  return ok({ book });
}

/** POST /v1/reading/books — create book */
async function createBook(event) {
  if (!isEditor(event)) return err('Forbidden', 403);

  const body = JSON.parse(event.body ?? '{}');
  if (!body.title?.trim()) return err('title is required');
  if (!body.author?.trim()) return err('author is required');

  const ts = now();
  const item = {
    bookId:       body.googleBooksId ?? randomUUID(),
    allBooks:     'ALL',   // constant PK for byUpdated GSI
    title:        body.title.trim(),
    author:       body.author.trim(),
    googleBooksId: body.googleBooksId ?? null,
    goodreadsUrl:  body.goodreadsUrl ?? null,
    coverUrl:      body.coverUrl ?? null,
    pageCount:     body.pageCount ?? null,
    description:   body.description ?? null,
    isbn:          body.isbn ?? null,
    tags:          body.tags ?? [],
    createdAt:    ts,
    updatedAt:    ts,
  };

  // Remove null values to keep items clean
  Object.keys(item).forEach(k => { if (item[k] === null) delete item[k]; });

  await dynamo.send(new PutCommand({ TableName: BOOKS_TABLE, Item: item }));
  return ok({ book: item }, 201);
}

/** PUT /v1/reading/books/{bookId} — update book metadata */
async function updateBook(event) {
  if (!isEditor(event)) return err('Forbidden', 403);

  const { bookId } = event.pathParameters;
  const body = JSON.parse(event.body ?? '{}');

  // All field names are aliased to avoid DynamoDB reserved word conflicts
  // (e.g. title, description, isbn are reserved keywords)
  const allowed = ['title','author','googleBooksId','goodreadsUrl','coverUrl','pageCount','description','isbn','tags'];
  const sets = ['updatedAt = :updatedAt'];
  const exprValues = { ':updatedAt': now() };
  const exprNames = {};

  for (const field of allowed) {
    if (body[field] !== undefined) {
      exprNames[`#${field}`] = field;
      sets.push(`#${field} = :${field}`);
      exprValues[`:${field}`] = body[field];
    }
  }

  try {
    const result = await dynamo.send(new UpdateCommand({
      TableName: BOOKS_TABLE,
      Key: { bookId },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
      ExpressionAttributeValues: exprValues,
      ConditionExpression: 'attribute_exists(bookId)',
      ReturnValues: 'ALL_NEW',
    }));
    return ok({ book: result.Attributes });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return err('Book not found', 404);
    throw e;
  }
}

/** DELETE /v1/reading/books/{bookId} — delete book and all its reads */
async function deleteBook(event) {
  if (!isEditor(event)) return err('Forbidden', 403);

  const { bookId } = event.pathParameters;

  // Find all reads for this book
  const readsResult = await dynamo.send(new QueryCommand({
    TableName: READS_TABLE,
    IndexName: 'byBook',
    KeyConditionExpression: 'bookId = :bid',
    ExpressionAttributeValues: { ':bid': bookId },
    ProjectionExpression: 'readId',
  }));

  const readIds = (readsResult.Items ?? []).map(r => r.readId);

  // Batch-delete reads in chunks of 25
  for (let i = 0; i < readIds.length; i += 25) {
    const chunk = readIds.slice(i, i + 25);
    await dynamo.send(new BatchWriteCommand({
      RequestItems: {
        [READS_TABLE]: chunk.map(readId => ({ DeleteRequest: { Key: { readId } } })),
      },
    }));
  }

  await dynamo.send(new DeleteCommand({ TableName: BOOKS_TABLE, Key: { bookId } }));
  return ok({ deleted: bookId });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** GET /v1/reading/reads[?bookId=&from=&to=] — list reads with book info joined */
async function listReads(event) {
  const { bookId, from, to } = event.queryStringParameters ?? {};

  let reads;

  if (bookId) {
    // All reads for one book via byBook GSI
    const result = await dynamo.send(new QueryCommand({
      TableName: READS_TABLE,
      IndexName: 'byBook',
      KeyConditionExpression: 'bookId = :bid',
      ExpressionAttributeValues: { ':bid': bookId },
    }));
    reads = result.Items ?? [];
  } else if (from || to) {
    // Date-range query via byFinished GSI
    let KeyConditionExpression = 'allReads = :all';
    const ExpressionAttributeValues = { ':all': 'ALL' };

    if (from && to) {
      KeyConditionExpression += ' AND finished BETWEEN :from AND :to';
      ExpressionAttributeValues[':from'] = from;
      ExpressionAttributeValues[':to']   = to;
    } else if (from) {
      KeyConditionExpression += ' AND finished >= :from';
      ExpressionAttributeValues[':from'] = from;
    } else {
      KeyConditionExpression += ' AND finished <= :to';
      ExpressionAttributeValues[':to'] = to;
    }

    const result = await dynamo.send(new QueryCommand({
      TableName: READS_TABLE,
      IndexName: 'byFinished',
      KeyConditionExpression,
      ExpressionAttributeValues,
    }));
    reads = result.Items ?? [];
  } else {
    // Full scan — paginate to handle tables > 1 MB
    reads = [];
    let lastKey;
    do {
      const result = await dynamo.send(new ScanCommand({
        TableName: READS_TABLE,
        ExclusiveStartKey: lastKey,
      }));
      reads.push(...(result.Items ?? []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
  }

  // Sort by finished date (nulls last), then started
  reads.sort((a, b) => {
    const af = a.finished ?? a.started ?? '';
    const bf = b.finished ?? b.started ?? '';
    return String(af).localeCompare(String(bf));
  });

  // Join book metadata (batch get books that appear in the result set)
  const bookIds = [...new Set(reads.map(r => r.bookId).filter(Boolean))];
  const bookMap = {};

  if (bookIds.length) {
    // DynamoDB BatchGet in chunks of 100; no ProjectionExpression to avoid
    // reserved-word conflicts — books are small so returning all fields is fine
    for (let i = 0; i < bookIds.length; i += 100) {
      const chunk = bookIds.slice(i, i + 100);
      const batchResult = await dynamo.send(new BatchGetCommand({
        RequestItems: {
          [BOOKS_TABLE]: {
            Keys: chunk.map(id => ({ bookId: id })),
          },
        },
      }));
      for (const book of batchResult.Responses?.[BOOKS_TABLE] ?? []) {
        bookMap[book.bookId] = book;
      }
    }
  }

  const enriched = reads.map(r => ({
    ...r,
    book: bookMap[r.bookId] ?? null,
  }));

  return ok({ reads: enriched });
}

/** POST /v1/reading/reads — log a new read */
async function createRead(event) {
  if (!isEditor(event)) return err('Forbidden', 403);

  const body = JSON.parse(event.body ?? '{}');
  if (!body.bookId) return err('bookId is required');

  // Verify book exists
  const bookCheck = await dynamo.send(new GetCommand({
    TableName: BOOKS_TABLE,
    Key: { bookId: body.bookId },
    ProjectionExpression: 'bookId',
  }));
  if (!bookCheck.Item) return err('Book not found', 404);

  const ts = now();
  const item = {
    readId:    randomUUID(),
    allReads:  'ALL',   // constant PK for byFinished / byStarted GSIs
    bookId:    body.bookId,
    started:   body.started  ?? null,
    finished:  body.finished ?? null,
    rating:    body.rating   ?? null,
    format:    body.format   ?? null,
    review:    body.review   ?? null,
    notes:     body.notes    ?? null,
    createdAt: ts,
    updatedAt: ts,
  };

  // Remove null values
  Object.keys(item).forEach(k => { if (item[k] === null) delete item[k]; });

  await dynamo.send(new PutCommand({ TableName: READS_TABLE, Item: item }));

  // Touch book's updatedAt so byUpdated GSI stays fresh
  await dynamo.send(new UpdateCommand({
    TableName: BOOKS_TABLE,
    Key: { bookId: body.bookId },
    UpdateExpression: 'SET updatedAt = :ts',
    ExpressionAttributeValues: { ':ts': ts },
  }));

  return ok({ read: item }, 201);
}

/** PUT /v1/reading/reads/{readId} — update a read */
async function updateRead(event) {
  if (!isEditor(event)) return err('Forbidden', 403);

  const { readId } = event.pathParameters;
  const body = JSON.parse(event.body ?? '{}');

  // Alias all field names to avoid reserved word conflicts (format, status, etc.)
  const allowed = ['started','finished','rating','format','review','notes'];
  const sets = ['updatedAt = :updatedAt'];
  const removes = [];
  const exprValues = { ':updatedAt': now() };
  const exprNames = {};

  for (const field of allowed) {
    if (body[field] !== undefined) {
      if (body[field] === null || body[field] === '') {
        exprNames[`#${field}`] = field;
        removes.push(`#${field}`);
      } else {
        exprNames[`#${field}`] = field;
        sets.push(`#${field} = :${field}`);
        exprValues[`:${field}`] = body[field];
      }
    }
  }

  let UpdateExpression = 'SET ' + sets.join(', ');
  if (removes.length) UpdateExpression += ' REMOVE ' + removes.join(', ');

  try {
    const result = await dynamo.send(new UpdateCommand({
      TableName: READS_TABLE,
      Key: { readId },
      UpdateExpression,
      ExpressionAttributeNames: Object.keys(exprNames).length ? exprNames : undefined,
      ExpressionAttributeValues: exprValues,
      ConditionExpression: 'attribute_exists(readId)',
      ReturnValues: 'ALL_NEW',
    }));
    return ok({ read: result.Attributes });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return err('Read not found', 404);
    throw e;
  }
}

/** DELETE /v1/reading/reads/{readId} — delete a read */
async function deleteRead(event) {
  if (!isEditor(event)) return err('Forbidden', 403);

  const { readId } = event.pathParameters;
  await dynamo.send(new DeleteCommand({ TableName: READS_TABLE, Key: { readId } }));
  return ok({ deleted: readId });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handler(event) {
  const method = event.requestContext.http.method;
  const path   = event.requestContext.http.path;

  console.log(`${method} ${path}`);

  try {
    // Books
    if (method === 'GET'    && path === '/v1/reading/books')              return await listBooks(event);
    if (method === 'GET'    && path.match(/^\/v1\/reading\/books\/[^/]+$/)) return await getBook(event);
    if (method === 'POST'   && path === '/v1/reading/books')              return await createBook(event);
    if (method === 'PUT'    && path.match(/^\/v1\/reading\/books\/[^/]+$/)) return await updateBook(event);
    if (method === 'DELETE' && path.match(/^\/v1\/reading\/books\/[^/]+$/)) return await deleteBook(event);

    // Reads
    if (method === 'GET'    && path === '/v1/reading/reads')              return await listReads(event);
    if (method === 'POST'   && path === '/v1/reading/reads')              return await createRead(event);
    if (method === 'PUT'    && path.match(/^\/v1\/reading\/reads\/[^/]+$/)) return await updateRead(event);
    if (method === 'DELETE' && path.match(/^\/v1\/reading\/reads\/[^/]+$/)) return await deleteRead(event);

    return err('Not found', 404);
  } catch (e) {
    console.error(e);
    return err(`Internal server error: ${e.message}`, 500);
  }
}
