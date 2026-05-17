// Cross-browser API alias (Safari supports both `browser` and `chrome`).
const api = (typeof browser !== "undefined") ? browser : chrome;

const extractBtn  = document.getElementById("extractBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl    = document.getElementById("status");
const statsEl     = document.getElementById("stats");
const sourceEl    = document.getElementById("source");
const uniqueEl    = document.getElementById("uniqueCount");
const totalEl     = document.getElementById("totalCount");
const resultsEl   = document.getElementById("results");

let lastResult = null; // { url, words, totalOccurrences }

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
    setStatus("No active tab.", "error");
    return;
  }

  // Some pages block content scripts (chrome:// safari-web-extension:// etc.)
  if (tab.url && /^(safari-web-extension|chrome|edge|about|file):/i.test(tab.url)) {
    setStatus("This page can't be scanned by extensions.", "error");
    return;
  }

  extractBtn.disabled = true;
  setStatus("Extracting…");

  try {
    const injectionResults = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractKanjiInPage,
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus("Extraction returned no data.", "error");
      return;
    }

    lastResult = { url: tab.url, ...result };
    renderResults(lastResult);
    downloadBtn.disabled = result.words.length === 0;
    if (result.words.length === 0) {
      setStatus("No kanji words (2+ chars) found on this page.", "");
    } else {
      setStatus(`Found ${result.words.length} unique word${result.words.length === 1 ? "" : "s"}.`, "ok");
    }
  } catch (err) {
    setStatus("Extraction failed: " + (err && err.message ? err.message : err), "error");
  } finally {
    extractBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!lastResult) return;
  let objectUrl = null;
  try {
    const text = buildFileContents(lastResult);
    const filename = makeFilename(lastResult.url);

    // Firefox blocks data: URLs in downloads.download(). Use a Blob object
    // URL instead — works in both Firefox and Chrome.
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    objectUrl = URL.createObjectURL(blob);

    await api.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
    });
    setStatus("Downloaded " + filename, "ok");
  } catch (err) {
    setStatus("Download failed: " + (err && err.message ? err.message : err), "error");
  } finally {
    // Revoke the object URL to free memory. Deferred so the browser has time
    // to start the download before the URL is invalidated.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
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
    len.textContent = charCount + " chars";

    li.appendChild(idx);
    li.appendChild(w);
    li.appendChild(len);
    frag.appendChild(li);
  });
  resultsEl.appendChild(frag);
}

function buildFileContents(r) {
  const lines = [];
  lines.push("Source: " + (r.url || ""));
  lines.push("Extracted: " + new Date().toISOString());
  lines.push("Unique kanji words (2+ chars): " + r.words.length);
  lines.push("Total occurrences (with duplicates): " + r.totalOccurrences);
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

// ---------------------------------------------------------------------------
// Function injected into the active page. Must be self-contained — it does
// NOT have access to anything in this file's scope at runtime.
// ---------------------------------------------------------------------------
function extractKanjiInPage() {
  const MIN_WORD_LENGTH = 2;

  // CJK Unified Ideographs + extensions + compatibility ideographs.
  // Mirrors the Swift app's ranges exactly.
  function isKanjiCodePoint(cp) {
    return (
      (cp >= 0x4E00  && cp <= 0x9FFF)  ||
      (cp >= 0x3400  && cp <= 0x4DBF)  ||
      (cp >= 0x20000 && cp <= 0x2A6DF) ||
      (cp >= 0x2A700 && cp <= 0x2B73F) ||
      (cp >= 0x2B740 && cp <= 0x2B81F) ||
      (cp >= 0x2B820 && cp <= 0x2CEAF) ||
      (cp >= 0x2CEB0 && cp <= 0x2EBEF) ||
      (cp >= 0x30000 && cp <= 0x3134F) ||
      (cp >= 0xF900  && cp <= 0xFAFF)
    );
  }

  // Walk visible text nodes only — skips <script>, <style>, hidden elements.
  function collectVisibleText(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
            return NodeFilter.FILTER_REJECT;
          }
          // Cheap visibility check — getComputedStyle is expensive in a loop
          // but acceptable here since we only run it on text nodes.
          const style = window.getComputedStyle(p);
          if (style && (style.display === "none" || style.visibility === "hidden")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let buf = "";
    let n;
    while ((n = walker.nextNode())) buf += n.nodeValue + "\n";
    return buf;
  }

  const text = collectVisibleText(document.body);

  // Iterate by Unicode code points so characters above the BMP (Extensions B+)
  // are handled correctly.
  const runs = [];
  let current = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isKanjiCodePoint(cp)) {
      current += ch;
    } else if (current) {
      if ([...current].length >= MIN_WORD_LENGTH) runs.push(current);
      current = "";
    }
  }
  if (current && [...current].length >= MIN_WORD_LENGTH) runs.push(current);

  // Deduplicate, preserving first-seen order.
  const seen = new Set();
  const unique = [];
  for (const r of runs) {
    if (!seen.has(r)) { seen.add(r); unique.push(r); }
  }

  return {
    words: unique,
    totalOccurrences: runs.length,
  };
}
