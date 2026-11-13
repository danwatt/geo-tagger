"""Build results/report.html: benchmark tables + per-query result grids + caption browser.

Static file, data inlined as JSON, thumbnails referenced from ../cache/thumbs. Kept
local on purpose — it contains personal photos.

    uv run python -m bench.report
"""
from __future__ import annotations

import json
import platform

from bench.common import RESULTS, load_manifest
from bench.metrics import load_queries


def _load(dirname: str) -> list[dict]:
    return [json.loads(f.read_text(encoding="utf-8")) for f in sorted((RESULTS / dirname).glob("*.json"))]


def main() -> None:
    import torch
    manifest = load_manifest()
    emb = _load("embed")
    cap = _load("caption")
    text_eval_path = RESULTS / "text_eval.json"
    text_eval = json.loads(text_eval_path.read_text(encoding="utf-8")) if text_eval_path.exists() else {}
    data = {
        "images": [{"id": m["id"], "name": m["name"]} for m in manifest],
        "queries": load_queries(),
        "embed": emb,
        "caption": cap,
        "text_eval": text_eval,
        "env": {"gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none",
                "cpu": platform.processor(), "torch": torch.__version__},
    }
    html = TEMPLATE.replace("/*DATA*/", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    out = RESULTS / "report.html"
    out.write_text(html, encoding="utf-8")
    print(out)


TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vision Bench</title>
<style>
:root { --bg:#14161a; --panel:#1d2026; --line:#2c3038; --text:#e4e6ea; --dim:#9aa0aa;
        --good:#3fb950; --bad:#f0544f; --accent:#58a6ff; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif; }
main { max-width:1500px; margin:0 auto; padding:20px 16px 60px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:34px 0 8px; }
.sub { color:var(--dim); margin-bottom:14px; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { padding:6px 9px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
th { color:var(--dim); font-weight:600; cursor:pointer; position:sticky; top:0; background:var(--bg); }
td:first-child, th:first-child { text-align:left; }
td.note { text-align:left; color:var(--dim); white-space:normal; min-width:180px; }
tr:hover td { background:var(--panel); }
.best { color:var(--good); font-weight:700; }
.err { color:var(--bad); }
.bar { display:inline-block; height:8px; background:var(--accent); border-radius:2px; vertical-align:middle; margin-left:6px; opacity:.7; }
select, input { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; }
.row { display:flex; gap:10px; align-items:center; margin:6px 0; flex-wrap:wrap; }
.method { display:grid; grid-template-columns:200px 1fr; gap:10px; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); }
.method .lbl { font-size:12px; } .method .lbl b { display:block; font-size:13px; }
.thumbs { display:flex; gap:4px; overflow-x:auto; }
.thumbs img { height:78px; border-radius:4px; border:3px solid transparent; flex:none; cursor:pointer; }
.thumbs img.hit { border-color:var(--good); } .thumbs img.miss { border-color:var(--bad); }
.heat td { text-align:center; font-size:12px; padding:4px 6px; }
.capgrid { display:grid; grid-template-columns:minmax(260px, 420px) 1fr; gap:16px; }
.capgrid img { width:100%; border-radius:6px; }
.cap { padding:8px 0; border-bottom:1px solid var(--line); }
.cap b { color:var(--accent); font-size:12px; display:block; }
.tag { display:inline-block; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1px 8px; margin:2px; font-size:12px; }
.kpi { color:var(--dim); font-size:12px; }
@media (max-width:760px) { .capgrid { grid-template-columns:1fr; } .method { grid-template-columns:1fr; } }
</style></head>
<body><main>
<h1>Photo description search — local model benchmark</h1>
<div class="sub" id="envline"></div>

<h2>1 · Joint image–text embeddings (CLIP family)</h2>
<div class="sub">Search = embed query text, cosine vs. stored image vectors. Quality = mean over hand-labeled queries.
mAP = mean average precision (whole ranking), R-prec = precision at rank R (# relevant), P@5 = first five results.
GPU = fp16 batch 32 incl. PIL preprocessing; CPU = torch fp32 (onnxruntime would be similar or faster).</div>
<div class="scroll"><table id="embTable"></table></div>

<h2>2 · Captioning models (VLMs)</h2>
<div class="sub">Each model writes a description per photo; search then runs over that text.
<b>fts5</b> = SQLite keyword BM25 · <b>semantic</b> = captions embedded with bge-small (33M) ·
<b>hybrid</b> = rank fusion of semantic captions + best embedding model (<span id="hybridWith"></span>).
100k-photo time = GPU s/img × 100,000.</div>
<div class="scroll"><table id="capTable"></table></div>

<h2>3 · Per-query quality (average precision)</h2>
<div class="sub">Green = good, red = poor. Click a cell to jump to that query’s results.</div>
<div class="scroll"><table class="heat" id="heat"></table></div>

<h2>4 · Query results side by side</h2>
<div class="row"><label>Query <select id="qsel"></select></label>
<span class="kpi">green border = relevant (ground truth), red = not relevant. Click a thumb for its captions.</span></div>
<div id="qres"></div>

<h2>5 · Captions &amp; zero-shot tags per photo</h2>
<div class="row"><label>Photo <select id="isel"></select></label>
<button id="prev">◀</button><button id="next">▶</button></div>
<div class="capgrid"><div><img id="ibig" alt=""></div><div id="icaps"></div></div>
</main>
<script>
const D = /*DATA*/;
const img = id => `../cache/thumbs/${id}.jpg`;
const fmt = (v, d=2) => v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d);
document.getElementById("envline").textContent =
  `${D.images.length} photos · ${D.queries.length} queries · GPU ${D.env.gpu} · torch ${D.env.torch}`;
document.getElementById("hybridWith").textContent = D.text_eval.hybrid_with || "n/a";

function table(el, cols, rows) {
  let sortKey = null, asc = false;
  function draw() {
    const rs = [...rows];
    if (sortKey) rs.sort((a, b) => ((a[sortKey] ?? -1e9) - (b[sortKey] ?? -1e9)) * (asc ? 1 : -1));
    const best = {};
    cols.forEach(c => { if (c.best) { const vs = rows.map(r => r[c.k]).filter(v => v != null);
      best[c.k] = c.best === "max" ? Math.max(...vs) : Math.min(...vs); } });
    el.innerHTML = `<tr>${cols.map(c => `<th data-k="${c.k}">${c.h}</th>`).join("")}</tr>` +
      rs.map(r => `<tr>${cols.map(c => {
        if (r.error && c.k !== "key" && c.k !== "note") return c.k === "model" ? `<td class="err">${r.error.slice(0,90)}</td>` : "<td></td>";
        const v = r[c.k];
        if (c.text) return `<td class="${c.cls||""}">${v ?? ""}</td>`;
        const cls = c.best && v === best[c.k] ? "best" : "";
        const bar = c.bar && v != null ? `<span class="bar" style="width:${Math.max(2, v*60)}px"></span>` : "";
        return `<td class="${cls}">${fmt(v, c.d ?? 2)}${bar}</td>`; }).join("")}</tr>`).join("");
    el.querySelectorAll("th").forEach(th => th.onclick = () => {
      const k = th.dataset.k; asc = sortKey === k ? !asc : false; sortKey = k; draw(); });
  }
  draw();
}

// ── Embedding table ──
const embRows = D.embed.map(r => r.error ? r : ({
  key: r.key, model: `${r.model} / ${r.pretrained}`, params: r.params_m, dim: r.dim,
  ap: r.retrieval.mean.ap, rprec: r.retrieval.mean.rprec, p5: r.retrieval.mean.p5,
  gpu: r.gpu_img_per_s, cpu: r.cpu_img_per_s, gtext: r.gpu_text_ms, ctext: r.cpu_text_ms,
  vram: r.gpu_peak_vram_mb, ram: r.cpu_rss_delta_mb, store: r.dim * 2 * 100000 / 2**20,
  cpu100k: 100000 / r.cpu_img_per_s / 3600, note: r.note }));
table(document.getElementById("embTable"), [
  {k:"key", h:"model", text:1}, {k:"params", h:"params (M)", d:0, best:"min"}, {k:"dim", h:"dim", d:0},
  {k:"ap", h:"mAP", best:"max", bar:1, d:3}, {k:"rprec", h:"R-prec", best:"max", d:3}, {k:"p5", h:"P@5", best:"max", d:3},
  {k:"gpu", h:"GPU img/s", d:0, best:"max"}, {k:"cpu", h:"CPU img/s", d:1, best:"max"},
  {k:"cpu100k", h:"CPU h /100k", d:1, best:"min"},
  {k:"gtext", h:"query ms GPU", d:1, best:"min"}, {k:"ctext", h:"query ms CPU", d:0, best:"min"},
  {k:"vram", h:"VRAM MB", d:0, best:"min"}, {k:"ram", h:"CPU RAM MB", d:0, best:"min"},
  {k:"store", h:"MB /100k (fp16)", d:0, best:"min"}, {k:"note", h:"note", text:1, cls:"note"}], embRows);

// ── Caption table ──
const TE = D.text_eval.models || {};
const capRows = D.caption.map(r => r.error ? r : ({
  key: r.key, params: r.params_m, gpu: r.gpu_s_per_img, cpu: r.cpu_s_per_img, tps: r.gpu_tok_per_s,
  vram: r.gpu_peak_vram_mb, words: r.avg_words, load: r.load_s,
  fts: TE[r.key]?.fts5.mean.ap, sem: TE[r.key]?.semantic.mean.ap, hyb: TE[r.key]?.hybrid?.mean.ap,
  semp5: TE[r.key]?.semantic.mean.p5,
  h100k: r.gpu_s_per_img * 100000 / 3600, note: r.note + (r.cpu_error ? " · CPU failed" : "") }));
table(document.getElementById("capTable"), [
  {k:"key", h:"model", text:1}, {k:"params", h:"params (M)", d:0, best:"min"},
  {k:"fts", h:"fts5 mAP", d:3, best:"max"}, {k:"sem", h:"semantic mAP", d:3, best:"max", bar:1},
  {k:"semp5", h:"semantic P@5", d:3, best:"max"}, {k:"hyb", h:"hybrid mAP", d:3, best:"max"},
  {k:"gpu", h:"GPU s/img", d:2, best:"min"}, {k:"h100k", h:"GPU h /100k", d:1, best:"min"},
  {k:"cpu", h:"CPU s/img", d:1, best:"min"}, {k:"tps", h:"tok/s", d:0},
  {k:"vram", h:"VRAM MB", d:0, best:"min"}, {k:"words", h:"words", d:0}, {k:"note", h:"note", text:1, cls:"note"}], capRows);

// ── Methods list (for heatmap + grids) ──
const methods = [];
D.embed.filter(r => !r.error).sort((a,b) => b.retrieval.mean.ap - a.retrieval.mean.ap)
  .forEach(r => methods.push({name: r.key, kind: "embedding", per: r.retrieval.per_query, mean: r.retrieval.mean}));
Object.entries(TE).forEach(([k, v]) => ["semantic", "fts5", "hybrid"].forEach(m => v[m] &&
  methods.push({name: `${k} · ${m}`, kind: "caption", per: v[m].per_query, mean: v[m].mean})));

// ── Heatmap ──
const heat = document.getElementById("heat");
const color = v => `hsl(${v*120}, 55%, ${22 + v*10}%)`;
heat.innerHTML = `<tr><th>method</th><th>mean</th>${D.queries.map((q,i) => `<th title="${q.q}">Q${i+1}</th>`).join("")}</tr>` +
  methods.map(m => `<tr><td>${m.name}</td><td style="background:${color(m.mean.ap)}">${fmt(m.mean.ap)}</td>${
    m.per.map((p,i) => `<td data-q="${i}" style="background:${color(p.ap)};cursor:pointer" title="${p.q}">${fmt(p.ap)}</td>`).join("")}</tr>`).join("");
heat.querySelectorAll("td[data-q]").forEach(td => td.onclick = () => { qsel.value = td.dataset.q; drawQuery();
  qsel.scrollIntoView({behavior:"smooth"}); });

// ── Query grids ──
const qsel = document.getElementById("qsel");
qsel.innerHTML = D.queries.map((q,i) => `<option value="${i}">Q${i+1}: ${q.q} (${q.relevant.length} relevant)</option>`).join("");
function drawQuery() {
  const qi = +qsel.value, rel = new Set(D.queries[qi].relevant);
  document.getElementById("qres").innerHTML = methods.map(m => {
    const p = m.per[qi];
    return `<div class="method"><div class="lbl"><b>${m.name}</b>AP ${fmt(p.ap)} · P@5 ${fmt(p.p5)}</div><div class="thumbs">${
      p.top.map(i => `<img src="${img(D.images[i].id)}" data-i="${i}" class="${rel.has(i) ? "hit" : "miss"}" title="#${i} ${D.images[i].name}">`).join("")}</div></div>`;
  }).join("");
  document.querySelectorAll("#qres img").forEach(el => el.onclick = () => { isel.value = el.dataset.i; drawImage();
    isel.scrollIntoView({behavior:"smooth"}); });
}
qsel.onchange = drawQuery;

// ── Caption browser ──
const isel = document.getElementById("isel");
isel.innerHTML = D.images.map((m,i) => `<option value="${i}">#${i} ${m.name}</option>`).join("");
function drawImage() {
  const m = D.images[+isel.value];
  document.getElementById("ibig").src = img(m.id);
  const caps = D.caption.filter(r => r.captions).map(r =>
    `<div class="cap"><b>${r.key}</b>${(r.captions[m.id] || "").replace(/</g, "&lt;")}</div>`).join("");
  const tags = D.embed.filter(r => r.tags).map(r =>
    `<div class="cap"><b>${r.key} zero-shot tags</b>${(r.tags[m.id] || []).map(t => `<span class="tag">${t}</span>`).join("")}</div>`).join("");
  document.getElementById("icaps").innerHTML = caps + tags;
}
isel.onchange = drawImage;
document.getElementById("prev").onclick = () => { isel.value = Math.max(0, +isel.value - 1); drawImage(); };
document.getElementById("next").onclick = () => { isel.value = Math.min(D.images.length - 1, +isel.value + 1); drawImage(); };
drawQuery(); drawImage();
</script></body></html>
"""

if __name__ == "__main__":
    main()
