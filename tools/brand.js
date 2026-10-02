#!/usr/bin/env node
// Builds Tino's brand assets from brand/, the one source of truth:
//   - copies the drawings the extension and the website use, so neither can
//     drift from the source (tools/test/brand.test.js checks they haven't);
//   - renders the PNG icons Chrome needs, with headless Chrome, so there's no
//     image library to install.
//
// Run it after editing anything in brand/:
//   node tools/brand.js            (CHROME_PATH=... to use another Chrome)
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const brand = path.join(root, "brand");

// The drawings used at runtime: by the extension's pages (images/) and by the
// GitHub Pages site (docs/assets/).
const DRAWINGS = ["tino.svg", "tino-reading.svg", "tino-curled.svg", "tino-mark.svg", "wordmark.svg"];
const COPY_TO = [path.join(root, "job-fit-evaluator", "images"), path.join(root, "docs", "assets")];

// Toolbar sizes get the simplified shell; the larger ones the full drawing.
const ICONS = [
  { size: 16, source: "icon-small.svg" },
  { size: 32, source: "icon-small.svg" },
  { size: 48, source: "icon.svg" },
  { size: 128, source: "icon.svg" },
];
const ICON_DIRS = [path.join(root, "job-fit-evaluator", "icons")];

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function copyDrawings() {
  COPY_TO.forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
    DRAWINGS.forEach((file) => fs.copyFileSync(path.join(brand, file), path.join(dir, file)));
    console.log(`  copied ${DRAWINGS.length} drawings to ${path.relative(root, dir)}/`);
  });
}

// One page per size: the SVG drawn at exactly that many CSS pixels on a
// transparent background, captured at device scale 1.
function renderIcons(chrome) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tino-icons-"));
  ICON_DIRS.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  ICONS.forEach(({ size, source }) => {
    const svg = path.join(brand, source);
    const page = path.join(tmp, `icon-${size}.html`);
    fs.writeFileSync(
      page,
      `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style></head>` +
        `<body><img src="file://${svg}"></body></html>`
    );
    const out = path.join(tmp, `icon-${size}.png`);
    const result = spawnSync(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ]);
    if (!fs.existsSync(out)) throw new Error(`Chrome didn't render icon-${size}.png: ${String(result.stderr).slice(0, 300)}`);
    ICON_DIRS.forEach((dir) => fs.copyFileSync(out, path.join(dir, `icon-${size}.png`)));
    console.log(`  rendered icon-${size}.png from ${source}`);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

copyDrawings();
const chrome = chromePath();
if (!chrome) {
  console.log("  Chrome not found: icons not rendered (set CHROME_PATH). The copies above are done.");
  process.exit(1);
}
renderIcons(chrome);
console.log("brand assets up to date");

module.exports = { DRAWINGS, ICONS };
