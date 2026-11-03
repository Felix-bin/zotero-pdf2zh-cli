/* global Zotero, Services, Pdf2zhCli */
function install() {}
function uninstall() {}

async function startup({ id, rootURI }) {
  await Zotero.uiReadyPromise;
  Services.scriptloader.loadSubScript(rootURI + "translator.js");
  Pdf2zhCli.init({ id });
  Zotero.Pdf2zhCli = Pdf2zhCli;
  for (const window of Zotero.getMainWindows()) Pdf2zhCli.addToWindow(window);
}

function onMainWindowLoad({ window }) {
  if (typeof Pdf2zhCli !== "undefined" && Pdf2zhCli) Pdf2zhCli.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (typeof Pdf2zhCli !== "undefined" && Pdf2zhCli) Pdf2zhCli.removeFromWindow(window);
}

async function shutdown() {
  if (typeof Pdf2zhCli === "undefined" || !Pdf2zhCli) return;
  await Pdf2zhCli.shutdown();
  for (const window of Zotero.getMainWindows()) Pdf2zhCli.removeFromWindow(window);
  delete Zotero.Pdf2zhCli;
  Pdf2zhCli = undefined;
}
