/* test-geo-shim.js — the page-world location shim, without a browser.
 *
 * The browser's "… wants to know your location" prompt is browser UI, not
 * page DOM: no content script can click it, so it interrupts an apply run the
 * moment a board asks. geo-shim.js (generated from ../autofill.json) runs in
 * the PAGE world before any site script and answers the call itself.
 *
 * These checks prove: the coordinates on record are served, the browser's own
 * geolocation API is never reached (so no prompt can appear), the permission
 * is reported as granted for sites that check first, other permissions pass
 * through untouched, the generated file matches the pack (no drift), and a
 * pack with no coordinates leaves the browser alone.
 *
 * usage: node test-geo-shim.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

require("./fillpack.js");            // sets globalThis.FILLPACK
const PACK = globalThis.FILLPACK;
const SRC = fs.readFileSync(path.join(__dirname, "geo-shim.js"), "utf8");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : "  -> " + JSON.stringify(extra)}`);
};

/* Run the shim in a scope where `navigator` is ours: a fake whose real
 * geolocation methods RECORD that they were called (the prompt appears only
 * when they are). */
function boot(shimSrc) {
  const calls = { real: 0 };
  const nav = {
    geolocation: {
      getCurrentPosition() { calls.real++; },
      watchPosition() { calls.real++; return 7; },
      clearWatch() {},
    },
    permissions: {
      query(desc) { return Promise.resolve({ state: "prompt", description: desc.name }); },
    },
  };
  const run = new Function("navigator", "setTimeout", "Promise", "Date", shimSrc);
  run(nav, setTimeout, Promise, Date);
  return { nav, calls };
}

const once = (fn) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("never answered")), 1500);
  fn((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(new Error("error " + e.code)); });
});

(async () => {
  /* --- the shipped shim answers with the coordinates on record --- */
  const { nav, calls } = boot(SRC);
  const pos = await once((ok) => nav.geolocation.getCurrentPosition(ok));
  check("shim answers getCurrentPosition", !!pos && !!pos.coords, pos);
  const geo = PACK.geolocation;
  check("shim serves the coordinates on record",
    pos && pos.coords.latitude === geo.lat && pos.coords.longitude === geo.lon,
    { got: pos && [pos.coords.latitude, pos.coords.longitude], want: [geo.lat, geo.lon] });
  check("shim serves an accuracy", pos && typeof pos.coords.accuracy === "number" && pos.coords.accuracy > 0,
    pos && pos.coords.accuracy);
  check("the browser's own geolocation was never reached (no prompt possible)",
    calls.real === 0, calls.real);

  /* --- watchPosition behaves the same way and returns an id --- */
  const watchPos = await once((ok) => nav.geolocation.watchPosition(ok));
  check("shim answers watchPosition too",
    watchPos && watchPos.coords.latitude === geo.lat, watchPos);
  check("watchPosition still returns a watcher id",
    nav.geolocation.watchPosition(() => {}) === 1, nav.geolocation.watchPosition(() => {}));
  check("real watchPosition never reached", calls.real === 0, calls.real);

  /* --- sites that ask permission state first must see "granted" --- */
  const state = await nav.permissions.query({ name: "geolocation" });
  check("permissions.query reports geolocation as granted", state.state === "granted", state.state);
  const other = await nav.permissions.query({ name: "clipboard-read" });
  check("other permissions still reach the browser unchanged",
    other.state === "prompt" && other.description === "clipboard-read", other);

  /* --- the generated file cannot drift from the pack --- */
  const embedded = /var geo = (\{.*?\});/.exec(SRC);
  check("generated shim carries the pack's coordinates",
    embedded && JSON.parse(embedded[1]).lat === geo.lat && JSON.parse(embedded[1]).lon === geo.lon,
    embedded && embedded[1]);

  /* --- a pack with no coordinates: the shim must do nothing at all --- */
  const empty = SRC.replace(/var geo = \{.*?\};/, "var geo = null;");
  check("no-coordinates variant is a real variant", /var geo = null;/.test(empty), empty.slice(0, 80));
  const untouched = boot(empty);
  const before = untouched.nav.geolocation.getCurrentPosition;
  untouched.nav.geolocation.getCurrentPosition(() => {});
  check("no coordinates: the browser's own API is left alone (prompt appears)",
    untouched.calls.real === 1 && untouched.nav.geolocation.getCurrentPosition === before,
    { real: untouched.calls.real });
  const st2 = await untouched.nav.permissions.query({ name: "geolocation" });
  check("no coordinates: permission state is not faked", st2.state === "prompt", st2.state);

  /* --- a page with no geolocation API at all must not throw --- */
  let threw = false;
  try {
    new Function("navigator", "setTimeout", "Promise", "Date", SRC)({}, setTimeout, Promise, Date);
  } catch (e) { threw = true; }
  check("shim survives a page with no geolocation API", threw === false, threw);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
