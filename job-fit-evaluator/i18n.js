// Translation for everything JobFit shows: the popup, the setup wizard,
// Tracked jobs, the banner on job pages and the service worker's messages.
//
// Chrome's own chrome.i18n can't do this: it always follows the browser's
// language and can't be switched from inside the extension. So the messages
// live in locales/<code>.js (one object per language, loaded as scripts so
// they work the same in pages, content scripts and the service worker), and
// the language is a setting: "auto" follows the browser, anything else is
// the user's choice. chrome.i18n is still used for the name and description
// Chrome shows on its own pages (_locales/), which can't be anything else.
//
// Loaded everywhere; assigned with var so re-injection doesn't throw.
var JOB_FIT_MESSAGES = JOB_FIT_MESSAGES || {};

var JOB_FIT_I18N = (function () {
  // The languages of the Americas. `locale` is the regional form used for
  // dates and numbers when the browser doesn't name a better one: Latin
  // American Spanish, Canadian French, Brazilian Portuguese.
  const LANGUAGES = [
    { code: "en", name: "English", locale: "en-US" },
    { code: "es", name: "Español", locale: "es-MX" },
    { code: "fr", name: "Français", locale: "fr-CA" },
    { code: "pt", name: "Português", locale: "pt-BR" },
  ];
  const CODES = LANGUAGES.map((l) => l.code);
  const STORAGE_KEY = "uiLanguage"; // "auto" | one of CODES

  function browserTags() {
    const tags = [];
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getUILanguage) tags.push(chrome.i18n.getUILanguage());
    } catch (err) {
      /* not available in this context */
    }
    if (typeof navigator !== "undefined") tags.push(...(navigator.languages || []), navigator.language);
    return tags.filter(Boolean).map(String);
  }

  function baseOf(tag) {
    return String(tag || "").toLowerCase().split(/[-_]/)[0];
  }

  // The browser's language when it's one JobFit has, else English.
  function detect() {
    const found = browserTags().map(baseOf).find((base) => CODES.includes(base));
    return found || "en";
  }

  let setting = "auto";
  let lang = detect();

  function resolve(value) {
    return CODES.includes(value) ? value : detect();
  }

  // The full tag for Intl: the browser's own regional form when it's the same
  // language ("es-AR" stays Argentinian), otherwise the default for it.
  function locale(code = lang) {
    const own = browserTags().find((tag) => baseOf(tag) === code && /[-_]/.test(tag));
    if (own) return own.replace("_", "-");
    const entry = LANGUAGES.find((l) => l.code === code);
    return entry ? entry.locale : "en-US";
  }

  async function load() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      setting = stored[STORAGE_KEY] || "auto";
    } catch (err) {
      setting = "auto";
    }
    lang = resolve(setting);
    if (typeof document !== "undefined" && document.documentElement && !isContentScript()) {
      document.documentElement.lang = lang;
    }
    return lang;
  }

  // A content script shares the page's document; its <html lang> is the
  // site's, not ours.
  function isContentScript() {
    try {
      return typeof location !== "undefined" && !/^chrome-extension:$/.test(location.protocol);
    } catch (err) {
      return true;
    }
  }

  async function setLanguage(value) {
    const next = CODES.includes(value) ? value : "auto";
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    setting = next;
    lang = resolve(next);
    return lang;
  }

  // Keeps a long-lived context (the service worker, an open banner) in the
  // language the user just picked elsewhere.
  function watch(onChange) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) return;
        setting = changes[STORAGE_KEY].newValue || "auto";
        const before = lang;
        lang = resolve(setting);
        if (onChange && before !== lang) onChange(lang);
      });
    } catch (err) {
      /* no storage events here */
    }
  }

  function lookup(code, key) {
    const catalog = JOB_FIT_MESSAGES[code];
    return catalog ? catalog[key] : undefined;
  }

  let pluralRules = null;
  let pluralLocale = null;
  function pluralCategory(n) {
    const loc = locale();
    if (!pluralRules || pluralLocale !== loc) {
      try {
        pluralRules = new Intl.PluralRules(loc);
      } catch (err) {
        pluralRules = new Intl.PluralRules("en-US");
      }
      pluralLocale = loc;
    }
    return pluralRules.select(Number(n) || 0);
  }

  // t("key", { name: "x" }) fills {name}. A message can be an object of
  // plural forms ({ one, other }), picked by vars.count with the language's
  // own rules — French treats 0 as singular, English doesn't. Falls back to
  // English, then to the key itself, so a missing translation shows as
  // English rather than as nothing.
  function t(key, vars) {
    let msg = lookup(lang, key);
    if (msg == null) msg = lookup("en", key);
    if (msg == null) return key;
    if (typeof msg === "object") {
      const n = vars && vars.count != null ? vars.count : 0;
      msg = msg[pluralCategory(n)] ?? msg.other ?? msg.one ?? "";
    }
    if (!vars) return msg;
    return msg.replace(/\{(\w+)\}/g, (match, name) => (vars[name] != null ? String(vars[name]) : match));
  }

  function has(key) {
    return lookup(lang, key) != null || lookup("en", key) != null;
  }

  // Static text in the extension's own pages is marked up with data-i18n*
  // attributes; the English in the HTML is what shows if a key is missing.
  // data-i18n-html is only ever used with this extension's own catalogs,
  // never with anything from a job posting.
  function translatePage(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((node) => {
      if (has(node.dataset.i18n)) node.textContent = t(node.dataset.i18n);
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((node) => {
      if (has(node.dataset.i18nHtml)) node.innerHTML = t(node.dataset.i18nHtml);
    });
    [
      ["i18nPlaceholder", "placeholder"],
      ["i18nTitle", "title"],
      ["i18nAriaLabel", "aria-label"],
    ].forEach(([dataKey, attr]) => {
      const selector = `[data-${dataKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
      scope.querySelectorAll(selector).forEach((node) => {
        const key = node.dataset[dataKey];
        if (has(key)) node.setAttribute(attr, t(key));
      });
    });
    if (typeof document !== "undefined" && scope === document) document.documentElement.lang = lang;
  }

  function formatDate(ts, options = { year: "numeric", month: "short", day: "numeric" }) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleDateString(locale(), options);
    } catch (err) {
      return new Date(ts).toLocaleDateString("en-US", options);
    }
  }

  function formatNumber(n, options) {
    if (n == null || Number.isNaN(Number(n))) return "";
    try {
      return Number(n).toLocaleString(locale(), options);
    } catch (err) {
      return Number(n).toLocaleString("en-US", options);
    }
  }

  // Country and language names come from the browser (Intl.DisplayNames), in
  // whichever language the UI is in — no table of names to keep translated.
  function displayName(type, code, inLang = lang) {
    if (!code) return "";
    try {
      const name = new Intl.DisplayNames([locale(inLang)], { type }).of(code);
      if (!name) return code;
      return type === "language" ? name.charAt(0).toLocaleUpperCase(locale(inLang)) + name.slice(1) : name;
    } catch (err) {
      return code;
    }
  }

  function countryName(code, inLang) {
    return displayName("region", code, inLang);
  }

  function languageName(code, inLang) {
    return displayName("language", code, inLang);
  }

  // "A, B and C" / "A, B y C" / "A, B et C" / "A, B e C".
  function list(items, type = "conjunction") {
    const clean = (items || []).filter(Boolean).map(String);
    try {
      return new Intl.ListFormat(locale(), { style: "long", type }).format(clean);
    } catch (err) {
      return clean.join(", ");
    }
  }

  // The language a model should write in, named in English — the prompts
  // themselves stay in English, which every model follows most reliably.
  function modelLanguageName(code = lang) {
    return { en: "English", es: "Spanish", fr: "French", pt: "Portuguese" }[code] || "English";
  }

  // Which locale scripts a page needs: English always (the fallback), plus
  // the language in use.
  function localeFiles(code = lang) {
    return Array.from(new Set(["locales/en.js", `locales/${resolve(code)}.js`]));
  }

  return {
    LANGUAGES,
    CODES,
    STORAGE_KEY,
    detect,
    load,
    setLanguage,
    watch,
    t,
    has,
    translatePage,
    formatDate,
    formatNumber,
    countryName,
    languageName,
    list,
    modelLanguageName,
    localeFiles,
    get lang() {
      return lang;
    },
    get setting() {
      return setting;
    },
    locale,
  };
})();

// Short alias used throughout the code.
var t = JOB_FIT_I18N.t;
