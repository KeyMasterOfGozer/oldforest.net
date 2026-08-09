"""Push book metadata from Calibre into the oldforest.net reading log."""

from calibre.customize import InterfaceActionBase


class OldforestBooksPlugin(InterfaceActionBase):

    name = 'Push to oldforest.net'
    description = ('Push selected books\' metadata into the oldforest.net '
                   'reading-log database')
    supported_platforms = ['windows', 'osx', 'linux']
    author = 'Mike Greene'
    version = (1, 0, 0)
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
