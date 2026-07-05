#!/usr/bin/env python3
"""Build the reference-data update pack the app's DATA channel downloads.

Produces ``dist-data/`` at the repo root with three artifacts:

  drops.sqlite        copy of assets/data/drops.sqlite
  triggers.zip        every *.json under triggers/ (curated + generated +
                      default.json), repo layout preserved, deterministic
                      (sorted entries, fixed timestamps) so re-running on
                      unchanged inputs yields byte-identical output
  data-manifest.json  {"version": ..., "files": [{name, sha256, bytes}, ...]}

The app fetches data-manifest.json from the rolling `data-latest` GitHub
release of Menthule/legends-companion, then downloads + sha256-verifies each
file (see app/src-tauri/src/datapack.rs).

Usage:
  python tools/release/make_data_pack.py [YYYY-MM-DD]

The optional argument sets the manifest version; it defaults to today's
date (UTC). Idempotent: safe to re-run, always rebuilds dist-data/ from the
current repo contents. Finishes by printing the `gh release` commands that
publish (or re-publish) the artifacts to the `data-latest` tag.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

REPO = "Menthule/legends-companion"
TAG = "data-latest"

ROOT = Path(__file__).resolve().parents[2]
TRIGGERS_DIR = ROOT / "triggers"
DROPS_DB = ROOT / "assets" / "data" / "drops.sqlite"
DIST = ROOT / "dist-data"

# Fixed timestamp for zip entries (zip's epoch) — keeps triggers.zip
# byte-identical across runs when the trigger files haven't changed.
ZIP_DATE_TIME = (1980, 1, 1, 0, 0, 0)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_triggers_zip(dest: Path) -> None:
    """Zip every *.json under triggers/, arcnames relative to triggers/.

    The app extracts this into <data_root>/refdata-update/triggers/, which
    library::packs_dir then loads recursively — so the archive must mirror
    the repo's triggers/ layout (curated/, generated/, default.json).
    """
    files = sorted(p for p in TRIGGERS_DIR.rglob("*.json") if p.is_file())
    if not files:
        sys.exit(f"error: no *.json packs found under {TRIGGERS_DIR}")
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            arcname = path.relative_to(TRIGGERS_DIR).as_posix()
            info = zipfile.ZipInfo(arcname, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16  # rw-r--r--
            zf.writestr(info, path.read_bytes())
    print(f"  triggers.zip: {len(files)} packs")


def main() -> None:
    if len(sys.argv) > 2:
        sys.exit(__doc__)
    if len(sys.argv) == 2:
        version = sys.argv[1]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", version):
            sys.exit(f"error: version must be YYYY-MM-DD, got {version!r}")
    else:
        version = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")

    if not DROPS_DB.is_file():
        sys.exit(f"error: {DROPS_DB} not found (run tools/dropdata first)")

    DIST.mkdir(exist_ok=True)
    print(f"Building data pack {version} -> {DIST}")

    shutil.copyfile(DROPS_DB, DIST / "drops.sqlite")
    build_triggers_zip(DIST / "triggers.zip")

    files = []
    for name in ("drops.sqlite", "triggers.zip"):
        path = DIST / name
        entry = {
            "name": name,
            "sha256": sha256_of(path),
            "bytes": path.stat().st_size,
        }
        files.append(entry)
        print(f"  {name}: {entry['bytes']} bytes, sha256 {entry['sha256'][:16]}…")

    manifest = {"version": version, "files": files}
    manifest_path = DIST / "data-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"  data-manifest.json: version {version}")

    artifacts = " \\\n    ".join(
        str((DIST / n).relative_to(ROOT))
        for n in ("data-manifest.json", "drops.sqlite", "triggers.zip")
    )
    print(
        f"""
Publish (from {ROOT}):

  # First time only — create the rolling release:
  gh release create {TAG} -R {REPO} \\
    --title "Reference data (rolling)" \\
    --notes "Rolling reference-data channel consumed by the app's Updates section." \\
    {artifacts}

  # Every update after that — overwrite the same tag's assets:
  gh release upload {TAG} -R {REPO} --clobber \\
    {artifacts}
"""
    )


if __name__ == "__main__":
    main()
