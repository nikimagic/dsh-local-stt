"""Иконка dsh-local-stt: микрофон со звуковой волной в стиле MagicControl.

Палитра снята с MagicControl: фон #111324 → #0B0B15, градиент знака
#7C3AED → #3B82F6 → #22D3EE. Рисуется в 4× и уменьшается, поэтому края
гладкие без внешних библиотек, кроме Pillow.

Запуск: python scripts/make-icon.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SCALE = 4

BACKGROUND_TOP = (23, 27, 51)      # #171B33
BACKGROUND_BOTTOM = (11, 11, 21)   # #0B0B15
GRADIENT = [(124, 58, 237), (59, 130, 246), (34, 211, 238)]  # #7C3AED → #3B82F6 → #22D3EE
GLOW = (124, 58, 237)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(left, right, t: float):
    return tuple(int(round(lerp(left[index], right[index], t))) for index in range(3))


def gradient_color(t: float):
    """Цвет на диагонали: фиолетовый → синий → голубой."""
    # растягиваем фиолетовый край, чтобы магия читалась
    t = max(0.0, min(1.0, (t - 0.08) / 0.84))
    if t < 0.5:
        return mix(GRADIENT[0], GRADIENT[1], t / 0.5)
    return mix(GRADIENT[1], GRADIENT[2], (t - 0.5) / 0.5)


def diagonal_gradient(size: int) -> Image.Image:
    """Диагональный градиент, растянутый на область знака."""
    gradient = Image.new("RGB", (size, size))
    pixels = gradient.load()
    for y in range(size):
        for x in range(size):
            raw = (x + y) / (2 * (size - 1))
            # знак занимает центр: растягиваем градиент на его область
            pixels[x, y] = gradient_color((raw - 0.28) / 0.44)
    return gradient


def rounded_background(size: int) -> Image.Image:
    """Скруглённый квадрат с мягким вертикальным градиентом."""
    background = Image.new("RGB", (size, size))
    pixels = background.load()
    for y in range(size):
        color = mix(BACKGROUND_TOP, BACKGROUND_BOTTOM, y / (size - 1))
        for x in range(size):
            pixels[x, y] = color
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.226), fill=255)
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(background, (0, 0), mask)
    return result


def mic_mask(size: int) -> Image.Image:
    """Силуэт микрофона со стойкой."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    unit = size / 512

    def box(values):
        return tuple(int(round(value * unit)) for value in values)

    # капсула
    draw.rounded_rectangle(box((221, 116, 291, 282)), radius=int(35 * unit), fill=255)
    # дужка и ножка
    width = int(18 * unit)
    draw.arc(box((188, 160, 324, 296)), start=0, end=180, fill=255, width=width)
    draw.line(box((256, 296, 256, 338)), fill=255, width=width)
    draw.line(box((218, 338, 294, 338)), fill=255, width=width)
    return mask


def wave_layers(size: int):
    """Три затухающие звуковые дуги с каждой стороны микрофона."""
    unit = size / 512
    layers = []
    for index, (radius, width, opacity) in enumerate(((120, 14, 210), (148, 11, 140), (176, 8, 80))):
        mask = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(mask)
        for start, end in ((142, 218), (-38, 38)):
            draw.arc(
                (
                    int((256 - radius) * unit),
                    int((208 - radius) * unit),
                    int((256 + radius) * unit),
                    int((208 + radius) * unit),
                ),
                start=start,
                end=end,
                fill=255,
                width=int(width * unit),
            )
        layers.append((mask, opacity))
    return layers


def paint_gradient(size: int, mask: Image.Image, opacity: int = 255) -> Image.Image:
    """Залить маску диагональным градиентом."""
    layer = diagonal_gradient(size).convert("RGBA")
    alpha = mask.point(lambda value: value * opacity // 255)
    layer.putalpha(alpha)
    return layer


def glow(size: int) -> Image.Image:
    """Мягкое свечение за микрофоном."""
    mask = mic_mask(size)
    # чуть шире силуэта
    mask = mask.filter(ImageFilter.GaussianBlur(radius=int(30 * size / 512)))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(Image.new("RGB", (size, size), GLOW), (0, 0), mask)
    alpha = mask.point(lambda value: min(255, int(value * 1.15)))
    layer.putalpha(alpha)
    return layer


def glow_cyan(size: int) -> Image.Image:
    """Голубой ореол снизу-справа для объёма."""
    unit = size / 512
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse(
        (
            int(196 * unit),
            int(196 * unit),
            int(360 * unit),
            int(360 * unit),
        ),
        fill=255,
    )
    mask = mask.filter(ImageFilter.GaussianBlur(radius=int(64 * unit)))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(Image.new("RGB", (size, size), (34, 211, 238)), (0, 0), mask)
    layer.putalpha(mask.point(lambda value: int(value * 0.16)))
    return layer


def build(size: int) -> Image.Image:
    pixels = size * SCALE
    canvas = rounded_background(pixels)

    canvas = Image.alpha_composite(canvas, glow(pixels))
    canvas = Image.alpha_composite(canvas, glow_cyan(pixels))
    # звуковые волны: затухающий градиент
    for mask, opacity in wave_layers(pixels):
        canvas = Image.alpha_composite(canvas, paint_gradient(pixels, mask, opacity=opacity))
    # сам микрофон
    canvas = Image.alpha_composite(canvas, paint_gradient(pixels, mic_mask(pixels)))

    # светлая сердцевина капсулы для объёма
    core = Image.new("RGBA", (pixels, pixels), (255, 255, 255, 0))
    core_mask = Image.new("L", (pixels, pixels), 0)
    ImageDraw.Draw(core_mask).rounded_rectangle(
        (
            int(214 * pixels / 512),
            int(122 * pixels / 512),
            int(298 * pixels / 512),
            int(292 * pixels / 512),
        ),
        radius=int(42 * pixels / 512),
        fill=255,
    )
    inner = Image.new("L", (pixels, pixels), 0)
    ImageDraw.Draw(inner).rounded_rectangle(
        (
            int(230 * pixels / 512),
            int(138 * pixels / 512),
            int(282 * pixels / 512),
            int(276 * pixels / 512),
        ),
        radius=int(26 * pixels / 512),
        fill=255,
    )
    shade = Image.composite(inner, Image.new("L", (pixels, pixels), 0), core_mask)
    core.putalpha(shade.point(lambda value: int(value * 0.22)))
    canvas = Image.alpha_composite(canvas, core)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    outputs = {
        ROOT / "assets" / "icon-512.png": 512,
        ROOT / "assets" / "icon-180.png": 180,
        ROOT / "icon.png": 180,
        ROOT / "docs" / "icons" / "local-stt.png": 180,
    }
    cache: dict[int, Image.Image] = {}
    for path, size in outputs.items():
        image = cache.setdefault(size, build(size))
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, "PNG", optimize=True)
        print(f"{path.relative_to(ROOT)}  {size}×{size}  {path.stat().st_size} байт")


if __name__ == "__main__":
    main()
