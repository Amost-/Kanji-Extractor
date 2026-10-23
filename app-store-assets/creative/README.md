# App Store creative assets (iOS 27)

Text-free brand images for the product page header and search results. One set serves every language. Built by `build.py` (`pip install playwright pillow`, then `python3 build.py`); output in `out/` (git-ignored).

| File | Size | Use |
|---|---|---|
| `testata-21x9.png` | 3840 × 1646 | product page header |
| `ricerca-3x2.png` | 3840 × 2560 | search results card |
| `universale-16x9.png` | 5244 × 2950 | single asset for both («Use header asset in search results») |

Each exists as dark (default) and light (`-chiara`). The subject (the real Hiku icon plus three ranked word cards) is fitted inside Apple's **Art Safe Area**, measured from the Photoshop templates (green layer): header (1097, 493) 1646 × 661, universal (1921, 660) 1402 × 962 (not vertically centred, by Apple's design). The 3:2 search asset has no template: its area is the universal one mapped onto the 3:2 centre crop, (1311, 573) 1217 × 835. `ASSETS` in `build.py` holds the rectangles; the subject fills 94% of them.

Only kanji and digits appear, never a localized word. Apple checks creative assets against the latest app version, so they should not depict features that are not shipped: the cards show only extraction and frequency ranking.

The area outside the safe rectangle is filled with a faint pattern of large kanji, faded out in an ellipse around the subject so the core graphic stays clean. It is decoration only (kanji, no localized words) and may be cropped freely.
