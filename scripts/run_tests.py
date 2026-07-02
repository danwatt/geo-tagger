"""
Run the test suite with a coverage report.

Run:  uv run python scripts/run_tests.py
      uv run python scripts/run_tests.py --open      # also open the HTML report
      uv run python scripts/run_tests.py -k guess     # extra args forwarded to pytest
"""
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).parent.parent
HTML_REPORT = ROOT / "htmlcov" / "index.html"


def main():
    args = sys.argv[1:]
    open_report = "--open" in args
    if open_report:
        args.remove("--open")

    cmd = [
        sys.executable, "-m", "pytest",
        "--cov=geotagger",
        "--cov-report=term-missing",
        "--cov-report=html",
        *args,
    ]
    result = subprocess.run(cmd, cwd=ROOT)

    if open_report and HTML_REPORT.exists():
        webbrowser.open(HTML_REPORT.as_uri())
    elif result.returncode == 0 or HTML_REPORT.exists():
        print(f"\nHTML coverage report: {HTML_REPORT}")

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
