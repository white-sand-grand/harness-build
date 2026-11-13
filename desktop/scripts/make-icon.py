"""Optional development asset generator; the generated PNG/ICO are committed."""
from pathlib import Path
from math import hypot
from PIL import Image, ImageDraw, ImageFilter

assets = Path(__file__).resolve().parent.parent / 'assets'
assets.mkdir(exist_ok=True)
size = 512
image = Image.new('RGBA', (size, size))
pixels = image.load()
for y in range(size):
    for x in range(size):
        edge = hypot(x - 256, y - 256)
        if edge > 233:
            continue
        t = min(1, hypot(x - 175, y - 155) / 420)
        colors = ((242, 234, 215), (184, 164, 122))
        rgb = tuple(round(colors[0][i] * (1 - t) + colors[1][i] * t) for i in range(3))
        pixels[x, y] = (*rgb, round(min(1, 233 - edge) * 255))
craters = Image.new('RGBA', image.size)
draw = ImageDraw.Draw(craters)
for box in [(112, 151, 211, 238), (281, 271, 403, 391), (279, 107, 342, 170), (163, 339, 208, 384)]:
    draw.ellipse(box, fill=(110, 89, 47, 31))
image = Image.alpha_composite(image, craters.filter(ImageFilter.GaussianBlur(2)))
image.save(assets / 'moon.png')
image.save(assets / 'moon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
