"""Package the plugin into dist/pdf2zh-cli-<version>.xpi."""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = ["manifest.json", "bootstrap.js", "translator.js", "prefs.js", "preferences.xhtml", "icon.svg"]
version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
out = ROOT / "dist" / f"pdf2zh-cli-{version}.xpi"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        z.write(ROOT / name, name)
    for ftl in sorted((ROOT / "locale").rglob("*.ftl")):
        z.write(ftl, ftl.relative_to(ROOT).as_posix())
print(out)
