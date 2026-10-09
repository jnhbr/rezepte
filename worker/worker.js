// Cloudflare Worker: nimmt Rezepttext/Screenshot/Link entgegen und lässt Claude ein strukturiertes Rezept daraus machen.
// Secrets: ANTHROPIC_API_KEY, ACCESS_CODE (derselbe Code wie in der App unter «Mehr»).
const MODEL = 'claude-haiku-4-5-20251001';
const SYSTEM = `Du extrahierst Kochrezepte für ein Schweizer Ehepaar. Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach:
{"titel":string,"portionen":number,"zutaten":[string],"schritte":[string],"tags":[string]}
Regeln:
- Deutsch, Schweizer Rechtschreibung (ss statt ß).
- Zutaten: je ein String im Format "Menge Einheit Zutat", z. B. "200 g Mehl", "2 Eier", "1 EL Olivenöl". Metrische Einheiten (g, ml, dl, EL, TL). Ohne Mengenangabe nur "Salz".
- Schritte: kurze, klare Anweisungen, ohne Nummerierung, ohne Hashtags und Werbung.
- tags: 2-5 kurze Stichworte (z. B. vegi, schnell, Pasta, Dessert, Gäste).
- portionen: Zahl; falls nicht angegeben, schätze sinnvoll (meist 2-4).
- Erfinde nichts, was nicht im Material steht. Wenn kein Rezept erkennbar ist: {"fehler":"Kein Rezept erkannt"}.`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

const decode = t => t.replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');

function captionFromEmbed(html) {
  const m = html.match(/class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/) || html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  if (!m) return '';
  let t = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '');
  t = decode(t).replace(/View all \d+ comments?/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

async function captionFromLink(link) {
  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  try {
    const id = link.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (id) {
      const r = await fetch(`https://www.instagram.com/p/${id[1]}/embed/captioned/`, { headers: { 'user-agent': UA } });
      const t = captionFromEmbed(await r.text());
      if (t) return t;
    }
    const r = await fetch(link, { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    const h = await r.text();
    const m = h.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]*)"/i);
    return m ? decode(m[1]) : '';
  } catch { return ''; }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ fehler: 'POST erwartet' }, 405);
    let b;
    try { b = await req.json(); } catch { return json({ fehler: 'Ungültige Anfrage' }, 400); }
    if (!env.ACCESS_CODE || b.code !== env.ACCESS_CODE) return json({ fehler: 'Zugangscode falsch' }, 401);

    let text = (b.text || '').slice(0, 12000);
    if (!text && !b.image && b.link) text = await captionFromLink(b.link);
    if (!text && !b.image) return json({ fehler: 'Von diesem Link konnte kein Text geladen werden. Bitte Text oder Screenshot einfügen.' }, 422);

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
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content }] }),
    });
    if (!r.ok) return json({ fehler: 'KI-Dienst nicht erreichbar (' + r.status + ')' }, 502);
    const d = await r.json();
    const out = (d.content || []).map(c => c.text || '').join('');
    try {
      const rec = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      return json(rec);
    } catch { return json({ fehler: 'Antwort nicht lesbar' }, 502); }
  },
};
