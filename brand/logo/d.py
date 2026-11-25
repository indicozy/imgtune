"""Concept D (folded photo) final set: mark, favicon, wordmark lockups, light + dark.
Run: python3 d.py  -> out/*.svg + out/*.png"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from gen import cut, blob, DEFS, CREAM, PAPER, CLAY, INK
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = pathlib.Path(__file__).parent; OUT = HERE/"out"; OUT.mkdir(exist_ok=True)
DARK_BG, FOLD = "#1C1B19", "#CFC6B2"

def mark(ink=INK, paper=PAPER, fx=True, bold=False):
    card = cut([(36,40),(140,40),(164,64),(164,160),(36,160)], j=1.0, seed=51)
    cid = f"card{abs(hash((ink,fx,bold)))%9999}"
    sh = ' filter="url(#lift)"' if fx else ""
    P = lambda d, f, s=False: f'<path d="{d}" fill="{f}"{sh if s else ""}/>'
    m  = f'<clipPath id="{cid}"><path d="{card}"/></clipPath>' + P(card, paper, True)
    m += P(cut([(140,40),(164,64),(140,64)], j=0.5, step=8, seed=52), FOLD)
    m += P(blob(78,80,14,0.04,seed=53), CLAY)
    t = 3 if bold else 0
    m += f'<g clip-path="url(#{cid})">' + P(cut([(30,166),(30,128),(76,104),(112,124),(170,94),(170,166)], j=1.2, seed=54), ink)
    m += P(cut([(52,142-t),(148,142-t),(148,146+t),(52,146+t)], j=0.4, step=8, seed=55), paper)
    m += P(blob(118,144,7+t*1.5,0.05,seed=56), CLAY) + '</g>' 
    return f'<g filter="url(#paper)">{m}</g>' if fx else m

def wordmark(text="imgtune", wght=520):
    f = TTFont(HERE.parent/"fonts/Fraunces.ttf")
    f = instantiateVariableFont(f, {"wght": wght, "opsz": 72, "SOFT": 100, "WONK": 0})
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f["hmtx"]
    upm = f["head"].unitsPerEm; x = 0; d = ""
    for ch in text:
        g = cmap[ord(ch)]; pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
        gs[g].draw(TransformPen(pen, (1,0,0,-1,x,0))); d += pen.getCommands()
        x += hmtx[g][0] - upm*0.01   # slight negative tracking
    return d, x, upm

def write(name, w, h, body, bg=None, scale=4):
    b = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    (OUT/f"{name}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w*scale}" height="{h*scale}">{DEFS}{b}{body}</svg>')

# mark (cropped to the card, transparent bg)
crop = '<g transform="translate(-28,-32)">{}</g>'
write("mark", 144, 136, crop.format(mark()))
write("mark-dark", 144, 136, crop.format(mark(ink="#2A2724")))  # card stays paper; hills a touch lifted

# favicon: no filters, a little bolder, square
write("favicon", 144, 144, '<g transform="translate(-28,-28)">'+mark(fx=False, bold=True)+'</g>', scale=1)

# lockups
wd, ww, upm = wordmark()
fs = 88/upm  # cap-ish height to match the 136-tall mark
def lockup(name, ink, bg, markink):
    W = 144 + 28 + ww*fs + 8
    body = crop.format(mark(ink=markink)) + f'<path d="{wd}" fill="{ink}" transform="translate(170,98) scale({fs})"/>'
    write(name, round(W), 136, body, bg)
lockup("lockup", INK, None, INK)
lockup("lockup-dark", "#EDE8DD", None, "#2A2724")
print("ok")
