#!/usr/bin/env python3
"""Build Kanji Extractor's localized App Store Connect screenshot series.

What it does, in two steps per (language, device, scene):

1. SHOOT - opens the REAL extension popup (src/popup.html + popup.css +
   popup.js) in headless Chrome, stubs the extension APIs with sample data
   (see STUB_JS), drives it into the state the scene needs (extract, new-only
   filter, sync, saved) and screenshots the popup alone at 3x. Nothing in the
   popup is mocked: it is the shipped HTML/CSS/JS in the shipped locales.
2. COMPOSE - lays that popup screenshot on a device-shaped scene (iPhone
   sheet, iPad popover, Safari window on the Mac) under a localized caption,
   renders the page at the exact native pixel size App Store Connect wants and
   saves an opaque JPEG (App Store Connect rejects alpha channels).

Outputs (git-ignored, regenerate with this script):
    out/<lang>/<device>/<scene>.jpg
      iphone-6.3  1206 x 2622   (required: 6.3" iPhone)
      ipad-13     2064 x 2752   (required: 13" iPad)
      mac         2880 x 1800   (required for macOS apps)
      duo-outer   1398 x 2034   (iPhone Duo outer display; optional now,
                                 required from April 2027 with the iOS 27.1 SDK)
      duo-inner   2007 x 2853   (iPhone Duo inner display, same rule)

Usage:
    python3 build.py [--lang it] [--device mac] [--scene 3-new-terms]

Requires: pip install playwright pillow, Google Chrome (driven through
Playwright's "chrome" channel, no browser download), and the macOS system
fonts SF Pro Display and Hiragino Sans.
"""

import argparse
import base64
import io
import json
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SRC = HERE.parent.parent / "src"
POPUP_URL = (SRC / "popup.html").as_uri()

LANGS = {  # App Store Connect locale -> (extension _locales folder, Chrome locale)
    "en-US": ("en", "en-US"),
    "it": ("it", "it-IT"),
    "ja": ("ja", "ja-JP"),
}

# Native pixel size = viewport (CSS px) x scale. `popup_w` is the width the
# popup is shot at: the iPhone sheet fills the screen, the iPad popover and
# the Safari popover keep the shipped desktop width (380 px, see popup.css).
DEVICES = {
    "iphone-6.3": dict(view=(402, 874), scale=3, popup_w=402,
                       ua="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
                          "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    "ipad-13": dict(view=(1032, 1376), scale=2, popup_w=380,
                    ua="Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
                       "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    # iPhone Duo, portrait (landscape is optional and not produced). The outer
    # display behaves like a phone (iPhone UA, full-width sheet); the inner
    # display has regular/regular size classes, so it gets the iPad-style
    # popover. Both are 3x: 466 x 678 pt and 669 x 951 pt.
    "duo-outer": dict(view=(466, 678), scale=3, popup_w=402,
                      ua="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
                         "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    "duo-inner": dict(view=(669, 951), scale=3, popup_w=380,
                      ua="Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
                         "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    "mac": dict(view=(1440, 900), scale=2, popup_w=380,
                ua="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
                   "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"),
}

# Sample page the popup claims to have scanned (a generic news URL on purpose).
SAMPLE_URL = "https://news.example.jp/economy/2026/10/10/market-outlook"

# Terms the stubbed page scan returns. Kanji-words mode: words written entirely
# in kanji. All-words mode: any word containing a kanji (okurigana included).
TERMS_KANJI = [("日本", 12), ("経済", 9), ("政府", 8), ("企業", 6), ("市場", 5), ("社会", 4),
               ("世界", 4), ("影響", 3), ("調査", 3), ("発表", 2), ("問題", 2), ("環境", 1)]
TERMS_ALL = [("日本", 12), ("経済", 9), ("新しい", 8), ("政府", 7), ("行われ", 6), ("企業", 5),
             ("大きな", 4), ("市場", 4), ("影響", 3), ("受ける", 3), ("高い", 2), ("問題", 2)]
# Words the user "already knows" in the new-terms scene: 7 of the 12 above, so
# the filtered list shows exactly 5 new terms.
KNOWN_WORDS = ["日本", "経済", "政府", "社会", "世界", "問題", "環境"]

SCENES = {
    "1-extract":   dict(mode="kanji-words", terms=TERMS_KANJI, known=128, extract=True),
    "2-frequency": dict(mode="all-words", terms=TERMS_ALL, known=128, extract=True),
    "3-new-terms": dict(mode="kanji-words", terms=TERMS_KANJI, known=312, extract=True, new_only=True),
    "4-sync":      dict(mode="kanji-words", terms=TERMS_KANJI, known=312, extract=True, sync=True),
    "5-save":      dict(mode="kanji-words", terms=TERMS_KANJI, known=312, extract=True, saved=True),
    "6-privacy":   dict(popup=False),
}

# Runs before popup.js in the page: a tiny in-page "background" that answers
# the popup's commands, a fake active tab, a fake page scan and the real
# extension locale. CONFIG / MESSAGES are injected as JSON by `shoot_popup`.
STUB_JS = r"""
(() => {
  const state = {
    schemaVersion: 2, revision: 5, generation: 1, seenKanji: {},
    newOnlyEnabled: !!CONFIG.newOnly, extractMode: CONFIG.mode,
    syncEnabled: !!CONFIG.sync, syncQueue: {}, syncToken: null,
    sync: { phase: "idle", requested: false, nextAttemptAt: 0,
            lastSuccessAt: CONFIG.sync ? new Date(2026, 9, 10, 9, 41).getTime() : null,
            error: null, pages: 0, sent: 0, resetPending: false },
  };
  // Known words first (they matter for the new-terms filter), then filler
  // entries that only exist to make the "N terms known" footer realistic.
  const stamp = { count: 3, firstSeen: "2026-06-01", lastSeen: "2026-09-30", firstUrl: "" };
  CONFIG.knownWords.forEach((w) => { state.seenKanji[w] = { ...stamp }; });
  for (let i = 0; Object.keys(state.seenKanji).length < CONFIG.known; i++) {
    state.seenKanji["filler" + i] = { ...stamp };
  }
  const total = CONFIG.terms.reduce((n, t) => n + t[1], 0);
  const reply = (cb, value) => setTimeout(() => cb(value), 0);
  window.chrome = {
    i18n: {
      getUILanguage: () => CONFIG.uiLang,
      getMessage: (key, subs) => {
        const entry = MESSAGES[key];
        if (!entry) return "";
        // Named placeholders ($count$) map to positional content ($1), as in
        // the WebExtension i18n format; then positional $N take the arguments.
        const named = entry.placeholders || {};
        const text = entry.message.replace(/\$([A-Za-z_]\w*)\$/g,
          (m, name) => (named[name.toLowerCase()] || named[name] || { content: m }).content);
        return text.replace(/\$(\d)/g, (_, n) => (subs || [])[Number(n) - 1] ?? "");
      },
    },
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        const { command, payload } = message;
        if (command === "setPreferences") Object.assign(state, payload);
        if (command === "setSyncEnabled") state.syncEnabled = payload.enabled;
        state.revision += 1;
        reply(cb, { ok: true, state: JSON.parse(JSON.stringify(state)) });
      },
    },
    storage: { onChanged: { addListener() {} } },
    tabs: { query: async () => [{ id: 1, url: CONFIG.url }] },
    scripting: {
      executeScript: async () => [{ result: {
        engine: "segmenter", totalOccurrences: total,
        terms: CONFIG.terms.map(([term, count]) => ({ term, count })) } }],
    },
  };
})();
"""


def shoot_popup(browser, device, lang, scene):
    """Returns the popup's PNG bytes for `scene` on `device` in `lang`.

    The page runs with the device's user agent, so the shipped popup.js takes
    the same branches as on the device (iOS sheet width and "Share .txt" label
    on iPhone/iPad, the Safari-only iCloud row everywhere in this app).
    """
    cfg = DEVICES[device]
    spec = SCENES[scene]
    folder, chrome_locale = LANGS[lang]
    messages = json.loads((SRC / "_locales" / folder / "messages.json").read_text(encoding="utf-8"))
    config = dict(mode=spec["mode"], terms=spec["terms"], known=spec["known"],
                  newOnly=spec.get("new_only", False), sync=spec.get("sync", False),
                  knownWords=KNOWN_WORDS, url=SAMPLE_URL, uiLang=chrome_locale)

    ctx = browser.new_context(viewport={"width": cfg["popup_w"], "height": 900},
                              device_scale_factor=3, locale=chrome_locale,
                              user_agent=cfg["ua"], color_scheme="light",
                              timezone_id="Europe/Rome")
    page = ctx.new_page()
    # Chrome's navigator.vendor is "Google Inc."; the popup treats Safari as
    # "vendor Apple or UA mentions Safari", which the UA above already satisfies.
    page.add_init_script(f"const CONFIG = {json.dumps(config)}; const MESSAGES = {json.dumps(messages)};\n"
                         + STUB_JS)
    page.goto(POPUP_URL)
    page.wait_for_function("document.getElementById('source').textContent !== ''")
    page.wait_for_timeout(150)                       # let the initial getState settle
    if spec.get("extract"):
        page.click("#extractBtn")
        page.wait_for_selector("#results li")
        page.wait_for_timeout(100)
    if spec.get("saved"):
        # Freeze the green "saved" confirmation (checkmark) at full strength.
        page.evaluate("""() => {
            const b = document.getElementById('downloadBtn');
            b.classList.add('saved');
            b.style.animation = 'none';
        }""")
    png = page.locator("body").screenshot(animations="disabled")
    ctx.close()
    return png


# ---------------------------------------------------------------------------
# Scene composition (HTML rendered by Chrome at the native size)
# ---------------------------------------------------------------------------

# Fake Japanese article drawn behind the popup, so the popup reads as sitting
# on top of a real page. The text is decorative and blurred by the overlay.
ARTICLE_HTML = """
<div class="article">
  <div class="kicker">経済</div>
  <h2>市場の動向と社会への影響、政府が調査結果を発表</h2>
  <p>日本の経済は新しい局面を迎えている。企業の投資は大きく伸び、世界の市場にも影響を与えると見られている。</p>
  <div class="hero"></div>
  <p>政府は環境問題への対応も含め、今後の方針について説明を行った。専門家は社会全体への波及を指摘している。</p>
  <p>調査によると、国内の企業の六割が来年度の計画を見直す考えを示し、市場の関心も高まっている。</p>
</div>
"""

CSS = """
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body { font-family: "SF Pro Display", "Hiragino Sans", sans-serif; color: #fff; position: relative;
       background: #0a0f1c; -webkit-font-smoothing: antialiased; }
.glow { position: absolute; inset: 0;
        background: radial-gradient(ellipse 75% 30% at 50% -4%, rgba(var(--accent), .38), transparent 72%); }
.caption { position: absolute; left: 0; right: 0; top: var(--cap-top); height: var(--cap-h);
           padding: 0 6%; text-align: center; display: flex; flex-direction: column; align-items: center; }
h1 { font-size: var(--title); line-height: 1.16; font-weight: 700; text-wrap: balance; letter-spacing: -.01em; }
.sub { margin-top: calc(var(--title) * .28); font-size: var(--subsize); line-height: 1.3; font-weight: 500;
       color: rgba(255,255,255,.66); text-wrap: balance; }
:lang(ja) h1, :lang(ja) .sub, :lang(ja) .bullet span { word-break: auto-phrase; line-break: strict; }
:lang(ja) h1 { font-weight: 600; letter-spacing: 0; font-size: calc(var(--title) * .86); }
.stage { position: absolute; inset: 0; }
.popup { display: block; width: 100%; }
.page { position: absolute; inset: 0; background: #f2f2f4; overflow: hidden; }
.article { padding: 22px 22px 0; color: #222; font-family: "Hiragino Sans", sans-serif; }
.article .kicker { color: #c8102e; font-weight: 700; font-size: 12px; margin-bottom: 8px; }
.article h2 { font-size: 24px; line-height: 1.35; margin-bottom: 14px; }
.article p { font-size: 15px; line-height: 1.8; margin-bottom: 14px; color: #444; }
.article .hero { height: 170px; border-radius: 6px; margin-bottom: 16px;
                 background: linear-gradient(135deg, #9db4cf, #cdb9a0); }
.dim { position: absolute; inset: 0; background: rgba(0,0,0,.38); }
.shadow { box-shadow: 0 18px 50px rgba(0,0,0,.35), 0 0 0 .5px rgba(0,0,0,.25); }
"""


def caption_html(entry):
    """Headline plus subline (or the privacy bullets, drawn on the stage)."""
    sub = f'<div class="sub">{entry["sub"]}</div>' if "sub" in entry else ""
    return f'<div class="caption"><h1>{entry["title"]}</h1>{sub}</div>'


def popup_img(png):
    """Inline <img> for the popup screenshot (PNG bytes)."""
    return f'<img class="popup" src="data:image/png;base64,{base64.b64encode(png).decode()}">'


def phone_scene(popup):
    """iPhone: a Safari page dimmed behind the extension sheet. The screen
    bleeds off the bottom edge, so the sheet is anchored near the top."""
    return f"""
<style>
  :root {{ --cap-top: 40px; --cap-h: 124px; --title: 30px; --subsize: 16px; }}
  .screen {{ position: absolute; left: 50%; top: 168px; width: 402px; height: 874px; margin-left: -201px;
             transform: scale(.90); transform-origin: top center; border-radius: 48px 48px 0 0;
             overflow: hidden; border: 6px solid #2b3345; border-bottom: 0; background: #000; }}
  .article {{ padding-top: 64px; }}
  .status {{ position: absolute; top: 0; left: 0; right: 0; height: 46px; z-index: 3; color: #fff;
             display: flex; justify-content: space-between; align-items: center; padding: 4px 34px 0;
             font-weight: 600; font-size: 15px; }}
  .sheet {{ position: absolute; left: 0; right: 0; top: 66px; bottom: 0; z-index: 2; border-radius: 16px 16px 0 0;
            overflow: hidden; background: #fff; }}
  .grab {{ position: absolute; top: 6px; left: 50%; width: 40px; height: 4px; margin-left: -20px;
           border-radius: 2px; background: rgba(0,0,0,.25); z-index: 4; }}
</style>
<div class="screen"><div class="page">{ARTICLE_HTML}<div class="dim"></div></div>
  <div class="status"><span>9:41</span><span>●●● ▮</span></div>
  <div class="sheet"><div class="grab"></div>{popup}</div></div>"""


def ipad_scene(popup):
    """iPad: Safari with the extension popover at the top right."""
    return f"""
<style>
  :root {{ --cap-top: 70px; --cap-h: 210px; --title: 64px; --subsize: 31px; }}
  .win {{ position: absolute; left: 50%; top: 322px; width: 940px; height: 1100px; margin-left: -470px;
          border-radius: 34px 34px 0 0; overflow: hidden; border: 7px solid #2b3345; border-bottom: 0;
          background: #f2f2f4; }}
  .bar {{ position: absolute; left: 0; right: 0; top: 0; height: 74px; background: #e9e9ec; z-index: 3;
          border-bottom: 1px solid #d0d0d4; display: flex; align-items: center; gap: 14px; padding: 0 26px; }}
  .url {{ flex: 1; height: 38px; border-radius: 10px; background: #fff; color: #555; font-size: 17px;
          display: flex; align-items: center; justify-content: center; }}
  .ext {{ width: 36px; height: 36px; border-radius: 9px; background: #007aff; color: #fff; font-size: 20px;
          display: flex; align-items: center; justify-content: center; font-family: "Hiragino Sans"; }}
  .article {{ padding: 110px 44px 0; }}
  .article h2 {{ font-size: 40px; }} .article p {{ font-size: 22px; }} .article .hero {{ height: 260px; }}
  .pop {{ position: absolute; right: 36px; top: 88px; width: 380px; z-index: 4; border-radius: 16px;
          overflow: hidden; background: #fff; zoom: 1.3; }}
</style>
<div class="win"><div class="page">{ARTICLE_HTML}<div class="dim"></div></div>
  <div class="bar"><div class="url">news.example.jp</div><div class="ext">漢</div></div>
  <div class="pop shadow">{popup}</div></div>"""


def duo_outer_scene(popup):
    """iPhone Duo outer display: the phone layout in a shorter, narrower
    screen, so the sheet is scaled down to keep its list in view."""
    return f"""
<style>
  :root {{ --cap-top: 30px; --cap-h: 104px; --title: 27px; --subsize: 14px; }}
  .screen {{ position: absolute; left: 50%; top: 136px; width: 402px; height: 874px; margin-left: -201px;
             transform: scale(.84); transform-origin: top center; border-radius: 48px 48px 0 0;
             overflow: hidden; border: 6px solid #2b3345; border-bottom: 0; background: #000; }}
  .article {{ padding-top: 64px; }}
  .status {{ position: absolute; top: 0; left: 0; right: 0; height: 46px; z-index: 3; color: #fff;
             display: flex; justify-content: space-between; align-items: center; padding: 4px 34px 0;
             font-weight: 600; font-size: 15px; }}
  .sheet {{ position: absolute; left: 0; right: 0; top: 66px; bottom: 0; z-index: 2; border-radius: 16px 16px 0 0;
            overflow: hidden; background: #fff; }}
  .grab {{ position: absolute; top: 6px; left: 50%; width: 40px; height: 4px; margin-left: -20px;
           border-radius: 2px; background: rgba(0,0,0,.25); z-index: 4; }}
</style>
<div class="screen"><div class="page">{ARTICLE_HTML}<div class="dim"></div></div>
  <div class="status"><span>9:41</span><span>●●● ▮</span></div>
  <div class="sheet"><div class="grab"></div>{popup}</div></div>"""


def duo_inner_scene(popup):
    """iPhone Duo inner display: a tablet-style Safari window with the
    extension popover at the top right."""
    return f"""
<style>
  :root {{ --cap-top: 40px; --cap-h: 150px; --title: 42px; --subsize: 20px; }}
  .win {{ position: absolute; left: 50%; top: 206px; width: 620px; height: 760px; margin-left: -310px;
          border-radius: 26px 26px 0 0; overflow: hidden; border: 6px solid #2b3345; border-bottom: 0;
          background: #f2f2f4; }}
  .bar {{ position: absolute; left: 0; right: 0; top: 0; height: 56px; background: #e9e9ec; z-index: 3;
          border-bottom: 1px solid #d0d0d4; display: flex; align-items: center; gap: 10px; padding: 0 18px; }}
  .url {{ flex: 1; height: 30px; border-radius: 8px; background: #fff; color: #555; font-size: 14px;
          display: flex; align-items: center; justify-content: center; }}
  .ext {{ width: 30px; height: 30px; border-radius: 8px; background: #007aff; color: #fff; font-size: 17px;
          display: flex; align-items: center; justify-content: center; font-family: "Hiragino Sans"; }}
  .article {{ padding: 80px 28px 0; }}
  .article h2 {{ font-size: 26px; }} .article p {{ font-size: 16px; }} .article .hero {{ height: 150px; }}
  .pop {{ position: absolute; right: 22px; top: 66px; width: 380px; z-index: 4; border-radius: 14px;
          overflow: hidden; background: #fff; }}
</style>
<div class="win"><div class="page">{ARTICLE_HTML}<div class="dim"></div></div>
  <div class="bar"><div class="url">news.example.jp</div><div class="ext">漢</div></div>
  <div class="pop shadow">{popup}</div></div>"""


def mac_scene(popup):
    """macOS: a Safari window with the extension popover under the toolbar button."""
    return f"""
<style>
  :root {{ --cap-top: 38px; --cap-h: 140px; --title: 54px; --subsize: 26px; }}
  .win {{ position: absolute; left: 50%; top: 196px; width: 1220px; height: 720px; margin-left: -610px;
          border-radius: 14px 14px 0 0; overflow: hidden; background: #f2f2f4;
          box-shadow: 0 -2px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12); }}
  .bar {{ position: absolute; left: 0; right: 0; top: 0; height: 54px; background: #ececef; z-index: 3;
          border-bottom: 1px solid #d0d0d4; display: flex; align-items: center; gap: 12px; padding: 0 16px; }}
  .dot {{ width: 13px; height: 13px; border-radius: 50%; }}
  .url {{ flex: 1; height: 32px; border-radius: 8px; background: #fff; color: #555; font-size: 15px;
          display: flex; align-items: center; justify-content: center; margin: 0 80px 0 70px; }}
  .ext {{ width: 30px; height: 30px; border-radius: 7px; background: #007aff; color: #fff; font-size: 17px;
          display: flex; align-items: center; justify-content: center; font-family: "Hiragino Sans"; }}
  .article {{ padding: 90px 60px 0; max-width: 760px; }}
  .article h2 {{ font-size: 32px; }} .article p {{ font-size: 18px; }}
  .pop {{ position: absolute; right: 22px; top: 62px; width: 380px; z-index: 4; border-radius: 12px;
          overflow: hidden; background: #fff; }}
</style>
<div class="win"><div class="page">{ARTICLE_HTML}<div class="dim"></div></div>
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span><div class="url">news.example.jp</div><div class="ext">漢</div></div>
  <div class="pop shadow">{popup}</div></div>"""


# Privacy scene: three icon rows instead of a popup. Icons are plain strokes.
ICONS = {
    "device": '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    "noaccount": '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.6-4 3.6-6 7-6s6.4 2 7 6"/><path d="M3.5 3.5l17 17"/>',
    "nosend": '<path d="M12 3v11M7.5 9.5L12 14l4.5-4.5M5 20h14"/><path d="M3.5 3.5l17 17"/>',
}


def privacy_scene(entry, device):
    """Title is the caption; the stage holds the three statements."""
    sizes = {"iphone-6.3": (46, 18, 300, 112), "ipad-13": (110, 31, 560, 150), "mac": (96, 30, 270, 112),
             "duo-outer": (38, 16, 232, 92), "duo-inner": (60, 22, 290, 130)}
    icon, text, top, row_h = sizes[device]
    rows = "".join(
        f'<div class="bullet"><svg viewBox="0 0 24 24" width="{icon}" height="{icon}" fill="none" '
        f'stroke="#5ac8fa" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{ICONS[k]}</svg>'
        f'<span>{b}</span></div>'
        for k, b in zip(["device", "noaccount", "nosend"], entry["bullets"]))
    width = {"iphone-6.3": "86%", "ipad-13": "80%", "mac": "62%", "duo-outer": "88%", "duo-inner": "82%"}[device]
    caps = {"iphone-6.3": (46, 150, 31, 16), "ipad-13": (74, 250, 66, 31), "mac": (44, 170, 56, 26),
            "duo-outer": (30, 104, 27, 14), "duo-inner": (40, 150, 42, 20)}[device]
    return f"""
<style>
  :root {{ --cap-top: {caps[0]}px; --cap-h: {caps[1]}px; --title: {caps[2]}px; --subsize: {caps[3]}px; }}
  .list {{ position: absolute; left: 50%; top: {top}px; width: {width}; transform: translateX(-50%);
           display: flex; flex-direction: column; gap: {row_h * .22}px; }}
  .bullet {{ display: flex; align-items: center; gap: {icon * .5}px; min-height: {row_h}px;
             padding: 0 {icon * .6}px; border-radius: {icon * .5}px; background: rgba(255,255,255,.07);
             box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }}
  .bullet svg {{ flex: none; }}
  .bullet span {{ font-size: {text}px; line-height: 1.3; font-weight: 500; text-wrap: balance; }}
</style>
<div class="list">{rows}</div>"""


def compose(browser, device, lang, scene, entry, accent, popup_png, out_path):
    """Renders the finished screenshot at the device's native size and saves
    it as an opaque JPEG."""
    cfg = DEVICES[device]
    w, h = cfg["view"]
    if scene == "6-privacy":
        body = privacy_scene(entry, device)
    else:
        img = popup_img(popup_png)
        body = {"iphone-6.3": phone_scene, "ipad-13": ipad_scene, "mac": mac_scene,
                "duo-outer": duo_outer_scene, "duo-inner": duo_inner_scene}[device](img)
    html = f"""<!doctype html><html lang="{'ja' if lang == 'ja' else lang}"><head><meta charset="utf-8">
<style>{CSS} :root {{ --accent: {accent[0]}, {accent[1]}, {accent[2]}; }}</style></head>
<body><div class="glow"></div>{caption_html(entry)}<div class="stage">{body}</div></body></html>"""
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=cfg["scale"])
    page = ctx.new_page()
    page.set_content(html)
    page.wait_for_timeout(120)
    png = page.screenshot(type="png")
    ctx.close()
    image = Image.open(io.BytesIO(png)).convert("RGB")
    expected = (w * cfg["scale"], h * cfg["scale"])
    assert image.size == expected, f"{device}: got {image.size}, want {expected}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 4:4:4 chroma keeps thin UI edges and small text crisp.
    image.save(out_path, "JPEG", quality=94, subsampling=0, optimize=True)


def main():
    """Parses the filters, then shoots and composes every matching image."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lang", choices=list(LANGS))
    ap.add_argument("--device", choices=list(DEVICES))
    ap.add_argument("--scene", choices=list(SCENES))
    args = ap.parse_args()
    captions = json.loads((HERE / "captions.json").read_text(encoding="utf-8"))["scenes"]

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        for scene, entry in captions.items():
            if args.scene and scene != args.scene:
                continue
            for lang in LANGS:
                if args.lang and lang != args.lang:
                    continue
                for device in DEVICES:
                    if args.device and device != args.device:
                        continue
                    png = b"" if scene == "6-privacy" else shoot_popup(browser, device, lang, scene)
                    out = HERE / "out" / lang / device / f"{scene}.jpg"
                    compose(browser, device, lang, scene, entry[lang], entry["accent"], png, out)
                    print(out.relative_to(HERE))
        browser.close()


if __name__ == "__main__":
    main()
