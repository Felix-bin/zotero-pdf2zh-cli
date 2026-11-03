"""Static checks on the source and the built XPI. Needs no Zotero, pdf2zh or API key.

Run after build.py:
    python test/check_package.py
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ["manifest.json", "bootstrap.js", "translator.js", "prefs.js", "preferences.xhtml", "icon.svg"]
PREF_PREFIX = "extensions.zotero.pdf2zh-cli."


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def ftl_keys(path):
    return set(re.findall(r"^([a-z][\w-]*) =", path.read_text(encoding="utf-8"), re.M))


def check_xpi(errors):
    version = json.loads(read("manifest.json"))["version"]
    xpi = ROOT / "dist" / f"pdf2zh-cli-{version}.xpi"
    if not xpi.exists():
        errors.append(f"{xpi.name} not found, run build.py first")
        return
    locales = [p.relative_to(ROOT).as_posix() for p in (ROOT / "locale").rglob("*.ftl")]
    with zipfile.ZipFile(xpi) as z:
        names = set(z.namelist())
        if z.testzip():
            errors.append(f"{xpi.name} is corrupt")
    errors.extend(f"{xpi.name} is missing {name}" for name in REQUIRED + locales if name not in names)


def check_locales(errors):
    en, zh = (ftl_keys(ROOT / "locale" / lang / "pdf2zh-cli.ftl") for lang in ("en-US", "zh-CN"))
    errors.extend(f"{key} is only in one locale" for key in sorted(en ^ zh))
    used = re.findall(r'data-l10n-id="([^"]+)"', read("preferences.xhtml"))
    used += re.findall(r'l10nID: "([^"]+)"', read("translator.js"))
    errors.extend(f"{key} is used but not in the locale files" for key in sorted(set(used) - en - zh))


def check_prefs(errors):
    defined = set(re.findall(r'^pref\("([^"]+)"', read("prefs.js"), re.M))
    used = set(re.findall(r'preference="([^"]+)"', read("preferences.xhtml")))
    used |= {PREF_PREFIX + name for name in re.findall(r'\bpref\("(\w+)"\)', read("translator.js"))}
    errors.extend(f"{name} is used but has no default in prefs.js" for name in sorted(used - defined))


def main():
    errors = []
    try:
        ET.fromstring(read("preferences.xhtml"))
    except ET.ParseError as e:
        errors.append(f"preferences.xhtml: {e}")
    check_xpi(errors)
    check_locales(errors)
    check_prefs(errors)
    for error in errors:
        print("FAIL", error)
    print(f"{len(errors)} problem(s)" if errors else "OK")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
