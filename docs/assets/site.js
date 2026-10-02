// Shows each page in the visitor's language: ?lang= if given (the extension
// passes it), otherwise the browser's, otherwise English. Every translated
// block carries data-lang; without JavaScript the English ones show.
(function () {
  var LANGS = ["en", "es", "fr", "pt"];

  function pick() {
    var asked = new URLSearchParams(location.search).get("lang");
    if (asked && LANGS.indexOf(asked) !== -1) return asked;
    var preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    for (var i = 0; i < preferred.length; i++) {
      var code = String(preferred[i]).slice(0, 2).toLowerCase();
      if (LANGS.indexOf(code) !== -1) return code;
    }
    return "en";
  }

  var lang = pick();
  var root = document.documentElement;
  root.classList.add("js");
  root.lang = lang;
  document.querySelectorAll("[data-lang]").forEach(function (el) {
    el.hidden = el.getAttribute("data-lang") !== lang;
  });
  document.querySelectorAll(".langs a[data-switch]").forEach(function (a) {
    var code = a.getAttribute("data-switch");
    var url = new URL(location.href);
    url.searchParams.set("lang", code);
    a.href = url.pathname.split("/").pop() + url.search;
    if (code === lang) a.setAttribute("aria-current", "true");
  });
  var title = document.querySelector('meta[name="title-' + lang + '"]');
  if (title) document.title = title.getAttribute("content");
  window.TINO_LANG = lang;
})();
