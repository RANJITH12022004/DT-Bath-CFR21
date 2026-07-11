#!/usr/bin/env python3
"""
Run all Friability ESP commands and print the ESP↔Pi communication log.
Maps actual UART lines against friability_firmware.txt.

Usage:
  python3 scripts/esp_pi_comm_probe.py
  python3 scripts/esp_pi_comm_probe.py --rpm 30 --run-sec 6 --with-pause
  python3 scripts/esp_pi_comm_probe.py --validation --rpm 25 --run-sec 10
"""

import argparse
import os
import sys
import time

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

import hardware_service as hw


def _start_reader():
    threading = __import__("threading")
    t = threading.Thread(target=hw._reader_loop, daemon=True)
    t.start()
    return t


def _print_log_tail(n=120):
    result = hw.get_uart_log_tail(max_lines=n)
    path = result.get("path", "")
    print(f"\n--- ESP↔Pi log tail ({path}) ---")
    for line in result.get("lines") or []:
        print(line)
    print("--- end log ---\n")


def _listen_stream(seconds, label="stream"):
    print(f"   listening {seconds}s for {label}...")
    deadline = time.time() + max(1.0, seconds)
    last_count = None
    while time.time() < deadline:
        lines = hw.drain_queue(max_lines=50)
        for line in lines:
            parsed = hw.parse_friability_progress_line(line)
            rot = parsed.get("rotationCount")
            rpm = parsed.get("rpm")
            if rot is not None and rot != last_count:
                if "rpm" in parsed:
                    print(f"   progress: {rot},{'--' if parsed.get('rpmPending') else rpm}")
                else:
                    print(f"   rotation: {rot}")
                last_count = rot
            elif rpm is not None:
                print(f"   rpm: {rpm}")
            kind = hw.classify_line(line)
            if kind == "completed":
                print(f"   complete: {line}")
        time.sleep(0.1)


def _run_parsing_self_test():
    cases = [
        ("3", {"rotationCount": 3}),
        ("5,24.56", {"rotationCount": 5, "rpm": 24.56}),
        ("10,--", {"rotationCount": 10, "rpm": None, "rpmPending": True}),
        ("complete", {}),
        ("ok", {}),
    ]
    ok = True
    for line, expect in cases:
        payload = hw.build_line_payload(line)
        for key, val in expect.items():
            got = payload.get(key)
            if key == "rpmPending":
                if bool(got) != bool(val):
                    print(f"FAIL parse {line!r}: {key} expected {val}, got {got}")
                    ok = False
            elif got != val:
                print(f"FAIL parse {line!r}: {key} expected {val!r}, got {got!r}")
                ok = False
    if ok:
        print("Parsing self-test: OK")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Probe Friability ESP UART commands")
    parser.add_argument("--rpm", type=int, default=30, help="RPM for start/val (20-70)")
    parser.add_argument("--run-sec", type=float, default=6.0, help="Seconds to run before stop")
    parser.add_argument("--with-pause", action="store_true", help="Exercise pause/resume during run")
    parser.add_argument("--validation", action="store_true", help="Use val,<rpm>* instead of start")
    parser.add_argument("--skip-dispense", action="store_true", help="Skip dispense command")
    parser.add_argument("--parse-only", action="store_true", help="Only run parsing self-test")
    args = parser.parse_args()

    if args.parse_only:
        return 0 if _run_parsing_self_test() else 1

    if not _run_parsing_self_test():
        return 1

    os.environ.setdefault("UART_LOG_PATH", os.path.join(APP_ROOT, "uart_communications.log"))
    hw._uart_log_path = os.environ["UART_LOG_PATH"]
    hw._config = {"ESP_PORT": os.environ.get("ESP_PORT", "/dev/serial0"), "ESP_BAUD": 9600}
    hw.reset_uart_log(reason="probe_start")
    serial_ok = False
    try:
        hw._open_esp_serial()
        _start_reader()
        serial_ok = True
    except Exception as e:
        print("WARNING: serial not available:", e)

    exit_code = 0

    print("1) dispense*")
    if not args.skip_dispense:
        if serial_ok:
            r = hw.cmd_dispense()
            print("   ", r)
            if not r.get("ok"):
                exit_code = 1
        else:
            print("   skipped (no serial)")
    else:
        print("   skipped")

    if args.validation:
        print(f"2) val,{args.rpm}*")
        start_fn = hw.cmd_start_validation
    else:
        print(f"2) start,{args.rpm}*")
        start_fn = hw.cmd_start_friability

    if serial_ok:
        r = start_fn(args.rpm)
        print("   ", r)
        if not r.get("ok"):
            _print_log_tail()
            return 1

        half = max(1.0, args.run_sec / 2.0)
        _listen_stream(half, "first half")

        if args.with_pause:
            print("3) pause*")
            r = hw.cmd_pause_friability()
            print("   ", r)
            time.sleep(1.0)
            print("4) resume*")
            r = hw.cmd_resume_friability()
            print("   ", r)
            _listen_stream(half, "after resume")

        print("5) stop*")
        r = hw.cmd_stop_friability()
        print("   ", r)
        if not r.get("ok"):
            exit_code = 1
    else:
        print("   skipped (no serial)")

    _print_log_tail(160)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
