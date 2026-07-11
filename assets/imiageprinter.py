#!/usr/bin/env python3
"""
Print JPG/PNG images from a USB pendrive folder named ``imiages`` on the
thermal printer (ESC/POS raster).

On a typical Raspberry Pi kiosk, run with no arguments after inserting the
pendrive::

  python3 imiageprinter.py

Legacy: decode space-separated binary text to PNG (optional)::

  python3 imiageprinter.py --from-binary --convert-only
  python3 imiageprinter.py --from-binary --print
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None  # type: ignore
    ImageDraw = None  # type: ignore
    ImageFont = None  # type: ignore

try:
    import serial
except ImportError:
    serial = None  # type: ignore

ASSETS_DIR = Path(__file__).resolve().parent
DEFAULT_BINARY = ASSETS_DIR / "imiage print binary"
DEFAULT_PNG_OUT = ASSETS_DIR / "decoded_from_binary.png"
DEFAULT_THERMAL_PORT = "/dev/ttyAMA3"
DEFAULT_THERMAL_BAUD = 9600
DEFAULT_PRINT_WIDTH = 384
DEFAULT_CODE_FILE = Path(__file__).resolve()
CODE_BG_OPACITY = 72

USB_FOLDER_NAMES = ("imiages", "Imiages", "IMIAGES", "images", "Images")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
MOUNT_SEARCH_ROOTS = (
    Path("/media"),
    Path("/run/media"),
    Path("/mnt"),
)


def _load_mono_font(size: int):
    if ImageFont is None:
        return None
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
    ]
    for path in candidates:
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_source_code_background(
    code_path: Path,
    width: int,
    height: int,
    *,
    font_size: int = 9,
    text_opacity: int = CODE_BG_OPACITY,
) -> "Image.Image":
    if Image is None or ImageDraw is None:
        raise RuntimeError("Pillow (PIL) is required for code background rendering")

    source = code_path.read_text(encoding="utf-8", errors="replace")
    lines = source.splitlines() or [""]
    font = _load_mono_font(font_size)
    line_h = max(10, font_size + 3)
    pad = 6
    usable_w = max(40, width - pad * 2)

    def wrap_line(line: str) -> list[str]:
        if not line:
            return [""]
        out: list[str] = []
        cut = max(1, int(usable_w // max(font_size * 0.55, 1)))
        while len(line) > cut:
            out.append(line[:cut])
            line = line[cut:]
        out.append(line)
        return out

    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(wrap_line(line))

    canvas_h = max(height, pad * 2 + len(wrapped) * line_h)
    canvas = Image.new("RGBA", (width, canvas_h), (255, 255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    y = pad
    for line in wrapped:
        draw.text((pad, y), line, fill=(0, 0, 0, text_opacity), font=font)
        y += line_h
        if y > canvas_h - line_h:
            break

    if canvas_h != height:
        canvas = canvas.resize((width, height), Image.LANCZOS)
    return canvas


def composite_foreground_on_code_background(
    foreground: "Image.Image",
    code_path: Path,
    width_pixels: int,
    *,
    text_opacity: int = CODE_BG_OPACITY,
) -> "Image.Image":
    if Image is None:
        raise RuntimeError("Pillow (PIL) is required")

    fg = foreground.convert("RGBA")
    w, h = fg.size
    if w != width_pixels:
        new_h = max(1, int(h * (width_pixels / w)))
        fg = fg.resize((width_pixels, new_h), Image.LANCZOS)
        w, h = fg.size

    bg = render_source_code_background(code_path, w, h, text_opacity=text_opacity)
    base = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    base = Image.alpha_composite(base, bg)
    base = Image.alpha_composite(base, fg)
    return base.convert("RGB")


def decode_binary_text_to_bytes(path: Path) -> bytes:
    text = path.read_text(encoding="utf-8", errors="replace")
    tokens = text.split()
    if not tokens:
        raise ValueError(f"No binary tokens found in {path}")

    out = bytearray()
    for i, token in enumerate(tokens):
        if len(token) != 8 or set(token) - {"0", "1"}:
            raise ValueError(
                f"Invalid token at index {i}: expected 8 binary digits, got {token[:20]!r}"
            )
        out.append(int(token, 2))

    if len(out) >= 8 and bytes(out[:8]) != b"\x89PNG\r\n\x1a\n":
        print(
            "Warning: decoded data does not start with PNG signature; saving anyway.",
            file=sys.stderr,
        )
    return bytes(out)


def save_png_from_binary_file(binary_path: Path, png_path: Path) -> tuple[Path, bytes]:
    data = decode_binary_text_to_bytes(binary_path)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    png_path.write_bytes(data)
    return png_path, data


def load_image_for_print(image_path: Path):
    if Image is None:
        raise RuntimeError("Pillow (PIL) is required. Install: pip install Pillow")
    img = Image.open(image_path)
    img.load()
    return img


def pil_to_escpos_raster_bytes(img, width_pixels: int) -> bytes:
    if Image is None:
        raise RuntimeError("Pillow (PIL) is required for raster printing")

    img = img.convert("L")
    w, h = img.size
    if w != width_pixels:
        new_h = max(1, int(h * (width_pixels / w)))
        img = img.resize((width_pixels, new_h), Image.LANCZOS)
        w, h = img.size

    bw = img.point(lambda p: 0 if p > 127 else 1, "1")
    m = 0
    xL = (w // 8) & 0xFF
    xH = ((w // 8) >> 8) & 0xFF
    yL = h & 0xFF
    yH = (h >> 8) & 0xFF
    header = bytes([0x1D, 0x76, 0x30, m, xL, xH, yL, yH])
    row_bytes = w // 8
    raw = bw.tobytes()
    out = bytearray(header)
    for row in range(h):
        start = row * row_bytes
        out.extend(raw[start : start + row_bytes])
    return bytes(out)


def _send_raster_on_serial(ser, raster: bytes, baud: int) -> None:
    chunk_size = 512 if baud <= 9600 else 1024
    pause = 0.08 if baud <= 9600 else 0.05
    for i in range(0, len(raster), chunk_size):
        ser.write(raster[i : i + chunk_size])
        ser.flush()
        if i + chunk_size < len(raster):
            time.sleep(pause)


def send_escpos_raster_to_printer(
    port: str,
    baud: int,
    raster: bytes,
) -> None:
    if serial is None:
        raise RuntimeError("pyserial is required. Install: pip install pyserial")
    if not Path(port).exists() and not str(port).upper().startswith("COM"):
        raise FileNotFoundError(f"Printer port not found: {port}")

    with serial.Serial(port=port, baudrate=baud, timeout=2, write_timeout=2) as ser:
        ser.write(b"\x1b\x40")
        ser.flush()
        time.sleep(0.05)
        _send_raster_on_serial(ser, raster, baud)
        ser.write(b"\n" * 4)
        ser.write(b"\x1d\x56\x00")
        ser.flush()
        time.sleep(0.1)


def prepare_image_for_print(
    image_path: Path,
    width_pixels: int,
    *,
    code_background_path: Path | None = None,
) -> "Image.Image":
    img = load_image_for_print(image_path)
    if code_background_path is not None and code_background_path.is_file():
        return composite_foreground_on_code_background(
            img, code_background_path, width_pixels
        )
    img_l = img.convert("L")
    w, h = img_l.size
    if w != width_pixels:
        new_h = max(1, int(h * (width_pixels / w)))
        img_l = img_l.resize((width_pixels, new_h), Image.LANCZOS)
    return img_l.convert("RGB")


def print_image_file_on_thermal(
    image_path: Path,
    port: str = DEFAULT_THERMAL_PORT,
    baud: int = DEFAULT_THERMAL_BAUD,
    width_pixels: int = DEFAULT_PRINT_WIDTH,
    *,
    code_background_path: Path | None = None,
    save_composite_path: Path | None = None,
) -> None:
    img = prepare_image_for_print(
        image_path, width_pixels, code_background_path=code_background_path
    )
    if save_composite_path is not None:
        save_composite_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(save_composite_path)
        print(f"Saved composite preview: {save_composite_path}", file=sys.stderr)
    print(
        f"Printing {image_path.name}: {img.size[0]}x{img.size[1]} "
        f"@ {width_pixels}px on {port}",
        file=sys.stderr,
    )
    raster = pil_to_escpos_raster_bytes(img, width_pixels)
    send_escpos_raster_to_printer(port, baud, raster)


def print_all_images_on_thermal(
    image_paths: list[Path],
    port: str = DEFAULT_THERMAL_PORT,
    baud: int = DEFAULT_THERMAL_BAUD,
    width_pixels: int = DEFAULT_PRINT_WIDTH,
    *,
    code_background_path: Path | None = None,
    gap_lines: int = 3,
) -> int:
    """Print many images in one serial session. Returns count printed."""
    if serial is None:
        raise RuntimeError("pyserial is required. Install: pip install pyserial")
    if not image_paths:
        return 0
    if not Path(port).exists() and not str(port).upper().startswith("COM"):
        raise FileNotFoundError(f"Printer port not found: {port}")

    printed = 0
    with serial.Serial(port=port, baudrate=baud, timeout=2, write_timeout=2) as ser:
        ser.write(b"\x1b\x40")
        ser.flush()
        time.sleep(0.05)

        for image_path in image_paths:
            img = prepare_image_for_print(
                image_path, width_pixels, code_background_path=code_background_path
            )
            print(
                f"[{printed + 1}/{len(image_paths)}] {image_path.name} "
                f"({img.size[0]}x{img.size[1]})",
                file=sys.stderr,
            )
            raster = pil_to_escpos_raster_bytes(img, width_pixels)
            _send_raster_on_serial(ser, raster, baud)
            ser.write(b"\n" * gap_lines)
            ser.flush()
            time.sleep(0.15)
            printed += 1

        ser.write(b"\n" * 4)
        ser.write(b"\x1d\x56\x00")
        ser.flush()
        time.sleep(0.1)

    return printed


def _is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES


def list_images_in_folder(folder: Path, *, recursive: bool = False) -> list[Path]:
    if not folder.is_dir():
        return []
    if recursive:
        files = [p for p in folder.rglob("*") if _is_image_file(p)]
    else:
        files = [p for p in folder.iterdir() if _is_image_file(p)]
    return sorted(files, key=lambda p: p.name.lower())


def _iter_volume_dirs() -> list[Path]:
    """Yield likely USB mount directories (one or two levels under /media)."""
    seen: set[str] = set()
    out: list[Path] = []

    def add(path: Path) -> None:
        key = str(path.resolve()) if path.exists() else str(path)
        if key not in seen and path.is_dir():
            seen.add(key)
            out.append(path)

    for root in MOUNT_SEARCH_ROOTS:
        if not root.is_dir():
            continue
        try:
            for level1 in root.iterdir():
                if not level1.is_dir():
                    continue
                add(level1)
                try:
                    for level2 in level1.iterdir():
                        if level2.is_dir():
                            add(level2)
                except OSError:
                    pass
        except OSError:
            pass
    return out


def _find_imiages_under_mount(mount: Path) -> Path | None:
    for name in USB_FOLDER_NAMES:
        candidate = mount / name
        if candidate.is_dir():
            return candidate
    return None


def _search_imiages_on_mounted_volumes() -> Path | None:
    for mount in _iter_volume_dirs():
        try:
            found = _find_imiages_under_mount(mount)
            if found is not None:
                return found
        except OSError:
            continue
    return None


def _run_cmd(cmd: list[str], timeout: float = 25.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        text = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode, text
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 1, str(e)


def _lsblk_removable_unmounted() -> list[str]:
    rc, out = _run_cmd(
        ["lsblk", "-J", "-o", "NAME,PATH,MOUNTPOINT,RM,TYPE,FSTYPE"]
    )
    if rc != 0 or not out.strip():
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []

    devices: list[str] = []
    for dev in data.get("blockdevices") or []:
        if not dev.get("rm"):
            continue
        children = dev.get("children") or []
        if not children and dev.get("type") == "part":
            children = [dev]
        for part in children:
            if part.get("type") != "part":
                continue
            if part.get("mountpoint"):
                continue
            fstype = (part.get("fstype") or "").lower()
            if fstype in ("", "swap"):
                continue
            path = part.get("path") or ""
            if path.startswith("/dev/"):
                devices.append(path)
    return devices


def _udisksctl_mount(device_path: str) -> str | None:
    rc, text = _run_cmd(["udisksctl", "mount", "-b", device_path], timeout=30.0)
    combined = text.strip()
    m = re.search(r"at\s+(.+?)\s*\.?\s*$", combined, re.MULTILINE)
    if m:
        return m.group(1).strip()
    if rc == 0 or "already mounted" in combined.lower():
        rc2, out2 = _run_cmd(
            ["lsblk", "-J", "-o", "PATH,MOUNTPOINT", "-n", device_path]
        )
        if rc2 == 0:
            try:
                blk = json.loads(out2)
                for node in blk.get("blockdevices") or []:
                    mp = (node.get("mountpoint") or "").strip()
                    if mp:
                        return mp
            except json.JSONDecodeError:
                pass
    return None


def _attempt_mount_external_partitions() -> list[str]:
    """Try to mount unmounted removable partitions; return new mountpoints."""
    mounted: list[str] = []
    for dev in _lsblk_removable_unmounted():
        mp = _udisksctl_mount(dev)
        if mp:
            print(f"Mounted {dev} at {mp}", file=sys.stderr)
            mounted.append(mp)
            time.sleep(0.5)
    return mounted


def discover_imiages_directory(explicit: Path | None = None) -> Path:
    """
    Locate ``imiages`` on an inserted USB pendrive.

    Searches mounted volumes under /media and /run/media, then attempts
    ``udisksctl mount`` on unmounted removable partitions.
    """
    if explicit is not None:
        explicit = explicit.expanduser()
        if explicit.is_dir():
            return explicit.resolve()
        raise FileNotFoundError(f"Folder not found: {explicit}")

    found = _search_imiages_on_mounted_volumes()
    if found is not None:
        return found.resolve()

    _attempt_mount_external_partitions()
    found = _search_imiages_on_mounted_volumes()
    if found is not None:
        return found.resolve()

    raise FileNotFoundError(
        "Could not find an 'imiages' folder on any connected USB drive. "
        "Insert the pendrive (with an 'imiages' folder containing JPG/PNG files) "
        "and run again."
    )


def print_usb_imiages_folder(
    folder: Path | None = None,
    *,
    port: str = DEFAULT_THERMAL_PORT,
    baud: int = DEFAULT_THERMAL_BAUD,
    width_pixels: int = DEFAULT_PRINT_WIDTH,
    recursive: bool = False,
    code_background_path: Path | None = None,
) -> int:
    imiages_dir = discover_imiages_directory(folder)
    images = list_images_in_folder(imiages_dir, recursive=recursive)
    if not images:
        raise FileNotFoundError(
            f"No JPG/PNG images found in {imiages_dir}"
        )

    print(
        f"Found {len(images)} image(s) in {imiages_dir}",
        file=sys.stderr,
    )
    return print_all_images_on_thermal(
        images,
        port=port,
        baud=baud,
        width_pixels=width_pixels,
        code_background_path=code_background_path,
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Print all JPG/PNG files from USB pendrive folder 'imiages' on thermal. "
            "Use --from-binary for legacy binary-to-PNG decode."
        )
    )
    p.add_argument(
        "--usb-folder",
        type=Path,
        default=None,
        help="Explicit path to imiages folder (default: auto-detect on USB)",
    )
    p.add_argument(
        "--recursive",
        action="store_true",
        help="Include images in subfolders of imiages",
    )
    p.add_argument(
        "--list-only",
        action="store_true",
        help="List images found on USB without printing",
    )
    p.add_argument(
        "--from-binary",
        action="store_true",
        help="Legacy mode: decode 'imiage print binary' instead of USB images",
    )
    p.add_argument(
        "--input",
        "-i",
        type=Path,
        default=DEFAULT_BINARY,
        help=f"Binary text file for --from-binary (default: {DEFAULT_BINARY.name})",
    )
    p.add_argument(
        "--output",
        "-o",
        type=Path,
        default=DEFAULT_PNG_OUT,
        help=f"PNG output for --from-binary (default: {DEFAULT_PNG_OUT.name})",
    )
    p.add_argument(
        "--convert-only",
        action="store_true",
        help="With --from-binary: only decode, do not print",
    )
    p.add_argument(
        "--print",
        dest="do_print",
        action="store_true",
        help="With --from-binary: print decoded PNG",
    )
    p.add_argument("--port", default=DEFAULT_THERMAL_PORT, help="Thermal serial port")
    p.add_argument("--baud", type=int, default=DEFAULT_THERMAL_BAUD, help="Serial baud rate")
    p.add_argument(
        "--width",
        type=int,
        default=DEFAULT_PRINT_WIDTH,
        help="Raster width in pixels (384 for 58mm, 576 for 80mm)",
    )
    p.add_argument(
        "--code-background",
        action="store_true",
        help="Render source code faintly behind each image (optional)",
    )
    p.add_argument(
        "--code-file",
        type=Path,
        default=DEFAULT_CODE_FILE,
        help="Source file for --code-background",
    )
    p.add_argument(
        "--composite-out",
        type=Path,
        default=ASSETS_DIR / "decoded_with_code_background.png",
        help="Save composite preview (--from-binary + --code-background)",
    )
    p.add_argument(
        "--no-save-composite",
        action="store_true",
        help="Do not write composite preview PNG",
    )
    return p


def _run_legacy_binary_mode(args) -> int:
    if not args.input.is_file():
        print(f"Input file not found: {args.input}", file=sys.stderr)
        return 1

    try:
        png_path, data = save_png_from_binary_file(args.input, args.output)
    except Exception as e:
        print(f"Decode failed: {e}", file=sys.stderr)
        return 1

    print(f"Decoded {len(data)} bytes -> {png_path}")
    if Image is not None:
        try:
            with Image.open(png_path) as im:
                print(f"Image: {im.size[0]}x{im.size[1]} mode={im.mode}")
        except Exception as e:
            print(f"PNG saved but PIL could not open it: {e}", file=sys.stderr)

    if args.convert_only and not args.do_print:
        return 0
    if not args.do_print:
        print("Tip: add --print to send decoded PNG to thermal.", file=sys.stderr)
        return 0

    code_bg = args.code_file if args.code_background else None
    composite_out = None if args.no_save_composite else args.composite_out
    if args.code_background and not args.code_file.is_file():
        print(f"Code background file not found: {args.code_file}", file=sys.stderr)
        return 1

    try:
        print_image_file_on_thermal(
            png_path,
            port=args.port,
            baud=args.baud,
            width_pixels=args.width,
            code_background_path=code_bg,
            save_composite_path=composite_out if args.code_background else None,
        )
    except Exception as e:
        print(f"Print failed: {e}", file=sys.stderr)
        return 1

    print("Print job sent.")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    code_bg = args.code_file if args.code_background else None

    if args.from_binary:
        return _run_legacy_binary_mode(args)

    try:
        imiages_dir = discover_imiages_directory(args.usb_folder)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1

    images = list_images_in_folder(imiages_dir, recursive=args.recursive)
    if not images:
        print(f"No JPG/PNG images in {imiages_dir}", file=sys.stderr)
        return 1

    print(f"USB folder: {imiages_dir}")
    for p in images:
        print(f"  {p.name}")

    if args.list_only:
        return 0

    try:
        n = print_all_images_on_thermal(
            images,
            port=args.port,
            baud=args.baud,
            width_pixels=args.width,
            code_background_path=code_bg,
        )
    except Exception as e:
        print(f"Print failed: {e}", file=sys.stderr)
        return 1

    print(f"Printed {n} image(s) on thermal printer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
