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
    showPopup(text, lastMousePos);
    requestTranslation(text);
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
    popupEl.innerHTML = `
      <div class="qt-header">
        <span class="qt-logo" style="display:flex;align-items:center;gap:6px;"><img src="${iconUrl}" class="qt-icon" style="width:16px;height:16px;object-fit:contain;display:block;flex-shrink:0;"> Quick Translate</span>
        <button class="qt-close" title="Close">✕</button>
      </div>
      <div class="qt-original">${escapeHtml(originalText)}</div>
      <div class="qt-divider"></div>
      <div class="qt-result qt-loading">
        <span class="qt-spinner"></span>
        <span>Translating…</span>
      </div>
    `;

    positionPopup(popupEl, mousePos);
    document.body.appendChild(popupEl);
    popupEl.querySelector(".qt-close").addEventListener("click", removePopup);
    setTimeout(() => document.addEventListener("mousedown", onOutsideClick), 0);
  }

  function setResult(text) {
    if (!popupEl) return;
    const el = popupEl.querySelector(".qt-result");
    el.classList.remove("qt-loading");
    el.innerHTML = escapeHtml(text);
  }

  function setError(msg) {
    if (!popupEl) return;
    const el = popupEl.querySelector(".qt-result");
    el.classList.remove("qt-loading");
    el.classList.add("qt-error");
    el.innerHTML = "⚠ " + escapeHtml(msg);
  }

  function removePopup() {
    popupEl?.remove();
    popupEl = null;
    document.removeEventListener("mousedown", onOutsideClick);
  }

  function onOutsideClick(e) {
    if (popupEl && !popupEl.contains(e.target)) removePopup();
  }

  function positionPopup(el, mousePos) {
    el.style.position = "absolute";
    el.style.zIndex = "2147483647";

    if (!mousePos || (mousePos.x === 0 && mousePos.y === 0)) {
      el.style.top = "80px";
      el.style.left = "50%";
      el.style.transform = "translateX(-50%)";
      return;
    }

    const MARGIN = 12;
    const POPUP_W = 320;
    const POPUP_H = 180;

    const cx = mousePos.x;
    const cy = mousePos.y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sx = window.scrollX;
    const sy = window.scrollY;

    // Контекстное меню открывается вправо и вниз от курсора.
    // Ставим попап в противоположный квадрант — они никогда не пересекутся.

    let x = cx > vw / 2
      // курсор правее центра → попап левее курсора
      ? Math.max(MARGIN, cx - POPUP_W - MARGIN)
      // курсор левее центра → попап правее курсора (не знаем ширину меню, жмём к правому краю)
      : Math.min(vw - POPUP_W - MARGIN, cx + MARGIN);

    let y = cy > vh / 2
      // курсор ниже центра → попап выше курсора
      ? Math.max(MARGIN, cy - POPUP_H - MARGIN)
      // курсор выше центра → попап ниже курсора
      : Math.min(vh - POPUP_H - MARGIN, cy + MARGIN);

    el.style.left = (x + sx) + "px";
    el.style.top = (y + sy) + "px";
  }

  // ─── Запрос перевода ────────────────────────────────────────────────────────

  async function requestTranslation(text) {
    try {
      const response = await browser.runtime.sendMessage({
        type: "REQUEST_TRANSLATION",
        text,
        from: "auto",
        to: "ru",
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
