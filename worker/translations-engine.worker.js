"use strict";

/* global loadBergamot */
importScripts(new URL("../wasm/bergamot-translator.js", self.location.href).href);

// ─── Логирование ──────────────────────────────────────────────────────────────

let _loggingLevel = "Error";
function log(...args) {
  if (_loggingLevel !== "Error" && _loggingLevel !== "Warn") {
    console.log("[QT Worker]:", ...args);
  }
}

// Пробрасываем unhandled rejections — иначе тихо глотаются в Worker
self.addEventListener("unhandledrejection", event => {
  throw event.reason;
});

// ─── Константы ────────────────────────────────────────────────────────────────

const MODEL_FILE_ALIGNMENTS = {
  model: 256,
  lex: 64,
  vocab: 64,
  qualityModel: 64,
  srcvocab: 64,
  trgvocab: 64,
};

const WHITESPACE_REGEX = /^(\s*)(.*?)(\s*)$/s;
const FULL_WIDTH_PUNCTUATION_REGEX = /([。！？])"/g;
const FULL_WIDTH_PUNCTUATION_LANGUAGE_TAGS = ["ja", "ko", "zh"];

// ─── Предобработка текста ─────────────────────────────────────────────────────

function cleanText(sourceLanguage, sourceText) {
  const result = WHITESPACE_REGEX.exec(sourceText);
  if (!result) throw new Error("Whitespace regex failed");

  const whitespaceBefore = result[1];
  const whitespaceAfter = result[3];
  let cleanedSourceText = result[2];

  // Мягкие переносы ломают токенизацию
  cleanedSourceText = cleanedSourceText.replaceAll("\u00AD", "");

  if (FULL_WIDTH_PUNCTUATION_LANGUAGE_TAGS.includes(sourceLanguage)) {
    cleanedSourceText = cleanedSourceText.replaceAll(
      FULL_WIDTH_PUNCTUATION_REGEX,
      '$1 \u201c'
    );
  }

  return { whitespaceBefore, whitespaceAfter, cleanedSourceText };
}

// ─── Инициализация ────────────────────────────────────────────────────────────
// Первое сообщение должно быть initialize — остальные игнорируются до готовности

addEventListener("message", handleInitializationMessage);

async function handleInitializationMessage({ data }) {
  if (data.type !== "initialize") {
    console.error("[QT Worker] Received message before initialization:", data.type);
    return;
  }

  try {
    const { sourceLanguage, targetLanguage, enginePayload, logLevel } = data;

    if (!sourceLanguage) throw new Error('Missing "sourceLanguage"');
    if (!targetLanguage) throw new Error('Missing "targetLanguage"');
    if (logLevel) _loggingLevel = logLevel;

    const { bergamotWasmArrayBuffer, translationModelPayloads } = enginePayload;

    // Грузим WASM — правильный паттерн с await Promise.resolve()
    const bergamot = await BergamotUtils.initializeWasm(bergamotWasmArrayBuffer);

    const engine = new Engine(
      sourceLanguage,
      targetLanguage,
      bergamot,
      translationModelPayloads
    );

    // Освобождаем ArrayBuffer после загрузки в WASM heap
    // transfer() позволяет GC собрать буфер даже если на него есть ссылки
    try { bergamotWasmArrayBuffer.transfer(); } catch (_) { }
    for (const { languageModelFiles } of translationModelPayloads) {
      for (const file of Object.values(languageModelFiles)) {
        try { file.buffer.transfer(); } catch (_) { }
      }
    }

    // Переходим к основному обработчику сообщений
    handleMessages(engine);
    postMessage({ type: "initialization-success" });

  } catch (error) {
    console.error("[QT Worker] Init error:", error);
    postMessage({ type: "initialization-error", error: error?.message });
  }

  removeEventListener("message", handleInitializationMessage);
}

// ─── Основной обработчик сообщений ───────────────────────────────────────────

function handleMessages(engine) {
  let discardPromise = null;

  addEventListener("message", async ({ data }) => {
    try {
      switch (data.type) {

        case "translation-request": {
          const { sourceText, messageId, translationId, isHTML } = data;

          if (discardPromise) await discardPromise;

          try {
            const { whitespaceBefore, whitespaceAfter, cleanedSourceText } =
              cleanText(engine.sourceLanguage, sourceText);

            let { targetText, inferenceMilliseconds } = await engine.translate(
              cleanedSourceText,
              isHTML,
              translationId
            );

            targetText = whitespaceBefore + targetText + whitespaceAfter;

            postMessage({
              type: "translation-response",
              targetText,
              inferenceMilliseconds,
              translationId,
              messageId,
            });
          } catch (error) {
            postMessage({
              type: "translation-error",
              error: { message: error?.message ?? "Unknown", stack: error?.stack ?? "" },
              messageId,
            });
          }
          break;
        }

        case "discard-translation-queue": {
          discardPromise = engine.discardTranslations();
          await discardPromise;
          discardPromise = null;
          postMessage({ type: "translations-discarded" });
          break;
        }

        case "cancel-single-translation": {
          engine.discardSingleTranslation(data.translationId);
          break;
        }

        default:
          console.warn("[QT Worker] Unknown message type:", data.type);
      }
    } catch (error) {
      console.error("[QT Worker] Unexpected error:", error);
    }
  });
}

// ─── Engine ───────────────────────────────────────────────────────────────────

class Engine {
  constructor(sourceLanguage, targetLanguage, bergamot, translationModelPayloads) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.bergamot = bergamot;

    this.languageTranslationModels = translationModelPayloads.map(payload =>
      BergamotUtils.constructSingleTranslationModel(bergamot, payload)
    );

    this.translationService = new bergamot.BlockingService({ cacheSize: 0 });
    this.workQueue = new WorkQueue();
  }

  translate(sourceText, isHTML, translationId) {
    return this.workQueue.runTask(translationId, () =>
      this.#syncTranslate(sourceText, isHTML)
    );
  }

  discardTranslations() {
    return this.workQueue.cancelWork();
  }

  discardSingleTranslation(translationId) {
    this.workQueue.cancelTask(translationId);
  }

  #syncTranslate(sourceText, isHTML) {
    const startTime = performance.now();
    const { messages, options } = BergamotUtils.getTranslationArgs(
      this.bergamot, sourceText, isHTML
    );

    try {
      if (messages.size() === 0) {
        return { targetText: "", inferenceMilliseconds: 0 };
      }

      let responses;

      if (this.languageTranslationModels.length === 1) {
        // Прямая пара: en→ru
        responses = this.translationService.translate(
          this.languageTranslationModels[0],
          messages,
          options
        );
      } else if (this.languageTranslationModels.length === 2) {
        // Через pivot: ru→en→fr
        responses = this.translationService.translateViaPivoting(
          this.languageTranslationModels[0],
          this.languageTranslationModels[1],
          messages,
          options
        );
      } else {
        throw new Error("Too many models provided");
      }

      const endTime = performance.now();
      const targetText = responses.get(0).getTranslatedText();
      return { targetText, inferenceMilliseconds: endTime - startTime };

    } finally {
      // Всегда чистим — даже если выброшен exception
      messages?.delete();
      options?.delete();
    }
  }
}

// ─── BergamotUtils ────────────────────────────────────────────────────────────

class BergamotUtils {
  static initializeWasm(wasmBinary) {
    return new Promise((resolve, reject) => {
      const bergamot = loadBergamot({
        // .wasm ищется относительно self.location (worker/), переопределяем путь
        locateFile(path) {
          return new URL(`../wasm/${path}`, self.location.href).href;
        },
        // Модель enru ~200MB + WASM heap — нужно минимум 256MB
        INITIAL_MEMORY: 268_435_456, // 256 MB
        ALLOW_MEMORY_GROWTH: 1,
        print: (...args) => log(...args),
        printErr: (...args) => console.error("[QT Worker WASM]:", ...args),
        onAbort(reason) {
          console.error("[QT Worker] Bergamot WASM abort reason:", reason);
          reject(new Error("Bergamot WASM aborted: " + reason));
        },
        onRuntimeInitialized: async () => {
          // Обязательный await — Emscripten паттерн
          // Объект мутирует себя, нужен хотя бы один микротаск
          await Promise.resolve();
          resolve(bergamot);
        },
        wasmBinary,
      });
    });
  }

  static constructSingleTranslationModel(bergamot, translationModelPayload) {
    const { sourceLanguage, targetLanguage, languageModelFiles } = translationModelPayload;
    const { model, lex, vocab, qualityModel, srcvocab, trgvocab } =
      BergamotUtils.allocateModelMemory(bergamot, languageModelFiles);

    const vocabList = new bergamot.AlignedMemoryList();
    if (vocab) {
      vocabList.push_back(vocab);
    } else if (srcvocab && trgvocab) {
      vocabList.push_back(srcvocab);
      vocabList.push_back(trgvocab);
    } else {
      throw new Error("No vocabulary found in model files");
    }

    // gemm-precision зависит от типа модели
    const isInt8 = languageModelFiles.model?.record?.name?.endsWith("intgemm8.bin");
    const gemmPrecision = isInt8 ? "int8shiftAll" : "int8shiftAlphaAll";

    const config = BergamotUtils.generateTextConfig({
      "beam-size": "1",
      "normalize": "1.0",
      "word-penalty": "0",
      "max-length-break": "128",
      "mini-batch-words": "1024",
      "workspace": "128",
      "max-length-factor": "2.0",
      "skip-cost": (!qualityModel).toString(),
      "cpu-threads": "0",
      "quiet": "true",
      "quiet-translation": "true",
      "gemm-precision": gemmPrecision,
      "alignment": "soft",
    });

    return new bergamot.TranslationModel(
      sourceLanguage,
      targetLanguage,
      config,
      model,
      lex ?? null,
      vocabList,
      qualityModel ?? null
    );
  }

  static allocateModelMemory(bergamot, languageModelFiles) {
    const results = {};
    for (const [fileType, file] of Object.entries(languageModelFiles)) {
      const alignment = MODEL_FILE_ALIGNMENTS[fileType];
      if (!alignment) throw new Error(`Unknown file type: "${fileType}"`);

      const alignedMemory = new bergamot.AlignedMemory(
        file.buffer.byteLength,
        alignment
      );
      alignedMemory.getByteArrayView().set(new Uint8Array(file.buffer));
      results[fileType] = alignedMemory;
    }
    return results;
  }

  static generateTextConfig(config) {
    const indent = "            ";
    let result = "\n";
    for (const [key, value] of Object.entries(config)) {
      result += `${indent}${key}: ${value}\n`;
    }
    return result + indent;
  }

  static getTranslationArgs(bergamot, sourceText, isHTML) {
    const messages = new bergamot.VectorString();
    const options = new bergamot.VectorResponseOptions();

    if (sourceText) {
      messages.push_back(sourceText);
      options.push_back({ qualityScores: false, alignment: true, html: isHTML });
    }

    return { messages, options };
  }
}

// ─── WorkQueue — не блокирует event loop ─────────────────────────────────────

class WorkQueue {
  #TIME_BUDGET = 100; // ms до yield
  #RUN_IMMEDIATELY_COUNT = 20; // первые N задач — сразу, без setTimeout

  #tasksByTranslationId = new Map();
  #isRunning = false;
  #isWorkCancelled = false;
  #runImmediately = this.#RUN_IMMEDIATELY_COUNT;

  runTask(translationId, task) {
    if (this.#runImmediately > 0) {
      this.#runImmediately--;
      return Promise.resolve(task());
    }
    return new Promise((resolve, reject) => {
      this.#tasksByTranslationId.set(translationId, { task, resolve, reject });
      this.#run().catch(e => console.error("[QT WorkQueue]", e));
    });
  }

  cancelTask(translationId) {
    this.#tasksByTranslationId.delete(translationId);
  }

  async #run() {
    if (this.#isRunning) return;
    this.#isRunning = true;
    let lastTimeout = null;

    while (this.#tasksByTranslationId.size) {
      if (this.#isWorkCancelled) break;

      const now = performance.now();

      if (lastTimeout === null) {
        lastTimeout = now;
        await new Promise(r => setTimeout(r, 0));
      } else if (now - lastTimeout > this.#TIME_BUDGET) {
        await new Promise(r => setTimeout(r, 0));
        lastTimeout = performance.now();
      }

      if (this.#isWorkCancelled || !this.#tasksByTranslationId.size) break;

      const [translationId, { task, resolve, reject }] =
        this.#tasksByTranslationId.entries().next().value;
      this.#tasksByTranslationId.delete(translationId);

      try {
        resolve(await task());
      } catch (e) {
        reject(e);
      }
    }

    this.#isRunning = false;
  }

  async cancelWork() {
    this.#isWorkCancelled = true;
    this.#tasksByTranslationId = new Map();
    await new Promise(r => setTimeout(r, 0));
    this.#isWorkCancelled = false;
  }
}


