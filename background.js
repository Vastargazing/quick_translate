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
  { code: "zh", name: "Chinese" },
];

function langName(code) {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase();
}

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

// ─── Загрузка WASM + моделей ──────────────────────────────────────────────────

async function loadEnginePayload(sourceLanguage, targetLanguage) {
  // Грузим WASM бинарник
  const wasmUrl = browser.runtime.getURL("wasm/bergamot-translator.wasm");
  const wasmResp = await fetch(wasmUrl);
  if (!wasmResp.ok) throw new Error(`Failed to fetch WASM: ${wasmResp.status}`);
  const bergamotWasmArrayBuffer = await wasmResp.arrayBuffer();

  // Грузим модели для языковой пары
  // Сначала пробуем прямую пару (en→ru)
  // Если нет — через pivot (xx→en + en→yy)
  const translationModelPayloads = await loadModelPayloads(
    sourceLanguage,
    targetLanguage
  );

  return { bergamotWasmArrayBuffer, translationModelPayloads };
}

async function loadModelPayloads(sourceLanguage, targetLanguage) {
  const modelsBase = browser.runtime.getURL("models/");

  // Пробуем прямую пару
  const directKey = `${sourceLanguage}${targetLanguage}`;
  const directExists = await checkModelExists(modelsBase, directKey);

  if (directExists) {
    const payload = await loadSingleModelPayload(
      modelsBase,
      sourceLanguage,
      targetLanguage
    );
    return [payload];
  }

  // Pivot через английский: src→en + en→tgt
  console.log(`[QT] No direct model ${directKey}, trying pivot via English`);

  const [pivotPayload1, pivotPayload2] = await Promise.all([
    loadSingleModelPayload(modelsBase, sourceLanguage, "en"),
    loadSingleModelPayload(modelsBase, "en", targetLanguage),
  ]);

  return [pivotPayload1, pivotPayload2];
}

async function checkModelExists(modelsBase, langPairKey) {
  try {
    const resp = await fetch(
      `${modelsBase}${langPairKey}/model.${langPairKey}.intgemm.alphas.bin`,
      { method: "HEAD" }
    );
    return resp.ok;
  } catch {
    return false;
  }
}

async function loadSingleModelPayload(modelsBase, src, tgt) {
  const key = `${src}${tgt}`;
  const base = `${modelsBase}${key}/`;

  // Грузим все три файла модели параллельно
  const [modelBuf, lexBuf, vocabBuf] = await Promise.all([
    fetchBuffer(`${base}model.${key}.intgemm.alphas.bin`),
    fetchBuffer(`${base}lex.50.50.${key}.s2t.bin`),
    fetchBuffer(`${base}vocab.${key}.spm`),
  ]);

  return {
    sourceLanguage: src,
    targetLanguage: tgt,
    languageModelFiles: {
      model: {
        buffer: modelBuf,
        record: { name: `model.${key}.intgemm.alphas.bin` },
      },
      lex: {
        buffer: lexBuf,
        record: { name: `lex.50.50.${key}.s2t.bin` },
      },
      vocab: {
        buffer: vocabBuf,
        record: { name: `vocab.${key}.spm` },
      },
    },
  };
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

// ─── Утилиты ──────────────────────────────────────────────────────────────────

async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.arrayBuffer();
}
