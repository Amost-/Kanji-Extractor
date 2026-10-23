// Executed after the real extractKanjiInPage function by test_extraction.py.
// The DOM fixture implements only the APIs consumed by the injected function.
var document;
function getComputedStyle(element) {
  const inlineTags = new Set(["SPAN", "A", "B", "EM", "STRONG", "RUBY", "RT", "RP", "WBR"]);
  let visibility = "visible";
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.style.visibility) {
      visibility = ancestor.style.visibility;
      break;
    }
  }
  return Object.assign({
    display: inlineTags.has(element.tagName) ? "inline" : "block",
    visibility,
  }, element.style);
}

// Model light children and an optional open shadow root for the page walker.
function domElement(tagName, children, style, shadowChildren) {
  return { tagName, children: children || [], style: style || {}, shadowChildren };
}

function setDOM(children, bodyStyle) {
  function build(spec, parent) {
    if (typeof spec === "string") {
      return { nodeType: 3, nodeValue: spec, parentElement: parent };
    }
    const element = {
      nodeType: 1, tagName: spec.tagName, style: spec.style || {},
      parentElement: parent, childNodes: [],
    };
    element.childNodes = (spec.children || []).map((child) => build(child, element));
    if (spec.shadowChildren) {
      element.shadowRoot = { childNodes: spec.shadowChildren.map((child) => build(child, element)) };
    }
    return element;
  }
  document = { body: build(domElement("BODY", children, bodyStyle), null) };
}

function setPage(chunks) {
  const children = chunks.map((chunk) => {
    if (typeof chunk === "string") chunk = { text: chunk };
    let spec = chunk.text;
    for (const ancestor of (chunk.ancestors || []).slice().reverse()) {
      spec = domElement(ancestor.tagName || "DIV", [spec], ancestor.style);
    }
    // Existing corpus chunks represent separate paragraphs; explicit inline
    // siblings are covered below with setDOM.
    return domElement("P", [spec]);
  });
  setDOM(children);
}

function checkResult(mode, engine, terms, name) {
  const expected = expectedTerms(terms);
  equal(extractKanjiInPage(mode), {
    terms: expected,
    totalOccurrences: expected.reduce((sum, term) => sum + term.count, 0),
    engine,
  }, name);
}

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + "\nExpected: " + JSON.stringify(expected)
      + "\nActual:   " + JSON.stringify(actual));
  }
}

function expectedTerms(terms) {
  return terms.map((term) => typeof term === "string" ? { term, count: 1 } : term);
}

let passed = 0;
let failed = 0;
function test(name, callback) {
  try {
    callback();
    passed++;
  } catch (error) {
    failed++;
    print("FAIL " + name + ": " + error.message);
  }
}

const originalSegmenter = Intl.Segmenter;
if (typeof originalSegmenter !== "function") {
  throw new Error("This suite requires Intl.Segmenter to exercise the primary engine.");
}

try {
  for (const engine of ["segmenter", "runs"]) {
    Intl.Segmenter = engine === "segmenter" ? originalSegmenter : undefined;
    for (const mode of ["kanji-words", "all-words"]) {
      const prefix = engine + " / " + mode + " / ";
      function check(name, chunks, terms) {
        test(prefix + name, () => {
          setPage(chunks);
          checkResult(mode, engine, terms, name);
        });
      }
      function checkDOM(name, children, terms, bodyStyle) {
        test(prefix + name, () => {
          setDOM(children, bodyStyle);
          checkResult(mode, engine, terms, name);
        });
      }

      check("reject Hangul syllables and all Jamo forms", [
        "안녕하세요 한국어 한글 서울 대한민국",
        "\u1112\u1161\u11AB\u1100\u1173\u11AF", // decomposed Hangul Jamo
        "\u314E\u314F\u3134\u3131\u3161\u3139", // compatibility Jamo
        "\uFFA1\uFFC2\uFFA4",                     // halfwidth Jamo
        "\uA960\uA961 \uD7B0\uD7B1",              // extended Jamo
      ], []);

      check("mixed Japanese and Korean", [
        "한국語 日本語 한글 學校에 漢字한글",
      ], engine === "segmenter" && mode === "all-words"
        ? ["語", "日本語", "學校", "漢字"]
        : ["日本語", "學校", "漢字"]);

      check("reject Korean Wikipedia terms from reported Safari screenshot", [
        "본문으로 이동 메뉴 검색 기부 계정 만들기 로그인",
      ], []);

      check("reject private use characters", [
        "\uE000\uE001 \uF000\uF001 \u{F0000}\u{F0001}",
      ], []);

      check("Japanese compounds and okurigana", [
        "日本語 学校 漢字 食べる お茶",
      ], engine === "segmenter" && mode === "all-words"
        ? ["日本語", "学校", "漢字", "食べる", "お茶"]
        : ["日本語", "学校", "漢字"]);

      check("iteration mark words", ["人々 時々 様々 我々 日々"],
        ["人々", "時々", "様々", "我々", "日々"]);
      check("variation selectors are removed before word classification", ["漢\u{E0100}字 日\uFE0F本"],
        ["漢字", "日本"]);
      check("iteration mark must not fuse adjacent words", ["時々大雨"],
        ["時々", "大雨"]);
      check("bare marks and placeholders are not vocabulary", ["々 〻 〇〇 ゝ ゞ ヽ ヾ"], []);

      // Hangul tone marks attach to a Han token under Intl.Segmenter. Merely
      // requiring one kanji would retain these non-Japanese mixed-script terms.
      check("reject attached Hangul tone marks", ["語\u302E 日本語 語\u302F"], ["日本語"]);

      check("count duplicates across text nodes in first-seen order", [
        "日本語 漢字 日本語", "漢字 日本語",
      ], [{ term: "日本語", count: 3 }, { term: "漢字", count: 2 }]);

      check("hidden ancestors and non-content tags", [
        "日本語",
        { text: "秘密", ancestors: [{ style: { display: "none" } }, {}] },
        { text: "学校", ancestors: [{ style: { visibility: "hidden" } }, {}] },
        { text: "漢字", ancestors: [{ tagName: "SCRIPT" }] },
        { text: "漢字", ancestors: [{ tagName: "STYLE" }] },
        { text: "漢字", ancestors: [{ tagName: "NOSCRIPT" }, {}] },
      ], ["日本語"]);

      checkDOM("inline markup preserves a Japanese word", [
        domElement("SPAN", ["日"]), domElement("B", ["本"]), "語",
      ], ["日本語"]);
      checkDOM("open shadow roots are scanned", [
        domElement("DIV", [], {}, ["日本語"]),
      ], ["日本語"]);
      test(prefix + "time budget returns a partial scan", () => {
        setDOM([domElement("P", ["日本語"]), domElement("P", ["学校"])]);
        const now = Date.now;
        let calls = 0;
        Date.now = () => (++calls > 5 ? 2000 : 0);
        try {
          equal(extractKanjiInPage(mode).partial, true, "budget marks incomplete scan");
        } finally { Date.now = now; }
      });
      checkDOM("ruby readings do not split base words", [
        domElement("RUBY", ["日", domElement("RT", ["に"]), "本",
          domElement("RP", ["("]), domElement("RT", ["ほん"]), domElement("RP", [")"]), "語"]),
      ], ["日本語"]);
      checkDOM("ruby base rejoins following okurigana", [
        domElement("RUBY", ["食", domElement("RT", ["た"])]), "べる",
      ], engine === "segmenter" && mode === "all-words" ? ["食べる"] : []);
      checkDOM("block elements do not create a compound", [
        domElement("DIV", ["日"]), domElement("DIV", ["本"]),
      ], engine === "segmenter" && mode === "all-words" ? ["日", "本"] : []);
      checkDOM("CSS block spans separate words", [
        domElement("SPAN", ["日"], { display: "block" }), "本",
      ], engine === "segmenter" && mode === "all-words" ? ["日", "本"] : []);
      checkDOM("BR separates words", ["日", domElement("BR"), "本"],
        engine === "segmenter" && mode === "all-words" ? ["日", "本"] : []);
      checkDOM("hidden inline content does not create a compound", [
        "日", domElement("SPAN", ["秘密"], { display: "none" }), "本",
      ], engine === "segmenter" && mode === "all-words" ? ["日", "本"] : []);
      checkDOM("hidden BODY excludes direct and nested text", ["日本語", domElement("SPAN", ["学校"])], [],
        { display: "none" });
      checkDOM("visibility-hidden BODY excludes inherited hidden text", ["日本語", domElement("SPAN", ["学校"])], [],
        { visibility: "hidden" });
      checkDOM("descendant can explicitly restore visibility", [
        domElement("DIV", [domElement("SPAN", ["日本語"], { visibility: "visible" })], { visibility: "hidden" }),
      ], ["日本語"]);
      checkDOM("collapsed table row is not visible", [
        domElement("TR", [domElement("TD", ["秘密"])], { visibility: "collapse" }),
      ], []);
      checkDOM("display contents keeps inline text contiguous", [
        "日", domElement("DIV", ["本"], { display: "contents" }), "語",
      ], ["日本語"]);
      checkDOM("literal whitespace remains a boundary", ["日", " ", "本"],
        engine === "segmenter" && mode === "all-words" ? ["日", "本"] : []);

      check("a supplementary ideograph is one character", ["\u{20BB7}"],
        engine === "segmenter" && mode === "all-words" ? ["\u{20BB7}"] : []);

      if (engine === "runs") {
        check("supplementary ideographs survive fallback runs", ["\u{20BB7}\u{20BB7}"],
          ["\u{20BB7}\u{20BB7}"]);
      }

      test(prefix + "missing body", () => {
        document = { body: null };
        equal(extractKanjiInPage(mode), {
          terms: [], totalOccurrences: 0, engine: "none",
        }, "missing body");
      });
    }
  }
} finally {
  Intl.Segmenter = originalSegmenter;
}

print(passed + " extraction cases passed; " + failed + " failed.");
if (failed) throw new Error("Extraction regression suite failed.");
