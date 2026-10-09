// Cloudflare Worker: nimmt Rezepttext/Screenshot/Link entgegen und lässt Claude ein strukturiertes Rezept daraus machen.
// Secrets: ANTHROPIC_API_KEY, ACCESS_CODE (derselbe Code wie in der App unter «Mehr»).
const MODEL = 'claude-haiku-4-5-20251001';

const TAGS = [
  'Pasta', 'Reis', 'Suppe', 'Salat', 'Auflauf', 'Eintopf', 'Curry', 'Pizza & Flammkuchen', 'Burger & Sandwich', 'Bowl', 'Pfanne', 'Ofengericht', 'Grill',
  'Brot & Gebäck', 'Dessert', 'Kuchen', 'Frühstück', 'Apéro & Snacks', 'Beilage', 'Sauce & Dip', 'Getränk',
  'Vegi', 'Vegan', 'Fleisch', 'Geflügel', 'Fisch & Meeresfrüchte',
  'Asiatisch', 'Italienisch', 'Mexikanisch', 'Orientalisch', 'Schweizerisch', 'Mediterran', 'Amerikanisch', 'Indisch',
  'Schnell', 'Gäste', 'Meal Prep', 'Gesund', 'Comfort Food',
];
const KATEGORIEN = ['Obst & Gemüse', 'Milch & Eier', 'Fleisch & Fisch', 'Brot & Backwaren', 'Trockenwaren & Konserven', 'Gewürze, Öle & Saucen', 'Tiefkühl', 'Getränke', 'Sonstiges'];

const TAGREGELN = (allowed) => `- tags: 2 bis 5 Stichworte, AUSSCHLIESSLICH aus dieser Liste (exakt so geschrieben): ${allowed.join(' | ')}.
  Wähle immer die übergeordnete Kategorie, nie etwas Spezifisches: Wird z. B. ein Rezept mit Eierschwämmen oder anderen Pilzen vegetarisch gekocht, ist der Tag "Vegi", nicht "Pilze" oder "Eierschwämme". Einzelne Zutaten, Marken oder Hashtags des Autors werden nie zu Tags.
- neuerTag: normalerweise null. Nur wenn wirklich KEIN Tag der Liste die Art des Gerichts abdeckt, schlage genau einen neuen, allgemeinen Oberbegriff vor (1-2 Wörter, keine Zutat, kein Eigenname).`;

const systemFor = (allowed) => `Du extrahierst Kochrezepte für ein Schweizer Ehepaar. Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach:
{"titel":string,"portionen":number,"zutaten":[string],"kategorien":[string],"schritte":[string],"tags":[string],"neuerTag":string|null}
Regeln:
- Deutsch, Schweizer Rechtschreibung (ss statt ß).
- Zutaten: je ein String im Format "Menge Einheit Zutat", z. B. "200 g Mehl", "2 Eier", "1 EL Olivenöl". Metrische Einheiten (g, ml, dl, EL, TL). Ohne Mengenangabe nur "Salz". Zutatennamen in der Grundform ("Zwiebel", nicht "Zwiebeln"), ohne Klammerzusätze wie "(topping)".
- kategorien: genau gleich viele Einträge wie zutaten, gleiche Reihenfolge. Jeder Eintrag ist einer dieser Supermarkt-Bereiche (exakt so geschrieben): ${KATEGORIEN.join(' | ')}.
- Schritte: kurze, klare Anweisungen, ohne Nummerierung, ohne Hashtags und Werbung. Zeitangaben (z. B. "20 Minuten köcheln") unbedingt beibehalten.
${TAGREGELN(allowed)}
- portionen: Zahl; falls nicht angegeben, schätze sinnvoll (meist 2-4).
- Erfinde nichts, was nicht im Material steht. Wenn kein Rezept erkennbar ist: {"fehler":"Kein Rezept erkannt"}.`;

const systemRetag = (allowed) => `Du ordnest Kochrezepte in Kategorien ein. Du bekommst eine JSON-Liste mit id, titel, zutaten und tags (bisherige, oft zu spezifische oder doppelte Tags). Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach:
{"ergebnisse":[{"id":string,"tags":[string],"neuerTag":string|null}]}
Regeln:
- Genau ein Eintrag pro Rezept, id unverändert übernehmen.
${TAGREGELN(allowed)}
- Die bisherigen Tags sind nur ein Hinweis; ordne anhand von Titel und Zutaten ein.`;

// Erlaubte Tags = feste Liste + vom Nutzer freigegebene Zusatz-Tags
function allowedTags(pool) {
  const extra = (Array.isArray(pool) ? pool : []).map(t => String(t).trim()).filter(t => t && t.length <= 30).slice(0, 60);
  const map = new Map();
  [...TAGS, ...extra].forEach(t => map.set(t.toLowerCase(), t));
  return map;
}
function cleanTags(tags, map) {
  const out = [];
  (Array.isArray(tags) ? tags : []).forEach(t => { const c = map.get(String(t).trim().toLowerCase()); if (c && !out.includes(c)) out.push(c); });
  return out.slice(0, 5);
}
function cleanNeu(t, map) {
  t = typeof t === 'string' ? t.trim() : '';
  if (t.length < 2 || t.length > 30 || /[<>{}]/.test(t) || map.has(t.toLowerCase())) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

const decode = t => t.replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function captionFromEmbed(html) {
  const m = html.match(/class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/) || html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (!m) return '';
  const t = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '');
  return decode(t).replace(/View all \d+ comments?/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Shortcode aus Instagram-Link; Share-Links (instagram.com/share/reel/…) werden über die Weiterleitung aufgelöst
const SC = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
async function shortcode(link) {
  if (!/\/share\//i.test(link)) { const m = link.match(SC); if (m) return m[1]; }
  try {
    const r = await fetch(link, { redirect: 'follow', headers: { 'user-agent': UA } });
    const m = decodeURIComponent(r.url).match(SC);
    if (m && !/\/share\//i.test(m[0])) return m[1];
  } catch { /* weiter */ }
  return '';
}

// Holt die Embed-Seite eines Instagram-Links: Text, Vorschaubild und Diagnose
async function fromInstagram(link) {
  const dbg = [];
  try {
    const id = await shortcode(link);
    if (!id) return { caption: '', img: '', dbg: 'Link nicht erkannt' };
    for (const path of [`p/${id}/embed/captioned/`, `reel/${id}/embed/captioned/`]) {
      const r = await fetch(`https://www.instagram.com/${path}`, { headers: { 'user-agent': UA, 'accept-language': 'de-CH,de;q=0.9' } });
      const h = await r.text();
      const caption = captionFromEmbed(h);
      dbg.push(`${r.status}/${h.length}B/${caption ? 'Text' : /login|checkpoint/i.test(h.slice(0, 4000)) ? 'Login-Sperre' : 'kein Text'}`);
      if (caption) {
        const im = h.match(/<img[^>]+class="EmbeddedMediaImage"[^>]+src="([^"]+)"/i);
        return { caption, img: im ? decode(im[1]) : '', dbg: dbg.join(', ') };
      }
    }
  } catch (e) { dbg.push('Fehler: ' + String(e).slice(0, 60)); }
  return { caption: '', img: '', dbg: dbg.join(', ') };
}

// ---- Normale Rezeptseiten: schema.org-Rezept (JSON-LD) lesen, sonst Seitentext ----
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
function ldRecipe(html) {
  const out = [];
  const collect = n => {
    if (Array.isArray(n)) return n.forEach(collect);
    if (!n || typeof n !== 'object') return;
    const t = n['@type'];
    if ((Array.isArray(t) ? t : [t]).includes('Recipe')) out.push(n);
    if (n['@graph']) collect(n['@graph']);
  };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { try { collect(JSON.parse(m[1].trim())); } catch { /* weiter */ } }
  return out[0] || null;
}
const flatSteps = x => {
  if (typeof x === 'string') return x.split(/\n+/);
  if (Array.isArray(x)) return x.flatMap(flatSteps);
  if (x && typeof x === 'object') return x.itemListElement ? flatSteps(x.itemListElement) : [x.text || x.name || ''];
  return [];
};
const firstImage = i => (typeof i === 'string' ? i : Array.isArray(i) ? firstImage(i[0]) : i && typeof i === 'object' ? i.url || '' : '');
function recipeToText(r) {
  const yieldTxt = Array.isArray(r.recipeYield) ? r.recipeYield.join(' / ') : r.recipeYield || '';
  return [
    `Titel: ${decode(String(r.name || ''))}`,
    yieldTxt ? `Portionen: ${yieldTxt}` : '',
    r.description ? `Beschreibung: ${decode(String(r.description)).slice(0, 400)}` : '',
    'Zutaten:\n' + (r.recipeIngredient || r.ingredients || []).map(i => '- ' + decode(String(i))).join('\n'),
    'Zubereitung:\n' + flatSteps(r.recipeInstructions).map(t => decode(String(t)).trim()).filter(Boolean).map((t, i) => `${i + 1}. ${t}`).join('\n'),
  ].filter(Boolean).join('\n');
}
async function fromWebpage(link) {
  try {
    const r = await fetch(link, { redirect: 'follow', headers: { 'user-agent': BROWSER_UA, 'accept-language': 'de-CH,de;q=0.9,en;q=0.7', accept: 'text/html,application/xhtml+xml' } });
    const h = await r.text();
    const rec = ldRecipe(h);
    const og = (p) => { const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i')) || h.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i')); return m ? decode(m[1]) : ''; };
    const img = (rec && firstImage(rec.image)) || og('og:image');
    if (rec) return { text: recipeToText(rec), img, dbg: `${r.status}/Rezept-Daten` };
    const body = h.replace(/<(script|style|noscript|nav|footer|header|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const text = (`Seitentitel: ${og('og:title')}\nBeschreibung: ${og('og:description')}\n` + decode(body).replace(/\s+/g, ' ')).slice(0, 9000);
    return { text, img, dbg: `${r.status}/${h.length}B/nur Seitentext` };
  } catch (e) { return { text: '', img: '', dbg: 'Fehler: ' + String(e).slice(0, 60) }; }
}

async function captionFallback(link) {
  try {
    const r = await fetch(link, { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    const h = await r.text();
    const m = h.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]*)"/i);
    return m ? decode(m[1]) : '';
  } catch { return ''; }
}

async function imageDataUrl(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return '';
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 2500000) return '';
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${btoa(bin)}`;
  } catch { return ''; }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ fehler: 'POST erwartet' }, 405);
    let b;
    try { b = await req.json(); } catch { return json({ fehler: 'Ungültige Anfrage' }, 400); }
    if (!env.ACCESS_CODE || b.code !== env.ACCESS_CODE) return json({ fehler: 'Zugangscode falsch' }, 401);

    const tagMap = allowedTags(b.pool);
    const allowed = [...tagMap.values()];

    if (Array.isArray(b.retag)) {
      const items = b.retag.slice(0, 15).map(x => ({ id: String(x.id), titel: String(x.titel || '').slice(0, 120), zutaten: (x.zutaten || []).slice(0, 25).map(z => String(z).slice(0, 80)), tags: (x.tags || []).slice(0, 10) }));
      const rr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: systemRetag(allowed), messages: [{ role: 'user', content: JSON.stringify(items) }] }),
      });
      if (!rr.ok) return json({ fehler: 'KI-Dienst nicht erreichbar (' + rr.status + ')' }, 502);
      const dd = await rr.json();
      const oo = (dd.content || []).map(c => c.text || '').join('');
      try {
        const parsed = JSON.parse(oo.slice(oo.indexOf('{'), oo.lastIndexOf('}') + 1));
        const ids = new Set(items.map(i => i.id));
        const ergebnisse = (parsed.ergebnisse || []).filter(e => ids.has(String(e.id))).map(e => ({ id: String(e.id), tags: cleanTags(e.tags, tagMap), neuerTag: cleanNeu(e.neuerTag, tagMap) }));
        return json({ ergebnisse });
      } catch { return json({ fehler: 'Antwort nicht lesbar' }, 502); }
    }

    let text = (b.text || '').slice(0, 12000);
    let img = '', dbg = '';
    if (b.link) {
      if (/instagram\.com/i.test(b.link)) {
        const ig = await fromInstagram(b.link);
        img = ig.img; dbg = ig.dbg;
        if (!text && !b.image) text = ig.caption || (await captionFallback(b.link));
        if (!text && !b.image) return json({ fehler: `Instagram gibt den Text nicht heraus (${dbg}). Bitte Text oder Screenshot einfügen.` }, 422);
      } else if (/^https?:\/\//i.test(b.link)) {
        const wp = await fromWebpage(b.link);
        img = wp.img; dbg = wp.dbg;
        if (!text && !b.image) text = wp.text;
        if (!text && !b.image) return json({ fehler: `Von dieser Seite konnte kein Rezept geladen werden (${dbg}). Bitte Text oder Screenshot einfügen.` }, 422);
      }
    }
    if (!text && !b.image) return json({ fehler: 'Bitte Text einfügen, einen Screenshot wählen oder einen Link eintragen.' }, 422);

    const content = [];
    if (b.image) {
      const m = String(b.image).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) return json({ fehler: 'Bildformat nicht unterstützt' }, 400);
      content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    content.push({ type: 'text', text: text ? `Material:\n${text}` : 'Lies das Rezept aus dem Bild.' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: systemFor(allowed), messages: [{ role: 'user', content }] }),
    });
    if (!r.ok) return json({ fehler: 'KI-Dienst nicht erreichbar (' + r.status + ')' }, 502);
    const d = await r.json();
    const out = (d.content || []).map(c => c.text || '').join('');
    let rec;
    try { rec = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch { return json({ fehler: 'Antwort nicht lesbar' }, 502); }
    rec.tags = cleanTags(rec.tags, tagMap);
    rec.neuerTag = cleanNeu(rec.neuerTag, tagMap);
    if (img) rec.bild = await imageDataUrl(img);
    return json(rec);
  },
};
