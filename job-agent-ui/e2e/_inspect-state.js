/* one-off: print queued jobs + decision counts from state.json */
const s = require("../state.json");
for (const id of (s.run && s.run.queue) || []) {
  const j = (s.jobs || []).find((j) => j.id === id);
  console.log("queued", id, j ? `${j.title} @ ${j.company} -> ${j.url}` : "MISSING");
}
console.log("attempted:", JSON.stringify((s.run || {}).attempted));
console.log("results:", JSON.stringify((s.run || {}).results));
console.log("sweep:", JSON.stringify(s.sweeps));
const dec = s.decisions || {};
const acts = {};
for (const k in dec) acts[dec[k].action] = (acts[dec[k].action] || 0) + 1;
console.log("decision actions:", JSON.stringify(acts), "total jobs:", (s.jobs || []).length);
