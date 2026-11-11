"""Push book metadata from Calibre into the oldforest.net reading log."""

from calibre.customize import InterfaceActionBase

# Single source of truth for the version: the class attribute below, the update
# check in updates.py, and scripts/publish-plugin.sh all read this one value.
#
# ⚠ Bump this on every publish. The update check compares published version
# against installed version, so shipping two different builds under the same
# number leaves an out-of-date install with no way to know it is stale.
PLUGIN_VERSION = (1, 1, 0)


class OldforestBooksPlugin(InterfaceActionBase):

    name = 'Push to oldforest.net'
    description = ('Push selected books\' metadata into the oldforest.net '
                   'reading-log database')
    supported_platforms = ['windows', 'osx', 'linux']
    author = 'Mike Greene'
    version = PLUGIN_VERSION
    # qt.core, the modern Qt6 binding used throughout, needs a recent calibre.
    minimum_calibre_version = (6, 0, 0)

    actual_plugin = 'calibre_plugins.oldforest_books.ui:OldforestBooksAction'

    def is_customizable(self):
        return True

    def config_widget(self):
        from calibre_plugins.oldforest_books.config import ConfigWidget
        return ConfigWidget()

    def save_settings(self, config_widget):
        config_widget.save_settings()
