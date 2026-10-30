/* scratch: one-click apply contract check (deleted after use) */
const http = require("http");
const req = (m, p, b) => new Promise((res, rej) => {
  const r = http.request("http://127.0.0.1:8357" + p, { method: m, headers: { "Content-Type": "application/json" } }, (x) => {
    let d = ""; x.on("data", (c) => (d += c));
    x.on("end", () => { let j = null; try { j = JSON.parse(d); } catch {} res({ s: x.statusCode, j }); });
  });
  r.on("error", rej); if (b) r.write(JSON.stringify(b)); r.end();
});
(async () => {
  let b = (await req("GET", "/api/bootstrap")).j;
  const q = b.jobs.find((j) => j.board === "linkedin");
  await req("POST", "/api/boards/linkedin/connect", { connected: true, force: true });
  await req("POST", `/api/jobs/${q.id}/action`, { action: "apply" });
  const k = await req("POST", "/api/apply/kick", {});
  console.log("kick(connected):", k.s, JSON.stringify({ job: k.j.job && k.j.job.id, url: k.j.job && k.j.job.url, progress: k.j.progress, needLogin: k.j.needLogin }));
  const k2 = await req("POST", "/api/apply/kick", {});
  console.log("kick2 (one at a time):", JSON.stringify({ waiting: k2.j.waiting, needLogin: k2.j.needLogin }));
  const r = await req("POST", `/api/jobs/${q.id}/report`, { status: "applied", confirmation: "Application sent" });
  console.log("report:", r.s);
  b = (await req("GET", "/api/bootstrap")).j;
  console.log("still listed?", b.jobs.some((j) => j.id === q.id), "| appliedJobs:", b.appliedJobs.length,
    "| run:", JSON.stringify(b.run && { done: b.run.done, applied: b.run.applied, total: b.run.total }));
})();
