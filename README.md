# Quick Translate

> Instant **offline** translation via right-click — powered by Mozilla's Bergamot engine, no cloud, no API keys.

![Quick Translate demo](https://github.com/Vastargazing/quick_translate/raw/master/icons/icon.png)

---

## Features

- **Fully offline** — translation runs locally in a WebAssembly engine
- **19 languages** — bg, cs, de, es, et, fr, hu, is, it, nl, pl, pt, ro, ru, sk, sl, sq, sr, uk
- **Auto language detection** — no need to specify source language
- **On-demand model download** — models (~35 MB/language) are fetched from Mozilla CDN on first use and cached persistently in IndexedDB
- **Right-click anywhere** — works on any webpage, select text → Translate
- **Language submenu** — switch target language directly from the context menu
- **Zen Browser compatible** — language selection via context menu works even when toolbar buttons are hidden
- **Pivot translation** — languages without a direct model pair translate via English automatically (e.g. de → ru becomes de→en→ru)

---

## How it works

```
Select text → right-click → "Translate: ..."
       │
       ▼
background.js detects source language (browser.i18n.detectLanguage)
       │
       ▼
Checks IndexedDB cache for model files
       │
  miss ▼  hit ────────────────────────┐
Mozilla CDN (.gz download ~10-15s)    │
       │                              │
       ▼                              ▼
DecompressionStream → IndexedDB  Bergamot WASM Worker
                                      │
                                      ▼
                              content_script.js
                              shows floating popup
```

Model files are downloaded **once**, then reused instantly on every subsequent request.

---

## Installation (development)

1. Clone the repo:
   ```bash
   git clone https://github.com/Vastargazing/quick_translate.git
   cd quick_translate
   ```

2. Open Firefox / Zen Browser and go to `about:debugging`

3. Click **This Firefox** → **Load Temporary Add-on** → select `manifest.json`

4. Select any text on a webpage → right-click → **Translate: "..."**

The first translation for each target language will download the model (~35 MB) from Mozilla's CDN automatically. No setup required.

---

## Switching language

Right-click on any selected text:

```
Translate: "selected text"
──────────────────────────
🌐 Language: Russian  ▶  Bulgarian
                          Czech
                          German
                          ...
                          Russian ✓
                          ...
```

The selected language is saved and used for all future translations.

---

## Language support

| Code | Language   | Code | Language   |
|------|------------|------|------------|
| bg   | Bulgarian  | nl   | Dutch      |
| cs   | Czech      | pl   | Polish     |
| de   | German     | pt   | Portuguese |
| en   | English    | ro   | Romanian   |
| es   | Spanish    | ru   | Russian    |
| et   | Estonian   | sk   | Slovak     |
| fr   | French     | sl   | Slovenian  |
| hu   | Hungarian  | sq   | Albanian   |
| is   | Icelandic  | sr   | Serbian    |
| it   | Italian    | uk   | Ukrainian  |

Pairs without a direct model (e.g. de↔ru) are translated via English pivot automatically.

---

## Model storage

Models are **not bundled** in the extension. On first use:

- Registry is fetched from [Mozilla's model CDN](https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json)
- 3 files per language pair are downloaded and decompressed in-browser:
  - `model.PAIR.intgemm.alphas.bin` (~16–30 MB)
  - `lex.50.50.PAIR.s2t.bin` (~2–5 MB)
  - `vocab.PAIR.spm` (~0.9 MB, committed to repo)
- All cached in **IndexedDB** — survives browser restarts

To pre-download models locally (for development/offline use):
```powershell
# All languages
powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1

# Specific languages
powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1 -Langs "de","fr","es"
```

---

## Project structure

```
manifest.json                  — MV3 manifest
background.js                  — Service worker: context menu, worker lifecycle, CDN download
content_script.js              — Injected into pages: floating popup UI
popup.html / popup.js          — Toolbar popup (language selector)
worker/
  translations-engine.worker.js — Bergamot Web Worker
wasm/
  bergamot-translator.wasm     — Bergamot WASM binary
  bergamot-translator.js       — JS glue
models/*/vocab.*.spm           — Vocabulary files (~0.9 MB each, committed)
scripts/
  download-models.ps1          — PowerShell script to pre-download all models
```

---

## Tech stack

- [Bergamot Translator](https://github.com/browsermt/bergamot-translator) — Mozilla's WASM machine translation engine
- [Firefox Translations models](https://github.com/mozilla/firefox-translations-models) — Neural MT models
- WebExtension MV3 API — context menus, scripting, storage
- IndexedDB — persistent binary model cache
- DecompressionStream — in-browser gzip decompression

---

## Known limitations

- Chinese (zh) — not supported (model not available in Bergamot)
- Source language detection falls back to English if unreliable
- First translation per language pair takes ~10–15 seconds (download)
