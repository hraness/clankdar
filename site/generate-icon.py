#!/usr/bin/env python3
"""Regenerate the current header-derived favicon set with the guarded renderer."""
import subprocess
from pathlib import Path

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    subprocess.run(["bun", "site/generate-icon-512.ts"], cwd=root, check=True)
