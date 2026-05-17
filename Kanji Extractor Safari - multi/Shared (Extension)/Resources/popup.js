// Cross-browser API alias (Safari supports both `browser` and `chrome`).
const api = (typeof browser !== "undefined") ? browser : chrome;

// Best-effort platform detection. We use it only to decide between the
// macOS download flow (anchor click in the page) and the iOS flow
// (native Share Sheet via runtime.sendNativeMessage).
function isIOS() {
  const ua = (navigator.userAgent || "");
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ reports "Macintosh" but is touch-enabled.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

function localizedMessage(key, substitutions, fallback) {
  if (!api.i18n || !api.i18n.getMessage) return fallback || key;
  return api.i18n.getMessage(key, substitutions || []) || fallback || key;
}

function applyLocalization() {
  if (api.i18n && api.i18n.getUILanguage) {
    document.documentElement.lang = api.i18n.getUILanguage().split("-")[0];
  }

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = localizedMessage(el.dataset.i18n, [], el.textContent);
  });
}

const extractBtn  = document.getElementById("extractBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl    = document.getElementById("status");
const statsEl     = document.getElementById("stats");
const sourceEl    = document.getElementById("source");
const uniqueEl    = document.getElementById("uniqueCount");
const totalEl     = document.getElementById("totalCount");
const resultsEl   = document.getElementById("results");

let lastResult = null; // { url, words, totalOccurrences }

applyLocalization();

// Adjust the button label on iOS where "Download" is misleading.
if (isIOS()) {
  downloadBtn.textContent = localizedMessage("share_button", [], "Share .txt");
}

function setStatus(msg, kind) {
  if (!msg) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.className = "status " + (kind || "");
}

async function getActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

// Show the current tab's URL up top so the user knows what will be scanned.
(async () => {
  const tab = await getActiveTab();
  if (tab && tab.url) {
    sourceEl.textContent = tab.url;
    sourceEl.title = tab.url;
  }
})();

extractBtn.addEventListener("click", async () => {
  setStatus("");
  resultsEl.innerHTML = "";
  statsEl.hidden = true;
  downloadBtn.disabled = true;
  lastResult = null;

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus(localizedMessage("no_active_tab", [], "No active tab."), "error");
    return;
  }

  // Some pages block content scripts (chrome:// safari-web-extension:// etc.)
  if (tab.url && /^(safari-web-extension|chrome|edge|about|file):/i.test(tab.url)) {
    setStatus(localizedMessage("restricted_page", [], "This page can't be scanned by extensions."), "error");
    return;
  }

  extractBtn.disabled = true;
  setStatus(localizedMessage("extracting", [], "Extracting..."));

  try {
    const injectionResults = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractKanjiInPage,
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus(localizedMessage("extraction_no_data", [], "Extraction returned no data."), "error");
      return;
    }

    lastResult = { url: tab.url, ...result };
    renderResults(lastResult);
    downloadBtn.disabled = result.words.length === 0;
    if (result.words.length === 0) {
      setStatus(localizedMessage("no_terms_found", [], "No kanji terms (2+ chars) found on this page."), "");
    } else {
      setStatus(localizedMessage("found_unique_terms", [String(result.words.length)], `Found ${result.words.length} unique term${result.words.length === 1 ? "" : "s"}.`), "ok");
    }
  } catch (err) {
    setStatus(localizedMessage("extraction_failed", [(err && err.message ? err.message : String(err))], "Extraction failed: " + (err && err.message ? err.message : err)), "error");
  } finally {
    extractBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!lastResult) return;
  try {
    const text = buildFileContents(lastResult);
    const filename = makeFilename(lastResult.url);

    if (isIOS()) {
      // iOS: anchor[download] doesn't trigger a save in Safari, and Safari Web
      // Extension handlers can't present native share UI. Keep the flow entirely
      // in the popup with the Web Share API.
      const file = new File([text], filename, { type: "text/plain;charset=utf-8" });

      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({ files: [file], title: filename });
          setStatus(localizedMessage("shared_file", [filename], "Shared " + filename), "ok");
        } catch (shareErr) {
          if (shareErr && shareErr.name === "AbortError") {
            setStatus("");
            return;
          }
          const reason = shareErr && shareErr.message ? shareErr.message : String(shareErr);
          setStatus(localizedMessage("share_failed", [reason], "Share failed: " + reason), "error");
        }
      } else {
        const reason = localizedMessage("web_share_unavailable", [], "Web Share is unavailable on this device.");
        setStatus(localizedMessage("share_failed", [reason], "Share failed: " + reason), "error");
      }
      return;
    }

    // macOS: inject a script that creates an <a download> and clicks it.
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus(localizedMessage("no_active_tab_download", [], "No active tab for download."), "error");
      return;
    }
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: (content, name) => {
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },
      args: [text, filename],
    });
    setStatus(localizedMessage("downloaded_file", [filename], "Downloaded " + filename), "ok");
  } catch (err) {
    setStatus(localizedMessage("download_failed", [(err && err.message ? err.message : String(err))], "Download failed: " + (err && err.message ? err.message : err)), "error");
  }
});

function renderResults(result) {
  uniqueEl.textContent = result.words.length;
  totalEl.textContent = result.totalOccurrences;
  statsEl.hidden = false;

  const frag = document.createDocumentFragment();
  result.words.forEach((word, i) => {
    const li = document.createElement("li");

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = (i + 1) + ".";

    const w = document.createElement("span");
    w.className = "word";
    w.textContent = word;

    const len = document.createElement("span");
    len.className = "len";
    // Spread to count code points correctly (handles surrogate pairs).
    const charCount = [...word].length;
    len.textContent = localizedMessage("char_count", [String(charCount)], charCount + " chars");

    li.appendChild(idx);
    li.appendChild(w);
    li.appendChild(len);
    frag.appendChild(li);
  });
  resultsEl.appendChild(frag);
}

function buildFileContents(r) {
  const lines = [];
  lines.push(localizedMessage("file_source", [r.url || ""], "Source: " + (r.url || "")));
  lines.push(localizedMessage("file_extracted", [new Date().toISOString()], "Extracted: " + new Date().toISOString()));
  lines.push(localizedMessage("file_unique_terms", [String(r.words.length)], "Unique kanji terms (2+ chars): " + r.words.length));
  lines.push(localizedMessage("file_total_occurrences", [String(r.totalOccurrences)], "Total occurrences (with duplicates): " + r.totalOccurrences));
  lines.push("-".repeat(40));
  for (const w of r.words) lines.push(w);
  return lines.join("\n") + "\n";
}

function makeFilename(url) {
  let host = "page";
  try { host = new URL(url).hostname || "page"; } catch (_) {}
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");
  return `kanji_${host}_${stamp}.txt`;
}

// Injected into the active page. Must be self-contained.
function extractKanjiInPage() {
  // Single regex: match runs of 2+ CJK ideographs in one pass.
  // Covers Unified Ideographs, Extensions A–G, and Compatibility block.
  const KANJI_RUN =
    /[一-鿿㐀-䶿豈-﫿\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}\u{2CEB0}-\u{2EBEF}\u{30000}-\u{3134F}]{2,}/gu;

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);
  const visCache = new Map();

  function isVisible(el) {
    if (!el || el === document.body) return true;
    const cached = visCache.get(el);
    if (cached !== undefined) return cached;
    let v = false;
    if (!SKIP_TAGS.has(el.tagName)) {
      const s = getComputedStyle(el);
      v = s.display !== "none" && s.visibility !== "hidden" && isVisible(el.parentElement);
    }
    visCache.set(el, v);
    return v;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  const words = [];
  let total = 0;
  let node;

  while ((node = walker.nextNode())) {
    if (!isVisible(node.parentElement)) continue;
    KANJI_RUN.lastIndex = 0;
    let m;
    while ((m = KANJI_RUN.exec(node.nodeValue)) !== null) {
      total++;
      if (!seen.has(m[0])) { seen.add(m[0]); words.push(m[0]); }
    }
  }

  return { words, totalOccurrences: total };
}
