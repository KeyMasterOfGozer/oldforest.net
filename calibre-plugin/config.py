"""Settings storage and the plugin's configuration screen."""

import threading
import webbrowser

from qt.core import (QCheckBox, QGroupBox, QHBoxLayout, QLabel, QLineEdit,
                     QPushButton, QTimer, QVBoxLayout, QWidget)

from calibre.utils.config import JSONConfig

from calibre_plugins.oldforest_books import auth

# Stored in calibre's config dir. Note this file is plain JSON on disk — see the
# security note in README.md about the refresh token kept here.
prefs = JSONConfig('plugins/oldforest_books')

prefs.defaults['api_base'] = 'https://oldforest.net'
prefs.defaults['cognito_domain'] = 'auth-165395066552.auth.us-east-1.amazoncognito.com'
# terraform output calibre_plugin_client_id — the plugin's own Cognito app
# client, not the website's. Public client, so this value isn't a secret.
prefs.defaults['client_id'] = '4iba7ad3ddrfopa26cfuu3m99j'
prefs.defaults['tokens'] = {}
prefs.defaults['skip_unchanged'] = True
prefs.defaults['upload_covers'] = False
# Applied only to books the plugin creates, never to updates — pushing from
# calibre means "I have this book but haven't logged reading it", which is what
# the site's pinned 'to read' filter represents. Empty disables the behaviour.
prefs.defaults['new_book_tags'] = 'to read'
# Set once, the first time the action registers itself on a toolbar. Kept so
# that deliberately removing the button later isn't undone on the next launch.
prefs.defaults['toolbar_registered'] = False


def auth_config():
    return {
        'cognito_domain': prefs['cognito_domain'],
        'client_id': prefs['client_id'],
    }


def is_configured():
    return bool(prefs['client_id'] and prefs['cognito_domain'] and prefs['api_base'])


def stored_tokens():
    return prefs['tokens'] or {}


def store_tokens(tokens):
    prefs['tokens'] = tokens or {}


def clear_tokens():
    prefs['tokens'] = {}


def access_token(force_refresh=False):
    """Return a usable access token, refreshing silently when needed.

    Raises auth.AuthError when the user has to sign in interactively again.
    """
    tokens = stored_tokens()
    if not tokens.get('refresh_token') and not tokens.get('access_token'):
        raise auth.AuthError('Not signed in. Open the plugin settings and sign in.')

    if force_refresh or auth.is_expired(tokens):
        refresh_token = tokens.get('refresh_token')
        if not refresh_token:
            raise auth.AuthError('Session expired. Sign in again from the plugin settings.')
        try:
            tokens = auth.refresh(auth_config(), refresh_token)
        except auth.AuthError:
            clear_tokens()
            raise auth.AuthError(
                'Session expired (refresh tokens last 7 days). '
                'Sign in again from the plugin settings.')
        store_tokens(tokens)

    return tokens['access_token']


class ConfigWidget(QWidget):

    def __init__(self):
        QWidget.__init__(self)
        self._sign_in_thread = None
        self._sign_in_error = None
        self._sign_in_tokens = None
        self._cancel_sign_in = False

        layout = QVBoxLayout(self)

        # ── Connection ───────────────────────────────────────────────────────
        connection = QGroupBox('Connection')
        form = QVBoxLayout(connection)

        form.addWidget(QLabel('Site URL:'))
        self.api_base = QLineEdit(prefs['api_base'], self)
        self.api_base.setPlaceholderText('https://oldforest.net')
        form.addWidget(self.api_base)

        form.addWidget(QLabel('Cognito domain:'))
        self.cognito_domain = QLineEdit(prefs['cognito_domain'], self)
        form.addWidget(self.cognito_domain)

        form.addWidget(QLabel('App client ID  (terraform output calibre_plugin_client_id):'))
        self.client_id = QLineEdit(prefs['client_id'], self)
        self.client_id.setPlaceholderText('e.g. 71fv32ot0raceh7mt5lqgjvbto')
        form.addWidget(self.client_id)

        layout.addWidget(connection)

        # ── Account ──────────────────────────────────────────────────────────
        account = QGroupBox('Account')
        account_layout = QVBoxLayout(account)

        self.status = QLabel(self)
        self.status.setWordWrap(True)
        account_layout.addWidget(self.status)

        buttons = QHBoxLayout()
        self.sign_in_button = QPushButton('Sign in…', self)
        self.sign_in_button.clicked.connect(self._start_sign_in)
        buttons.addWidget(self.sign_in_button)

        self.sign_out_button = QPushButton('Sign out', self)
        self.sign_out_button.clicked.connect(self._sign_out)
        buttons.addWidget(self.sign_out_button)
        buttons.addStretch(1)
        account_layout.addLayout(buttons)

        layout.addWidget(account)

        # ── Behaviour ────────────────────────────────────────────────────────
        self.skip_unchanged = QCheckBox(
            'Skip books whose metadata already matches the site', self)
        self.skip_unchanged.setChecked(bool(prefs['skip_unchanged']))
        layout.addWidget(self.skip_unchanged)

        self.upload_covers = QCheckBox('Upload cover art', self)
        self.upload_covers.setChecked(bool(prefs['upload_covers']))
        self.upload_covers.setToolTip(
            'Uploads the calibre cover to the site and sets the book\'s coverUrl.\n'
            'Only for books that have no cover on the site yet, so re-pushing\n'
            'does not litter S3 with duplicate images.')
        layout.addWidget(self.upload_covers)

        hint = QLabel(
            'Covers are uploaded only when the site has none for that book. '
            'To replace one, clear it on the site first.', self)
        hint.setWordWrap(True)
        hint.setStyleSheet('color: palette(mid); font-size: 11px;')
        layout.addWidget(hint)

        layout.addWidget(QLabel('Tags to add to newly created books:'))
        self.new_book_tags = QLineEdit(prefs['new_book_tags'], self)
        self.new_book_tags.setPlaceholderText('to read')
        self.new_book_tags.setToolTip(
            'Comma-separated. Added only to books this plugin creates, never to\n'
            'updates, and never duplicating a tag the book already has.\n'
            'Leave blank to add nothing.')
        layout.addWidget(self.new_book_tags)

        layout.addStretch(1)
        self._refresh_status()

    # ── sign-in ──────────────────────────────────────────────────────────────

    def _refresh_status(self):
        tokens = stored_tokens()
        if tokens.get('access_token') or tokens.get('refresh_token'):
            who = auth.describe(tokens)
            groups = auth.groups_from(tokens)
            note = ''
            if groups and not ({'editors', 'admins'} & set(groups)):
                note = ('  ⚠ This account is not in the editors group, so '
                        'pushes will be rejected.')
            self.status.setText('Signed in as %s.%s' % (who, note))
            self.sign_in_button.setText('Sign in again…')
            self.sign_out_button.setEnabled(True)
        else:
            self.status.setText('Not signed in.')
            self.sign_in_button.setText('Sign in…')
            self.sign_out_button.setEnabled(False)

    def _start_sign_in(self):
        # Persist connection fields first — sign-in needs them.
        self._save_connection()
        if not is_configured():
            self.status.setText(
                'Fill in the site URL, Cognito domain and app client ID first.')
            return

        self.sign_in_button.setEnabled(False)
        self.status.setText(
            'Opening your browser… complete the sign-in there, then come back.')

        self._sign_in_error = None
        self._sign_in_tokens = None
        self._cancel_sign_in = False

        cfg = auth_config()

        def worker():
            try:
                self._sign_in_tokens = auth.sign_in(
                    cfg, webbrowser.open,
                    should_cancel=lambda: self._cancel_sign_in)
            except Exception as exc:
                self._sign_in_error = str(exc)

        self._sign_in_thread = threading.Thread(target=worker, daemon=True)
        self._sign_in_thread.start()

        # Poll from the GUI thread — keeps Qt objects off the worker thread.
        self._poll = QTimer(self)
        self._poll.setInterval(400)
        self._poll.timeout.connect(self._check_sign_in)
        self._poll.start()

    def _check_sign_in(self):
        if self._sign_in_thread is not None and self._sign_in_thread.is_alive():
            return
        self._poll.stop()
        self.sign_in_button.setEnabled(True)

        if self._sign_in_error:
            self.status.setText('Sign-in failed: %s' % self._sign_in_error)
            return
        if self._sign_in_tokens:
            store_tokens(self._sign_in_tokens)
        self._refresh_status()

    def _sign_out(self):
        clear_tokens()
        self._refresh_status()

    # ── persistence ──────────────────────────────────────────────────────────

    def _save_connection(self):
        prefs['api_base'] = self.api_base.text().strip().rstrip('/')
        prefs['cognito_domain'] = self.cognito_domain.text().strip()
        prefs['client_id'] = self.client_id.text().strip()

    def save_settings(self):
        self._cancel_sign_in = True  # don't leave a listener bound if dialog closes
        self._save_connection()
        prefs['skip_unchanged'] = self.skip_unchanged.isChecked()
        prefs['upload_covers'] = self.upload_covers.isChecked()
        prefs['new_book_tags'] = self.new_book_tags.text().strip()
