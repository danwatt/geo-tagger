"""Request-origin protection for a no-auth local server.

Two attacks work against an unauthenticated app bound to 127.0.0.1:
  * cross-site requests: any page the user visits can POST a form to
    http://127.0.0.1:8000/api/... (body-less POSTs need no CORS preflight);
  * DNS rebinding: a hostile domain re-resolves to 127.0.0.1, making its pages
    "same-origin" with the app.
RequestGuard stops both with a Host allow-list and an Origin / Sec-Fetch-Site check.
Pure ASGI (not BaseHTTPMiddleware) so hot routes like thumbnails pay no wrapper cost."""

import ipaddress
import json
import socket

from geotagger import config

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_DEFAULT_PORTS = {"http": "80", "https": "443", "ws": "80", "wss": "443"}


def _split_host(value: str) -> tuple[str, str]:
    """'Host:port' -> (lowercased host, port or ''). Handles bracketed IPv6 ('[::1]:8000')
    and bare IPv6 literals; the returned host has no brackets."""
    value = value.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        if end == -1:
            return value, ""
        rest = value[end + 1:]
        return value[1:end], rest[1:] if rest.startswith(":") else ""
    if value.count(":") > 1:  # unbracketed IPv6 literal, no port
        return value, ""
    host, _, port = value.partition(":")
    return host, port


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host.split("%", 1)[0])  # drop any IPv6 zone id
        return True
    except ValueError:
        return False


def _host_allowed(host: str) -> bool:
    if not host:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    # An IP-literal Host can't be a rebinding attack (that needs a DNS name), and this
    # keeps LAN access via --network working without knowing the bind address.
    if _is_ip(host):
        return True
    machine = socket.gethostname().lower()
    if host in (machine, f"{machine}.local"):
        return True
    return host in config.ALLOWED_HOSTS  # module-attribute access: tests monkeypatch it


def _origin_matches_host(origin: str, host_header: str) -> bool:
    scheme, sep, rest = origin.strip().lower().partition("://")
    if not sep or not rest:  # "null", garbage
        return False
    o_host, o_port = _split_host(rest.split("/", 1)[0])
    h_host, h_port = _split_host(host_header)
    # Browsers omit default ports from Origin, and clients may omit them from Host too.
    default = _DEFAULT_PORTS.get(scheme, "")
    return o_host == h_host and (o_port or default) == (h_port or default)


class RequestGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        host_header = headers.get("host", "")

        if not _host_allowed(_split_host(host_header)[0]):
            await self._deny(scope, receive, send,
                             "Host not allowed. If you reach this app by a custom name, add it to "
                             "the GEOTAGGER_ALLOWED_HOSTS environment variable (comma-separated).")
            return

        if scope["type"] == "http" and scope["method"] not in _SAFE_METHODS:
            origin = headers.get("origin")
            if origin is not None and not _origin_matches_host(origin, host_header):
                await self._deny(scope, receive, send, "Cross-origin request blocked (Origin does not match Host).")
                return
            if headers.get("sec-fetch-site", "").lower() == "cross-site":
                await self._deny(scope, receive, send, "Cross-site request blocked.")
                return

        await self.app(scope, receive, send)

    @staticmethod
    async def _deny(scope, receive, send, detail: str) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": 403, "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ]})
        await send({"type": "http.response.body", "body": body})
