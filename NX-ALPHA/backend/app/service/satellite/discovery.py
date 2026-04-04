"""
AURA NX-Alpha — Satellite Network Discovery
Scans the local subnet for bootstrap agents (port 7778) and satellite agents (port 7779).

Uses asyncio.open_connection with 2-second timeouts for fast concurrent scanning.
Returns discovered endpoints with type classification.

USAGE:
    from app.service.satellite.discovery import scan_subnet
    results = await scan_subnet()  # scans all common LAN subnets
"""

from __future__ import annotations

import asyncio
import logging
import socket
from typing import Any

logger = logging.getLogger(__name__)

# Ports to scan
BOOTSTRAP_PORT = 7778
AGENT_PORT = 7779
SCAN_TIMEOUT = 2.0  # seconds per host
MAX_CONCURRENT = 50  # limit concurrent connections to avoid flooding

# Common ports used to detect ANY reachable LAN host (Windows & Linux)
# If a host responds on any of these we know it's alive, even without satellite software
_PRESENCE_PORTS = [22, 80, 135, 443, 445, 3389, 8080]


async def _probe_host(ip: str, port: int, timeout: float = SCAN_TIMEOUT) -> dict | None:
    """Attempt a TCP connection to ip:port. Returns endpoint info or None."""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port),
            timeout=timeout,
        )
        writer.close()
        await writer.wait_closed()
        port_type = "bootstrap" if port == BOOTSTRAP_PORT else "agent"
        return {"ip": ip, "port": port, "type": port_type}
    except (asyncio.TimeoutError, OSError, ConnectionRefusedError):
        return None


async def _probe_host_all_ports(ip: str, timeout: float = SCAN_TIMEOUT) -> list[dict]:
    """
    Probe a single IP for satellite ports AND common presence-detection ports.

    Returns:
        - {"ip", "port": 7778, "type": "bootstrap"} if bootstrap agent is running
        - {"ip", "port": 7779, "type": "agent"}     if satellite agent is running
        - {"ip", "port": <n>,  "type": "host"}      if machine is reachable but no satellite software
    """
    satellite_tasks = [
        _probe_host(ip, BOOTSTRAP_PORT, timeout),
        _probe_host(ip, AGENT_PORT, timeout),
    ]

    satellite_results: list[dict] = []
    for coro in asyncio.as_completed(satellite_tasks):
        r = await coro
        if r is not None:
            satellite_results.append(r)

    # If satellite ports found, return them — no need to check presence ports
    if satellite_results:
        return satellite_results

    # Check presence ports lazily — create each coroutine inside the loop so
    # unawaited coroutines are never created (avoids RuntimeWarning on early return)
    for p in _PRESENCE_PORTS:
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(ip, p), timeout=timeout)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return [{"ip": ip, "port": p, "type": "host"}]
        except (asyncio.TimeoutError, OSError, ConnectionRefusedError):
            continue
    return []


# Keep old name as alias for callers that use it directly
async def _probe_host_both_ports(ip: str, timeout: float = SCAN_TIMEOUT) -> list[dict]:
    return await _probe_host_all_ports(ip, timeout)


def _get_local_subnets() -> list[str]:
    """
    Detect all local LAN subnets (e.g., ['192.168.1', '10.0.0']).
    Tries multiple methods in order; deduplicates results.
    Returns at least one subnet or empty list if all methods fail.
    """
    subnets: list[str] = []

    # Method 1: UDP trick — connect to 8.8.8.8 (no data sent) to find preferred outbound IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(1)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        parts = local_ip.split(".")
        if len(parts) == 4 and parts[0] not in ("127", "169"):
            subnet = f"{parts[0]}.{parts[1]}.{parts[2]}"
            if subnet not in subnets:
                subnets.append(subnet)
    except Exception:
        pass

    # Method 2: hostname resolution — may return LAN IP on Windows
    try:
        host_ip = socket.gethostbyname(socket.gethostname())
        parts = host_ip.split(".")
        if len(parts) == 4 and parts[0] not in ("127", "169"):
            subnet = f"{parts[0]}.{parts[1]}.{parts[2]}"
            if subnet not in subnets:
                subnets.append(subnet)
    except Exception:
        pass

    # Method 3: try getaddrinfo for all interfaces (Python 3.8+)
    try:
        addrs = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        for addr in addrs:
            ip = addr[4][0]
            parts = ip.split(".")
            if len(parts) == 4 and parts[0] not in ("127", "169"):
                subnet = f"{parts[0]}.{parts[1]}.{parts[2]}"
                if subnet not in subnets:
                    subnets.append(subnet)
    except Exception:
        pass

    if not subnets:
        logger.warning("[discovery] Could not detect any local subnets — network scan may fail")
    else:
        logger.info("[discovery] Detected subnets: %s", subnets)

    return subnets


def _get_local_subnet() -> str | None:
    """Single-subnet compat wrapper for callers that only need one."""
    subnets = _get_local_subnets()
    return subnets[0] if subnets else None


async def scan_subnet(
    subnet: str | None = None,
    timeout: float = SCAN_TIMEOUT,
) -> list[dict[str, Any]]:
    """
    Scan one or more /24 subnets for AURA bootstrap agents and satellite agents.

    Args:
        subnet: Base subnet (e.g., "192.168.1"). Auto-detects all local subnets if None.
        timeout: TCP connection timeout per host.

    Returns:
        List of discovered endpoints:
        [
            {"ip": "192.168.1.42", "port": 7778, "type": "bootstrap"},
            {"ip": "192.168.1.99", "port": 7779, "type": "agent"},
        ]

    Raises:
        RuntimeError: If no local subnets can be detected and no subnet was provided.
    """
    if subnet:
        subnets_to_scan = [subnet]
    else:
        subnets_to_scan = _get_local_subnets()
        if not subnets_to_scan:
            raise RuntimeError(
                "Cannot determine local subnet — check network connectivity or provide subnet manually"
            )

    discovered: list[dict] = []
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def _bounded_probe(ip: str) -> list[dict]:
        async with semaphore:
            return await _probe_host_all_ports(ip, timeout)

    for sn in subnets_to_scan:
        logger.info("[discovery] Scanning %s.1-254 (satellite ports + presence detection)", sn)
        tasks = [_bounded_probe(f"{sn}.{i}") for i in range(1, 255)]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, list):
                discovered.extend(result)
            elif isinstance(result, Exception):
                logger.debug("[discovery] Probe exception: %s", result)

    # Deduplicate by (ip, port)
    seen: set[tuple] = set()
    unique: list[dict] = []
    for ep in discovered:
        key = (ep["ip"], ep["port"])
        if key not in seen:
            seen.add(key)
            unique.append(ep)

    logger.info("[discovery] Scan complete — found %d endpoint(s) across %s", len(unique), subnets_to_scan)
    return unique


async def probe_single_host(ip: str, timeout: float = SCAN_TIMEOUT) -> list[dict]:
    """Probe a single IP for AURA services. Used for manual IP entry."""
    return await _probe_host_both_ports(ip, timeout)
