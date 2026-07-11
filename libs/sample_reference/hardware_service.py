#!/usr/bin/env python3
"""
hardware_service.py - ESP32 hardware communication service
Handles serial communication, command processing, and SSE streaming for real-time hardware data.
"""

import errno
import json
import os
import queue
import threading
import time
from contextlib import contextmanager

import serial

# Module-level state (set in init)
_logger = None
_config = {}
_esp_port = None

# ESP32 serial and line handling
ser_lock = threading.Lock()
esp_ser = None
line_q = queue.Queue(maxsize=2000)
sse_clients = []
esp_read_buffer = ""

# Response timeout for commands
COMMAND_TIMEOUT = 2.0
# Longer timeout for test commands (dimension/hardness) - ESP needs time to measure
TEST_COMMAND_TIMEOUT = 30.0
MAX_RETRIES = 3
# Wait up to 25 seconds for ESP serial device to appear before showing error
ESP_CONNECT_WAIT_SEC = 25
ESP_CONNECT_RETRY_INTERVAL = 1.0


def init(app, config):
    """Initialize hardware service with Flask app and config"""
    global _logger, _config, _esp_port, line_q, sse_clients
    _logger = app.logger
    _config = dict(config)
    _esp_port = _config.get("ESP_PORT", "/dev/serial0")
    line_q = queue.Queue(maxsize=2000)
    sse_clients = []
    
    try:
        _open_esp_serial()
        _logger.info("[HARDWARE] ESP32 UART initialized at startup")
    except Exception as e:
        _logger.error("[HARDWARE] Failed to open ESP UART at startup: %s", e)
    
    # Start background reader thread
    threading.Thread(target=esp_reader_loop, daemon=True).start()
    _logger.info("[HARDWARE] ESP reader thread started")


def _open_esp_serial():
    """Open UART to ESP32 if needed"""
    global esp_ser, _esp_port
    port = _config.get("ESP_PORT", "/dev/serial0")
    baud = _config.get("ESP_BAUD", 9600)
    
    with ser_lock:
        if esp_ser and getattr(esp_ser, "is_open", False):
            _logger.debug("[HARDWARE] ESP serial already open")
            return esp_ser
        
        try:
            if not port or not os.path.exists(port):
                # Try to probe for port
                candidates = ["/dev/serial0", "/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyAMA0"]
                for candidate in candidates:
                    if os.path.exists(candidate):
                        port = candidate
                        _esp_port = candidate
                        _logger.info("[HARDWARE] Probed ESP port: using %s", port)
                        break
                else:
                    raise FileNotFoundError(errno.ENOENT, "ESP serial device not found", port)
            
            if esp_ser:
                try:
                    esp_ser.close()
                except Exception:
                    pass
            
            esp_ser = serial.Serial(
                port=port,
                baudrate=baud,
                timeout=2.0,
                write_timeout=2.0,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                xonxoff=False,
                rtscts=False,
                dsrdtr=False
            )
            esp_ser.reset_input_buffer()
            esp_ser.reset_output_buffer()
            _esp_port = port
            _logger.info("[HARDWARE] ESP serial opened on %s @ %d", port, baud)
            return esp_ser
        except Exception as e:
            _logger.error("[HARDWARE] Failed to open ESP serial: %s", e)
            raise


def _is_device_not_found_error(e):
    """True if the exception indicates the serial device is not (yet) present."""
    if isinstance(e, FileNotFoundError):
        return True
    if isinstance(e, OSError) and getattr(e, "errno", None) == errno.ENOENT:
        return True
    msg = str(e).lower()
    return "not found" in msg or "enoent" in msg or "no such file" in msg


def _open_esp_serial_with_wait():
    """
    Try to open ESP serial; if device not found, retry for up to ESP_CONNECT_WAIT_SEC
    before giving up. Raises the last exception if still not open after wait.
    """
    global esp_ser
    start = time.time()
    last_exc = None
    while time.time() - start < ESP_CONNECT_WAIT_SEC:
        try:
            _open_esp_serial()
            if esp_ser and getattr(esp_ser, "is_open", False):
                return
        except Exception as e:
            last_exc = e
            if _is_device_not_found_error(e):
                _logger.debug("[HARDWARE] ESP device not ready, retrying in %.1fs (%.0fs left)",
                              ESP_CONNECT_RETRY_INTERVAL, max(0, ESP_CONNECT_WAIT_SEC - (time.time() - start)))
                time.sleep(ESP_CONNECT_RETRY_INTERVAL)
                continue
            raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("ESP serial could not be opened within {} seconds".format(ESP_CONNECT_WAIT_SEC))


def send_command(cmd: str, timeout=COMMAND_TIMEOUT, max_retries=MAX_RETRIES):
    """
    Send command to ESP32 and wait for response
    Returns dict with 'ok', 'response', 'error' keys
    """
    global esp_ser
    
    if not cmd:
        return {"ok": False, "error": "Empty command"}
    
    cmd = cmd.strip()
    if not cmd.endswith("*"):
        cmd = cmd + "*"
    
    backoff = 0.1
    max_backoff = 1.0
    
    for attempt in range(max_retries):
        if not esp_ser or not getattr(esp_ser, "is_open", False):
            try:
                _open_esp_serial_with_wait()
            except Exception as e:
                _logger.error("[HARDWARE] Could not reopen ESP serial (attempt %d/%d): %s",
                             attempt + 1, max_retries, e)
                if attempt < max_retries - 1:
                    time.sleep(backoff)
                    backoff = min(backoff * 2, max_backoff)
                    continue
                return {"ok": False, "error": f"Failed to connect to ESP32: {e}"}
        
        try:
            # Drain line_q to clear stale responses from previous operations
            while True:
                try:
                    line_q.get_nowait()
                except queue.Empty:
                    break
            # Clear any pending serial data
            with ser_lock:
                if esp_ser and getattr(esp_ser, "is_open", False):
                    esp_ser.reset_input_buffer()
            
            # Send command
            with ser_lock:
                if not esp_ser or not getattr(esp_ser, "is_open", False):
                    if attempt < max_retries - 1:
                        time.sleep(backoff)
                        backoff = min(backoff * 2, max_backoff)
                        continue
                    return {"ok": False, "error": "ESP serial not available"}
                
                line = (cmd + "\n").encode('ascii', errors='replace')
                esp_ser.write(line)
                esp_ser.flush()
                _logger.debug("[HARDWARE] Sent: %r", cmd)
            
            # Wait for response (timeout=None means wait indefinitely)
            start_time = time.time()
            response_lines = []
            
            while timeout is None or (time.time() - start_time < timeout):
                try:
                    # Check queue for responses
                    try:
                        line = line_q.get(timeout=0.1)
                        if line and line.strip():
                            response_lines.append(line.strip())
                            # Check if this looks like a response to our command
                            if _is_command_response(cmd, line):
                                return {"ok": True, "response": line.strip(), "cmd": cmd}
                    except queue.Empty:
                        pass
                    
                    # Also try reading directly
                    with ser_lock:
                        if esp_ser and getattr(esp_ser, "is_open", False):
                            if esp_ser.in_waiting > 0:
                                line_bytes = esp_ser.readline()
                                if line_bytes:
                                    line = line_bytes.decode('ascii', errors='ignore').strip()
                                    if line:
                                        response_lines.append(line)
                                        if _is_command_response(cmd, line):
                                            return {"ok": True, "response": line, "cmd": cmd}
                except Exception as e:
                    _logger.debug("[HARDWARE] Read error: %s", e)
                
                time.sleep(0.05)
            
            # Timeout (only when timeout was set) - return what we got
            if timeout is not None:
                elapsed = time.time() - start_time
                if response_lines:
                    return {
                        "ok": True,
                        "response": response_lines[-1],
                        "cmd": cmd,
                        "warning": "Timeout but got response",
                        "last_response_lines": response_lines[-5:],
                        "elapsed_sec": elapsed,
                        "timeout_sec": timeout,
                    }
                return {
                    "ok": False,
                    "error": "Timeout waiting for response",
                    "cmd": cmd,
                    "last_response_lines": response_lines[-5:],
                    "elapsed_sec": elapsed,
                    "timeout_sec": timeout,
                }
            # timeout is None: should not reach here
            return {"ok": False, "error": "No response", "cmd": cmd}
            
        except Exception as e:
            _logger.warning("[HARDWARE] Command failed (attempt %d/%d): %s", attempt + 1, max_retries, e)
            if attempt < max_retries - 1:
                try:
                    with ser_lock:
                        if esp_ser:
                            try:
                                esp_ser.close()
                            except Exception:
                                pass
                            esp_ser = None
                        _open_esp_serial()
                except Exception:
                    pass
                time.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)
            else:
                _logger.exception("[HARDWARE] All %d attempts failed for: %s", max_retries, cmd)
                return {"ok": False, "error": str(e), "cmd": cmd}
    
    return {"ok": False, "error": "Max retries exceeded", "cmd": cmd}


def _is_command_response(cmd: str, response: str) -> bool:
    """Check if response matches the command type (Short format protocol)"""
    cmd_upper = cmd.upper()
    resp_upper = response.upper()
    
    # System: S,PING -> S,OK
    if "S,PING" in cmd_upper:
        return "S,OK" in resp_upper
    
    # Calibration
    if "C,TARE" in cmd_upper:
        return "C,TARE,OK" in resp_upper
    if "C,LOAD" in cmd_upper:
        return "C,LOAD" in resp_upper
    if "C,DZ" in cmd_upper:
        return "DZ,OK" in resp_upper or "DZ,ERR" in resp_upper
    if "C,DS" in cmd_upper:
        return "C,DS" in resp_upper
    
    # Test
    if "T,BO" in cmd_upper:
        return "T,BO,OK" in resp_upper
    if "T,DIM" in cmd_upper:
        return "D,DIM," in resp_upper
    if "T,HARD" in cmd_upper:
        return "D,HARD," in resp_upper
    if "T,HOME" in cmd_upper:
        return "T,HOME,OK" in resp_upper
    
    # Validation
    if "V,L,1" in cmd_upper:
        return "V,L,1" in resp_upper
    if "V,L,0" in cmd_upper:
        return "V,L,0" in resp_upper
    
    return False


def wait_for_line_containing(pattern: str, timeout: float = 60.0) -> dict:
    """
    Read from line_q until a line contains the pattern (case-insensitive), or timeout.
    Returns {"ok": True} when pattern found, {"ok": False, "error": str} on timeout.
    """
    pattern_upper = pattern.upper()
    start = time.time()
    while (time.time() - start) < timeout:
        try:
            line = line_q.get(timeout=0.2)
            if line and line.strip() and pattern_upper in (line.strip().upper()):
                return {"ok": True, "response": line.strip()}
        except queue.Empty:
            pass
        time.sleep(0.02)
    return {"ok": False, "error": f"Timeout waiting for {pattern!r}"}


def esp_reader_loop():
    """Background thread: read lines from ESP32, push into line_q and sse_clients"""
    global esp_read_buffer, esp_ser
    reopen_backoff = 1.0
    max_backoff = 30.0
    
    while True:
        try:
            if not esp_ser or not getattr(esp_ser, "is_open", False):
                try:
                    _open_esp_serial()
                    reopen_backoff = 1.0
                except Exception as e:
                    _logger.error("[HARDWARE] Cannot open ESP serial in reader thread: %s", e)
                    time.sleep(reopen_backoff)
                    reopen_backoff = min(reopen_backoff * 2, max_backoff)
                    continue
            
            s = esp_ser
            with ser_lock:
                bytes_waiting = getattr(s, 'in_waiting', 0) or 0
                if bytes_waiting > 0:
                    chunk = s.read(min(bytes_waiting, 1024))
                else:
                    chunk = s.readline()
            
            if not chunk:
                time.sleep(0.05)
                continue
            
            try:
                decoded_chunk = chunk.decode("ascii", errors="ignore")
                esp_read_buffer += decoded_chunk
            except Exception as e:
                _logger.warning("[HARDWARE] Failed to decode ESP32 chunk: %s", e)
                continue
            
            # Process complete lines
            while "\n" in esp_read_buffer:
                line, esp_read_buffer = esp_read_buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                
                _logger.debug("[HARDWARE] <<< RECEIVED FROM ESP32: %r", line)
                
                # Check for printable characters
                has_printable = any(c.isprintable() for c in line)
                if not has_printable and len(line) > 0:
                    continue
                
                # Queue for internal consumers
                try:
                    line_q.put_nowait(line)
                except queue.Full:
                    try:
                        line_q.put(line, timeout=0.2)
                    except queue.Full:
                        _logger.warning("[HARDWARE] line_q FULL - dropping line")
                
                # Broadcast to SSE clients
                dead = [q for q in list(sse_clients) if not _put_sse(q, line)]
                for q in dead:
                    if q in sse_clients:
                        sse_clients.remove(q)
            
            # Prevent buffer overflow
            if len(esp_read_buffer) > 4096:
                last_nl = esp_read_buffer.rfind("\n")
                if last_nl >= 0:
                    esp_read_buffer = esp_read_buffer[last_nl + 1:]
                else:
                    esp_read_buffer = ""
            
            time.sleep(0.02)
            reopen_backoff = 1.0
            
        except OSError as e:
            err = str(e).lower()
            if "device reports readiness" in err or "returned no data" in err:
                time.sleep(0.05)
                continue
            _logger.error("[HARDWARE] ESP reader OSError: %s", e)
            _close_esp_ser()
            time.sleep(reopen_backoff)
            reopen_backoff = min(reopen_backoff * 2, max_backoff)
        except Exception as e:
            _logger.error("[HARDWARE] ESP reader error: %s", e, exc_info=True)
            _close_esp_ser()
            time.sleep(reopen_backoff)
            reopen_backoff = min(reopen_backoff * 2, max_backoff)


def _put_sse(q, msg):
    """Put message into SSE queue"""
    try:
        q.put_nowait(msg)
        return True
    except (queue.Full, Exception):
        return False


def _close_esp_ser():
    """Close ESP serial connection"""
    global esp_ser
    try:
        if esp_ser:
            try:
                esp_ser.close()
            except Exception:
                pass
        esp_ser = None
    except Exception:
        pass


def start_sse_stream():
    """Start SSE stream generator for browser"""
    from flask import Response
    
    def generate():
        client_q = queue.Queue(maxsize=100)
        sse_clients.append(client_q)
        _logger.info("[HARDWARE] SSE client connected (total: %d)", len(sse_clients))
        
        try:
            # Send initial connection message
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            
            while True:
                try:
                    msg = client_q.get(timeout=30.0)
                    yield f"data: {json.dumps({'type': 'data', 'line': msg})}\n\n"
                except queue.Empty:
                    # Send keepalive
                    yield f"data: {json.dumps({'type': 'keepalive'})}\n\n"
        except GeneratorExit:
            pass
        finally:
            if client_q in sse_clients:
                sse_clients.remove(client_q)
            _logger.info("[HARDWARE] SSE client disconnected (total: %d)", len(sse_clients))
    
    return Response(generate(), mimetype='text/event-stream')


def drain_queue(max_lines=10):
    """Drain response queue for testing/debugging"""
    lines = []
    for _ in range(max_lines):
        try:
            line = line_q.get_nowait()
            lines.append(line)
        except queue.Empty:
            break
    return lines, line_q.qsize()
