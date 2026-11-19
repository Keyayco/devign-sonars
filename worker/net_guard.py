"""
worker/net_guard.py — SONARS Outbound RSS SSRF, DNS-Rebinding & Redirect Guard
==============================================================================
Validates outbound RSS URLs and resolves DNS records before opening a socket,
connecting directly to the validated pinned IP (with TLS SNI for HTTPS) and
re-validating every HTTP redirect target.
"""

import http.client
import ipaddress
import os
import re
import socket
import ssl
import urllib.parse
from typing import Any, Callable, Optional


class SSRFBlockedError(ValueError):
    """Raised when a URL, resolved IP, or redirect target violates SSRF policy."""


BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "metadata",
    "metadata.google.internal",
    "ip6-localhost",
    "ip6-loopback",
}

CGNAT_NET = ipaddress.IPv4Network("100.64.0.0/10")
NAT64_NET = ipaddress.IPv6Network("64:ff9b::/96")
NAT64_LOCAL_NET = ipaddress.IPv6Network("64:ff9b:1::/48")
MAX_REDIRECTS = 3
MAX_BODY_BYTES = 5 * 1024 * 1024  # 5 MiB guard


def is_prohibited_ip(raw_ip: str) -> bool:
    """Return True if raw_ip belongs to any non-public/prohibited network range."""
    clean = str(raw_ip or "").strip().strip("[]")
    if not clean or "%" in clean:
        return True
    try:
        ip = ipaddress.ip_address(clean)
    except ValueError:
        return True

    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return is_prohibited_ip(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return is_prohibited_ip(str(ip.sixtofour))
        if ip.teredo is not None:
            return is_prohibited_ip(str(ip.teredo[0])) or is_prohibited_ip(str(ip.teredo[1]))
        if ip in NAT64_NET or ip in NAT64_LOCAL_NET:
            return True

    if isinstance(ip, ipaddress.IPv4Address) and ip in CGNAT_NET:
        return True

    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    )


def is_blocked_hostname(hostname: str) -> bool:
    host = str(hostname or "").strip().lower().rstrip(".")
    if not host:
        return True
    if host in BLOCKED_HOSTNAMES:
        return True
    if host.endswith((".localhost", ".local", ".internal", ".localdomain")):
        return True
    if re.fullmatch(r"(0x[0-9a-f]+|\d+|0[0-7]+)", host, re.IGNORECASE):
        return True
    return False


def _can_allow_test_private(allow_private_for_test: bool) -> bool:
    if os.environ.get("NODE_ENV") == "production":
        return False
    return bool(allow_private_for_test)


def _default_resolver(hostname: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    ips: list[str] = []
    for info in infos:
        sockaddr = info[4]
        if sockaddr and sockaddr[0] not in ips:
            ips.append(sockaddr[0])
    return ips


def validate_and_resolve_url(
    url: str,
    *,
    allow_private_for_test: bool = False,
    resolver: Optional[Callable[[str, int], list[str]]] = None,
) -> tuple[str, str, int, str, list[str]]:
    """
    Validate URL syntax, scheme, hostname, and DNS-resolved IPs.
    Returns (scheme, host, port, path_and_query, resolved_ips).
    """
    allow_test = _can_allow_test_private(allow_private_for_test)
    raw = str(url or "").strip()
    try:
        parsed = urllib.parse.urlsplit(raw)
    except Exception as exc:
        raise SSRFBlockedError(f"Malformed URL: {exc}") from exc

    scheme = parsed.scheme.lower()
    if scheme != "https" and not (allow_test and scheme == "http"):
        raise SSRFBlockedError(f"Disallowed scheme '{scheme}': https required")

    if parsed.username or parsed.password:
        raise SSRFBlockedError("Embedded URL credentials are not allowed")

    host = (parsed.hostname or "").strip()
    if not host:
        raise SSRFBlockedError("URL missing hostname")

    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError as exc:
        raise SSRFBlockedError(f"Invalid port: {exc}") from exc

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    if not allow_test and is_blocked_hostname(host):
        raise SSRFBlockedError(f"Blocked internal hostname: {host}")

    # Literal IP check
    try:
        ipaddress.ip_address(host.strip("[]"))
        is_literal_ip = True
    except ValueError:
        is_literal_ip = False

    if is_literal_ip:
        if not allow_test and is_prohibited_ip(host):
            raise SSRFBlockedError(f"Blocked private/reserved IP: {host}")
        return scheme, host, port, path, [host.strip("[]")]

    resolve_fn = resolver or _default_resolver
    try:
        resolved_ips = resolve_fn(host, port)
    except Exception as exc:
        raise SSRFBlockedError(f"DNS lookup failed for {host}: {exc}") from exc

    if not resolved_ips:
        raise SSRFBlockedError(f"DNS resolved no addresses for {host}")

    if not allow_test:
        for ip_str in resolved_ips:
            if is_prohibited_ip(ip_str):
                raise SSRFBlockedError(f"Hostname {host} resolved to prohibited IP {ip_str}")

    return scheme, host, port, path, resolved_ips


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection pinning socket dial to validated_ip while preserving TLS SNI."""

    def __init__(self, host: str, port: int, pinned_ip: str, timeout: float, context: ssl.SSLContext):
        super().__init__(host=host, port=port, timeout=timeout, context=context)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        raw_sock = socket.create_connection((self._pinned_ip, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(raw_sock, server_hostname=self.host)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTP connection pinning socket dial to validated_ip while keeping Host header."""

    def __init__(self, host: str, port: int, pinned_ip: str, timeout: float):
        super().__init__(host=host, port=port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout, self.source_address)


def safe_fetch_bytes(
    url: str,
    headers: Optional[dict[str, str]] = None,
    *,
    method: str = "GET",
    body: Optional[bytes] = None,
    timeout: float = 15.0,
    max_redirects: int = MAX_REDIRECTS,
    allow_private_for_test: bool = False,
    resolver: Optional[Callable[[str, int], list[str]]] = None,
) -> dict[str, Any]:
    """
    Fetch URL safely with:
      • strict scheme, hostname, and IP range validation
      • pinned IP socket dialing (DNS-rebinding mitigation)
      • re-validation of every redirect target (no blind redirect following)
      • optional POST request body for authorized OAuth / Overpass API queries
    """
    req_method = str(method or "GET").upper().strip()
    if req_method not in ("GET", "POST"):
        raise ValueError(f"Unsupported HTTP method: {req_method}")

    current_url = url
    req_headers = dict(headers or {})
    req_body = body
    ssl_ctx = ssl.create_default_context()

    for hop in range(max_redirects + 1):
        scheme, host, port, path, ips = validate_and_resolve_url(
            current_url,
            allow_private_for_test=allow_private_for_test,
            resolver=resolver,
        )
        pinned_ip = ips[0]

        conn: http.client.HTTPConnection
        if scheme == "https":
            conn = _PinnedHTTPSConnection(host, port, pinned_ip, timeout, ssl_ctx)
        else:
            conn = _PinnedHTTPConnection(host, port, pinned_ip, timeout)

        try:
            conn.request(req_method, path, body=req_body, headers=req_headers)
            resp = conn.getresponse()
            status = int(resp.status)
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}

            if status in (301, 302, 303, 307, 308):
                location = resp_headers.get("location", "").strip()
                resp.read(1024)
                if not location:
                    return {"status": status, "headers": resp_headers, "body": b""}
                if hop >= max_redirects:
                    raise SSRFBlockedError("Exceeded maximum safe redirect hops")
                if status in (301, 302, 303) and req_method == "POST":
                    req_method = "GET"
                    req_body = None
                current_url = urllib.parse.urljoin(current_url, location)
                continue

            body_bytes = resp.read(MAX_BODY_BYTES + 1)
            if len(body_bytes) > MAX_BODY_BYTES:
                raise ValueError("Feed response exceeded maximum allowed size")
            return {"status": status, "headers": resp_headers, "body": body_bytes}
        finally:
            conn.close()

    raise SSRFBlockedError("Exceeded maximum safe redirect hops")
