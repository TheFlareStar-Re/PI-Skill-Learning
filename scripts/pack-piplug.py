"""Pack plugin as store-only .piplug (PI installer rejects deflated entries)."""
from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INCLUDE = [
    "manifest.json",
    "main.js",
    "README.md",
    "src/extension.js",
    "src/skill-store.js",
    "src/review-prompt.js",
    "src/review-apply.js",
    "src/prompt-compose.js",
    "skills/skill-learning.md",
    "views/library.html",
]


def main() -> None:
    import json

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    plugin_id = manifest["id"]
    version = manifest["version"]
    out = ROOT / "dist" / f"{plugin_id}-{version}.piplug"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:
        for rel in INCLUDE:
            src = ROOT / rel
            if not src.is_file():
                raise SystemExit(f"missing {rel}")
            zf.write(src, rel.replace("\\", "/"))
    print(f"wrote {out} bytes={out.stat().st_size}")
    with zipfile.ZipFile(out) as zf:
        for info in zf.infolist():
            print(f"  {info.filename} compress={info.compress_type} size={info.file_size}")
            if info.compress_type != zipfile.ZIP_STORED:
                raise SystemExit("deflated entry not allowed")


if __name__ == "__main__":
    main()
