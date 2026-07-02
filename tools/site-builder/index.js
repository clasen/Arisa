import { readFile } from "node:fs/promises";
import defaults from "./config.js";

function printHelp() {
  console.log(`site-builder\n\nUsage:\n  node index.js run --request-file <json>\n\nArgs:\n  mode: "single-file" | "plan" | "audit" (default: single-file)\n  title: site title override\n  vibe: minimalist | bold | editorial | product | premium | playful\n  accent/bg/ink: CSS color overrides\n`);
}

function textFromRequest(req) {
  if (typeof req.text === "string") return req.text;
  if (typeof req.artifact?.text === "string") return req.artifact.text;
  return "";
}

function esc(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function titleCase(s) {
  return String(s || "Untitled Site").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function infer(brief, args = {}) {
  const lower = brief.toLowerCase();
  const title = args.title || (brief.match(/^#\s+(.+)$/m)?.[1]) || (brief.match(/(?:site|landing|page|for|sobre)\s+([^\.\n]{3,60})/i)?.[1]) || "Signal Site";
  let kind = "landing page";
  if (/portfolio|cv|personal/.test(lower)) kind = "portfolio";
  if (/blog|editorial|newsletter/.test(lower)) kind = "editorial site";
  if (/dashboard|admin|app/.test(lower)) kind = "product surface";
  let audience = /developer|dev|technical|api/.test(lower) ? "technical buyers" : /consumer|dtc|shop|tienda/.test(lower) ? "consumers" : "decision makers";
  let vibe = args.vibe || "bold";
  if (/minimal|clean|linear|calm|simple/.test(lower)) vibe = "minimalist";
  if (/premium|luxury|lujo|apple/.test(lower)) vibe = "premium";
  if (/playful|fun|juego|kids/.test(lower)) vibe = "playful";
  if (/editorial|magazine|story/.test(lower)) vibe = "editorial";
  if (/b2b|saas|product/.test(lower)) vibe = "product";
  const palette = paletteFor(vibe, args);
  return { title: titleCase(title), kind, audience, vibe, palette };
}

function paletteFor(vibe, args) {
  const map = {
    minimalist: { bg: "#f6f7f2", ink: "#111312", accent: "#2457ff" },
    bold: { bg: defaults.defaultBg, ink: defaults.defaultInk, accent: defaults.defaultAccent },
    editorial: { bg: "#f1efe7", ink: "#16130f", accent: "#1e6b4e" },
    product: { bg: "#f7f8f5", ink: "#111827", accent: "#2563eb" },
    premium: { bg: "#eceff1", ink: "#111315", accent: "#7c8cff" },
    playful: { bg: "#fff7d8", ink: "#17130a", accent: "#e43d64" }
  };
  return { ...(map[vibe] || map.bold), bg: args.bg || (map[vibe] || map.bold).bg, ink: args.ink || (map[vibe] || map.bold).ink, accent: args.accent || (map[vibe] || map.bold).accent };
}

function auditDesign(brief, read) {
  const findings = [];
  const lower = brief.toLowerCase();
  if (/purple|violet|gradient/.test(lower) && !/brand|marca|explicit|pedido/.test(lower)) {
    findings.push({ severity: "medium", type: "visual", issue: "Potential AI-default purple/gradient direction", fix: "Use a brand-specific accent or justify the gradient as part of the design read." });
  }
  if (/card|cards|tarjeta/.test(lower) && /three|3|tres/.test(lower)) {
    findings.push({ severity: "low", type: "layout", issue: "Three-card section can look templated", fix: "Vary section rhythm with proof, mechanism, screenshots, or asymmetric layout." });
  }
  if (read.kind === "product surface" && !/dashboard|admin|app/.test(lower)) {
    findings.push({ severity: "low", type: "scope", issue: "Brief may be drifting from marketing site into app UI", fix: "Confirm whether this tool should output a landing/static page or a product interface." });
  }
  return findings;
}

function plan(brief, read) {
  const findings = auditDesign(brief, read);
  return `# Site build plan: ${read.title}\n\nReading this as: ${read.kind} for ${read.audience}, with a ${read.vibe} language.\n\n## Direction\n- Palette: ${read.palette.bg} background, ${read.palette.ink} ink, ${read.palette.accent} accent\n- Structure: hero, proof strip, mechanism section, use cases, CTA\n- Avoid: purple-blue AI glow, three equal generic cards, nested cards, generic glassmorphism\n\n## Design audit\n${findings.length ? findings.map(f => `- [${f.severity}] ${f.issue} → ${f.fix}`).join("\n") : "- No obvious frontend anti-patterns detected in the brief."}\n\n## Build checklist\n- Mobile-first responsive grid\n- One accent color across all sections\n- Visible focus states\n- Contrast above AA\n- Clear CTA placement\n`;
}

function html(brief, read) {
  const p = read.palette;
  const cleanBrief = brief.replace(/^#.+$/m, "").trim().slice(0, 260) || "A focused product experience built around clarity, speed, and a point of view.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(read.title)}</title>
<style>
:root{--bg:${p.bg};--ink:${p.ink};--accent:${p.accent};--muted:color-mix(in srgb,var(--ink) 62%,var(--bg));--line:color-mix(in srgb,var(--ink) 14%,var(--bg))}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit}.wrap{width:min(1120px,calc(100% - 32px));margin:auto}.nav{display:flex;justify-content:space-between;align-items:center;padding:24px 0}.brand{font-weight:800;letter-spacing:-.04em}.pill{border:1px solid var(--line);border-radius:999px;padding:9px 14px;text-decoration:none}.hero{min-height:76dvh;display:grid;align-items:center;padding:56px 0}.kicker{color:var(--accent);font-weight:800;text-transform:uppercase;letter-spacing:.12em;font-size:12px}.hero h1{font-size:clamp(48px,9vw,112px);line-height:.88;letter-spacing:-.08em;margin:18px 0;max-width:950px}.hero p{font-size:clamp(18px,2vw,23px);line-height:1.45;color:var(--muted);max-width:680px}.cta{display:inline-flex;background:var(--ink);color:var(--bg);padding:15px 20px;border-radius:16px;text-decoration:none;font-weight:750;margin-top:24px}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:24px;padding:48px 0}.panel{border:1px solid var(--line);border-radius:28px;padding:28px;background:color-mix(in srgb,var(--bg) 82%,white)}.panel strong{font-size:42px;letter-spacing:-.06em;display:block}.panel p{color:var(--muted);line-height:1.55}.stripe{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:18px 0;color:var(--muted);display:flex;gap:18px;flex-wrap:wrap}.section{padding:72px 0}.section h2{font-size:clamp(34px,5vw,64px);line-height:.95;letter-spacing:-.06em;max-width:740px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{padding:24px;border-left:3px solid var(--accent);background:color-mix(in srgb,var(--bg) 72%,white);border-radius:18px}.card p{color:var(--muted);line-height:1.5}.footer{padding:40px 0;color:var(--muted)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}@media(max-width:780px){.grid,.cards{grid-template-columns:1fr}.hero{min-height:auto}.nav{align-items:flex-start}.hero h1{font-size:54px}}
</style>
</head>
<body>
<header class="wrap nav"><div class="brand">${esc(read.title)}</div><a class="pill" href="#contact">Start</a></header>
<main>
<section class="wrap hero"><div><div class="kicker">${esc(read.kind)} · ${esc(read.audience)}</div><h1>A site with a point of view, not another template.</h1><p>${esc(cleanBrief)}</p><a class="cta" href="#contact">Make the next move</a></div></section>
<div class="wrap stripe"><span>Fast to scan</span><span>Clear hierarchy</span><span>One visual system</span><span>No AI-default gloss</span></div>
<section class="wrap grid"><div class="panel"><strong>01</strong><p>Lead with the mechanism: what changes for the visitor, what they can do next, and why this page deserves trust.</p></div><div class="panel"><strong>AA</strong><p>Responsive layout, visible focus states, restrained motion, and a single accent color carried through the page.</p></div></section>
<section class="wrap section"><h2>Built around rhythm, hierarchy, and useful friction.</h2><div class="cards"><article class="card"><h3>Proof area</h3><p>Reserve this slot for metrics, named examples, screenshots, or third-party validation.</p></article><article class="card"><h3>Mechanism area</h3><p>Use this section to show the product model, workflow, or differentiating interaction.</p></article><article class="card"><h3>Memory hook</h3><p>Give the page one distinct visual move so it remains recognizable after the tab closes.</p></article></div></section>
<section id="contact" class="wrap section"><h2>Ready for the real content.</h2><p style="color:var(--muted);max-width:620px;line-height:1.55">Swap in product-specific proof, screenshots, and a sharper CTA. Keep the system; remove anything that reads like filler.</p><a class="cta" href="mailto:hello@example.com">Contact</a></section>
</main><footer class="wrap footer">Generated by site-builder anti-slop.</footer>
</body></html>`;
}

async function run(requestFile) {
  const req = JSON.parse(await readFile(requestFile, "utf8"));
  const args = req.args || {};
  const brief = textFromRequest(req);
  const read = infer(brief, args);
  const mode = args.mode || "single-file";
  if (mode === "audit") {
    console.log(JSON.stringify({ ok: true, output: { mimeType: "application/json", text: JSON.stringify({ designRead: read, findings: auditDesign(brief, read) }, null, 2) } }));
    return;
  }
  if (mode === "plan") {
    console.log(JSON.stringify({ ok: true, output: { mimeType: "text/markdown", text: plan(brief, read) } }));
    return;
  }
  console.log(JSON.stringify({ ok: true, output: { mimeType: "text/html", text: html(brief, read), meta: { designRead: read, plan: plan(brief, read) } } }));
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv[0] === "help") printHelp();
else if (argv[0] === "run") {
  const i = argv.indexOf("--request-file");
  run(argv[i + 1]).catch(err => console.log(JSON.stringify({ ok: false, error: err.message || String(err) })));
} else printHelp();
