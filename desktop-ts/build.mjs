/** Build the WebView frontend: bundle the bootstrap (which pulls in the whole TS
 * engine) to a single classic script, then assemble a self-contained web/ dir from
 * the canonical UI so Tauri has one folder to ship.
 *
 *   web/bundle.js  <- esbuild(src/main.ts)   (IIFE, no imports)
 *   web/index.html <- ../web/index.html + a <script> for bundle.js
 *   web/app.js     <- ../web/app.js          (the canonical vanilla-JS UI)
 *   web/style.css  <- ../web/style.css
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "..", "web");
const OUT = join(HERE, "web");

mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [join(HERE, "src", "main.ts")],
  bundle: true,
  format: "iife",        // classic script -> runs before the deferred-free UI, sets window.__invest
  platform: "browser",
  target: "es2022",
  outfile: join(OUT, "bundle.js"),
  legalComments: "none",
  logLevel: "info",
});

for (const f of ["app.js", "style.css"]) copyFileSync(join(WEB_SRC, f), join(OUT, f));

// Inject the bundle before app.js so window.__invest is present when the UI runs.
let html = readFileSync(join(WEB_SRC, "index.html"), "utf-8");
if (!html.includes("bundle.js")) {
  const m = html.match(/<script[^>]*\bsrc=["'](\/?)app\.js["'][^>]*><\/script>/);
  if (!m) throw new Error("could not find the app.js <script> tag to anchor bundle.js");
  html = html.replace(m[0], `<script src="${m[1]}bundle.js"></script>\n  ${m[0]}`);
}
writeFileSync(join(OUT, "index.html"), html);

console.log("frontend assembled in", OUT);
