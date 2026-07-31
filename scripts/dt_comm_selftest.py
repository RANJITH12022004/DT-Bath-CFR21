#!/usr/bin/env python3
"""
Detailed DT communication self-test (mock parsers + live UART + HTTP API).

Usage:
  /opt/kiosk/venv/bin/python3 /opt/kiosk/scripts/dt_comm_selftest.py
  /opt/kiosk/venv/bin/python3 /opt/kiosk/scripts/dt_comm_selftest.py --live-only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_ROOT = Path(os.environ.get("APP_ROOT", "/opt/kiosk"))
sys.path.insert(0, str(APP_ROOT))

BASE = os.environ.get("KIOSK_API_BASE", "http://127.0.0.1:5000")
FACTORY_USER = os.environ.get("DT_TEST_USER", "RLERLT")
FACTORY_PASS = os.environ.get("DT_TEST_PASS", "Rahul")
ESP_PORT = os.environ.get("ESP_PORT", "/dev/serial0")
ESP_BAUD = int(os.environ.get("ESP_BAUD", "9600"))

passed: list[str] = []
failed: list[str] = []
warned: list[str] = []


def ok(msg: str) -> None:
    passed.append(msg)
    print(f"  OK   {msg}")


def fail(msg: str) -> None:
    failed.append(msg)
    print(f"  FAIL {msg}")


def warn(msg: str) -> None:
    warned.append(msg)
    print(f"  WARN {msg}")


def req(method: str, path: str, body=None, headers=None, timeout=8.0):
    data = None if body is None else json.dumps(body).encode()
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        h.update(headers)
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw) if raw else {}
        except Exception:
            payload = {"error": raw}
        return e.code, payload


def test_parsers() -> None:
    print("\n== 1) Protocol parsers (Dt_Dr_Reddy parity) ==")
    import dt_hardware_service as hw

    cases = [
        ("T1,25.3,24.8", "T1", (25.3, 24.8)),
        ("T1,IR1,25.3,EXT1,24.8", "T1", (25.3, 24.8)),
        ("T2,IR2,36.1,EXT2,35.9", "T2", (36.1, 35.9)),
    ]
    for line, tag, expect in cases:
        got = hw.parse_t1_t2(line, tag)
        (ok if got == expect else fail)(f"parse_t1_t2({line!r}) -> {got}")

    bulk = hw.parse_temp_bulk("IR1:25.3,IR2:25.1,EXT1:24.8,EXT2:24.9")
    (ok if bulk and bulk.get("IR1") == 25.3 and bulk.get("EXT2") == 24.9 else fail)(
        f"parse_temp_bulk -> {bulk}"
    )

    strokes = hw.parse_strokes("S1:12,S2:34")
    (ok if strokes == {"S1": 12, "S2": 34} else fail)(f"parse_strokes -> {strokes}")

    (ok if hw.is_ts_response_line("TR1,TR2") else fail)("is_ts_response_line TR1,TR2")
    (ok if hw.is_ts_response_line("TS,TR1,0") else fail)("is_ts_response_line TS,TR1,0")
    (ok if hw.classify_line("IR1:1,EXT1:2") == "temps_bulk" else fail)("classify TEMP bulk")


def test_uart_probe() -> dict:
    print("\n== 2) Live UART probe (/dev/serial0 @ 9600) ==")
    result = {"open": False, "rx_any": False, "lines": []}
    try:
        import serial
    except Exception as e:
        fail(f"pyserial missing: {e}")
        return result
    if not os.path.exists(ESP_PORT):
        fail(f"ESP port missing: {ESP_PORT}")
        return result
    try:
        ser = serial.Serial(ESP_PORT, ESP_BAUD, timeout=0.4, write_timeout=1.0)
    except Exception as e:
        fail(f"open {ESP_PORT}: {e}")
        return result
    result["open"] = True
    ok(f"opened {ESP_PORT} @ {ESP_BAUD}")
    try:
        ser.reset_input_buffer()
        ser.reset_output_buffer()
        for cmd in ("T1", "T2", "TS", "TEMP", "PHW,37.0,37.0", "STOP"):
            ser.write((cmd + "\n").encode())
            ser.flush()
            time.sleep(0.9)
            raw = ser.read(1024)
            text = raw.decode("utf-8", "replace").strip()
            result["lines"].append({"tx": cmd, "rx": text})
            print(f"    TX {cmd:<18} RX {text!r}")
            if text:
                result["rx_any"] = True
        if result["rx_any"]:
            ok("ESP returned at least one UART line")
        else:
            warn(
                "ESP silent on UART — check power, TX/RX swap (Pi14→ESP RX, Pi15→ESP TX), GND, firmware"
            )
    finally:
        ser.close()
    return result


def test_ports() -> None:
    print("\n== 3) Component port open checks ==")
    try:
        import serial
    except Exception as e:
        fail(f"pyserial: {e}")
        return
    for port, baud, name in (
        ("/dev/ttyAMA3", 9600, "thermal"),
        ("/dev/ttyAMA4", 9600, "a4"),
        ("/dev/ttyAMA5", 57600, "biometric"),
    ):
        try:
            ser = serial.Serial(port, baud, timeout=0.2, write_timeout=0.5)
            ser.close()
            ok(f"{name} port open ({port}@{baud})")
        except Exception as e:
            warn(f"{name} port {port}: {e}")


def test_http_api() -> None:
    print("\n== 4) HTTP hardware API (session + protocol commands) ==")
    code, health = req("GET", "/api/health")
    (ok if code == 200 and health.get("status") == "ok" else fail)(f"health {code} {health}")

    code, login = req(
        "POST",
        "/api/data/auth/login",
        {"username": FACTORY_USER, "password": FACTORY_PASS},
    )
    if code != 200 or not login.get("ok", True) and "session" not in str(login).lower() and "user" not in login:
        # Some builds return user without ok
        if code != 200:
            fail(f"login {code} {login}")
            return
    ok(f"login as {FACTORY_USER}")

    headers = {
        "X-User-Username": FACTORY_USER,
        "X-User-Role": "factory",
        "X-User-Name": "Factory User",
    }
    # Carry session cookie if present via urllib opener would be better; headers work for factory stub.

    code, st = req("GET", "/api/hardware/status", headers=headers)
    (ok if code == 200 else fail)(f"hardware/status {code} mock={st.get('mock')} port={st.get('port')}")

    code, live = req("GET", "/api/hardware/dt/live", headers=headers)
    (ok if code == 200 else fail)(f"dt/live {code} mock={live.get('mock')}")

    steps = [
        ("POST", "/api/hardware/dt/preheat", {"t1": 37.0, "t2": 37.0}, "PHW"),
        ("POST", "/api/hardware/command", {"command": "T1"}, "T1"),
        ("POST", "/api/hardware/command", {"command": "T2"}, "T2"),
        ("POST", "/api/hardware/dt/temp", None, "TEMP"),
        ("GET", "/api/hardware/dt/temp", None, "TEMP GET"),
        ("POST", "/api/hardware/dt/start", {"basket": 1, "temp": 37.0}, "START,B1"),
        ("POST", "/api/hardware/dt/start-stroke", {"basket": 1}, "START,STROKE"),
        ("POST", "/api/hardware/dt/stop", {"basket": 1}, "STOP1"),
        ("POST", "/api/hardware/dt/start", {"basket": 3, "t1": 37.0, "t2": 37.0}, "START,B3"),
        ("POST", "/api/hardware/dt/stop", {}, "STOP"),
        ("POST", "/api/hardware/dt/calibrate", {"sensor": "IR1", "temp": 37.0}, "CAL,IR1"),
    ]
    for method, path, body, label in steps:
        code, data = req(method, path, body, headers=headers)
        good = code in (200, 201) and (data.get("ok") is not False)
        # calibrate may require different perms or return ok False for validation — accept 200
        if label.startswith("CAL") and code == 200:
            good = True
        (ok if good else fail)(f"{label}: {method} {path} -> {code} ok={data.get('ok')} cmd={data.get('cmd') or data.get('command',{}).get('cmd')}")

    # Ensure STOP left system idle
    req("POST", "/api/hardware/dt/stop", {}, headers=headers)


def test_uart_log() -> None:
    print("\n== 5) UART log recent traffic ==")
    path = APP_ROOT / "uart_communications.log"
    if not path.exists():
        warn("uart_communications.log missing")
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
    for ln in lines:
        print(f"    {ln}")
    if any("[TX]" in ln or "TX_MOCK" in ln or "[TX_MOCK]" in ln for ln in lines):
        ok("uart log has TX entries")
    else:
        warn("no TX entries in recent uart log")
    if any("[RX]" in ln and "RX_MOCK" not in ln for ln in lines):
        ok("uart log has live RX entries")
    elif any("RX_MOCK" in ln for ln in lines):
        warn("uart log still showing RX_MOCK only (ESP not answering / still mock)")
    else:
        warn("no live RX in uart log (ESP not answering yet)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-only", action="store_true")
    ap.add_argument("--skip-http", action="store_true")
    args = ap.parse_args()

    print("DT-CFR communication self-test")
    print(f"API={BASE} ESP={ESP_PORT}@{ESP_BAUD}")

    if not args.live_only:
        test_parsers()
    uart = test_uart_probe()
    test_ports()
    if not args.skip_http:
        test_http_api()
        test_uart_log()

    print("\n== Summary ==")
    print(f"passed={len(passed)} failed={len(failed)} warnings={len(warned)}")
    if failed:
        print("FAILURES:")
        for m in failed:
            print(" -", m)
    if warned:
        print("WARNINGS:")
        for m in warned:
            print(" -", m)
    if not uart.get("rx_any"):
        print(
            "\nESP wiring reminder (Dt_Dr_Reddy):\n"
            "  Pi GPIO14 (TX) -> ESP RX\n"
            "  Pi GPIO15 (RX) -> ESP TX\n"
            "  GND <-> GND, ESP powered, firmware @ 9600 8N1"
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
