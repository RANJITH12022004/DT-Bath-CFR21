#!/usr/bin/env python3
"""Probe R307 on UART: verify module, poll GenImage until finger detected (place finger and hold)."""
import os
import sys
import time

try:
    import serial
except ImportError:
    print("ERROR: pip install pyserial")
    sys.exit(1)

PACKET_START = b"\xEF\x01"
ADDR = 0xFFFFFFFF
PWD = 0x00000000
CMD_VERIFY = 0x13
CMD_GEN_IMAGE = 0x01
CMD_TEMPLATE_COUNT = 0x1D
CONFIRM_OK = 0x00
CONFIRM_NO_FINGER = 0x02


def checksum(pkt_type, payload):
    total = pkt_type + len(payload) + 2
    for b in payload:
        total += b
    return total & 0xFFFF


def build_packet(payload):
    pkt_type = 0x01
    length = len(payload) + 2
    chk = checksum(pkt_type, payload)
    body = bytes([pkt_type]) + length.to_bytes(2, "big") + payload + chk.to_bytes(2, "big")
    return PACKET_START + ADDR.to_bytes(4, "big") + body


def read_response(ser, timeout=2.0):
    deadline = time.time() + timeout
    header = b""
    while len(header) < 9 and time.time() < deadline:
        chunk = ser.read(9 - len(header))
        if chunk:
            header += chunk
        else:
            time.sleep(0.01)
    if len(header) != 9 or header[:2] != PACKET_START:
        return None, "bad_header"
    pkt_type = header[6]
    ln = int.from_bytes(header[7:9], "big")
    body = b""
    while len(body) < ln and time.time() < deadline:
        chunk = ser.read(ln - len(body))
        if chunk:
            body += chunk
        else:
            time.sleep(0.01)
    if len(body) != ln:
        return None, "short_body"
    payload = body[:-2]
    recv_chk = int.from_bytes(body[-2:], "big")
    if recv_chk != checksum(pkt_type, payload):
        return None, "bad_checksum"
    if pkt_type != 0x07 or not payload:
        return None, "not_ack"
    return payload[0], payload


def main():
    port = os.environ.get("BIOMETRIC_PORT", "/dev/ttyAMA5")
    baud = int(os.environ.get("BIOMETRIC_BAUD", "57600"))
    poll_sec = float(os.environ.get("FINGER_POLL_SEC", "120"))

    if not os.path.exists(port):
        print(f"ERROR: {port} not found")
        sys.exit(2)

    print(f"Opening {port} @ {baud} baud...")
    ser = serial.Serial(
        port=port,
        baudrate=baud,
        timeout=0.5,
        write_timeout=1.0,
        bytesize=serial.EIGHTBITS,
        parity=serial.PARITY_NONE,
        stopbits=serial.STOPBITS_ONE,
    )
    ser.reset_input_buffer()
    ser.reset_output_buffer()

    # Verify password
    pkt = build_packet(bytes([CMD_VERIFY]) + PWD.to_bytes(4, "big"))
    ser.write(pkt)
    ser.flush()
    code, _ = read_response(ser, 2.0)
    if code is None:
        print("VERIFY: no valid response (wrong baud, wiring, or not R307 protocol)")
    elif code == CONFIRM_OK:
        print("VERIFY: OK (module answered)")
    else:
        print(f"VERIFY: confirm code 0x{code:02x}")

    # Template count
    ser.reset_input_buffer()
    pkt = build_packet(bytes([CMD_TEMPLATE_COUNT]))
    ser.write(pkt)
    ser.flush()
    code, pl = read_response(ser, 2.0)
    if code == CONFIRM_OK and pl and len(pl) >= 3:
        cnt = int.from_bytes(pl[1:3], "big")
        print(f"TEMPLATE COUNT: {cnt}")
    else:
        print(f"TEMPLATE COUNT: code={code}")

    print(f"\nPlace and HOLD finger on sensor for up to {poll_sec:.0f}s...")
    print("Polling GenImage until SUCCESS (code 0x00)...\n")

    t0 = time.time()
    attempt = 0
    while time.time() - t0 < poll_sec:
        attempt += 1
        ser.reset_input_buffer()
        pkt = build_packet(bytes([CMD_GEN_IMAGE]))
        ser.write(pkt)
        ser.flush()
        code, _ = read_response(ser, 1.5)
        if code == CONFIRM_OK:
            print(f"SUCCESS: finger image captured (attempt {attempt}, {time.time()-t0:.1f}s)")
            ser.close()
            return 0
        if code == CONFIRM_NO_FINGER:
            if attempt % 10 == 1:
                print(f"  ... waiting for finger (attempt {attempt})")
        elif code is not None:
            print(f"  attempt {attempt}: sensor code 0x{code:02x}")
        time.sleep(0.15)

    print("TIMEOUT: no finger detected in window")
    ser.close()
    return 1


if __name__ == "__main__":
    sys.exit(main())
