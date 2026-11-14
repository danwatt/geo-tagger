"""Request-origin protection for a no-auth local server.

Two attacks work against an unauthenticated app bound to 127.0.0.1:
  * cross-site requests: any page the user visits can POST a form to
    http://127.0.0.1:8000/api/... (body-less POSTs need no CORS preflight);
  * DNS rebinding: a hostile domain re-resolves to 127.0.0.1, making its pages
    "same-origin" with the app.
RequestGuard stops both with a Host allow-list and an Origin / Sec-Fetch-Site check.
A third attack applies only off loopback (`--network`): any machine on the LAN can just
talk to the app. There RequestGuard also demands an access token (config.ACCESS_TOKEN),
sent as a cookie (set once by opening `/?token=...`) or an `Authorization: Bearer` header.
Pure ASGI (not BaseHTTPMiddleware) so hot routes like thumbnails pay no wrapper cost."""

import hmac
import ipaddress
import json
import socket
from urllib.parse import parse_qsl, urlencode

from geotagger import config

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_DEFAULT_PORTS = {"http": "80", "https": "443", "ws": "80", "wss": "443"}
# The app's own pages only ever produce "same-origin" (fetch, form posts) or "none"
# (typed URL, bookmark). "same-site" is rejected too: ports are ignored when computing a
# site, so another dev server on localhost:3000 counts as same-site with localhost:8000.
_BLOCKED_FETCH_SITES = {"cross-site", "same-site"}
TOKEN_COOKIE = "geotagger_token"
TOKEN_PARAM = "token"


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


def _token_ok(candidate: str | None) -> bool:
    # Constant-time compare so response timing can't leak the token prefix by prefix.
    return candidate is not None and hmac.compare_digest(candidate.encode(), config.ACCESS_TOKEN.encode())


def _cookie(header: str, name: str) -> str | None:
    for part in header.split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == name:
            return value.strip().strip('"')
    return None


def _bearer(header: str) -> str | None:
    scheme, _, value = header.strip().partition(" ")
    return value.strip() if scheme.lower() == "bearer" and value.strip() else None


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
            # 400, like Starlette's TrustedHostMiddleware: the request is malformed for
            # this server rather than a permission problem.
            await self._deny(scope, receive, send, 400,
                             "Host not allowed. If you reach this app by a custom name, add it to "
                             "the GEOTAGGER_ALLOWED_HOSTS environment variable (comma-separated).")
            return

        # Requests with neither Origin nor Sec-Fetch-Site pass: browsers always send
        # Origin on non-GET requests (form posts included), so their absence means a
        # non-browser client (curl, a script), which is no cross-site threat - it could
        # forge any header it liked anyway.
        if scope["type"] == "http" and scope["method"] not in _SAFE_METHODS:
            origin = headers.get("origin")
            if origin is not None and not _origin_matches_host(origin, host_header):
                await self._deny(scope, receive, send, 403, "Cross-origin request blocked (Origin does not match Host).")
                return
            if headers.get("sec-fetch-site", "").lower() in _BLOCKED_FETCH_SITES:
                await self._deny(scope, receive, send, 403, "Cross-site request blocked.")
                return

        if config.ACCESS_TOKEN:  # module-attribute access: __main__ and tests set it
            if not (_token_ok(_cookie(headers.get("cookie", ""), TOKEN_COOKIE))
                    or _token_ok(_bearer(headers.get("authorization", "")))):
                if scope["type"] == "http" and await self._token_login(scope, send):
                    return
                await self._deny(scope, receive, send, 401,
                                 "Access token required. Open the URL with ?token=... that the "
                                 "server printed at startup, or send 'Authorization: Bearer <token>'.")
                return

        await self.app(scope, receive, send)

    @staticmethod
    async def _token_login(scope, send) -> bool:
        """`GET /any/path?token=<valid>`: set the cookie and redirect to the same URL
        without the token, so it doesn't linger in the address bar, history or a
        Referer header. False when the query carries no valid token."""
        if scope["method"] not in ("GET", "HEAD"):
            return False
        params = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
        supplied = [v for k, v in params if k == TOKEN_PARAM]
        if not supplied or not _token_ok(supplied[-1]):
            return False
        rest = urlencode([(k, v) for k, v in params if k != TOKEN_PARAM])
        path = scope.get("raw_path") or scope["path"].encode()
        location = path.decode("latin-1") + (f"?{rest}" if rest else "")
        # HttpOnly: page scripts never need it. SameSite=Lax (not Strict) so the first
        # visit still works when the URL was opened from a link in another app/site;
        # cross-site writes are already stopped by the Origin check above.
        cookie = f"{TOKEN_COOKIE}={config.ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax"
        await send({"type": "http.response.start", "status": 303, "headers": [
            (b"location", location.encode("latin-1")),
            (b"set-cookie", cookie.encode("latin-1")),
            (b"content-length", b"0"),
        ]})
        await send({"type": "http.response.body", "body": b""})
        return True

    @staticmethod
    async def _deny(scope, receive, send, status: int, detail: str) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ]})
        await send({"type": "http.response.body", "body": body})
