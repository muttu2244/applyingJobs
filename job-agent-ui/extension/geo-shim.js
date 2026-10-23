/* GENERATED FILE — do not edit by hand.
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
  var geo = {"lat":12.9716,"lon":77.5946,"accuracy":1500,"city":"Bengaluru"};
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
