// The Tino rebrand: brand assets in sync with brand/, icons the size the
// manifest says, the uninstall page's address, and no "JobFit" left anywhere
// a person reads it.
const fs = require("fs");
const path = require("path");
const { EXT, loadWorker, suite, tick } = require("./support");

const { check, done } = suite("brand");
const ROOT = path.join(EXT, "..");

// Width and height from a PNG's IHDR chunk.
function pngSize(file) {
  const bytes = fs.readFileSync(file);
  const isPng = bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return isPng ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

(async () => {
  // --- the copies match their source ----------------------------------------
  const drawings = ["tino.svg", "tino-reading.svg", "tino-curled.svg", "tino-mark.svg", "wordmark.svg"];
  for (const dir of ["job-fit-evaluator/images", "docs/assets"]) {
    const drifted = drawings.filter((f) => {
      const copy = path.join(ROOT, dir, f);
      return !fs.existsSync(copy) || !fs.readFileSync(copy).equals(fs.readFileSync(path.join(ROOT, "brand", f)));
    });
    check(`${dir}/ matches brand/ (run node tools/brand.js after editing brand/)`, drifted.length === 0, drifted);
  }

  // --- the manifest's icons exist, at their sizes ---------------------------
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const icons = { ...manifest.icons, ...((manifest.action && manifest.action.default_icon) || {}) };
  check("manifest declares icons", Object.keys(manifest.icons || {}).length === 4, manifest.icons);
  Object.entries(icons).forEach(([size, file]) => {
    const full = path.join(EXT, file);
    const dims = fs.existsSync(full) ? pngSize(full) : null;
    check(`icon ${file} is ${size}×${size}`, dims && dims.width === Number(size) && dims.height === Number(size), dims);
  });
  check("version is 1.0.0 or later", /^[1-9]\d*\.\d+\.\d+$/.test(manifest.version), manifest.version);
  check("homepage points at the site", manifest.homepage_url === "https://emaccheese.github.io/JobFit/", manifest.homepage_url);

  // --- no "JobFit" where a person reads it ----------------------------------
  const visible = [
    ...["en", "es", "fr", "pt"].map((l) => `locales/${l}.js`),
    ...fs.readdirSync(path.join(EXT, "_locales")).map((l) => `_locales/${l}/messages.json`),
    ...fs.readdirSync(EXT).filter((f) => f.endsWith(".html")),
  ];
  const leftovers = visible.filter((f) => fs.readFileSync(path.join(EXT, f), "utf8").includes("JobFit"));
  check("no JobFit in catalogs, Chrome's strings or pages", leftovers.length === 0, leftovers);
  check("manifest title is Tino", manifest.action.default_title === "Tino");
  const names = fs.readdirSync(path.join(EXT, "_locales")).map((l) =>
    JSON.parse(fs.readFileSync(path.join(EXT, "_locales", l, "messages.json"), "utf8")));
  check("store names start with Tino and fit Chrome's limits", names.every((m) => /^Tino/.test(m.extName.message) && m.extName.message.length <= 75 && m.extDescription.message.length <= 132));

  // --- the uninstall page -----------------------------------------------------
  const w = loadWorker();
  await tick(60);
  const urls = w.uninstallUrls || [];
  const last = urls[urls.length - 1] || "";
  let parsed = null;
  try {
    parsed = new URL(last);
  } catch (err) {
    /* none set */
  }
  check("uninstall page is set", Boolean(parsed), urls);
  check("…on the site's goodbye page", parsed && parsed.href.startsWith("https://emaccheese.github.io/JobFit/goodbye.html"), last);
  check(
    "…with only the language and the version",
    parsed && [...parsed.searchParams.keys()].sort().join(",") === "lang,v" && parsed.searchParams.get("lang") === "en",
    last
  );

  done();
})();
