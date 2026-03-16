"use strict";

// ─── Состояние ────────────────────────────────────────────────────────────────

let engineWorker = null;
let engineReady = false;
let initPromise = null;
let currentPairKey = null;
let messageCounter = 0;

// Ожидающие ответа: messageId → { resolve, reject }
let pendingMessages = new Map();

// ─── Контекстное меню ─────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: "bg", name: "Bulgarian" },
  { code: "cs", name: "Czech" },
  { code: "de", name: "German" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "et", name: "Estonian" },
  { code: "fr", name: "French" },
  { code: "hu", name: "Hungarian" },
  { code: "is", name: "Icelandic" },
  { code: "it", name: "Italian" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "sq", name: "Albanian" },
  { code: "sr", name: "Serbian" },
  { code: "uk", name: "Ukrainian" },
];

function langName(code) {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase();
}

browser.contextMenus.removeAll().then(() => {

  browser.contextMenus.create({
    id: "quick-translate",
    title: 'Translate: "%s"',
    contexts: ["selection"],
    icons: {
      "16": "icons/icon.png",
      "32": "icons/icon.png",
    },
  });

  // Разделитель
  browser.contextMenus.create({
    id: "qt-separator",
    type: "separator",
    contexts: ["selection"],
  });

  // Родительский пункт "🌐 Language: Russian"
  browser.contextMenus.create({
    id: "qt-lang-parent",
    title: "🌐 Language: Russian",
    contexts: ["selection"],
  });

  // Подменю с языками
  for (const { code, name } of LANGUAGES) {
    browser.contextMenus.create({
      id: `qt-lang-${code}`,
      parentId: "qt-lang-parent",
      title: name,
      type: "radio",
      checked: code === "ru",
      contexts: ["selection"],
    });
  }

  // Инициализируем заголовок и checked из storage при старте
  browser.storage.local.get("targetLang").then(({ targetLang }) => {
    const code = targetLang ?? "ru";
    browser.contextMenus.update("qt-lang-parent", { title: `🌐 Language: ${langName(code)}` });
    browser.contextMenus.update(`qt-lang-${code}`, { checked: true });
  });

}); // end removeAll

browser.contextMenus.onClicked.addListener((info, tab) => {
  // Смена языка
  if (info.menuItemId.startsWith("qt-lang-")) {
    const code = info.menuItemId.slice("qt-lang-".length);
    browser.storage.local.set({ targetLang: code });
    browser.contextMenus.update("qt-lang-parent", { title: `🌐 Language: ${langName(code)}` });
    return;
  }

  if (info.menuItemId !== "quick-translate") return;
  const text = info.selectionText?.trim();
  if (!text) return;

  browser.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_SELECTION",
    text,
  });
});

// ─── Сообщения от content_script ─────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "REQUEST_TRANSLATION") {
    handleTranslation(message)
      .then(r => sendResponse({ ok: true, targetText: r }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // держим канал открытым для async
  }
});

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

function startWorker(sourceLanguage, targetLanguage) {
  // Каждая новая языковая пара = новый worker
  // (оригинал Firefox тоже создаёт worker per language pair)
  return new Promise((resolve, reject) => {
    const url = browser.runtime.getURL(
      "worker/translations-engine.worker.js"
    );

    const worker = new Worker(url);

    worker.onmessage = ({ data }) => {
      switch (data.type) {

        // ── Инициализация ──────────────────────────────────────────────────
        case "initialization-success":
          engineReady = true;
          engineWorker = worker;
          resolve(worker);
          break;

        case "initialization-error":
          reject(new Error(data.error ?? "Worker init failed"));
          break;

        // ── Перевод ────────────────────────────────────────────────────────
        case "translation-response": {
          const p = pendingMessages.get(data.messageId);
          if (!p) break;
          pendingMessages.delete(data.messageId);
          p.resolve(data.targetText);
          break;
        }

        case "translation-error": {
          const p = pendingMessages.get(data.messageId);
          if (!p) break;
          pendingMessages.delete(data.messageId);
          p.reject(new Error(data.error?.message ?? "Translation failed"));
          break;
        }

        case "translations-discarded":
          break;

        default:
          console.warn("[QT background] Unknown worker message:", data.type);
      }
    };

    worker.onerror = (e) => {
      console.error("[QT background] Worker crashed:", e);
      engineReady = false;
      engineWorker = null;
      initPromise = null;
      reject(new Error("Worker crashed: " + e.message));
    };

    // Отправляем initialize — первое сообщение должно быть именно оно
    loadEnginePayload(sourceLanguage, targetLanguage)
      .then(enginePayload => {
        // Собираем все ArrayBuffer для передачи как transferable
        // (без этого ~200MB копируется, что вызывает OOM в сервис-воркере)
        const transferables = [enginePayload.bergamotWasmArrayBuffer];
        for (const payload of enginePayload.translationModelPayloads) {
          for (const file of Object.values(payload.languageModelFiles)) {
            transferables.push(file.buffer);
          }
        }

        worker.postMessage({
          type: "initialize",
          sourceLanguage,
          targetLanguage,
          enginePayload,
          logLevel: "Error",
        }, transferables);
      })
      .catch(reject);
  });
}

// ─── IndexedDB (кэш моделей) ─────────────────────────────────────────────────

const IDB_NAME = "qt-models-v1";
const IDB_STORE = "files";
let _db = null;

async function openModelDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

async function idbGet(key) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror = e => reject(e.target.error);
  });
}

async function idbPut(key, value) {
  const db = await openModelDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

// ─── Mozilla CDN ──────────────────────────────────────────────────────────────

const REGISTRY_URL = "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json";
const RELEASE_PRIORITY = ["Release", "Release Desktop", "Release Android", "Nightly"];
let _registry = null;

async function getRegistry() {
  if (_registry) return _registry;
  // Проверяем кэш в IDB (чтобы не грузить каждый раз)
  const cached = await idbGet("__registry__");
  if (cached) {
    _registry = JSON.parse(new TextDecoder().decode(cached));
    return _registry;
  }
  console.log("[QT] Fetching model registry from Mozilla CDN...");
  const resp = await fetch(REGISTRY_URL);
  if (!resp.ok) throw new Error(`Registry fetch failed: ${resp.status}`);
  _registry = await resp.json();
  await idbPut("__registry__", new TextEncoder().encode(JSON.stringify(_registry)));
  return _registry;
}

function pickBestModel(variants) {
  for (const status of RELEASE_PRIORITY) {
    const found = variants.find(v => v.releaseStatus === status);
    if (found) return found;
  }
  return variants[0];
}

async function downloadAndDecompress(url, idbKey) {
  console.log(`[QT] Downloading ${idbKey}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed for ${idbKey}: HTTP ${resp.status}`);
  let buf;
  if (url.endsWith(".gz")) {
    const ds = new DecompressionStream("gzip");
    buf = await new Response(resp.body.pipeThrough(ds)).arrayBuffer();
  } else {
    buf = await resp.arrayBuffer();
  }
  await idbPut(idbKey, buf);
  console.log(`[QT] Cached ${idbKey} (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  return buf;
}

async function getOrDownload(idbKey, remoteUrl) {
  const cached = await idbGet(idbKey);
  if (cached) return cached;
  return downloadAndDecompress(remoteUrl, idbKey);
}

// ─── Загрузка WASM + моделей ──────────────────────────────────────────────────

async function loadEnginePayload(sourceLanguage, targetLanguage) {
  const wasmUrl = browser.runtime.getURL("wasm/bergamot-translator.wasm");
  const wasmResp = await fetch(wasmUrl);
  if (!wasmResp.ok) throw new Error(`Failed to fetch WASM: ${wasmResp.status}`);
  const bergamotWasmArrayBuffer = await wasmResp.arrayBuffer();

  const translationModelPayloads = await loadModelPayloads(sourceLanguage, targetLanguage);
  return { bergamotWasmArrayBuffer, translationModelPayloads };
}

async function loadModelPayloads(sourceLanguage, targetLanguage) {
  const registry = await getRegistry();
  const directKey = `${sourceLanguage}-${targetLanguage}`;
  const hasDirectModel = Array.isArray(registry.models[directKey]) && registry.models[directKey].length > 0;

  if (hasDirectModel) {
    return [await loadSingleModelPayload(sourceLanguage, targetLanguage, registry)];
  }

  // Pivot через английский: src→en + en→tgt
  console.log(`[QT] No direct model for ${directKey}, pivoting via English`);
  const [p1, p2] = await Promise.all([
    loadSingleModelPayload(sourceLanguage, "en", registry),
    loadSingleModelPayload("en", targetLanguage, registry),
  ]);
  return [p1, p2];
}

async function loadSingleModelPayload(src, tgt, registry) {
  const key = `${src}${tgt}`;
  const regKey = `${src}-${tgt}`;
  const variants = registry.models[regKey];
  if (!variants?.length) throw new Error(`No CDN model available for ${regKey}`);

  const best = pickBestModel(variants);
  const { model: modelFile, lexicalShortlist: lexFile, vocab: vocabFile } = best.files;
  const base = registry.baseUrl;

  setBadge("⬇", "#0077cc");
  try {
    const [modelBuf, lexBuf, vocabBuf] = await Promise.all([
      getOrDownload(`${key}/model`, `${base}/${modelFile.path}`),
      getOrDownload(`${key}/lex`,   `${base}/${lexFile.path}`),
      getOrDownload(`${key}/vocab`, `${base}/${vocabFile.path}`),
    ]);
    return {
      sourceLanguage: src,
      targetLanguage: tgt,
      languageModelFiles: {
        model: { buffer: modelBuf, record: { name: `model.${key}.intgemm.alphas.bin` } },
        lex:   { buffer: lexBuf,   record: { name: `lex.50.50.${key}.s2t.bin` } },
        vocab: { buffer: vocabBuf, record: { name: `vocab.${key}.spm` } },
      },
    };
  } finally {
    setBadge("", "");
  }
}

function setBadge(text, color) {
  browser.action.setBadgeText({ text });
  if (color) browser.action.setBadgeBackgroundColor({ color });
}

// ─── Перевод ──────────────────────────────────────────────────────────────────

async function handleTranslation({ text, from, to }) {
  // Определяем языки
  const sourceLanguage = from === "auto" ? "en" : from; // TODO: детектор
  const targetLanguage = to ?? "ru";

  // Создаём ключ для кэша воркеров по языковой паре
  const pairKey = `${sourceLanguage}-${targetLanguage}`;

  // Если язык сменился — убиваем старый воркер и создаём новый
  if (pairKey !== currentPairKey) {
    if (engineWorker) {
      engineWorker.terminate();
      engineWorker = null;
    }
    engineReady = false;
    initPromise = null;
    currentPairKey = pairKey;
  }

  if (!initPromise) {
    initPromise = startWorker(sourceLanguage, targetLanguage);
  }

  await initPromise;

  // Отправляем задачу воркеру
  return new Promise((resolve, reject) => {
    const messageId = ++messageCounter;
    pendingMessages.set(messageId, { resolve, reject });

    engineWorker.postMessage({
      type: "translation-request",
      sourceText: text,
      messageId,
      translationId: messageId,
      isHTML: false,
    });

    // Таймаут
    setTimeout(() => {
      if (!pendingMessages.has(messageId)) return;
      pendingMessages.delete(messageId);
      reject(new Error("Translation timeout (30s)"));
    }, 30_000);
  });
}
