/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils */
// Drives the real plugin inside a throwaway Zotero profile, writes results.json, then quits.
function install() {}
function uninstall() {}
function shutdown() {}

const PREF = "extensions.zotero.pdf2zh-cli.";

// Zotero awaits each add-on's startup in turn, so returning this promise would block the plugin
// under test from ever starting. Run detached.
function startup() {
  main().catch((e) => Zotero.logError(e));
}

async function main() {
  await Zotero.uiReadyPromise;
  const config = JSON.parse(Services.prefs.getStringPref("pdf2zhcli.e2e.config"));
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
    // Written on every step so a hang still shows how far the run got.
    IOUtils.writeUTF8(config.resultsPath + ".partial", JSON.stringify(results, null, 1)).catch(() => {});
  };
  const save = () => IOUtils.writeUTF8(config.resultsPath, JSON.stringify(results, null, 1));
  try {
    await run(config, check);
  }
  catch (e) {
    check("harness completed", false, `${e}\n${e?.stack}`);
    const errors = Services.console.getMessageArray()
      .map((m) => m.message || String(m))
      .filter((m) => /pdf2zh|translator\.js|bootstrap\.js|preferences\.xhtml/i.test(m))
      .slice(-12);
    results.push({ name: "console errors", ok: false, detail: errors.join("\n---\n").slice(0, 3000) });
  }
  await save();
  Zotero.Utilities.Internal.quit();
}

const sha = async (path) => {
  const bytes = await IOUtils.read(path);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
};

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Zotero.Promise.delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const isVisible = (el) => !!el && !el.hidden && el.getAttribute("hidden") !== "true";

/**
 * Open the context menu through Zotero's own right-click entry point. onShowing only runs when the
 * popup really opens, and that needs the window to hold OS focus, so take focus and retry.
 */
async function openMenu(win, items) {
  await win.ZoteroPane.selectItems(items.map((i) => i.id));
  await waitFor(() => win.ZoteroPane.getSelectedItems().length === items.length, 5000, "selection");
  const popup = win.document.getElementById("zotero-itemmenu");
  for (let attempt = 0; attempt < 4; attempt++) {
    win.focus();
    await Zotero.Promise.delay(400);
    const shown = new Promise((r) => popup.addEventListener("popupshown", () => r(true), { once: true }));
    await win.ZoteroPane.onItemsContextMenuOpen({ target: null }, 200, 200);
    if (await Promise.race([shown, Zotero.Promise.delay(5000).then(() => false)])) return popup;
    popup.hidePopup();
  }
  throw new Error("context menu did not open after 4 attempts");
}

async function closeMenu(popup) {
  const hidden = new Promise((r) => popup.addEventListener("popuphidden", r, { once: true }));
  popup.hidePopup();
  await Promise.race([hidden, Zotero.Promise.delay(3000)]);
}

async function menuState(win, items) {
  const popup = await openMenu(win, items);
  const find = (id) => popup.querySelector(`[data-l10n-id="${id}"]`);
  const translate = find("pdf2zh-cli-menu-translate");
  // Fluent applies labels asynchronously.
  if (isVisible(translate)) await waitFor(() => translate.getAttribute("label"), 5000, "menu label");
  const state = {
    translate: { exists: !!translate, visible: isVisible(translate), label: translate?.getAttribute("label") || "" },
    cancel: { exists: !!find("pdf2zh-cli-menu-cancel"), visible: isVisible(find("pdf2zh-cli-menu-cancel")) },
  };
  await closeMenu(popup);
  return state;
}

async function clickTranslate(win, items) {
  const popup = await openMenu(win, items);
  popup.activateItem(popup.querySelector('[data-l10n-id="pdf2zh-cli-menu-translate"]'));
}

/** Await with a deadline, recording each step so a hang names the exact call that stalled. */
async function step(check, name, promise, ms = 20000) {
  const timeout = Zotero.Promise.delay(ms).then(() => { throw new Error(`step hung: ${name}`); });
  try {
    const value = await Promise.race([promise, timeout]);
    check(`step: ${name}`, true);
    return value;
  }
  catch (e) {
    check(`step: ${name}`, false, e?.stack || e?.message || `rejected with ${String(e)}`);
    throw e || new Error(`step rejected without an error: ${name}`);
  }
}

// Disabling removes the menu; re-enabling restores it.
async function lifecycleChecks(win, parent, check) {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const addon = await AddonManager.getAddonByID("pdf2zh-cli@local");
  await win.ZoteroPane.selectItems([parent.id]);
  await step(check, "build menu before disable", win.ZoteroPane.buildItemContextMenu());
  await step(check, "addon.disable", addon.disable());
  await Zotero.Promise.delay(500);
  check("disable clears global", !Zotero.Pdf2zhCli);
  await step(check, "select after disable", win.ZoteroPane.selectItems([parent.id]));
  await step(check, "build menu after disable", win.ZoteroPane.buildItemContextMenu());
  const after = await step(check, "open menu after disable", menuState(win, [parent]), 40000);
  check("disable removes menu", !after.translate.visible);
  await step(check, "addon.enable", addon.enable());
  await waitFor(() => Zotero.Pdf2zhCli, 10000, "re-enable");
  const again = await step(check, "open menu after enable", menuState(win, [parent]), 40000);
  check("re-enable restores menu", again.translate.visible);
}

async function prefsChecks(check) {
  // Preferences pane renders and binds to prefs.
  const pane = Zotero.PreferencePanes.pluginPanes.find((p) => p.pluginID === "pdf2zh-cli@local");
  check("pref pane registered", !!pane);
  const prefsWin = Zotero.Utilities.Internal.openPreferences(pane.id);
  await waitFor(() => prefsWin.document?.getElementById("pdf2zh-cli-service"), 15000, "pref pane");
  await Zotero.Promise.delay(800);
  check("pref pane binds service", prefsWin.document.getElementById("pdf2zh-cli-service").value === "deepseek",
    prefsWin.document.getElementById("pdf2zh-cli-service").value);
  check("pref pane binds output", prefsWin.document.getElementById("pdf2zh-cli-output").value === "both");
  prefsWin.close();

}

async function run(config, check) {
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  // Add-ons start in parallel, so give the plugin and the library view time to come up.
  await waitFor(() => Zotero.Pdf2zhCli, 30000, "plugin load");
  const P = Zotero.Pdf2zhCli;
  check("plugin loaded", !!P);
  const win = Zotero.getMainWindow();
  await waitFor(() => win.ZoteroPane.itemsView && win.ZoteroPane.collectionsView, 30000, "library view");
  await win.ZoteroPane.collectionsView.waitForLoad();
  await win.ZoteroPane.itemsView.waitForLoad();

  // Hard cap so a failure can never spend much on API calls.
  const setPrefs = (extra) => {
    for (const [k, v] of Object.entries(extra)) Zotero.Prefs.set(PREF + k, v, true);
  };
  setPrefs({ threads: 2, extraArgs: "-p 1", pdf2zhPath: "" });

  const makeParent = async (title) => {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", title);
    await item.saveTx();
    return item;
  };
  const addPdf = (file, parent, title) => Zotero.Attachments.importFromFile({
    file, title, ...(parent ? { parentItemID: parent.id } : {}),
  });

  const parent = await makeParent("中文 Title 测试条目");
  const source = await addPdf(config.samplePdf, parent, "Full Text PDF");
  if (config.only === "lifecycle") {
    await prefsChecks(check);
    const fake = await addPdf(config.samplePdf2, parent, "[译文] Full Text PDF");
    await step(check, "build with translation attached", win.ZoteroPane.buildItemContextMenu());
    fake.deleted = true;
    await fake.saveTx();
    await addPdf(config.samplePdf2, parent, "[译文] Full Text PDF");
    await win.ZoteroPane.selectItems([parent.id]);
    await step(check, "build with trashed translation", win.ZoteroPane.buildItemContextMenu());
    await lifecycleChecks(win, parent, check);
    check("harness completed", true);
    return;
  }
  const sourcePath = await source.getFilePathAsync();
  const sourceHash = await sha(sourcePath);
  const standalone = await addPdf(config.samplePdf2, null, "独立附件");
  const noPdf = await makeParent("没有附件的条目");
  const note = new Zotero.Item("note");
  note.setNote("<p>note</p>");
  await note.saveTx();

  // Menu visibility, through the real popup.
  let m = await menuState(win, [parent]);
  check("menu shows on item with PDF", m.translate.exists && m.translate.visible);
  check("menu label is localized", m.translate.label === "用 pdf2zh 翻译" || m.translate.label === "Translate with pdf2zh", m.translate.label);
  check("cancel hidden when idle", m.cancel.exists && !m.cancel.visible);
  m = await menuState(win, [source]);
  check("menu shows on PDF attachment", m.translate.visible);
  m = await menuState(win, [noPdf]);
  check("menu hidden on item without PDF", !m.translate.visible);
  m = await menuState(win, [note]);
  check("menu hidden on note", !m.translate.visible);

  // Happy path, started by a real menu click.
  await clickTranslate(win, [parent]);
  await waitFor(() => P.isBusy(), 8000, "job start");
  check("menu click starts translation", true);
  const during = await menuState(win, [parent]);
  check("cancel visible while running", during.cancel.visible);
  await waitFor(() => !P.isBusy(), 240000, "translation end");
  await P._pumping;
  const children = () => Zotero.Items.get(parent.getAttachments());
  const mono = () => children().filter((a) => a.getField("title") === "[译文] Full Text PDF");
  const dual = () => children().filter((a) => a.getField("title") === "[双语] Full Text PDF");
  check("mono attached", mono().length === 1, `log tail: ${P.lastLog.slice(-300)}`);
  check("dual attached", dual().length === 1);
  check("source PDF unchanged", (await sha(sourcePath)) === sourceHash);
  if (mono().length) {
    const monoPath = await mono()[0].getFilePathAsync();
    check("mono file stored", monoPath && (await IOUtils.stat(monoPath)).size > 0, monoPath);
    await IOUtils.writeUTF8(config.monoPathFile, monoPath);
  }
  const tempRoot = PathUtils.join(Zotero.getTempDirectory().path, "pdf2zh-cli");
  const leftovers = await IOUtils.exists(tempRoot) ? await IOUtils.getChildren(tempRoot) : [];
  check("job directory cleaned", leftovers.length === 0, leftovers.join());

  // Translated attachments must not themselves be offered for translation.
  if (mono().length) {
    m = await menuState(win, [mono()[0]]);
    check("menu hidden on translated PDF", !m.translate.visible);
  }

  // Existing translation: skip leaves things alone; redo replaces and trashes the old one.
  let r = await P.translate([parent], { existing: "skip" });
  check("existing=skip skips", r.length === 1 && r[0].status === "skipped", JSON.stringify(r));
  const oldMonoID = mono()[0]?.id;
  r = await P.translate([parent], { existing: "redo" });
  check("existing=redo succeeds", r.length === 1 && r[0].status === "done", JSON.stringify(r));
  check("redo keeps one live mono", mono().filter((a) => !a.deleted).length === 1);
  check("redo trashes old mono", Zotero.Items.get(oldMonoID)?.deleted === true);
  check("source PDF unchanged after redo", (await sha(sourcePath)) === sourceHash);

  // Standalone PDF stays standalone, in a path containing non-ASCII characters.
  setPrefs({ output: "mono" });
  r = await P.translate([standalone], { existing: "redo" });
  check("standalone translates", r[0]?.status === "done", JSON.stringify(r));
  if (r[0]?.attachments?.length) {
    const made = Zotero.Items.get(r[0].attachments[0]);
    check("standalone output is top-level", !made.parentItemID && r[0].attachments.length === 1);
    check("output pref respected", made.getField("title") === "[译文] 独立附件", made.getField("title"));
  }
  setPrefs({ output: "both" });

  // Bad executable path gives a readable failure and attaches nothing.
  const before = Zotero.Items.get(parent.getAttachments()).length;
  setPrefs({ pdf2zhPath: "C:\\no\\such\\pdf2zh.exe" });
  r = await P.translate([parent], { existing: "redo" });
  check("bad path fails cleanly", r[0]?.status === "failed" && /找不到/.test(r[0].error), JSON.stringify(r));
  check("bad path attaches nothing", Zotero.Items.get(parent.getAttachments()).length === before);
  setPrefs({ pdf2zhPath: "" });

  // Invalid API key: pdf2zh itself hangs here, so the plugin must end it quickly.
  setPrefs({ extraArgs: `-p 1 --config "${config.badConfig}"` });
  let t0 = Date.now();
  r = await P.translate([parent], { existing: "redo" });
  const badKeyMs = Date.now() - t0;
  check("bad key is reported", r[0]?.status === "failed" && /API Key/.test(r[0].error), JSON.stringify(r));
  check("bad key does not hang", badKeyMs < 60000, `${badKeyMs}ms`);
  check("bad key keeps old translations", mono().filter((a) => !a.deleted).length === 1);

  // Multi-select: every item is translated, one after another, and each gets its own results.
  setPrefs({ extraArgs: "-p 1", output: "mono" });
  const batch = [await makeParent("批量 A"), await makeParent("批量 B")];
  for (const item of batch) await addPdf(config.samplePdf, item, "Batch PDF");
  r = await P.translate(batch, { existing: "redo" });
  check("batch translates every item", r.length === 2 && r.every((x) => x.status === "done"), JSON.stringify(r));
  check("batch attaches to the right items", batch.every((item) => {
    const titles = Zotero.Items.get(item.getAttachments()).map((a) => a.getField("title"));
    return titles.length === 2 && titles.includes("[译文] Batch PDF");
  }));
  setPrefs({ extraArgs: "", output: "both" });

  const running = async () => {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pdf2zh-cli*input.pdf*' "
      + "-and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId }";
    const utf16 = new Uint8Array(new Uint16Array([...script].map((c) => c.charCodeAt(0))).buffer);
    const proc = await Subprocess.call({
      command: await Subprocess.pathSearch("powershell.exe", Subprocess.getEnvironment()),
      arguments: ["-NoProfile", "-NonInteractive", "-EncodedCommand", win.btoa(String.fromCharCode(...utf16))],
      stderr: "stdout",
    });
    proc.stdin.close().catch(() => {});
    let out = "";
    for (;;) {
      const chunk = await proc.stdout.readString();
      if (!chunk) break;
      out += chunk;
    }
    await proc.wait();
    return out.split(/\s+/).filter((x) => /^\d+$/.test(x));
  };

  // Cancel mid-run: everything is killed and nothing is attached.
  const longParent = await makeParent("取消测试");
  await addPdf(config.longPdf, longParent, "Long PDF");
  const pending = P.translate([longParent], { existing: "redo" });
  await waitFor(() => P._current?.proc, 15000, "process start");
  await Zotero.Promise.delay(1500);
  const pidsDuring = await running();
  check("pdf2zh process found while running", pidsDuring.length > 0, pidsDuring.join());
  await P.cancelAll();
  r = await pending;
  check("cancel reports cancelled", r[0]?.status === "cancelled", JSON.stringify(r));
  check("cancel attaches nothing", Zotero.Items.get(longParent.getAttachments()).length === 1);
  await Zotero.Promise.delay(1000);
  const pidsAfter = await running();
  check("cancel kills whole process tree", pidsDuring.length > 0 && pidsAfter.length === 0, pidsAfter.join());

  // A run that goes silent is killed by the idle watchdog. The value below is the enforced minimum.
  check("not busy at end", !P.isBusy());

  await prefsChecks(check);
  await lifecycleChecks(win, parent, check);
  check("harness completed", true);
}
