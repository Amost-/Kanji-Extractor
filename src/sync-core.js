// =============================================================================
// sync-core.js — pure, context-agnostic sync helpers.
//
// Data transforms for sync-coordinator.js. No DOM, storage, or network calls.
// The background loads these helpers before the coordinator in every browser.
// =============================================================================

// Legacy keys read ONLY during migration to the versioned kanjiState envelope.
const STORE_DEFAULTS = {
  seenKanji: {}, newOnlyEnabled: false, extractMode: "kanji-words",
  syncEnabled: false, syncQueue: {}, syncToken: null,
};

const MAX_TERM_COUNT = 1_000_000;
// CloudKit messages and imported histories use the same bounded term domain.
const MAX_HISTORY_TERM_CODE_POINTS = 64;

// Format a new save using the browser's local calendar day; ms is injected by
// the coordinator so tests and resumed jobs use the same clock.
function localDateString(ms) {
  const date = new Date(ms);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}

// Validate wire and imported dates before lexical min/max comparisons.
function validTermDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

// Invalid counts are absent; valid oversized integers share the native cap.
function termCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_TERM_COUNT) : null;
}

// Unknown incoming dates do not displace valid stored dates.
function mergedTermDate(stored, incoming, earliest) {
  const a = validTermDate(stored) ? stored : "";
  const b = validTermDate(incoming) ? incoming : "";
  return earliest ? minStr(a, b) : maxStr(a, b);
}

function today() { return localDateString(Date.now()); }
function minStr(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }
function maxStr(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }

// One shared collator. localeCompare(b, "ja") builds a fresh Collator on every
// comparison (~10x slower); sortSeenByCount runs on every save, so hoist it.
const KANJI_COLLATOR = (typeof Intl !== "undefined" && Intl.Collator)
  ? new Intl.Collator("ja") : null;

// The history is kept ordered by occurrence count (descending) so every save and
// export is frequency-sorted. Object key order survives storage.local and JSON,
// so rebuilding the object in sorted order is enough. Ties: by code point (ja).
function sortSeenByCount(seen) {
  const sorted = {};
  Object.keys(seen)
    .sort((a, b) => ((seen[b].count || 0) - (seen[a].count || 0)) ||
      (KANJI_COLLATOR ? KANJI_COLLATOR.compare(a, b) : (a < b ? -1 : a > b ? 1 : 0)))
    .forEach((k) => { sorted[k] = seen[k]; });
  return sorted;
}

// Union merge of remote records into the local history. Conflict-free:
// count = max, firstSeen = earliest, lastSeen = latest, URLs stay local.
// Returns how many local entries changed.
function mergeRemoteIntoSeen(seen, records) {
  let changed = 0;
  for (const record of (records || [])) {
    if (!record || typeof record.term !== "string" || !record.term) continue;
    const r = { ...record, term: record.term.normalize("NFC") };
    // Prototype-pollution guard (defense-in-depth for remote/imported records).
    if (r.term === "__proto__" || r.term === "constructor" || r.term === "prototype") continue;
    // Sanitize the remote count here, at the shared choke point, so EVERY
    // backend gets the protection (the native dto() clamps too, but a future
    // non-CloudKit backend pulls raw JSON straight into this merge).
    const rCount = termCount(r.count);
    const cur = Object.prototype.hasOwnProperty.call(seen, r.term) ? seen[r.term] : null;
    if (!cur) {
      seen[r.term] = {
        count: rCount ?? 0,
        firstSeen: validTermDate(r.firstSeen) ? r.firstSeen : today(),
        lastSeen: validTermDate(r.lastSeen) ? r.lastSeen : today(),
        firstUrl: "",
      };
      changed++;
    } else {
      const storedCount = termCount(cur.count);
      const c = Math.max(storedCount ?? 0, rCount ?? 0);
      const f = mergedTermDate(cur.firstSeen, r.firstSeen, true);
      const l = mergedTermDate(cur.lastSeen, r.lastSeen, false);
      if (c !== cur.count || f !== cur.firstSeen || l !== cur.lastSeen) {
        cur.count = c; cur.firstSeen = f; cur.lastSeen = l; changed++;
      }
    }
  }
  return changed;
}

// Protect object-keyed histories and command receipts from prototype keys.
function isSafeHistoryKey(value) {
  return typeof value === "string" && value.length > 0 &&
    !["__proto__", "constructor", "prototype"].includes(value);
}

// Accept only vocabulary terms within the shared JS/native code point limit.
function isHistoryTerm(term) {
  return isSafeHistoryKey(term) && Array.from(term).length <= MAX_HISTORY_TERM_CODE_POINTS;
}

// Imports and migration share normalization. Resolve older NFD aliases before
// merging so one written word cannot occupy two rows or two CloudKit records.
// Returns normalized touched terms so only those records need uploading.
function importIntoHistory(seen, incoming) {
  const aliases = new Map();
  for (const key of Object.keys(seen)) {
    const normalized = key.normalize("NFC");
    if (normalized !== key) {
      if (!aliases.has(normalized)) aliases.set(normalized, []);
      aliases.get(normalized).push(key);
    }
  }
  let added = 0;
  const touched = new Set();
  const removed = [];
  for (const rawTerm of Object.keys(incoming)) {
    if (!isHistoryTerm(rawTerm)) continue;
    const term = rawTerm.normalize("NFC");
    const rec = incoming[rawTerm];
    if (!isHistoryTerm(term) || !rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    for (const alias of aliases.get(term) || []) {
      const previous = seen[alias];
      if (previous && typeof previous === "object") {
        mergeRemoteIntoSeen(seen, [{ ...previous, term }]);
        seen[term].firstUrl = seen[term].firstUrl || previous.firstUrl || "";
      }
      delete seen[alias];
      removed.push(alias);
    }
    aliases.delete(term);
    const existed = Object.prototype.hasOwnProperty.call(seen, term);
    mergeRemoteIntoSeen(seen, [{
      // A listed term was seen at least once: a missing or invalid count
      // imports as 1, while an oversized valid one is clamped by termCount.
      term, count: termCount(rec.count) ?? 1,
      firstSeen: typeof rec.firstSeen === "string" ? rec.firstSeen : "",
      lastSeen: typeof rec.lastSeen === "string" ? rec.lastSeen : "",
    }]);
    if (!existed) {
      seen[term].firstUrl = typeof rec.firstUrl === "string" ? rec.firstUrl : "";
      added++;
    }
    touched.add(term);
  }
  return { added, touched: [...touched], removed };
}
