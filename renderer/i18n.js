// Traduction de l'interface (français). Couche légère: elle remplace les textes anglais affichés par leur version
// française (dictionnaire i18n-fr.js), sans toucher au reste du code. Langue: "auto" (suit le système), "fr" ou "en".
// Choisie dans Paramètres → Étagère → Langue; stockée dans localStorage ("boxshelf.lang").
(function () {
  "use strict";
  const KEY = "boxshelf.lang";
  const pref = () => { try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; } };
  const detect = () => { const p = pref(); if (p !== "auto") return p; return /^fr/i.test(navigator.language || "") ? "fr" : "en"; };
  const lang = detect();
  window.BS_LANG = lang;
  window.BS_LANG_PREF = pref;
  window.BS_setLang = v => { try { localStorage.setItem(KEY, v); } catch {} location.reload(); };
  if (lang !== "fr" || !window.BS_I18N_FR) return;

  document.documentElement.lang = "fr";
  const D = window.BS_I18N_FR;
  const exact = new Map(Object.entries(D.exact));
  const pats = D.patterns.map(([s, f]) => { try { return [new RegExp(s, "s"), f]; } catch { return null; } }).filter(Boolean);
  const norm = s => s.replace(/\s+/g, " ").trim();
  const cache = new Map();

  const fill = (f, m) => f.replace(/\{(\d+)(?:\?([^}]*))?\}/g, (_, n, opt) => {
    const v = m[+n]; if (v == null) return "";
    if (opt != null) return v ? opt : "";
    return exact.get(norm(v)) || v;
  });

  function tr(text) {
    if (!text || !/[A-Za-z]/.test(text)) return text;
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    const core = norm(text);
    if (!core) return text;
    let out = cache.get(core);
    if (out === undefined) {
      out = exact.get(core) || null;
      if (!out && core.length < 600) {
        for (const [re, f] of pats) { const m = re.exec(core); if (m) { out = fill(f, m); break; } }
      }
      if (cache.size > 6000) cache.clear();
      cache.set(core, out);
    }
    return out ? lead + out + trail : text;
  }
  window.BS_tr = tr;

  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE", "NOSCRIPT"]);
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];

  function textNode(n) {
    const p = n.parentNode; if (!p || SKIP.has(p.nodeName)) return;
    const v = n.nodeValue, t = tr(v); if (t !== v) n.nodeValue = t;
  }
  function attrs(el) {
    for (const a of ATTRS) { const v = el.getAttribute && el.getAttribute(a); if (v) { const t = tr(v); if (t !== v) el.setAttribute(a, t); } }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { textNode(root); return; }
    if (root.nodeType !== 1 || SKIP.has(root.nodeName)) return;
    attrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) textNode(n); else if (!SKIP.has(n.nodeName)) attrs(n); }
  }

  let queue = new Set(), scheduled = false;
  function flush() {
    scheduled = false; const q = queue; queue = new Set();
    for (const n of q) if (n.isConnected !== false) walk(n);
  }
  const schedule = n => { queue.add(n); if (!scheduled) { scheduled = true; (window.requestAnimationFrame || setTimeout)(flush); } };

  const mo = new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === "childList") r.addedNodes.forEach(schedule);
      else if (r.type === "characterData") schedule(r.target);
      else if (r.type === "attributes") schedule(r.target);
    }
  });
  function start() {
    if (document.title) document.title = tr(document.title);
    walk(document.body || document.documentElement);
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
