# Privacy Policy — Quick Translate

**Last updated:** March 2026

## Summary

Quick Translate translates text **locally on your device** using a WebAssembly engine. No text you translate is ever sent to any server.

---

## Data collected

**None.** Quick Translate does not collect, store, transmit, or share any personal data.

---

## What happens when you translate

1. You select text on a webpage and click "Translate"
2. The extension detects the source language **locally** using Firefox's built-in `browser.i18n.detectLanguage` API — no network request is made
3. The selected text is passed to a local WebAssembly translation engine (Bergamot) running entirely inside your browser
4. The translated result is displayed — nothing leaves your device

---

## External network requests

Quick Translate makes network requests **only to download translation model files**, and only on first use of a given language:

| Request | URL | Purpose | Frequency |
|---------|-----|---------|-----------|
| Model registry | `https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json` | Discover model file locations | Once, then cached |
| Model files | `https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/...` | Download translation model (~35 MB/language) | Once per language, then cached |

These requests are made to **Mozilla's official model CDN** (Google Cloud Storage, operated by Mozilla). The requests contain no user data — only file path identifiers for the requested language pair.

After download, all model files are stored locally in your browser's IndexedDB and reused without further network access.

**No text you translate is ever sent anywhere.**

---

## Local storage

The extension stores the following data locally on your device:

| Data | Storage | Purpose |
|------|---------|---------|
| Selected target language | `browser.storage.local` | Remember your language preference |
| Translation model files | IndexedDB (`qt-models-v1`) | Cache downloaded models for reuse |
| Model registry | IndexedDB (`qt-models-v1`) | Cache model URLs to avoid repeated fetches |

All of this data stays on your device and is never transmitted.

---

## Permissions

| Permission | Reason |
|-----------|--------|
| `contextMenus` | Add "Translate" item to the right-click menu |
| `storage` | Save your selected language preference |
| `unlimitedStorage` | Store translation model files (~35 MB/language) in IndexedDB |
| `scripting` | Inject the translation popup into pages opened before the extension loaded |
| `<all_urls>` (host permission) | Show the translation popup on any webpage |

---

## Third-party services

The only third-party service used is Mozilla's translation model CDN. Mozilla's privacy policy applies to those requests: https://www.mozilla.org/privacy/

---

## Contact

Source code: https://github.com/Vastargazing/quick_translate  
Issues: https://github.com/Vastargazing/quick_translate/issues
