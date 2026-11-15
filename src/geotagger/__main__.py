import argparse
import ipaddress
import os
import sys
from pathlib import Path

import uvicorn

# Hosts that listen on every interface rather than a single address.
_WILDCARD_HOSTS = ("0.0.0.0", "::")


def _is_loopback(host: str) -> bool:
    """True only when the bind host can be reached from this computer alone.

    Anything else (wildcards, LAN addresses, ordinary hostnames) exposes the
    unauthenticated app to other machines, so callers warn on False.
    """
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # Not an IP literal (hostname, empty string, ...). Treat as non-loopback
        # rather than guessing how the resolver would map it.
        return False


def _token_is_cookie_safe(token: str) -> bool:
    """The token travels in a cookie and a URL query, so keep it to characters that
    need no quoting in either (secrets.token_urlsafe output always qualifies)."""
    return all(c.isascii() and (c.isalnum() or c in "-_.") for c in token)


def _positive_int(value: str) -> int:
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected an integer, got {value!r}")
    if n < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, got {n}")
    return n


def main():
    parser = argparse.ArgumentParser(description="Geo-Tagger: Photo geotagging tool")
    parser.add_argument(
        "--cache-dir",
        type=str,
        help="Cache directory for database and thumbnails (overrides GEOTAGGER_CACHE_DIR)"
    )
    parser.add_argument(
        "--scan-dir",
        type=str,
        action="append",
        dest="scan_dirs",
        help="Directory to scan for photos (can be specified multiple times)"
    )
    parser.add_argument(
        "--host",
        type=str,
        help="Host to bind to (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--network",
        action="store_true",
        help="Bind to all network interfaces (0.0.0.0) to allow access from local network"
    )
    parser.add_argument(
        "--port",
        type=int,
        help="Port to bind to (default: 8000)"
    )
    parser.add_argument(
        "--workers",
        type=_positive_int,
        # None (not 4) so an unset flag leaves GEOTAGGER_WORKERS from the
        # environment alone; config.get_workers() falls back to 4 when it is unset.
        default=None,
        help="Worker thread count for the shared request thread pool and the scan pool "
             "(default: 4, or the GEOTAGGER_WORKERS environment variable if set)"
    )
    parser.add_argument(
        "--no-scan",
        action="store_true",
        help="Skip automatic directory scanning at startup (assumes database is up-to-date)"
    )

    args = parser.parse_args()

    # Set cache directory in environment if specified
    if args.cache_dir:
        os.environ["GEOTAGGER_CACHE_DIR"] = str(Path(args.cache_dir).resolve())

    # Set worker threads only when the flag was given, so a pre-set
    # GEOTAGGER_WORKERS in the environment is respected.
    if args.workers is not None:
        os.environ["GEOTAGGER_WORKERS"] = str(args.workers)

    # Set no-scan flag
    if args.no_scan:
        os.environ["GEOTAGGER_NO_SCAN"] = "1"

    # Store scan directories in environment for main.py to pick up
    if args.scan_dirs:
        # Validate directories
        for scan_dir in args.scan_dirs:
            p = Path(scan_dir)
            if not p.is_dir():
                print(f"Error: Not a directory: {scan_dir}", file=sys.stderr)
                sys.exit(1)
        # Store as newline-separated paths
        os.environ["GEOTAGGER_SCAN_DIRS"] = "\n".join(str(Path(d).resolve()) for d in args.scan_dirs)

    # Import config after setting env vars
    from geotagger.config import HOST, PORT
    from geotagger import index

    # Require a scan directory on first run: refuse to boot a server with no
    # library configured (bare `geotagger` used to start a server where every
    # API call failed because no db was ever initialized).
    if not args.scan_dirs and not index.get_last_scan_roots():
        print("Error: no photo library configured yet.", file=sys.stderr)
        print("Pass --scan-dir <path> to point Geo-Tagger at a photo folder on first run.", file=sys.stderr)
        print("Example: uv run geotagger --scan-dir C:\\Photos", file=sys.stderr)
        sys.exit(1)

    # Ported pages (frontend/) only exist once built; without the build their URLs 404.
    from geotagger.static import frontend_built
    if not frontend_built():
        print("Warning: the React frontend is not built, so ported pages (Home, Settings, Data) will 404.", file=sys.stderr)
        print("Build it once with: npm --prefix frontend ci && npm --prefix frontend run build", file=sys.stderr)

    # Determine host to bind to
    if args.network:
        bind_host = "0.0.0.0"
        print("Binding to all network interfaces (0.0.0.0) - accessible from local network")
    elif args.host:
        bind_host = args.host
    else:
        bind_host = HOST

    bind_port = args.port if args.port else PORT

    # IPv6 literals need brackets in a URL, or the port is parsed as part of the address.
    url_host = f"[{bind_host}]" if ":" in bind_host else bind_host

    # Any non-loopback bind is reachable from other machines, not just the 0.0.0.0
    # wildcard, so it always gets an access token (middleware.RequestGuard enforces it).
    # Set on the config module (not just the env) because it is already imported, and
    # uvicorn.run below loads the app in this same process.
    from geotagger import config
    if not _is_loopback(bind_host) and not config.ACCESS_TOKEN:
        import secrets
        config.ACCESS_TOKEN = secrets.token_urlsafe(24)
    if config.ACCESS_TOKEN and not _token_is_cookie_safe(config.ACCESS_TOKEN):
        print("Error: GEOTAGGER_TOKEN may only contain letters, digits, '-', '_' and '.'", file=sys.stderr)
        sys.exit(1)
    # Appended to every printed URL: opening it once stores the token in a cookie.
    token_qs = f"/?token={config.ACCESS_TOKEN}" if config.ACCESS_TOKEN else ""

    # Print access information
    if _is_loopback(bind_host):
        print(f"Server accessible at: http://{url_host}:{bind_port}{token_qs}")
    else:
        print(f"\nWARNING: binding to {bind_host} exposes Geo-Tagger to your local network.")
        print("Access needs the token below (open a URL with ?token=... once per browser, or")
        print("send 'Authorization: Bearer <token>'), but traffic is plain HTTP: anyone who")
        print("can sniff the network can read it. Only use this on a network you trust.")
        print(f"Access token: {config.ACCESS_TOKEN}")

    if bind_host in _WILDCARD_HOSTS:
        import socket
        print(f"\nBinding to {url_host}:{bind_port}")
        print("Server will be accessible at:")
        print(f"  - http://localhost:{bind_port}{token_qs} (this computer)")

        # Try to get all local IP addresses
        try:
            hostname = socket.gethostname()
            # Get all IP addresses associated with this host
            ip_list = socket.getaddrinfo(hostname, None, socket.AF_INET)
            ips = set()
            for addr_info in ip_list:
                ip = addr_info[4][0]
                if not ip.startswith("127."):
                    ips.add(ip)

            if ips:
                for ip in sorted(ips):
                    print(f"  - http://{ip}:{bind_port}{token_qs} (from local network)")
            else:
                # Fallback
                local_ip = socket.gethostbyname(hostname)
                print(f"  - http://{local_ip}:{bind_port}{token_qs} (from local network)")
        except Exception as e:
            print(f"  Could not determine local IP: {e}")

        print("\nNOTE: If you cannot connect from another device:")
        print("  1. Check Windows Firewall - you may need to allow port", bind_port)
        print("  2. Ensure devices are on the same network")
        print("  3. Try accessing from this computer first using the IP above")
        print()
    elif not _is_loopback(bind_host):
        # Specific LAN address: one URL is enough, the interface list is only
        # useful when we don't know which address the user should pick.
        print(f"\nServer accessible at: http://{url_host}:{bind_port}{token_qs}")

    uvicorn.run(
        "geotagger.main:app",
        host=bind_host,
        port=bind_port,
        reload=False,
        limit_concurrency=None,  # Remove connection limit
        backlog=2048,  # Increase connection backlog
    )


if __name__ == "__main__":
    main()
