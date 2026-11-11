'use strict';

/**
 * reading-workflow.js — the "start reading this book" workflow.
 *
 * Working out what to change touches several books and several read records at
 * once, so the decision-making lives here as one pure function with no DOM and
 * no network. That makes it testable headlessly:
 *
 *   node site/js/reading-workflow.js
 *
 * The page loads this file and only performs the writes the plan describes.
 */

const CURRENT_TAG = 'current';
const TO_READ_TAG = 'to read';

/** Tags are entered lowercase in the UI but imported data is inconsistent. */
function _norm(tag) {
  return String(tag ?? '').trim().toLowerCase();
}

function _hasTag(tags, wanted) {
  return (tags || []).some(t => _norm(t) === wanted);
}

function _withoutTag(tags, unwanted) {
  return (tags || []).filter(t => _norm(t) !== unwanted);
}

/** A read still in progress: it has no finish date. */
function _isOpen(read) {
  return !String(read.finished ?? '').trim();
}

/**
 * Plan everything needed to start reading `newBook` today.
 *
 * @param {object} newBook   the book being started
 * @param {object[]} allBooks every book (needs bookId, title, tags)
 * @param {object[]} allReads every read (needs readId, bookId, started, finished)
 * @param {string} today     ISO date, 'YYYY-MM-DD'
 * @returns {object} plan — see shape below; `isNoop` when there is nothing to do
 */
function planStartReading(newBook, allBooks, allReads, today) {
  const startTags = newBook.tags || [];

  // Start side: gain 'current', lose 'to read'.
  let tagsAfter = startTags;
  const willAddCurrent = !_hasTag(startTags, CURRENT_TAG);
  const willDropToRead = _hasTag(startTags, TO_READ_TAG);
  if (willDropToRead) tagsAfter = _withoutTag(tagsAfter, TO_READ_TAG);
  if (willAddCurrent) tagsAfter = [...tagsAfter, CURRENT_TAG];

  // Don't open a second read if one is already in progress for this book.
  const ownReads = (allReads || []).filter(r => r.bookId === newBook.bookId);
  const ownOpen = ownReads.filter(_isOpen);

  const start = {
    bookId: newBook.bookId,
    title: newBook.title || '(untitled)',
    tagsAfter,
    tagsChanged: willAddCurrent || willDropToRead,
    addedCurrent: willAddCurrent,
    droppedToRead: willDropToRead,
    createRead: ownOpen.length === 0,
    // Set only when an open read exists but has no start date recorded.
    backfillStartedReadId:
      ownOpen.length && !String(ownOpen[0].started ?? '').trim()
        ? ownOpen[0].readId : null,
  };

  // Close side: every OTHER book still tagged 'current'.
  const close = (allBooks || [])
    .filter(b => b.bookId !== newBook.bookId && _hasTag(b.tags, CURRENT_TAG))
    .map(book => {
      const openReads = (allReads || [])
        .filter(r => r.bookId === book.bookId && _isOpen(r));
      return {
        bookId: book.bookId,
        title: book.title || '(untitled)',
        tagsAfter: _withoutTag(book.tags, CURRENT_TAG),
        finishReadIds: openReads.map(r => r.readId),
      };
    });

  const warnings = [];
  for (const entry of close) {
    if (!entry.finishReadIds.length) {
      // Nothing to date — worth surfacing so a missing read isn't silently ignored.
      warnings.push(`"${entry.title}" is tagged ${CURRENT_TAG} but has no unfinished read to date.`);
    } else if (entry.finishReadIds.length > 1) {
      warnings.push(`"${entry.title}" has ${entry.finishReadIds.length} unfinished reads; all will be dated ${today}.`);
    }
  }
  if (!start.createRead && !start.backfillStartedReadId) {
    warnings.push('This book already has a read in progress, so no new read will be created.');
  }

  const writes =
    (start.tagsChanged ? 1 : 0) +
    (start.createRead ? 1 : 0) +
    (start.backfillStartedReadId ? 1 : 0) +
    close.length +
    close.reduce((n, c) => n + c.finishReadIds.length, 0);

  return { today, start, close, warnings, writes, isNoop: writes === 0 };
}

// ── Self-test ────────────────────────────────────────────────────────────────
// node site/js/reading-workflow.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planStartReading, CURRENT_TAG, TO_READ_TAG };

  if (require.main === module) {
    const failures = [];
    const check = (label, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(`${label}\n     got:  ${g}\n     want: ${w}`);
    };
    const TODAY = '2026-08-10';

    // The core case: finish one, start the next.
    let books = [
      { bookId: 'new', title: 'New One', tags: ['to read', 'fantasy'] },
      { bookId: 'old', title: 'Old One', tags: ['current', 'scifi'] },
      { bookId: 'other', title: 'Untouched', tags: ['owned'] },
    ];
    let reads = [
      { readId: 'r-old', bookId: 'old', started: '2026-07-01', finished: null },
      { readId: 'r-done', bookId: 'other', started: '2026-01-01', finished: '2026-02-01' },
    ];
    let p = planStartReading(books[0], books, reads, TODAY);
    check('start: to read dropped, current added', p.start.tagsAfter, ['fantasy', 'current']);
    check('start: creates a read', p.start.createRead, true);
    check('close: only the other current book', p.close.map(c => c.bookId), ['old']);
    check('close: current tag removed, others kept', p.close[0].tagsAfter, ['scifi']);
    check('close: open read gets dated', p.close[0].finishReadIds, ['r-old']);
    check('write count', p.writes, 4); // start tags, new read, old tags, old read
    check('no spurious warnings', p.warnings, []);

    // Already-finished reads must not be re-dated.
    check('finished reads untouched',
      planStartReading(books[0], books,
        [{ readId: 'r1', bookId: 'old', started: '2026-01-01', finished: '2026-02-01' }],
        TODAY).close[0].finishReadIds, []);

    // A 'current' book with no open read still loses the tag, and warns.
    p = planStartReading(books[0], books, [], TODAY);
    check('tag still cleared with no reads', p.close[0].tagsAfter, ['scifi']);
    check('warns about missing read', p.warnings.length, 1);

    // Multiple open reads on one book: all get dated, with a warning.
    p = planStartReading(books[0], books, [
      { readId: 'a', bookId: 'old', started: '2026-01-01', finished: null },
      { readId: 'b', bookId: 'old', started: '2026-03-01', finished: '' },
    ], TODAY);
    check('all open reads dated', p.close[0].finishReadIds, ['a', 'b']);
    check('warns about multiple', p.warnings.length, 1);

    // Book already in progress: no duplicate read.
    p = planStartReading(books[0], books,
      [{ readId: 'mine', bookId: 'new', started: '2026-08-01', finished: null }], TODAY);
    check('no duplicate read', p.start.createRead, false);
    check('no backfill needed', p.start.backfillStartedReadId, null);
    check('warns already in progress',
      p.warnings.some(w => w.includes('already has a read in progress')), true);

    // Open read with no start date gets today backfilled.
    p = planStartReading(books[0], books,
      [{ readId: 'blank', bookId: 'new', started: '', finished: null }], TODAY);
    check('backfills missing start', p.start.backfillStartedReadId, 'blank');
    check('still no new read', p.start.createRead, false);

    // Book already current and already started → genuinely nothing to do.
    p = planStartReading(
      { bookId: 'new', title: 'N', tags: ['current'] },
      [{ bookId: 'new', title: 'N', tags: ['current'] }],
      [{ readId: 'x', bookId: 'new', started: '2026-08-01', finished: null }], TODAY);
    check('noop detected', p.isNoop, true);
    check('noop writes zero', p.writes, 0);

    // Tag casing must not create duplicates or miss matches.
    p = planStartReading(
      { bookId: 'new', title: 'N', tags: ['To Read'] },
      [{ bookId: 'new', title: 'N', tags: ['To Read'] },
       { bookId: 'o', title: 'O', tags: ['Current'] }],
      [], TODAY);
    check('mixed-case to read dropped', p.start.tagsAfter, ['current']);
    check('mixed-case current matched for close', p.close.map(c => c.bookId), ['o']);

    // The book being started is never also closed.
    p = planStartReading(
      { bookId: 'new', title: 'N', tags: ['current', 'to read'] },
      [{ bookId: 'new', title: 'N', tags: ['current', 'to read'] }], [], TODAY);
    check('never closes itself', p.close, []);
    check('keeps current, drops to read', p.start.tagsAfter, ['current']);

    if (failures.length) {
      console.log(`FAILED (${failures.length}):`);
      failures.forEach(f => console.log('  - ' + f));
      process.exit(1);
    }
    console.log('reading-workflow: all checks passed');
  }
}
