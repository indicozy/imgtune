#!/usr/bin/env python3
"""Generates the synthetic font fixtures for the font analyzer tests (test/fixtures/fonts/).

The glyphs are plain boxes, so the files carry no third-party outlines. Run with fontTools installed:
    python3 scripts/make-font-fixtures.py
"""
import os
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "fixtures", "fonts")
os.makedirs(OUT, exist_ok=True)

# Latin (basic + Latin-1), Latin Extended-A, Cyrillic, Greek: about 470 code points.
CODEPOINTS = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + list(range(0x100, 0x180)) + list(range(0x400, 0x500)) + list(range(0x370, 0x3D0))


def box(w):
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0))
    pen.lineTo((50, 700))
    pen.lineTo((w - 50, 700))
    pen.lineTo((w - 50, 0))
    pen.closePath()
    return pen.glyph()


def build(path, family, style, weight_class, width, axes=None, codepoints=CODEPOINTS, flavor=None):
    names = ([".notdef"] + [f"g{cp:04X}" for cp in codepoints])
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({cp: f"g{cp:04X}" for cp in codepoints})
    glyphs = {n: box(width) for n in names}
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({n: (width, 50) for n in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": family, "styleName": style})
    fb.setupOS2(usWeightClass=weight_class, sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    if axes:
        fb.setupFvar(axes, [])
    fb.save(path)
    if flavor:
        font = TTFont(path)
        font.flavor = flavor
        font.save(path.rsplit(".", 1)[0] + "." + flavor)


build(os.path.join(OUT, "synthetic-sans-regular.ttf"), "Synthetic Sans", "Regular", 400, 500)
build(os.path.join(OUT, "synthetic-sans-light.ttf"), "Synthetic Sans", "Light", 300, 480)
build(os.path.join(OUT, "synthetic-sans-variable.ttf"), "Synthetic Sans Variable", "Regular", 400, 500,
      axes=[("wght", 100, 400, 900, "Weight")])
build(os.path.join(OUT, "synthetic-sans-bold.ttf"), "Synthetic Sans", "Bold", 700, 520)
# Private-use code points only: an icon font.
build(os.path.join(OUT, "synthetic-icons.ttf"), "Synthetic Icons", "Regular", 400, 500,
      codepoints=list(range(0xE000, 0xE040)))
# A script slice (Latin Extended-A only), as a site splits a family by unicode-range.
build(os.path.join(OUT, "synthetic-slice-latin-ext.ttf"), "Synthetic Slice", "Regular", 400, 500,
      codepoints=list(range(0x100, 0x180)))
build(os.path.join(OUT, "synthetic-sans-regular.ttf"), "Synthetic Sans", "Regular", 400, 500, flavor="woff")
build(os.path.join(OUT, "synthetic-sans-regular.ttf"), "Synthetic Sans", "Regular", 400, 500, flavor="woff2")
print("wrote", sorted(os.listdir(OUT)))
