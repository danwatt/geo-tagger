"""Write the API's OpenAPI schema to frontend/openapi.json.

The React frontend generates its TypeScript API types from that file
(`npm run gen:api` runs this script, then openapi-typescript). Building the app
needs no server, scan root or database: the schema comes from the route
declarations alone. tests/test_openapi_schema.py fails when the committed file is
stale, so a backend change that alters the API shows up as a diff to regenerate.

Usage:
    uv run python scripts/export_openapi.py
"""

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "frontend" / "openapi.json"


def render() -> str:
    from geotagger.main import create_app
    # sort_keys + trailing newline: a stable file, so regenerating without an API
    # change produces no diff.
    return json.dumps(create_app().openapi(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    OUT.write_text(render(), encoding="utf-8")
    print(f"Wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
