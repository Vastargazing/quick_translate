(function () {
  "use strict";

  let popupEl = null;
  let lastSelectionRect = null;
  let lastMousePos = { x: 0, y: 0 };

  // ─── Запоминаем позицию выделения ──────────────────────────────────────────

  document.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    lastSelectionRect = range.getBoundingClientRect();
  });

  // ─── Автоперевод при правом клике ──────────────────────────────────────────

  document.addEventListener("contextmenu", (e) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    if (!text) return;

    lastMousePos = { x: e.clientX, y: e.clientY };

    injectStyles();

    requestAnimationFrame(() => {
      setTimeout(() => {
        showPopup(text, lastMousePos);
        requestTranslation(text);
      }, 80);
    });
  });

  // ─── Команды от background (запасной путь через пункт меню) ─────────────────

  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "TRANSLATE_SELECTION") {
      injectStyles();
      showPopup(message.text, lastMousePos);
      requestTranslation(message.text);
    }
  });

  // ─── Popup ──────────────────────────────────────────────────────────────────

  function showPopup(originalText, mousePos) {
    removePopup();

    const iconUrl = browser.runtime.getURL("icons/icon.png");

    popupEl = document.createElement("div");
    popupEl.id = "qt-popup";

    const header = document.createElement("div");
    header.className = "qt-header";

    const logo = document.createElement("span");
    logo.className = "qt-logo";
    logo.style.cssText = "display:flex;align-items:center;gap:6px;";

    const img = document.createElement("img");
    img.src = iconUrl;
    img.className = "qt-icon";
    img.style.cssText = "width:16px;height:16px;object-fit:contain;display:block;flex-shrink:0;";
    logo.appendChild(img);
    logo.appendChild(document.createTextNode(" Quick Translate"));

    const closeBtn = document.createElement("button");
    closeBtn.className = "qt-close";
    closeBtn.title = "Close";
    closeBtn.textContent = "✕";

    header.appendChild(logo);
    header.appendChild(closeBtn);

    const originalDiv = document.createElement("div");
    originalDiv.className = "qt-original";
    originalDiv.textContent = originalText;

    const divider = document.createElement("div");
    divider.className = "qt-divider";

    const resultDiv = document.createElement("div");
    resultDiv.className = "qt-result qt-loading";
    const spinner = document.createElement("span");
    spinner.className = "qt-spinner";
    resultDiv.appendChild(spinner);
    resultDiv.appendChild(document.createTextNode("Translating…"));

    popupEl.appendChild(header);
    popupEl.appendChild(originalDiv);
    popupEl.appendChild(divider);
    popupEl.appendChild(resultDiv);

    positionPopup(popupEl, mousePos);
    document.body.appendChild(popupEl);
    popupEl.querySelector(".qt-close").addEventListener("click", removePopup);
    setTimeout(() => document.addEventListener("mousedown", onOutsideClick), 0);
  }

  function setResult(text) {
    if (!popupEl) return;
    const el = popupEl.querySelector(".qt-result");
    el.classList.remove("qt-loading");
    el.textContent = text;
  }

  function setError(msg) {
    if (!popupEl) return;
    const el = popupEl.querySelector(".qt-result");
    el.classList.remove("qt-loading");
    el.classList.add("qt-error");
    el.textContent = "⚠ " + msg;
  }

  function removePopup() {
    popupEl?.remove();
    popupEl = null;
    document.removeEventListener("mousedown", onOutsideClick);
  }

  function onOutsideClick(e) {
    if (popupEl && !popupEl.contains(e.target)) removePopup();
  }

  function positionPopup(el, pos) {
    el.style.position = "fixed";
    el.style.zIndex = "2147483647";

    const POPUP_W = 320;
    const POPUP_H = 180;
    const MARGIN = 12;
    const MENU_W = 340;  // ширина нативного контекстного меню Firefox
    const MENU_H = 420;  // высота (примерная, зависит от пунктов)

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = pos.x;
    const cy = pos.y;

    // Зона которую займёт контекстное меню
    const menuEndX = cx + MENU_W;
    const menuEndY = cy + MENU_H;

    // Четыре варианта размещения popup, в порядке приоритета:
    // 1. Слева от курсора  — меню идёт вправо, popup левее
    // 2. Выше курсора      — меню идёт вниз, popup выше
    // 3. Справа от меню   — крайний случай, меню слева
    // 4. Ниже меню        — последний fallback

    let left, top;

    if (cx - POPUP_W - MARGIN >= 0) {
      // ── Вариант 1: слева ──────────────────────────────
      left = cx - POPUP_W - MARGIN;
      top = Math.min(cy, vh - POPUP_H - MARGIN);
      top = Math.max(MARGIN, top);

    } else if (cy - POPUP_H - MARGIN >= 0) {
      // ── Вариант 2: выше ───────────────────────────────
      top = cy - POPUP_H - MARGIN;
      left = Math.min(cx, vw - POPUP_W - MARGIN);
      left = Math.max(MARGIN, left);

    } else if (menuEndX + POPUP_W + MARGIN <= vw) {
      // ── Вариант 3: правее меню ────────────────────────
      left = menuEndX + MARGIN;
      top = Math.min(cy, vh - POPUP_H - MARGIN);
      top = Math.max(MARGIN, top);

    } else {
      // ── Вариант 4: ниже меню — последний шанс ─────────
      top = Math.min(menuEndY + MARGIN, vh - POPUP_H - MARGIN);
      top = Math.max(MARGIN, top);
      left = Math.max(MARGIN, Math.min(cx - POPUP_W / 2, vw - POPUP_W - MARGIN));
    }

    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  // ─── Запрос перевода ────────────────────────────────────────────────────────

  async function requestTranslation(text) {
    try {
      const { targetLang } = await browser.storage.local.get("targetLang");
      const to = targetLang ?? "ru";

      const response = await browser.runtime.sendMessage({
        type: "REQUEST_TRANSLATION",
        text,
        from: "auto",
        to,
      });
      response.ok ? setResult(response.targetText) : setError(response.error);
    } catch (err) {
      setError(err.message);
    }
  }

  // ─── Утилиты ────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function injectStyles() {
    if (document.getElementById("qt-styles")) return;

    const style = document.createElement("style");
    style.id = "qt-styles";
    const comfortaaLatin = browser.runtime.getURL("fonts/Comfortaa-latin.woff2");
    const comfortaaCyrillic = browser.runtime.getURL("fonts/Comfortaa-cyrillic.woff2");
    const jetbrainsLatin = browser.runtime.getURL("fonts/JetBrainsMono-latin.woff2");
    const jetbrainsCyrillic = browser.runtime.getURL("fonts/JetBrainsMono-cyrillic.woff2");
    const nunitoLatin = browser.runtime.getURL("fonts/Nunito-latin.woff2");
    const nunitoCyrillic = browser.runtime.getURL("fonts/Nunito-cyrillic.woff2");
    style.textContent = `
      @font-face {
        font-family: 'Comfortaa';
        font-weight: 600;
        font-display: swap;
        src: url('${comfortaaLatin}') format('woff2');
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
      }
      @font-face {
        font-family: 'Comfortaa';
        font-weight: 600;
        font-display: swap;
        src: url('${comfortaaCyrillic}') format('woff2');
        unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
      }
      @font-face {
        font-family: 'JetBrains Mono';
        font-weight: 400;
        font-display: swap;
        src: url('${jetbrainsLatin}') format('woff2');
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
      }
      @font-face {
        font-family: 'JetBrains Mono';
        font-weight: 400;
        font-display: swap;
        src: url('${jetbrainsCyrillic}') format('woff2');
        unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
      }
      @font-face {
        font-family: 'Nunito';
        font-weight: 400 600;
        font-display: swap;
        src: url('${nunitoLatin}') format('woff2');
        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
      }
      @font-face {
        font-family: 'Nunito';
        font-weight: 400 600;
        font-display: swap;
        src: url('${nunitoCyrillic}') format('woff2');
        unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
      }
      #qt-popup {
        all: initial;
        position: absolute;
        z-index: 2147483647;
        width: 320px;
        max-width: calc(100vw - 32px);
        background: #1c1c1e;
        color: #f2f2f7;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
        font-family: "Nunito", sans-serif;
        font-size: 14px;
        line-height: 1.5;
        overflow: hidden;
        animation: qt-in 0.15s ease;
      }
      @keyframes qt-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #qt-popup .qt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      #qt-popup .qt-logo {
        font-family: "Comfortaa", cursive;
        font-size: 12px;
        font-weight: 600;
        color: #636366;
        letter-spacing: 0.02em;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #qt-popup .qt-icon {
        width: 14px;
        height: 14px;
        object-fit: contain;
        display: block;
        flex-shrink: 0;
      }
      #qt-popup .qt-close {
        all: unset;
        cursor: pointer;
        color: #636366;
        font-size: 13px;
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background 0.15s, color 0.15s;
      }
      #qt-popup .qt-close:hover {
        background: rgba(255,255,255,0.1);
        color: #f2f2f7;
      }
      #qt-popup .qt-original {
        font-family: "JetBrains Mono", monospace;
        padding: 10px 14px;
        color: #8e8e93;
        font-size: 12px;
        max-height: 72px;
        overflow-y: auto;
        word-break: break-word;
      }
      #qt-popup .qt-divider {
        height: 1px;
        background: rgba(255,255,255,0.08);
        margin: 0 14px;
      }
      #qt-popup .qt-result {
        font-family: "Nunito", sans-serif;
        padding: 12px 14px 14px;
        font-size: 15px;
        font-weight: 600;
        color: #f2f2f7;
        word-break: break-word;
        min-height: 46px;
      }
      #qt-popup .qt-loading {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #636366;
        font-size: 13px;
        font-weight: 400;
      }
      #qt-popup .qt-error {
        color: #ff453a;
        font-size: 13px;
        font-weight: 400;
      }
      #qt-popup .qt-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255,255,255,0.12);
        border-top-color: #0a84ff;
        border-radius: 50%;
        animation: qt-spin 0.7s linear infinite;
        flex-shrink: 0;
      }
      @keyframes qt-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }
})();
