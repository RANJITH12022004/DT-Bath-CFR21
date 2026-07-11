#!/usr/bin/env python3
"""
network_service.py - List local network addresses (excluding Tailscale).
"""

import re
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

_TAILSCALE_IPV4_RE = re.compile(r"^100\.")
_TAILSCALE_IPV6_PREFIXES = ("fd7a:", "fe80:")


def _is_tailscale_address(family: str, address: str) -> bool:
    addr = str(address or "").strip().lower()
    if not addr:
        return True
    if family == "ipv4":
        if addr.startswith("127.") or _TAILSCALE_IPV4_RE.match(addr):
            return True
        return False
    if addr.startswith("::1"):
        return True
    for prefix in _TAILSCALE_IPV6_PREFIXES:
        if addr.startswith(prefix):
            return True
    return False


def _parse_ip_addr_show() -> List[Dict[str, str]]:
    """Parse `ip -o addr show` for global/up interfaces."""
    try:
        proc = subprocess.run(
            ["ip", "-o", "addr", "show", "scope", "global", "up"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return []
    rows: List[Dict[str, str]] = []
    seen = set()
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        iface = parts[1]
        if iface == "lo":
            continue
        family_token = parts[2]
        cidr = parts[3]
        if family_token not in ("inet", "inet6"):
            continue
        family = "ipv4" if family_token == "inet" else "ipv6"
        address = cidr.split("/", 1)[0]
        if _is_tailscale_address(family, address):
            continue
        key = (iface, family, address)
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            {
                "interface": iface,
                "family": family,
                "address": address,
            }
        )
    return rows


def _interface_kind(iface: str) -> Optional[str]:
    """Map interface name to wlan or lan; ignore other interfaces."""
    name = str(iface or "").strip().lower()
    if name.startswith("wlan") or name.startswith("wl"):
        return "wlan"
    if name.startswith("eth") or name.startswith("en") or name.startswith("lan"):
        return "lan"
    return None


def list_non_tailscale_addresses() -> Dict[str, Any]:
    """Return WLAN and LAN IPv4 addresses only; hide Tailscale (100.x.x.x)."""
    addresses = _parse_ip_addr_show()
    wlan_ip: Optional[str] = None
    lan_ip: Optional[str] = None
    for row in addresses:
        if str(row.get("family") or "").lower() != "ipv4":
            continue
        kind = _interface_kind(row.get("interface") or "")
        addr = str(row.get("address") or "").strip()
        if not kind or not addr:
            continue
        if kind == "wlan" and wlan_ip is None:
            wlan_ip = addr
        elif kind == "lan" and lan_ip is None:
            lan_ip = addr
    refreshed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "ok": True,
        "wlan": wlan_ip,
        "lan": lan_ip,
        "refreshedAt": refreshed_at,
    }
