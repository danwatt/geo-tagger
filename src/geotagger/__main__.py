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

    uvicorn.run(
        "geotagger.main:app",
        host=args.host if args.host else HOST,
        port=args.port if args.port else PORT,
        reload=False,
        limit_concurrency=None,  # Remove connection limit
        backlog=2048,  # Increase connection backlog
    )


if __name__ == "__main__":
    main()
