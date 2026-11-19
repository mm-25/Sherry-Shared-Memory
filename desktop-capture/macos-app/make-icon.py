#!/usr/bin/env python3
"""Create the Sherry macOS icon from the same mark used in the app UI."""
import subprocess
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

destination = Path(sys.argv[1]); destination.mkdir(parents=True, exist_ok=True)
iconset = destination / "Sherry.iconset"; iconset.mkdir(exist_ok=True)
size = 1024
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((70, 70, 954, 954), radius=235, fill=(88, 71, 175, 255))
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 610)
bounds = draw.textbbox((0, 0), "S", font=font)
draw.text(((size - (bounds[2] - bounds[0])) / 2 - bounds[0],
           (size - (bounds[3] - bounds[1])) / 2 - bounds[1] - 23), "S", font=font,
          fill=(255, 255, 255, 255))
for points in (16, 32, 128, 256, 512):
    image.resize((points, points), Image.Resampling.LANCZOS).save(iconset / f"icon_{points}x{points}.png")
    image.resize((points * 2, points * 2), Image.Resampling.LANCZOS).save(iconset / f"icon_{points}x{points}@2x.png")
subprocess.run(["iconutil", "-c", "icns", "-o", str(destination / "AppIcon.icns"), str(iconset)], check=True)
