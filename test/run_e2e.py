"""End-to-end test: run the built XPI in a throwaway Zotero profile and data directory.

The user's own profile, library and running Zotero are never touched. Uses real pdf2zh and
a few API calls (about 5 pages). Run with the Python from pdf2zh's uv tool, which has pymupdf:
    %APPDATA%\\uv\\tools\\pdf2zh\\Scripts\\python.exe -I test/run_e2e.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
ZOTERO = r"C:\Program Files\Zotero\zotero.exe"
TIMEOUT_S = 480


def make_pdf(path, pages):
    doc = pymupdf.open()
    text = ("Deep neural networks learn hierarchical representations of data. In this paper "
            "we study how attention mechanisms improve translation quality across long "
            "documents, and report results on several benchmark datasets. ") * 4
    for n in range(pages):
        doc.new_page().insert_textbox((72, 72, 520, 700), f"Section {n + 1}\n\n{text}", fontsize=11)
    doc.save(path)


def build_addon_xpi(dest):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for f in (ROOT / "test" / "e2e-addon").iterdir():
            z.write(f, f.name)


def test_instance_pids(work):
    """PIDs of Zotero processes started with this run's profile."""
    script = ("Get-CimInstance Win32_Process -Filter \"Name='zotero.exe'\" | "
              f"Where-Object {{ $_.CommandLine -like '*{work.name}*' }} | "
              "ForEach-Object { $_.ProcessId }")
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script],
                         capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def main():
    work = Path(tempfile.mkdtemp(prefix="pdf2zh-cli-e2e-"))
    profile, data, files = work / "profile", work / "data", work / "测试 文件"
    for d in (profile / "extensions", data, files):
        d.mkdir(parents=True)

    make_pdf(files / "示例 论文.pdf", 1)
    make_pdf(files / "独立 PDF.pdf", 1)
    make_pdf(files / "long.pdf", 12)
    bad_config = files / "bad config.json"
    bad_config.write_text(json.dumps({"translators": [{"name": "deepseek", "envs": {
        "DEEPSEEK_API_KEY": "sk-invalid-test", "DEEPSEEK_MODEL": "deepseek-flash"}}]}), encoding="utf-8")

    xpi = next((ROOT / "dist").glob("pdf2zh-cli-*.xpi"))
    shutil.copy(xpi, profile / "extensions" / "pdf2zh-cli@local.xpi")
    build_addon_xpi(profile / "extensions" / "pdf2zh-cli-e2e@local.xpi")

    results_path = work / "results.json"
    mono_file = work / "mono-path.txt"
    config = {
        "resultsPath": str(results_path), "monoPathFile": str(mono_file),
        "samplePdf": str(files / "示例 论文.pdf"), "samplePdf2": str(files / "独立 PDF.pdf"),
        "longPdf": str(files / "long.pdf"), "badConfig": str(bad_config).replace("\\", "/"),
        "only": sys.argv[1] if len(sys.argv) > 1 else "",
    }
    prefs = {
        "extensions.zotero.dataDir": str(data), "extensions.zotero.useDataDir": True,
        "extensions.zotero.firstRun2": False, "extensions.zotero.firstRun.skipFirefoxProfileAccess": True,
        "extensions.zotero.sync.autoSync": False, "extensions.zotero.reportTranslationFailure": False,
        "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
        "xpinstall.signatures.required": False, "app.update.enabled": False, "app.update.auto": False,
        "extensions.update.enabled": False, "intl.locale.requested": "zh-CN",
        "pdf2zhcli.e2e.config": json.dumps(config),
    }
    (profile / "user.js").write_text(
        "".join(f'user_pref({json.dumps(k)}, {json.dumps(v)});\n' for k, v in prefs.items()), encoding="utf-8")

    print("work dir:", work, flush=True)
    # zotero.exe re-launches itself and the first process exits at once, so wait on the results
    # file rather than on this process.
    subprocess.Popen([ZOTERO, "-no-remote", "-profile", str(profile)])
    start = time.time()
    while time.time() - start < TIMEOUT_S and not results_path.exists():
        time.sleep(1)
    deadline = time.time() + 30
    while time.time() < deadline and test_instance_pids(work):
        time.sleep(1)
    # Only ever stop processes whose command line names this run's profile, never the user's Zotero.
    for pid in test_instance_pids(work):
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)

    if not results_path.exists():
        print(f"FAILED: no results after {time.time() - start:.0f}s; files kept in {work}")
        partial = Path(str(results_path) + ".partial")
        if partial.exists():
            for r in json.loads(partial.read_text(encoding="utf-8")):
                print(("PASS " if r["ok"] else "FAIL ") + r["name"])
        return 1

    results = json.loads(results_path.read_text(encoding="utf-8"))
    if mono_file.exists():
        doc = pymupdf.open(mono_file.read_text(encoding="utf-8"))
        text = doc[0].get_text()
        ok = any("\u4e00" <= c <= "\u9fff" for c in text)
        results.append({"name": "mono PDF contains Chinese text", "ok": ok, "detail": ""})
        doc.close()

    failed = [r for r in results if not r["ok"]]
    for r in results:
        print(("PASS " if r["ok"] else "FAIL ") + r["name"] + (f"  -- {r['detail']}" if r["detail"] and not r["ok"] else ""))
    print(f"\n{len(results) - len(failed)}/{len(results)} passed in {time.time() - start:.0f}s")
    if not failed:
        shutil.rmtree(work, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
