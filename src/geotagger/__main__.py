import argparse
import os
import sys
from pathlib import Path

import uvicorn


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
        type=int,
        default=4,
        help="Number of worker threads for thumbnail generation (default: 4)"
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

    # Set worker threads
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

    # Determine host to bind to
    if args.network:
        bind_host = "0.0.0.0"
        print("Binding to all network interfaces (0.0.0.0) - accessible from local network")
    elif args.host:
        bind_host = args.host
    else:
        bind_host = HOST

    bind_port = args.port if args.port else PORT

    # Print access information
    if bind_host == "0.0.0.0":
        import socket
        print(f"\nWARNING: --network exposes Geo-Tagger to your entire local network with")
        print(f"NO AUTHENTICATION. Anyone who can reach this port can browse every photo,")
        print(f"rewrite geotags, edit sidecar files, and rename people. Only use this on a")
        print(f"network you trust.")
        print(f"\nBinding to 0.0.0.0:{bind_port}")
        print(f"Server will be accessible at:")
        print(f"  - http://localhost:{bind_port} (this computer)")

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
                    print(f"  - http://{ip}:{bind_port} (from local network)")
            else:
                # Fallback
                local_ip = socket.gethostbyname(hostname)
                print(f"  - http://{local_ip}:{bind_port} (from local network)")
        except Exception as e:
            print(f"  Could not determine local IP: {e}")

        print("\nNOTE: If you cannot connect from another device:")
        print("  1. Check Windows Firewall - you may need to allow port", bind_port)
        print("  2. Ensure devices are on the same network")
        print("  3. Try accessing from this computer first using the IP above")
        print()
    else:
        print(f"Server accessible at: http://{bind_host}:{bind_port}")

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
