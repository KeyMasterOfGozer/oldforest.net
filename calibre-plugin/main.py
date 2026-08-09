"""The push dialog: review what will happen to each book, adjust, then push."""

import threading

from qt.core import (Qt, QAbstractItemView, QComboBox, QDialog, QDialogButtonBox,
                     QHBoxLayout, QLabel, QProgressBar, QPushButton, QTimer,
                     QTreeWidget, QTreeWidgetItem, QVBoxLayout)

from calibre_plugins.oldforest_books import auth
from calibre_plugins.oldforest_books.api import ApiClient, ApiError
from calibre_plugins.oldforest_books.config import (access_token, is_configured,
                                                    prefs, stored_tokens)
from calibre_plugins.oldforest_books.covers import CoverError, upload_cover
from calibre_plugins.oldforest_books.metadata_map import (EXACT, STRONG, WEAK,
                                                          best_candidate, book_payload,
                                                          build_index, changed_fields,
                                                          find_candidates, missing_tags,
                                                          parse_tag_list, with_extra_tags)

CREATE = '__create__'   # userData marking the "create a new book" choice
SKIP = '__skip__'       # book can't be pushed at all

_CONFIDENCE_LABEL = {EXACT: 'exact', STRONG: 'strong', WEAK: 'weak'}


class PushDialog(QDialog):

    def __init__(self, gui, icon, do_user_config, book_ids):
        QDialog.__init__(self, gui)
        self.gui = gui
        self.do_user_config = do_user_config
        self.book_ids = book_ids
        self.rows = []
        self._remote = []
        self._error = None
        self._results = None
        self._done_count = 0
        self._cancel = False
        self._pushing = False

        self.setWindowTitle('Push books to oldforest.net')
        self.setWindowIcon(icon)
        self.resize(920, 520)

        layout = QVBoxLayout(self)

        self.heading = QLabel(self)
        self.heading.setWordWrap(True)
        layout.addWidget(self.heading)

        self.tree = QTreeWidget(self)
        self.tree.setHeaderLabels(['Title', 'Author', 'Action', 'Why / details'])
        self.tree.setRootIsDecorated(False)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        self.tree.setAlternatingRowColors(True)
        layout.addWidget(self.tree, 1)

        self.progress = QProgressBar(self)
        self.progress.setVisible(False)
        layout.addWidget(self.progress)

        buttons = QHBoxLayout()
        self.settings_button = QPushButton('Settings…', self)
        self.settings_button.clicked.connect(self._open_settings)
        buttons.addWidget(self.settings_button)

        self.all_new_button = QPushButton('Set all to "Create new"', self)
        self.all_new_button.clicked.connect(lambda: self._set_all(CREATE))
        buttons.addWidget(self.all_new_button)

        self.all_match_button = QPushButton('Accept all suggested matches', self)
        self.all_match_button.clicked.connect(lambda: self._set_all(None))
        buttons.addWidget(self.all_match_button)

        buttons.addStretch(1)

        self.button_box = QDialogButtonBox(self)
        self.push_button = self.button_box.addButton(
            'Push', QDialogButtonBox.ButtonRole.AcceptRole)
        self.close_button = self.button_box.addButton(
            QDialogButtonBox.StandardButton.Close)
        self.push_button.clicked.connect(self._start_push)
        self.close_button.clicked.connect(self.reject)
        buttons.addWidget(self.button_box)
        layout.addLayout(buttons)

        self._set_busy(True)
        QTimer.singleShot(0, self._build_plan)

    # ── planning ─────────────────────────────────────────────────────────────

    def _build_plan(self):
        if not is_configured():
            self._fail('This plugin is not configured yet. Open Settings and '
                       'enter the site URL, Cognito domain and app client ID.')
            return
        tokens = stored_tokens()
        if not (tokens.get('access_token') or tokens.get('refresh_token')):
            self._fail('Not signed in. Open Settings and sign in first.')
            return

        self.heading.setText('Reading library metadata and comparing with the site…')

        db = self.gui.current_db.new_api
        scanned = []
        for calibre_id in self.book_ids:
            mi = db.get_metadata(calibre_id)
            scanned.append({
                'calibre_id': calibre_id,
                'title': mi.title or '(untitled)',
                'author': ', '.join(mi.authors or []) or '',
                'payload': book_payload(mi),
            })

        self._error = None

        def worker():
            try:
                client = ApiClient(prefs['api_base'], access_token)
                self._remote = client.list_books()
            except Exception as exc:
                self._error = str(exc)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self._await(thread, lambda: self._finish_plan(scanned))

    def _finish_plan(self, scanned):
        if self._error:
            self._fail('Could not load existing books from the site:\n%s\n\n'
                       'Nothing was sent.' % self._error)
            return

        index = build_index(self._remote)

        self.rows = []
        for entry in scanned:
            row = dict(entry)
            if row['payload'] is None:
                row['candidates'] = []
                row['decision'] = SKIP
                row['note'] = 'needs both a title and an author'
            else:
                candidates = find_candidates(row['payload'], index)
                row['candidates'] = candidates
                suggested = best_candidate(candidates)
                row['suggested'] = suggested
                row['decision'] = (suggested['book'].get('bookId')
                                   if suggested else CREATE)
                row['note'] = self._note_for(candidates, suggested)
            self.rows.append(row)

        self._render_plan()
        self._set_busy(False)

    @staticmethod
    def _note_for(candidates, suggested):
        if not candidates:
            return 'no match on the site — will be created'
        if suggested is not None:
            return suggested['reason']
        top = candidates[0]
        if len(candidates) > 1 and candidates[1]['confidence'] == top['confidence']:
            return ('⚠ %d equally good matches (%s) — pick one or create new'
                    % (len(candidates), top['reason']))
        return '⚠ only a %s match (%s) — defaulting to create new' % (
            _CONFIDENCE_LABEL.get(top['confidence'], 'partial'), top['reason'])

    def _render_plan(self):
        self.tree.clear()
        for row in self.rows:
            item = QTreeWidgetItem(self.tree,
                                   [row['title'], row['author'], '', row['note']])
            row['_item'] = item
            if row['decision'] == SKIP:
                item.setText(2, 'Skip')
                item.setDisabled(True)
                continue

            combo = QComboBox(self.tree)
            combo.addItem('Create new book', CREATE)
            for candidate in row['candidates']:
                book = candidate['book']
                combo.addItem(
                    'Update: %s — %s  (%s)' % (
                        book.get('title') or '(untitled)',
                        book.get('author') or '(no author)',
                        candidate['reason']),
                    book.get('bookId'))
            wanted = combo.findData(row['decision'])
            combo.setCurrentIndex(wanted if wanted >= 0 else 0)
            combo.currentIndexChanged.connect(
                lambda _idx, r=row, c=combo: self._decision_changed(r, c))
            self.tree.setItemWidget(item, 2, combo)
            row['_combo'] = combo

        for column in (0, 1, 2):
            self.tree.resizeColumnToContents(column)
        self._update_summary()

    def _decision_changed(self, row, combo):
        row['decision'] = combo.currentData()
        self._update_summary()

    def _set_all(self, decision):
        """decision=CREATE forces create; None restores the suggested match."""
        for row in self.rows:
            combo = row.get('_combo')
            if combo is None:
                continue
            if decision == CREATE:
                target = CREATE
            else:
                suggested = row.get('suggested')
                target = suggested['book'].get('bookId') if suggested else CREATE
            position = combo.findData(target)
            if position >= 0:
                combo.setCurrentIndex(position)
        self._update_summary()

    def _actions(self):
        """(creates, updates, unchanged, skipped) under the current decisions."""
        creates, updates, unchanged, skipped = [], [], [], []
        skip_unchanged = bool(prefs['skip_unchanged'])
        want_covers = bool(prefs['upload_covers'])

        for row in self.rows:
            if row['decision'] == SKIP:
                skipped.append(row)
                continue
            if row['decision'] == CREATE:
                creates.append(row)
                continue

            existing = next((c['book'] for c in row['candidates']
                             if c['book'].get('bookId') == row['decision']), None)
            if existing is None:            # decision points at a stale entry
                creates.append(row)
                continue

            diff = changed_fields(row['payload'], existing)
            needs_cover = want_covers and not existing.get('coverUrl')
            if not diff and not needs_cover:
                unchanged.append(row)
                continue
            row['_diff'] = diff if skip_unchanged else dict(row['payload'])
            row['_target'] = existing
            updates.append(row)

        return creates, updates, unchanged, skipped

    def _refresh_details(self):
        """Re-annotate the detail column — what happens depends on the decision,
        which the user can change at any time from the Action dropdown."""
        extra = parse_tag_list(prefs['new_book_tags'])
        for row in self.rows:
            item = row.get('_item')
            if item is None or row['decision'] == SKIP:
                continue
            detail = row['note']
            if row['decision'] == CREATE and row.get('payload'):
                adding = missing_tags(row['payload'], extra)
                if adding:
                    detail += ' · tagging %s' % ', '.join('"%s"' % t for t in adding)
            item.setText(3, detail)

    def _update_summary(self):
        self._refresh_details()
        creates, updates, unchanged, skipped = self._actions()
        parts = []
        if creates:
            parts.append('%d to create' % len(creates))
        if updates:
            parts.append('%d to update' % len(updates))
        if unchanged:
            parts.append('%d already up to date' % len(unchanged))
        if skipped:
            parts.append('%d skipped' % len(skipped))

        ambiguous = sum(1 for r in self.rows
                        if r.get('candidates') and r.get('suggested') is None
                        and r['decision'] == CREATE)
        warning = ''
        if ambiguous:
            warning = ('  —  %d book%s had an uncertain match and default to '
                       'creating a new entry; review the Action column.'
                       % (ambiguous, '' if ambiguous == 1 else 's'))

        self.heading.setText('%d book%s selected: %s.%s'
                             % (len(self.rows), '' if len(self.rows) == 1 else 's',
                                ', '.join(parts) or 'nothing to do', warning))

        total = len(creates) + len(updates)
        self.push_button.setEnabled(total > 0 and not self._pushing)
        self.push_button.setText(
            'Push %d book%s' % (total, '' if total == 1 else 's')
            if total else 'Nothing to push')

    # ── pushing ──────────────────────────────────────────────────────────────

    def _start_push(self):
        creates, updates, _, _ = self._actions()
        todo = [('create', r) for r in creates] + [('update', r) for r in updates]
        if not todo:
            return

        self._pushing = True
        self._cancel = False
        self._done_count = 0
        self._set_busy(True)
        self.progress.setVisible(True)
        self.progress.setRange(0, len(todo))
        self.progress.setValue(0)

        db = self.gui.current_db.new_api      # documented threadsafe
        api_base = prefs['api_base']
        want_covers = bool(prefs['upload_covers'])
        new_book_tags = parse_tag_list(prefs['new_book_tags'])
        results = []

        def worker():
            client = ApiClient(api_base, access_token)
            for kind, row in todo:
                if self._cancel:
                    break
                warning = None
                try:
                    # New books only: an update must never silently re-add a tag
                    # that was deliberately removed on the site.
                    payload = (with_extra_tags(row['payload'], new_book_tags)
                               if kind == 'create'
                               else dict(row.get('_diff') or {}))
                    target = row.get('_target') or {}

                    if want_covers and not target.get('coverUrl'):
                        try:
                            payload['coverUrl'] = upload_cover(
                                client, api_base, db.cover(row['calibre_id']),
                                row['title'])
                        except (CoverError, ApiError) as exc:
                            # A cover problem must never lose the metadata push.
                            warning = 'cover not uploaded (%s)' % exc

                    if kind == 'create':
                        client.create_book(payload)
                    elif payload:
                        client.update_book(target.get('bookId'), payload)

                    results.append((row, kind, None, warning))
                except (ApiError, auth.AuthError) as exc:
                    results.append((row, kind, str(exc), warning))
                except Exception as exc:      # one bad book must not end the run
                    results.append((row, kind, '%s: %s' % (type(exc).__name__, exc),
                                    warning))
                self._done_count += 1

        self._results = results
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self._await(thread, self._finish_push,
                    on_tick=lambda: self.progress.setValue(self._done_count))

    def _finish_push(self):
        self._pushing = False
        self.progress.setVisible(False)
        self._set_busy(False)

        results = self._results or []
        failures = [r for r in results if r[2]]
        warned = [r for r in results if not r[2] and r[3]]
        succeeded = len(results) - len(failures)

        self.tree.clear()
        for row, kind, error, warning in results:
            if error:
                action, detail = 'Failed', error
            else:
                action = 'Created' if kind == 'create' else 'Updated'
                detail = warning or 'ok'
            QTreeWidgetItem(self.tree, [row['title'], row['author'], action, detail])
        for column in range(4):
            self.tree.resizeColumnToContents(column)

        summary = '%d pushed' % succeeded
        if failures:
            summary += ', %d failed' % len(failures)
        if warned:
            summary += ', %d without a cover' % len(warned)
        if self._cancel:
            summary += ' (cancelled — remaining books were not sent)'
        if failures:
            summary += ('. The usual cause is an account outside the editors '
                        'group, or an expired session.')
        self.heading.setText(summary + '.')

        self.push_button.setEnabled(False)
        self.push_button.setText('Done')

    # ── helpers ──────────────────────────────────────────────────────────────

    def _set_busy(self, busy):
        for widget in (self.settings_button, self.all_new_button,
                       self.all_match_button):
            widget.setEnabled(not busy)
        self.tree.setEnabled(not busy)
        if busy:
            self.push_button.setEnabled(False)
        self.close_button.setText('Cancel' if busy and self._pushing else 'Close')

    def _await(self, thread, on_done, on_tick=None):
        """Poll a worker thread from the GUI thread.

        Qt objects are only ever touched here, never on the worker.
        """
        timer = QTimer(self)
        timer.setInterval(150)

        def check():
            if on_tick is not None:
                on_tick()
            if thread.is_alive():
                return
            timer.stop()
            on_done()

        timer.timeout.connect(check)
        timer.start()

    def _fail(self, message):
        self.heading.setText(message)
        self._set_busy(False)
        self.push_button.setEnabled(False)
        self.push_button.setText('Push')

    def _open_settings(self):
        self.do_user_config(parent=self)
        self._set_busy(True)
        self._build_plan()

    def reject(self):
        if self._pushing:
            self._cancel = True     # let the worker stop at the next book
            return
        QDialog.reject(self)
