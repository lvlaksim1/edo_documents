from __future__ import annotations

import subprocess
import sys
from pathlib import Path

MAX_TRACKED_FILE_BYTES = 5 * 1024 * 1024
FORBIDDEN_SUFFIXES = {".exe", ".msi", ".zip", ".7z", ".rar", ".dll", ".pdb"}


def tracked_files(repository_root: Path) -> list[Path]:
    completed = subprocess.run(["git", "ls-files", "-z"], cwd=repository_root, check=True, capture_output=True)
    return [repository_root / raw.decode("utf-8") for raw in completed.stdout.split(b"\0") if raw]


def violations(repository_root: Path) -> list[str]:
    result: list[str] = []
    for path in tracked_files(repository_root):
        if not path.is_file():
            continue
        relative = path.relative_to(repository_root).as_posix()
        size = path.stat().st_size
        suffix = path.suffix.lower()
        if suffix in FORBIDDEN_SUFFIXES:
            result.append(f"{relative}: forbidden tracked binary/archive type {suffix}")
        if size > MAX_TRACKED_FILE_BYTES:
            result.append(f"{relative}: {size:,} bytes exceeds {MAX_TRACKED_FILE_BYTES:,}-byte tracked-file limit")
    return result


def main() -> int:
    repository_root = Path(__file__).resolve().parents[1]
    found = violations(repository_root)
    if found:
        print("Repository storage policy violations:", file=sys.stderr)
        for item in found:
            print(f" - {item}", file=sys.stderr)
        print("\nLarge distributables belong in the current GitHub Release, not Git history.", file=sys.stderr)
        return 1
    print("Repository storage policy OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
