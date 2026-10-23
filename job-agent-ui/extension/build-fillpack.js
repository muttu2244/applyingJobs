/* Regenerate fillpack.js from ../autofill.json.
 *
 * The extension needs the fill pack as a plain JS global (content scripts can't
 * fetch local JSON). Generating it from the single source of truth means the
 * pack in your Chrome can never drift from the pack the dashboard serves.
 *
 *   node build-fillpack.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "autofill.json");
const dst = path.join(__dirname, "fillpack.js");

const pack = JSON.parse(fs.readFileSync(src, "utf8"));

const banner = `/* GENERATED FILE — do not edit by hand.
 * Source: ../autofill.json
 * Regenerate: node build-fillpack.js
 */
"use strict";
globalThis.FILLPACK = `;

fs.writeFileSync(dst, banner + JSON.stringify(pack, null, 2) + ";\n", "utf8");

/* The page-world geolocation shim. Sites ask the BROWSER for your location,
 * and that prompt is browser UI — no content script can click it, so it sits
 * in the middle of an apply run. Serving the coordinates on record means the
 * site gets an answer and the prompt never appears. No coordinates recorded
 * means the shim does nothing and the normal prompt appears. */
const geo = pack.geolocation;
const geoData = (geo && typeof geo.lat === "number" && typeof geo.lon === "number")
  ? { lat: geo.lat, lon: geo.lon, accuracy: Number(geo.accuracy) || 1000, city: geo.city || "" }
  : null;

const shimSrc = `/* GENERATED FILE — do not edit by hand.
 * Source: ../autofill.json (geolocation)
 * Regenerate: node build-fillpack.js
 *
 * Runs in the PAGE world (manifest: world MAIN, document_start) — before any
 * site script can ask for your location. A site's navigator.geolocation call
 * otherwise triggers the browser's own permission prompt, which is not part
 * of the DOM: no content script can click it, so it interrupts a run. This
 * answers with the coordinates on record instead, and reports the permission
 * as granted so sites that check first do not render their own ask-location
 * button either. With no coordinates recorded it does nothing.
 */
"use strict";
(function () {
  var geo = ${JSON.stringify(geoData)};
  if (!geo) return;                       // nothing on record — leave the browser alone

  var position = {
    coords: {
      latitude: geo.lat,
      longitude: geo.lon,
      accuracy: geo.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null
    },
    timestamp: Date.now()
  };
  function serve(success) {
    try {
      setTimeout(function () { try { success(position); } catch (e) {} }, 0);
    } catch (e) {}
  }

  var api = navigator.geolocation;
  if (!api) return;
  try {
    api.getCurrentPosition = function (success) { serve(success); };
    api.watchPosition = function (success) { serve(success); return 1; };
  } catch (e) {}

  try {
    var ask = navigator.permissions && navigator.permissions.query;
    if (!ask) return;
    var original = ask.bind(navigator.permissions);
    navigator.permissions.query = function (descriptor) {
      try {
        if (descriptor && descriptor.name === "geolocation") {
          return Promise.resolve({ state: "granted", status: "granted", onchange: null });
        }
      } catch (e) {}
      return original(descriptor);
    };
  } catch (e) {}
})();
`;
fs.writeFileSync(path.join(__dirname, "geo-shim.js"), shimSrc, "utf8");

// Count ready (non-null leaf) fields the same way the dashboard's card does.
let ready = 0;
const open = [];
(function walk(o) {
  if (o == null) return;
  if (Array.isArray(o)) return o.forEach(walk);
  if (typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    /* askUser is the human-readable list; questions is the answer bank —
     * neither is a form value, and counting their nulls as "open" would
     * list six anonymous `answer` entries on the dashboard card. */
    if (k.startsWith("_") || k === "askUser" || k === "questions") continue;
    if (v === null) { open.push(k); continue; }
    if (typeof v === "object") walk(v);
    else ready++;
  }
})(pack);

console.log(`wrote ${dst}`);
console.log(`wrote ${path.join(__dirname, "geo-shim.js")} — ${geoData ? `answers location as ${geoData.city || "(no city)"} (${geoData.lat}, ${geoData.lon})` : "off — no coordinates on record"}`);
console.log(`${ready} fields ready, ${open.length} open: ${open.join(", ")}`);
