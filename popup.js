const LANGUAGES = [
    { code: "bg", name: "Bulgarian — Болгарский" },
    { code: "cs", name: "Czech — Чешский" },
    { code: "de", name: "German — Немецкий" },
    { code: "en", name: "English — Английский" },
    { code: "es", name: "Spanish — Испанский" },
    { code: "et", name: "Estonian — Эстонский" },
    { code: "fr", name: "French — Французский" },
    { code: "hu", name: "Hungarian — Венгерский" },
    { code: "is", name: "Icelandic — Исландский" },
    { code: "it", name: "Italian — Итальянский" },
    { code: "nl", name: "Dutch — Нидерландский" },
    { code: "pl", name: "Polish — Польский" },
    { code: "pt", name: "Portuguese — Португальский" },
    { code: "ro", name: "Romanian — Румынский" },
    { code: "ru", name: "Russian — Русский" },
    { code: "sk", name: "Slovak — Словацкий" },
    { code: "sl", name: "Slovenian — Словенский" },
    { code: "sq", name: "Albanian — Албанский" },
    { code: "sr", name: "Serbian — Сербский" },
    { code: "uk", name: "Ukrainian — Украинский" },
];

const select = document.getElementById("lang-select");
const saved = document.getElementById("saved");

// Заполняем дропдаун
LANGUAGES.forEach(({ code, name }) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    select.appendChild(opt);
});

// Загружаем сохранённый язык
browser.storage.local.get("targetLang").then(({ targetLang }) => {
    select.value = targetLang ?? "ru";
});

// Сохраняем при изменении
select.addEventListener("change", () => {
    browser.storage.local.set({ targetLang: select.value }).then(() => {
        saved.classList.add("show");
        setTimeout(() => saved.classList.remove("show"), 1500);
    });
});