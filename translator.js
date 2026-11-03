/* global Zotero, Services, ChromeUtils, Components, IOUtils, PathUtils */
var Pdf2zhCli = (() => {
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  const PREFIX = "extensions.zotero.pdf2zh-cli.";
  const FTL = "pdf2zh-cli.ftl";
  const TITLES = { mono: "[译文] ", dual: "[双语] " };
  const TRANSLATED_RE = /^\[(译文|双语)\] /;
  // pdf2zh logs API failures and then hangs instead of exiting, so these must end the run.
  const FATAL_PATTERNS = [
    [/Authentication\s*Fails|AuthenticationError|Error code: 401/i, "API Key 无效，请检查 pdf2zh 的 config.json"],
    [/Insufficient\s*Balance|Error code: 402/i, "翻译服务账户余额不足"],
    [/Error code: 403/i, "翻译服务拒绝访问（403）"],
    [/Model\s*Not\s*Exist|Error code: 404/i, "翻译模型不存在，请检查 config.json 里的模型名"],
  ];
  const PROGRESS_RE = /(\d{1,3})%\|[^\r\n]*?(\d+)\/(\d+)/g;

  class UserError extends Error {}

  const pref = (name) => Zotero.Prefs.get(PREFIX + name, true);

  /** Split a command-line string on whitespace, honouring double quotes. */
  const splitArgs = (text) => [...String(text || "").matchAll(/"([^"]*)"|(\S+)/g)]
    .map((m) => m[1] ?? m[2]);

  return {
    _menuID: null,
    _queue: [],
    _current: null,
    _batchWindow: null,
    _batchFailed: false,
    _pumping: null,
    lastLog: "",

    init({ id }) {
      this._menuID = Zotero.MenuManager.registerMenu({
        menuID: "pdf2zh-cli-item-menu",
        pluginID: id,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "pdf2zh-cli-menu-translate",
            onShowing: (_event, context) => {
              context.setVisible(this.getSources(context.items || []).length > 0);
            },
            onCommand: (_event, context) => {
              this.translate(context.items || []).catch((e) => Zotero.logError(e));
            },
          },
          {
            menuType: "menuitem",
            l10nID: "pdf2zh-cli-menu-cancel",
            onShowing: (_event, context) => context.setVisible(this.isBusy()),
            onCommand: () => {
              this.cancelAll().catch((e) => Zotero.logError(e));
            },
          },
        ],
      });
      Zotero.PreferencePanes.register({
        pluginID: id,
        src: "preferences.xhtml",
        label: "PDF2zh CLI",
        image: "icon.svg",
      });
    },

    addToWindow(window) {
      window.MozXULElement.insertFTLIfNeeded(FTL);
    },

    removeFromWindow(window) {
      const { document } = window;
      document.querySelector(`link[rel="localization"][href="${FTL}"]`)?.remove();
      // unregisterMenu leaves rendered items behind, still wired to this unloaded plugin's
      // callbacks, and the next right-click then fails to build the menu.
      for (const el of document.querySelectorAll('#zotero-itemmenu [data-l10n-id^="pdf2zh-cli-menu-"]')) {
        el.remove();
      }
    },

    async shutdown() {
      await this.cancelAll();
      if (this._menuID) Zotero.MenuManager.unregisterMenu(this._menuID);
      this._menuID = null;
    },

    isBusy() {
      return !!this._current || this._queue.length > 0;
    },

    /** PDFs a selection would translate: an item's first PDF, or the selected PDF itself. */
    getSources(items) {
      const sources = new Map();
      for (const item of items) {
        const source = this._sourceFor(item);
        if (source && source.library.editable && source.library.filesEditable) {
          sources.set(source.id, source);
        }
      }
      return [...sources.values()];
    },

    _sourceFor(item) {
      if (item.isPDFAttachment()) return this._isTranslated(item) ? null : item;
      if (!item.isRegularItem()) return null;
      const pdfs = Zotero.Items.get(item.getAttachments())
        .filter((a) => a.isPDFAttachment() && !this._isTranslated(a));
      return pdfs[0] ?? null;
    },

    _isTranslated(attachment) {
      return TRANSLATED_RE.test(attachment.getField("title"));
    },

    _titleFor(source, kind) {
      return TITLES[kind] + source.getField("title");
    },

    _existingTranslations(source) {
      if (!source.parentItemID) return [];
      const titles = new Set(Object.keys(TITLES).map((k) => this._titleFor(source, k)));
      return Zotero.Items.get(source.parentItem.getAttachments())
        .filter((a) => titles.has(a.getField("title")));
    },

    /**
     * @param {Zotero.Item[]} items
     * @param {{existing?: "ask"|"redo"|"skip"}} [options] what to do when a translation exists
     * @return {Promise<Object[]>} one result per source, once all of them have settled
     */
    async translate(items, { existing = "ask" } = {}) {
      const active = new Set([this._current, ...this._queue].filter(Boolean).map((j) => j.source.id));
      const sources = this.getSources(items).filter((s) => !active.has(s.id));
      if (!sources.length) {
        this._notice("没有可翻译的 PDF，或它们已经在翻译队列中。");
        return [];
      }

      let choice = "redo";
      const translatedCount = sources.filter((s) => this._existingTranslations(s).length).length;
      if (translatedCount) {
        choice = existing === "ask" ? this._askExisting(translatedCount) : existing;
        if (choice === "cancel") return [];
      }

      const results = [];
      const pending = [];
      for (const source of sources) {
        const previous = this._existingTranslations(source);
        if (previous.length && choice === "skip") {
          results.push({ sourceID: source.id, status: "skipped", attachments: [], error: null });
        }
        else {
          pending.push(this._enqueue(source, previous));
        }
      }
      if (!pending.length) {
        this._notice("所选 PDF 都已有译文，已跳过。");
        return results;
      }
      this._pump();
      results.push(...await Promise.all(pending));
      return results;
    },

    _askExisting(count) {
      const { prompt } = Services;
      const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING
        + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL
        + prompt.BUTTON_POS_2 * prompt.BUTTON_TITLE_IS_STRING;
      const button = prompt.confirmEx(
        Zotero.getMainWindow(), "pdf2zh",
        `${count} 个 PDF 已有译文。重新翻译成功后，旧译文会移到回收站。`,
        flags, "重新翻译", null, "跳过这些", null, {},
      );
      return ["redo", "cancel", "skip"][button];
    },

    _enqueue(source, previous) {
      return new Promise((resolve) => {
        this._queue.push({
          source, previous, resolve,
          proc: null, cancelled: false, fatal: null, timedOut: false,
          progress: this._progressRow(source),
        });
      });
    },

    _progressRow(source) {
      if (!this._batchWindow) {
        this._batchWindow = new Zotero.ProgressWindow({ closeOnClick: false });
        this._batchWindow.changeHeadline("pdf2zh 翻译");
        this._batchWindow.show();
        this._batchFailed = false;
      }
      const row = new this._batchWindow.ItemProgress("attachmentPDF", `排队中：${this._label(source)}`);
      row.setProgress(0);
      return row;
    },

    _label(source) {
      const name = source.parentItem?.getField("title") || source.getField("title");
      return name.length > 42 ? `${name.slice(0, 42)}…` : name;
    },

    _notice(text) {
      const win = new Zotero.ProgressWindow();
      win.changeHeadline("pdf2zh 翻译");
      win.addDescription(text);
      win.show();
      win.startCloseTimer(4000);
    },

    _pump() {
      if (!this._pumping) {
        this._pumping = this._drain().finally(() => { this._pumping = null; });
      }
      return this._pumping;
    },

    async _drain() {
      while (this._queue.length) {
        const job = this._queue.shift();
        this._current = job;
        const result = await this._execute(job);
        this._current = null;
        job.resolve(result);
      }
      if (this._batchWindow) {
        this._batchWindow.startCloseTimer(this._batchFailed ? 30000 : 5000);
        this._batchWindow = null;
      }
    },

    async _execute(job) {
      const { source, progress } = job;
      const name = this._label(source);
      const result = { sourceID: source.id, status: "failed", attachments: [], error: null };
      let dir;
      try {
        progress.setText(`准备中：${name}`);
        const sourcePath = await source.getFilePathAsync();
        if (!sourcePath) throw new UserError("本地没有这个 PDF，请先在 Zotero 中下载");
        const exe = await this._findExecutable();

        dir = PathUtils.join(
          Zotero.getTempDirectory().path, "pdf2zh-cli", Zotero.Utilities.randomString(10),
        );
        await IOUtils.makeDirectory(dir, { createAncestors: true });
        // Never hand pdf2zh the library file: it deletes inputs under the system temp dir.
        const input = PathUtils.join(dir, "input.pdf");
        await IOUtils.copy(sourcePath, input);

        await this._runPdf2zh(job, exe, input, dir, name);
        if (job.cancelled) throw new UserError("已取消");

        const created = await this._attachOutputs(source, dir, sourcePath);
        for (const old of job.previous) {
          old.deleted = true;
          await old.saveTx();
        }
        result.status = "done";
        result.attachments = created.map((a) => a.id);
        progress.setText(`完成：${name}`);
        progress.setProgress(100);
      }
      catch (e) {
        if (!(e instanceof UserError)) Zotero.logError(e);
        result.status = job.cancelled ? "cancelled" : "failed";
        result.error = e.message;
        if (job.cancelled) {
          progress.setText(`已取消：${name}`);
        }
        else {
          this._batchFailed = true;
          progress.setError();
          progress.setText(`失败：${name}（${e.message}）`);
        }
      }
      finally {
        if (dir) {
          await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true })
            .catch((e) => Zotero.logError(e));
        }
      }
      return result;
    },

    async _findExecutable() {
      const custom = String(pref("pdf2zhPath") || "").trim();
      if (custom) {
        if (await IOUtils.exists(custom)) return custom;
        throw new UserError(`找不到设置里指定的 pdf2zh：${custom}`);
      }
      const exeName = Zotero.isWin ? "pdf2zh.exe" : "pdf2zh";
      try {
        return await Subprocess.pathSearch(exeName, Subprocess.getEnvironment());
      }
      catch (_e) { /* fall through to uv's default tool location */ }
      const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
      const fallback = PathUtils.join(home, ".local", "bin", exeName);
      if (await IOUtils.exists(fallback)) return fallback;
      throw new UserError("找不到 pdf2zh，请在插件设置里填写路径");
    },

    async _runPdf2zh(job, exe, input, dir, name) {
      const threads = Math.max(1, parseInt(pref("threads"), 10) || 4);
      const args = [
        input,
        "-s", String(pref("service") || "deepseek"),
        "-li", String(pref("langIn") || "en"),
        "-lo", String(pref("langOut") || "zh"),
        "-t", String(threads),
        "-o", dir,
        ...splitArgs(pref("extraArgs")),
      ];
      if (job.previous.length) args.push("--ignore-cache");

      job.progress.setText(`启动中：${name}`);
      const proc = await Subprocess.call({
        command: exe,
        arguments: args,
        workdir: dir,
        stderr: "stdout",
        environmentAppend: true,
        environment: {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUNBUFFERED: "1",
          NO_COLOR: "1",
          COLUMNS: "200",
        },
      });
      job.proc = proc;
      proc.stdin.close().catch(() => {});
      if (job.cancelled) await proc.kill(2000);

      const idleMs = Math.max(30, parseInt(pref("idleTimeoutSeconds"), 10) || 300) * 1000;
      let idleTimer;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          job.timedOut = true;
          proc.kill(2000).catch(() => {});
        }, idleMs);
      };
      armIdle();

      let log = "";
      try {
        for (;;) {
          const chunk = await proc.stdout.readString();
          if (!chunk) break;
          armIdle();
          log = (log + chunk).slice(-20000);
          this._showProgress(job, log, name);
          const fatal = !job.fatal && FATAL_PATTERNS.find(([re]) => re.test(log));
          if (fatal) {
            job.fatal = fatal[1];
            proc.kill(2000).catch(() => {});
          }
        }
      }
      catch (e) {
        // A killed process can close the pipe mid-read; only other read errors are real.
        if (!job.cancelled && !job.fatal && !job.timedOut) throw e;
      }
      finally {
        clearTimeout(idleTimer);
      }
      const { exitCode } = await proc.wait();
      job.proc = null;
      this.lastLog = log;

      if (job.cancelled) return;
      if (job.fatal) throw new UserError(job.fatal);
      if (job.timedOut) throw new UserError(`pdf2zh 超过 ${idleMs / 1000} 秒没有输出，已终止`);
      if (exitCode !== 0) {
        Zotero.logError(new Error(`pdf2zh exited with ${exitCode}:\n${log.slice(-4000)}`));
        throw new UserError(this._summarize(log) || `pdf2zh 退出码 ${exitCode}`);
      }
    },

    _showProgress(job, log, name) {
      let match;
      let last = null;
      PROGRESS_RE.lastIndex = 0;
      while ((match = PROGRESS_RE.exec(log))) last = match;
      if (last) {
        // Keep the bar short of full until the attachments are actually saved.
        job.progress.setProgress(Math.min(95, parseInt(last[1], 10)));
        job.progress.setText(`翻译中 ${last[2]}/${last[3]} 页：${name}`);
      }
      else {
        job.progress.setText(`分析版面中：${name}`);
      }
    },

    _summarize(log) {
      const lines = log.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^[\w.]*(Error|Exception)\b/.test(lines[i])) return lines[i].slice(0, 200);
      }
      return "";
    },

    async _attachOutputs(source, dir, sourcePath) {
      const wanted = { both: ["mono", "dual"], mono: ["mono"], dual: ["dual"] }[pref("output")]
        || ["mono", "dual"];
      const base = Zotero.File.getValidFileName(
        PathUtils.filename(sourcePath).replace(/\.pdf$/i, ""),
      ).slice(0, 120);

      // Check every output first so a partial run never attaches half a result.
      const files = [];
      for (const kind of wanted) {
        const file = PathUtils.join(dir, `input-${kind}.pdf`);
        if (!await IOUtils.exists(file) || !(await IOUtils.stat(file)).size) {
          throw new UserError(`pdf2zh 没有生成 ${kind} 文件`);
        }
        files.push({ kind, file });
      }

      const created = [];
      for (const { kind, file } of files) {
        const options = {
          file,
          title: this._titleFor(source, kind),
          fileBaseName: `${base}-${kind}`,
          contentType: "application/pdf",
          libraryID: source.libraryID,
        };
        if (source.parentItemID) options.parentItemID = source.parentItemID;
        else options.collections = source.getCollections();
        created.push(await Zotero.Attachments.importFromFile(options));
      }
      return created;
    },

    async cancelAll() {
      for (const job of this._queue.splice(0)) {
        job.cancelled = true;
        job.progress.setText(`已取消：${this._label(job.source)}`);
        job.resolve({ sourceID: job.source.id, status: "cancelled", attachments: [], error: "已取消" });
      }
      const current = this._current;
      if (current) {
        current.cancelled = true;
        await current.proc?.kill(2000).catch(() => {});
      }
      await this._pumping;
    },
  };
})();
