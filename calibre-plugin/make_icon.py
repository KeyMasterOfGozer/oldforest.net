"""Regenerate the plugin's toolbar icon from the site favicon.

Run whenever site/favicon.svg changes:

    /Applications/calibre.app/Contents/MacOS/calibre-debug calibre-plugin/make_icon.py

Kept out of the built zip — it is a development tool, not a runtime dependency.
Rendered through calibre's own Qt so it needs nothing else installed.
"""

import os
import sys

from qt.core import (QApplication, QByteArray, QImage, QPainter, QSvgRenderer, Qt)

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, os.pardir, 'site', 'favicon.svg')
OUT = os.path.join(HERE, 'images', 'icon.png')

# Rendered large and left for Qt to scale down: calibre draws this at anywhere
# from ~16px in a menu to ~32px on a HiDPI toolbar.
SIZE = 256


def main():
    app = QApplication.instance() or QApplication(sys.argv[:1])  # noqa: F841

    with open(SVG, 'rb') as handle:
        svg = handle.read()

    renderer = QSvgRenderer(QByteArray(svg))
    if not renderer.isValid():
        raise SystemExit('could not parse %s' % SVG)

    image = QImage(SIZE, SIZE, QImage.Format.Format_ARGB32)
    image.fill(Qt.GlobalColor.transparent)
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    renderer.render(painter)
    painter.end()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if not image.save(OUT):
        raise SystemExit('could not write %s' % OUT)
    print('wrote %s (%dx%d)' % (OUT, SIZE, SIZE))


if __name__ == '__main__':
    main()
