"""Draw the elhellal app icon: a pearl crescent over a desert sunset.

Usage: python3 scripts/pwa-assets/icons.py <out dir> (needs Pillow). See splash.mjs.
"""
import sys, math, random
from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 2048  # master size

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient(stops, size=S):
    img = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        for i in range(len(stops) - 1):
            (t0, c0), (t1, c1) = stops[i], stops[i + 1]
            if t0 <= t <= t1:
                img.putpixel((0, y), lerp(c0, c1, (t - t0) / (t1 - t0)))
                break
    return img.resize((size, size))

def scene(scale=1.0, cx_off=0.0):
    """Full-bleed artwork. scale shrinks the moon/sun toward the centre (maskable safe zone)."""
    sky = gradient([
        (0.00, (24, 18, 58)),    # night indigo
        (0.30, (78, 36, 96)),    # violet
        (0.55, (196, 72, 92)),   # rose
        (0.70, (247, 140, 68)),  # orange
        (0.76, (255, 196, 110)), # horizon glow
        (1.00, (255, 196, 110)),
    ]).convert("RGBA")
    horizon = int(S * 0.76)

    # stars
    d = ImageDraw.Draw(sky)
    rnd = random.Random(7)
    for _ in range(46):
        x, y = rnd.randint(0, S), rnd.randint(0, int(S * 0.38))
        r = rnd.choice([3, 4, 5, 6])
        a = rnd.randint(110, 230)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 245, 230, a))

    # sun inside the crescent's hollow
    R0 = S * 0.30 * scale
    mcx0, mcy0 = S * (0.5 + cx_off), S * 0.46
    sx, sy = int(mcx0 + R0 * 0.40), int(mcy0 + R0 * 0.06)
    glow = Image.new("RGBA", (S, S), (255, 190, 110, 0))
    gd = ImageDraw.Draw(glow)
    for r, a in [(int(S * 0.42 * scale), 50), (int(S * 0.30 * scale), 80), (int(S * 0.20 * scale), 120)]:
        gd.ellipse((sx - r, sy - r, sx + r, sy + r), fill=(255, 190, 110, a))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.05))
    sky = Image.alpha_composite(sky, glow)
    sun = Image.new("RGBA", (S, S), (255, 244, 214, 0))
    r = int(S * 0.075 * scale)
    ImageDraw.Draw(sun).ellipse((sx - r, sy - r, sx + r, sy + r), fill=(255, 244, 214, 255))
    sky = Image.alpha_composite(sky, sun.filter(ImageFilter.GaussianBlur(S * 0.004)))

    # desert: far mesas, then the near dune
    land = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(land)
    far = (150, 62, 70, 255)
    ld.polygon([(0, horizon + 10), (S * 0.08, horizon - S * 0.035), (S * 0.12, horizon - S * 0.075), (S * 0.22, horizon - S * 0.075),
                (S * 0.25, horizon - S * 0.03), (S * 0.34, horizon + 10)], fill=far)
    ld.polygon([(S * 0.66, horizon + 10), (S * 0.72, horizon - S * 0.05), (S * 0.76, horizon - S * 0.095), (S * 0.88, horizon - S * 0.095),
                (S * 0.91, horizon - S * 0.045), (S, horizon - S * 0.02), (S, horizon + 10)], fill=far)
    # dune band
    pts = [(0, S)]
    for i in range(0, 101):
        x = S * i / 100
        y = horizon + S * 0.02 + math.sin(i / 100 * math.pi * 1.2 + 0.6) * S * 0.025
        pts.append((x, y))
    pts.append((S, S))
    ld.polygon(pts, fill=(214, 120, 74, 255))
    pts2 = [(0, S)]
    for i in range(0, 101):
        x = S * i / 100
        y = horizon + S * 0.10 + math.sin(i / 100 * math.pi * 1.6 + 2.2) * S * 0.03
        pts2.append((x, y))
    pts2.append((S, S))
    ld.polygon(pts2, fill=(168, 82, 60, 255))
    sky = Image.alpha_composite(sky, land)

    # the crescent: outer disc minus an offset disc, pearl gradient
    mcx, mcy = S * (0.5 + cx_off), S * 0.46
    R = S * 0.30 * scale
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse((mcx - R, mcy - R, mcx + R, mcy + R), fill=255)
    ox, oy, r2 = mcx + R * 0.42, mcy - R * 0.22, R * 0.86
    md.ellipse((ox - r2, oy - r2, ox + r2, oy + r2), fill=0)
    mask = mask.filter(ImageFilter.GaussianBlur(1.5))

    pearl = Image.new("RGBA", (S, S))
    # diagonal light: bright top-left to warm peach bottom-right (sunlit)
    lin = gradient([(0, (255, 255, 255)), (0.45, (246, 240, 236)), (1, (255, 196, 150))]).rotate(35, resample=Image.BICUBIC, expand=False)
    pearl.paste(lin.convert("RGBA"))
    # soft shadow behind moon
    shadow = Image.new("RGBA", (S, S), (40, 10, 40, 0))
    shadow.putalpha(mask.filter(ImageFilter.GaussianBlur(S * 0.02)).point(lambda v: int(v * 0.45)))
    shadow = ImageChops.offset(shadow, int(S * 0.012), int(S * 0.02))
    sky = Image.alpha_composite(sky, shadow)
    # halo
    halo = Image.new("RGBA", (S, S), (255, 230, 210, 0))
    halo.putalpha(mask.filter(ImageFilter.GaussianBlur(S * 0.035)).point(lambda v: int(v * 0.55)))
    sky = Image.alpha_composite(sky, halo)
    pearl.putalpha(mask)
    sky = Image.alpha_composite(sky, pearl)
    # inner rim shading on the inner edge
    rim = Image.new("L", (S, S), 0)
    rd = ImageDraw.Draw(rim)
    r3 = r2 * 1.06
    rd.ellipse((ox - r3, oy - r3, ox + r3, oy + r3), fill=255)
    rim = ImageChops.multiply(rim, mask).filter(ImageFilter.GaussianBlur(S * 0.012))
    rim = ImageChops.multiply(rim, mask)
    shade = Image.new("RGBA", (S, S), (210, 140, 130, 0))
    shade.putalpha(rim.point(lambda v: int(v * 0.35)))
    sky = Image.alpha_composite(sky, shade)
    return sky.convert("RGB")

def rounded(img, radius_frac):
    m = Image.new("L", img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), int(img.size[0] * radius_frac), fill=255)
    out = img.convert("RGBA"); out.putalpha(m); return out

out = sys.argv[1]
full = scene(cx_off=-0.05)
safe = scene(scale=0.76, cx_off=-0.04)
full.save(f"{out}/master.png")
# "any" icons: rounded square, so they look like an app icon everywhere (desktop, banner)
for n in (192, 512):
    rounded(full, 0.225).resize((n, n), Image.LANCZOS).save(f"{out}/icon-{n}.png", optimize=True)
# maskable + apple: full bleed, the OS applies its own shape
safe.resize((512, 512), Image.LANCZOS).save(f"{out}/icon-512-maskable.png", optimize=True)
safe.resize((192, 192), Image.LANCZOS).save(f"{out}/icon-192-maskable.png", optimize=True)
full.resize((180, 180), Image.LANCZOS).save(f"{out}/apple-touch-icon.png", optimize=True)
rounded(full, 0.225).resize((64, 64), Image.LANCZOS).save(f"{out}/favicon-64.png", optimize=True)
