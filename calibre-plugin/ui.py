"""Toolbar action wiring."""

from calibre.gui2 import error_dialog
from calibre.gui2.actions import InterfaceAction

from calibre_plugins.oldforest_books.main import PushDialog


class OldforestBooksAction(InterfaceAction):

    name = 'Push to oldforest.net'
    # (text, icon, tooltip, keyboard shortcut)
    action_spec = ('Push to oldforest.net', None,
                   'Push the selected books to the oldforest.net reading log', None)

    def genesis(self):
        icon = self._plugin_icon()
        if icon is not None:
            self.qaction.setIcon(icon)
        self.qaction.triggered.connect(self.show_dialog)
        self._register_in_menus()

    def _plugin_icon(self):
        """The oldforest.net tree, rendered from the site favicon.

        get_icons is injected into plugin modules by calibre's zip importer
        rather than imported, so it is absent when this module is exercised
        outside a running calibre — hence the guard.
        """
        try:
            return get_icons('images/icon.png', self.name)  # noqa: F821
        except Exception:
            return None

    def _register_in_menus(self):
        """Put this action on the main toolbar and the book right-click menu.

        Calibre does not place InterfaceAction plugins anywhere by itself, so
        without this the plugin installs cleanly and then appears nowhere in the
        UI. Done once only — tracked by a pref — so that removing the button by
        hand afterwards is respected rather than undone on the next launch.
        """
        from calibre.gui2 import gprefs
        from calibre_plugins.oldforest_books.config import prefs

        if prefs['toolbar_registered']:
            return
        try:
            for key in ('action-layout-toolbar', 'action-layout-context-menu'):
                layout = list(gprefs[key])
                if self.name not in layout:
                    gprefs[key] = tuple(layout + [self.name])
            prefs['toolbar_registered'] = True
        except Exception:
            # Never let a cosmetic placement problem stop the plugin loading;
            # it can still be added by hand in Preferences → Toolbars & menus.
            pass

    def show_dialog(self):
        book_ids = self._selected_book_ids()
        if not book_ids:
            return error_dialog(
                self.gui, 'No books selected',
                'Select one or more books in the library, then run this again.',
                show=True)

        base = self.interface_action_base_plugin
        dialog = PushDialog(self.gui, self.qaction.icon(),
                            base.do_user_config, book_ids)
        dialog.exec()

    def _selected_book_ids(self):
        rows = self.gui.library_view.selectionModel().selectedRows()
        if not rows:
            return []
        model = self.gui.library_view.model()
        return [model.id(row) for row in rows]

    def apply_settings(self):
        # Settings are read at push time, so nothing to hot-apply here.
        pass
