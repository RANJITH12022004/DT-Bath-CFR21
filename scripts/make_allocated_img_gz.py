#!/usr/bin/env python3
"""Create an allocated-space SD image (.img.gz) with live progress and ETA.

Reads only through the end of the last partition (SD Card Copier style),
compresses with pigz/gzip, writes to the destination path.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time


def human_bytes(n: float) -> str:
    n = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024.0:
            return "{:.1f} {}".format(n, unit)
        n /= 1024.0
    return "{:.1f} PiB".format(n)


def human_duration(seconds: float) -> str:
    if seconds < 0 or seconds != seconds:  # NaN
        return "--:--"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "{:d}h {:02d}m {:02d}s".format(h, m, s)
    if m:
        return "{:d}m {:02d}s".format(m, s)
    return "{:d}s".format(s)


def allocated_bytes(device: str) -> int:
    """Bytes covering partition table through end of last partition."""
    sysfs = "/sys/block/{}".format(os.path.basename(device))
    parts = []
    for name in sorted(os.listdir(sysfs)):
        if not name.startswith(os.path.basename(device)):
            continue
        start_path = os.path.join(sysfs, name, "start")
        size_path = os.path.join(sysfs, name, "size")
        if not (os.path.isfile(start_path) and os.path.isfile(size_path)):
            continue
        with open(start_path) as f:
            start = int(f.read().strip())
        with open(size_path) as f:
            size = int(f.read().strip())
        parts.append(start + size)
    if not parts:
        raise SystemExit("No partitions found on {}".format(device))
    return max(parts) * 512


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="Block device, e.g. /dev/mmcblk0")
    ap.add_argument("--dest", required=True, help="Destination .img.gz path")
    ap.add_argument("--chunk-mib", type=int, default=4)
    args = ap.parse_args()

    source = args.source
    dest = args.dest
    total = allocated_bytes(source)
    chunk = max(1, args.chunk_mib) * 1024 * 1024

    compressor = "pigz" if subprocess.call(["which", "pigz"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0 else "gzip"
    print("Source:      {}".format(source), flush=True)
    print("Destination: {}".format(dest), flush=True)
    print("Allocated:   {} ({} bytes)".format(human_bytes(total), total), flush=True)
    print("Compressor:  {}".format(compressor), flush=True)
    print("Mode:        read-only allocated space -> .img.gz", flush=True)
    print("---", flush=True)

    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    # Remove incomplete previous file if any
    if os.path.exists(dest):
        os.remove(dest)

    # Flush filesystem caches before imaging
    subprocess.check_call(["sync"])

    out_f = open(dest, "wb")
    proc = subprocess.Popen(
        [compressor, "-1", "-c"],
        stdin=subprocess.PIPE,
        stdout=out_f,
        stderr=subprocess.PIPE,
    )
    assert proc.stdin is not None

    done = 0
    t0 = time.time()
    last_print = 0.0
    try:
        with open(source, "rb", buffering=0) as src:
            while done < total:
                to_read = min(chunk, total - done)
                data = src.read(to_read)
                if not data:
                    raise SystemExit("Unexpected EOF at {} / {}".format(done, total))
                proc.stdin.write(data)
                done += len(data)
                now = time.time()
                if now - last_print >= 1.0 or done >= total:
                    elapsed = max(now - t0, 0.001)
                    rate = done / elapsed
                    remain = (total - done) / rate if rate > 0 else 0
                    pct = 100.0 * done / total
                    try:
                        out_size = os.path.getsize(dest)
                    except OSError:
                        out_size = 0
                    print(
                        "\r[{:6.2f}%] {} / {} | out {} | {}/s | elapsed {} | ETA {}".format(
                            pct,
                            human_bytes(done),
                            human_bytes(total),
                            human_bytes(out_size),
                            human_bytes(rate),
                            human_duration(elapsed),
                            human_duration(remain),
                        ),
                        end="",
                        flush=True,
                    )
                    last_print = now
        proc.stdin.close()
        rc = proc.wait()
        out_f.flush()
        os.fsync(out_f.fileno())
        out_f.close()
        print(flush=True)
        if rc != 0:
            err = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
            raise SystemExit("{} failed rc={}: {}".format(compressor, rc, err))
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
        try:
            out_f.close()
        except Exception:
            pass
        raise

    subprocess.check_call(["sync"])
    final = os.path.getsize(dest)
    elapsed = time.time() - t0
    print("---", flush=True)
    print("DONE: {}".format(dest), flush=True)
    print("Compressed size: {} ({} bytes)".format(human_bytes(final), final), flush=True)
    print("Elapsed: {}".format(human_duration(elapsed)), flush=True)
    print("Avg read rate: {}/s".format(human_bytes(total / max(elapsed, 0.001))), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
