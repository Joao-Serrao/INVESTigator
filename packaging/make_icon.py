"""Generate the Investraton app icon (1024x1024 PNG) from the brand mark.

Dark rounded tile + a two-tone (blue -> teal) twin-peak mark echoing the in-app
"◢◣" logo. Run `tauri icon packaging/icon.png` to produce all platform sizes.
"""

from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded dark tile with a subtle vertical gradient.
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
tg = ImageDraw.Draw(tile)
for y in range(S):
    t = y / S
    r = int(0x12 + (0x1b - 0x12) * t)
    g = int(0x17 + (0x22 - 0x17) * t)
    b = int(0x1f + (0x2d - 0x1f) * t)
    tg.line([(0, y), (S, y)], fill=(r, g, b, 255))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(tile, (0, 0), mask)

# Twin peaks: a big blue peak and an overlapping smaller teal peak.
BLUE = (79, 140, 255, 255)
TEAL = (45, 212, 167, 255)
base = int(S * 0.70)        # baseline y
big = [(int(S * 0.20), base), (int(S * 0.50), int(S * 0.30)), (int(S * 0.80), base)]
small = [(int(S * 0.46), base), (int(S * 0.66), int(S * 0.42)), (int(S * 0.86), base)]
d.polygon(big, fill=BLUE)
d.polygon(small, fill=TEAL)

# A thin "snow line" highlight on the big peak for a bit of polish.
d.line([(int(S * 0.50), int(S * 0.30)), (int(S * 0.50) + 4, int(S * 0.30))], fill=(255, 255, 255, 0))

out = __file__.rsplit("\\", 1)[0] + "\\icon.png"
img.save(out)
print("wrote", out)
