const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: 'https://smalblackprices.netlify.app' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 300 }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MAX_AGE_DAYS = 6;

// [categoria do site, termo buscado na Amazon] - 3 por dia, em rodízio de 3 dias
const QUERIES = [
  ['trending', 'smart tv 4k'],
  ['trending', 'iphone'],
  ['trending', 'air fryer'],
  ['eletronico', 'fone bluetooth'],
  ['beleza', 'perfume'],
  ['eletrodomestico', 'eletrodomesticos'],
  ['casa cozinha', 'utensilios de cozinha'],
  ['video game', 'console video game'],
  ['brinquedo', 'brinquedos']
];
const CATEGORY_KEYS = new Set(QUERIES.map(q => q[0]));

function cleanQuery(q) {
  return typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '';
}

function parsePrice(val) {
  if (typeof val === 'number') return val;
  const s = String(val || '').replace(/[^\d.,]/g, '');
  return parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0;
}

const sinceDate = () => new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString();
// Data de hoje no horário de Brasília, ex.: "2026-11-16"
const brDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

// Busca palavra por palavra: "tv samsung" encontra "Samsung Smart TV"
function matchWords(query, q) {
  for (const w of q.split(/\s+/)) query = query.ilike('title', `%${w}%`);
  return query;
}

// Busca tolerante a erro de digitação ("ipone" -> "iphone"), pela função
// search_products_fuzzy do Supabase (pg_trgm). Se ela não existir, devolve vazio.
async function fuzzySearch(q, limit) {
  const { data, error } = await supabase.rpc('search_products_fuzzy', { q, since: sinceDate(), max_rows: limit });
  if (error) { console.error('fuzzy:', error.message); return []; }
  return data || [];
}

function findItems(data) {
  let best = [];
  for (const v of Object.values(data || {})) {
    if (Array.isArray(v) && v.length > best.length && v[0] && typeof v[0] === 'object'
        && 'name' in v[0]) best = v;
  }
  return best;
}

async function geckoSearch(keyword) {
  const res = await fetch('https://api.geckoapi.com.br/v1/extract', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GECKO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      target: 'amazon.com.br',
      type: 'plp',
      url: `https://www.amazon.com.br/s?k=${encodeURIComponent(keyword).replace(/%20/g, '+')}`,
      page: 1,
      keyword
    })
  });
  if (!res.ok) throw new Error(`GeckoAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return findItems(json.data);
}

// A GeckoAPI manda títulos com códigos HTML: "D&#x27;Água" -> "D'Água"
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

// Campos da GeckoAPI: url, sku, name, price, asin, thumbnail, aggregateRating...
function mapAmazon(item) {
  const price = parsePrice(item.price);
  if (!item.asin || !item.name || !(price > 0)) return null;
  return {
    id: item.asin,
    title: decodeHtml(String(item.name)).slice(0, 300),
    price,
    url: `https://www.amazon.com.br/dp/${item.asin}`,
    image: item.thumbnail || null,
    store: 'Amazon'
  };
}

async function saveProducts(rows, category) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('products')
    .upsert(rows.map(r => ({ ...r, category, updated_at: now })));
  if (error) throw new Error('Supabase products: ' + error.message);
  const { error: e2 } = await supabase.from('prices')
    .upsert(rows.map(r => ({ product_id: r.id, price: r.price, day: brDate() })),
      { onConflict: 'product_id,day' });
  if (e2) throw new Error('Supabase prices: ' + e2.message);
}

app.post('/api/refresh', async (req, res) => {
  if (!process.env.REFRESH_KEY || req.get('x-refresh-key') !== process.env.REFRESH_KEY) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  const day = Math.floor(Date.parse(brDate()) / 86400000);
  const today = [0, 1, 2].map(i => QUERIES[(day * 3 + i) % QUERIES.length]);

  const report = await Promise.all(today.map(async ([category, keyword]) => {
    try {
      const items = await geckoSearch(keyword);
      const mapped = items.map(mapAmazon).filter(Boolean);
      const rows = [...new Map(mapped.map(r => [r.id, r])).values()];
      if (rows.length) await saveProducts(rows, category);
      return { keyword, recebidos: items.length, salvos: rows.length,
               campos: items[0] ? Object.keys(items[0]) : [] };
    } catch (e) {
      return { keyword, erro: e.message };
    }
  }));

  console.log(JSON.stringify(report));
  catalogCache.at = 0;
  // Tudo falhou (ex.: créditos da GeckoAPI acabaram): o job do GitHub fica vermelho
  res.status(report.every(r => r.erro) ? 502 : 200).json(report);
});
function toFront(r) {
  return {
    id: r.id,
    title: r.title,
    price: Number(r.price),
    originalPrice: r.original_price ? Number(r.original_price) : null,
    url: r.url,
    image: r.image,
    store: r.store,
    storeLogo: '🅰️',
    rating: null,
    checkedAt: r.updated_at
  };
}

// Health check: o cron-job.org chama a cada 10 min para o Render grátis não dormir.
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Catálogo inteiro para o site buscar no navegador (rápido, sem uma chamada por letra).
// Produtos monitorados (Amazon, com histórico) + ofertas que o bot postou no canal (3 lojas).
let catalogCache = { at: 0, data: null };
app.get('/api/catalog', async (req, res) => {
  try {
    if (!catalogCache.data || Date.now() - catalogCache.at > 5 * 60 * 1000) {
      const [prod, chan] = await Promise.all([
        supabase.from('products').select('*').gte('updated_at', sinceDate())
          .order('updated_at', { ascending: false }).limit(1000),
        supabase.from('channel_offers').select('*')
          .gte('posted_at', new Date(Date.now() - 7 * 86400000).toISOString())
          .order('posted_at', { ascending: false }).limit(200)
      ]);
      if (prod.error) throw prod.error;
      if (chan.error) console.error('channel_offers:', chan.error.message);
      catalogCache = { at: Date.now(), data: {
        products: prod.data.map(r => ({ ...toFront(r), category: r.category })),
        channel: (chan.data || []).map(r => ({
          id: 'c' + r.id, title: r.title, price: Number(r.price),
          originalPrice: r.original_price ? Number(r.original_price) : null,
          url: r.url, image: r.image, store: r.store, checkedAt: r.posted_at, fromChannel: true
        })),
        generatedAt: new Date().toISOString()
      } };
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json(catalogCache.data);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Falha ao ler catálogo' });
  }
});

app.post('/api/trending', async (req, res) => {
  try {
    const { data, error } = await supabase.from('products').select('*')
      .gte('updated_at', sinceDate()).order('updated_at', { ascending: false }).limit(48);
    if (error) throw error;
    res.json({ results: data.map(toFront) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Falha ao ler ofertas' });
  }
});

app.post('/api/search', async (req, res) => {
  const q = cleanQuery(req.body.query);
  if (!q) return res.status(400).json({ error: 'Termo inválido' });
  try {
    let query = supabase.from('products').select('*').gte('updated_at', sinceDate());
    query = CATEGORY_KEYS.has(q) ? query.eq('category', q) : matchWords(query, q);
    const { data, error } = await query.order('updated_at', { ascending: false }).limit(48);
    if (error) throw error;
    const rows = data.length || CATEGORY_KEYS.has(q) ? data : await fuzzySearch(q, 48);
    res.json({ results: rows.map(toFront) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Falha na busca' });
  }
});

app.post('/api/suggest', async (req, res) => {
  const q = cleanQuery(req.body.query);
  if (q.length < 2) return res.json({ suggestions: [] });
  try {
    const base = supabase.from('products').select('title').gte('updated_at', sinceDate());
    let { data } = await matchWords(base, q).limit(5);
    if (!data || !data.length) data = await fuzzySearch(q, 5);
    res.json({ suggestions: [...new Set((data || []).map(r => r.title))] });
  } catch {
    res.json({ suggestions: [] });
  }
});

app.post('/api/history', async (req, res) => {
  const { product_id } = req.body;
  if (typeof product_id !== 'string' || product_id.length > 40) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const { data, error } = await supabase.from('prices')
      .select('day, price').eq('product_id', product_id).order('day');
    if (error) throw error;
    if (!data || data.length < 2) return res.status(404).json({ error: 'Pouco histórico' });
    const vals = data.map(r => Number(r.price)).sort((a, b) => a - b);
    res.json({ data: {
      points: data.map(r => ({ date: r.day, price: Number(r.price) })),
      min: vals[0],
      max: vals[vals.length - 1],
      median: vals[Math.floor(vals.length / 2)]
    }});
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Falha ao ler histórico' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
