"""Hand-cut paper logo concepts for imgtune. Run: python3 gen.py -> concept-*.svg"""
import math, random, pathlib
OUT = pathlib.Path(__file__).parent
CREAM, PAPER, CLAY, INK, SAGE = "#F1EDE4", "#E6DFD0", "#C9643F", "#1F1D1A", "#7E8F6E"

def smooth(pts):
    # closed Catmull-Rom -> cubic bezier path
    n = len(pts); d = f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"
    for i in range(n):
        p0, p1, p2, p3 = pts[i-1], pts[i], pts[(i+1)%n], pts[(i+2)%n]
        c1 = (p1[0]+(p2[0]-p0[0])/6, p1[1]+(p2[1]-p0[1])/6)
        c2 = (p2[0]-(p3[0]-p1[0])/6, p2[1]-(p3[1]-p1[1])/6)
        d += f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}"
    return d + "Z"

def blob(cx, cy, r, j=0.03, n=28, seed=1, sx=1, sy=1):
    j=j*0.4; n=min(n,18) if r<30 else n
    rnd = random.Random(seed)
    return smooth([(cx+math.cos(a)*r*sx*(1+rnd.uniform(-j,j)), cy+math.sin(a)*r*sy*(1+rnd.uniform(-j,j)))
                   for a in (2*math.pi*i/n for i in range(n))])

def cut(poly, j=1.2, step=14, seed=2):
    j=j*0.45; step=max(step,22)
    # densify a polygon and jitter it -> scissor-cut edge (straight-ish, with small wobble)
    rnd = random.Random(seed); pts = []
    for i in range(len(poly)):
        (x1,y1),(x2,y2) = poly[i], poly[(i+1)%len(poly)]
        L = math.hypot(x2-x1,y2-y1); k = max(1,int(L/step))
        for t in range(k):
            f = t/k; pts.append((x1+(x2-x1)*f+rnd.uniform(-j,j), y1+(y2-y1)*f+rnd.uniform(-j,j)))
    return smooth(pts)

def roundrect(x,y,w,h,r,seg=6):
    pts=[]
    for cx,cy,a0 in ((x+w-r,y+r,-90),(x+w-r,y+h-r,0),(x+r,y+h-r,90),(x+r,y+r,180)):
        for s in range(seg+1):
            a=math.radians(a0+90*s/seg); pts.append((cx+r*math.cos(a),cy+r*math.sin(a)))
    return pts

DEFS = """<defs>
 <filter id="paper" x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="4" result="n"/>
  <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.10 0" result="g"/>
  <feComposite in="g" in2="SourceGraphic" operator="in" result="gi"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="gi"/></feMerge>
 </filter>
 <filter id="lift" x="-10%" y="-10%" width="130%" height="130%">
  <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" flood-color="#3a2a1a" flood-opacity="0.22"/>
 </filter>
</defs>"""

def svg(body, bg=True, w=200, h=200):
    b = f'<rect width="{w}" height="{h}" fill="{CREAM}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w*4}" height="{h*4}">{DEFS}{b}<g filter="url(#paper)">{body}</g></svg>'

def P(d, fill, shadow=True):
    return f'<path d="{d}" fill="{fill}"{" filter=\"url(#lift)\"" if shadow else ""}/>'

concepts = {}

# A: sun-knob. Paper tile, mountains, sun = slider knob riding on a track.
A = P(cut(roundrect(30,30,140,140,30), j=1.0, seed=11), PAPER, False)
A += P(cut([(38,150),(78,92),(102,122),(126,84),(162,150)], j=1.3, seed=12), INK)
A += P(cut([(48,66),(152,66),(152,71),(48,71)], j=0.6, step=10, seed=13), INK, False)  # track
A += P(blob(122,68,16,0.035,seed=14), CLAY)
concepts["A-sun-knob"] = A

# B: three strips (tribal sliders). Knob positions climb -> reads as a rising histogram / mountain.
B = ""
for i,(y,kx,col) in enumerate([(62,134,CLAY),(100,98,INK),(138,62,SAGE)]):
    B += P(cut([(34,y-5),(166,y-5),(166,y+5),(34,y+5)], j=1.1, step=12, seed=20+i), INK if col!=INK else INK, False)
    B += P(blob(kx,y,15,0.05,seed=30+i), col)
concepts["B-three-strips"] = B

# C: dial stamp. Big clay disc, mountain cut out of it, a tick notch like a tuning knob.
C = P(blob(100,100,72,0.018,n=36,seed=41), CLAY)
C += P(cut([(48,138),(84,88),(104,112),(126,78),(158,138)], j=1.2, seed=42), CREAM, False)
C += P(blob(136,62,9,0.05,seed=43), CREAM, False)
C += P(cut([(96,34),(104,34),(104,52),(96,52)], j=0.6, step=6, seed=44), INK, False)
concepts["C-dial-stamp"] = C

# D: folded photo. Paper card with a dog-ear, clay sun, ink hill; a slider cut along the bottom.
D = P(cut([(36,40),(140,40),(164,64),(164,160),(36,160)], j=1.0, seed=51), PAPER)
D += P(cut([(140,40),(164,64),(140,64)], j=0.5, step=8, seed=52), "#CFC6B2", False)
D += P(blob(78,80,14,0.04,seed=53), CLAY, False)
D += P(cut([(36,160),(36,128),(76,104),(112,124),(164,96),(164,160)], j=1.2, seed=54), INK, False)
D += P(cut([(52,142),(148,142),(148,146),(52,146)], j=0.4, step=8, seed=55), CREAM, False)
D += P(blob(118,144,7,0.05,seed=56), CLAY, False)
concepts["D-folded-photo"] = D

for name, body in concepts.items():
    (OUT/f"concept-{name}.svg").write_text(svg(body))
print("ok", list(concepts))
