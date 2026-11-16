const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: 'https://smalblackprices.netlify.app' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 60 }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MAX_AGE_DAYS = 6;

// [categoria do site, termo buscado na Amazon] - 3 por dia, em rodízio
const QUERIES = [
  ['trending', 'smart tv 4k'],
  ['trending', 'iphone'],
  ['trending', 'air fryer'],
  ['eletrodomestico', 'eletrodomesticos'],
  ['casa cozinha', 'utensilios de cozinha'],
  ['eletronico', 'fone bluetooth'],
  ['beleza', 'perfume'],
  ['livro', 'livros mais vendidos'],
  ['video game', 'console video game'],
  ['brinquedo', 'brinquedos'],
  ['moda roupa', 'tenis'],
  ['esporte', 'artigos esportivos'],
  ['suplemento', 'whey protein'],
  ['cupom', 'ofertas do dia']
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

function pick(obj, ...paths) {
  for (const path of paths) {
    const v = path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
    if (v != null && v !== '') return v;
  }
  return undefined;
}

const sinceDate = () => new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString();
function findItems(data) {
  let best = [];
  for (const v of Object.values(data || {})) {
    if (Array.isArray(v) && v.length > best.length && v[0] && typeof v[0] === 'object'
        && ('title' in v[0] || 'name' in v[0])) best = v;
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

function mapAmazon(item) {
  const link = pick(item, 'url', 'link', 'product_url', 'productUrl');
  const url = link ? new URL(link, 'https://www.amazon.com.br').href : '';
  const asin = pick(item, 'asin', 'ASIN') || url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1];
  const title = pick(item, 'title', 'name');
  const price = parsePrice(pick(item, 'price.value', 'price.current', 'price', 'current_price', 'currentPrice'));
  if (!asin || !title || !(price > 0)) return null;
  const original = parsePrice(pick(item, 'price.original', 'original_price', 'originalPrice',
    'list_price', 'listPrice', 'old_price'));
  return {
    id: asin,
    title: String(title).slice(0, 300),
    price,
    original_price: original > price ? original : null,
    url: `https://www.amazon.com.br/dp/${asin}`,
    image: pick(item, 'image', 'thumbnail', 'image_url', 'imageUrl', 'images.0') || null,
    store: 'Amazon'
  };
}
async function saveProducts(rows, category) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('products')
    .upsert(rows.map(r => ({ ...r, category, updated_at: now })));
  if (error) throw new Error('Supabase products: ' + error.message);
  const { error: e2 } = await supabase.from('prices')
    .upsert(rows.map(r => ({ product_id: r.id, price: r.price })),
      { onConflict: 'product_id,day', ignoreDuplicates: true });
  if (e2) throw new Error('Supabase prices: ' + e2.message);
}

app.post('/api/refresh', async (req, res) => {
  if (!process.env.REFRESH_KEY || req.get('x-refresh-key') !== process.env.REFRESH_KEY) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  const day = Math.floor(Date.now() / 86400000);
  const today = [0, 1, 2].map(i => QUERIES[(day * 3 + i) % QUERIES.length]);

  const report = await Promise.all(today.map(async ([category, keyword]) => {
    try {
      const items = await geckoSearch(keyword);
      const mapped = items.map(i => { try { return mapAmazon(i); } catch { return null; } }).filter(Boolean);
      const rows = [...new Map(mapped.map(r => [r.id, r])).values()];
      if (rows.length) await saveProducts(rows, category);
      return { keyword, recebidos: items.length, salvos: rows.length,
               campos: items[0] ? Object.keys(items[0]) : [] };
    } catch (e) {
      return { keyword, erro: e.message };
    }
  }));

  console.log(JSON.stringify(report));
  res.json(report);
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
    query = CATEGORY_KEYS.has(q) ? query.eq('category', q) : query.ilike('title', `%${q}%`);
    const { data, error } = await query.order('updated_at', { ascending: false }).limit(48);
    if (error) throw error;
    res.json({ results: data.map(toFront) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Falha na busca' });
  }
});

app.post('/api/suggest', async (req, res) => {
  const q = cleanQuery(req.body.query);
  if (q.length < 2) return res.json({ suggestions: [] });
  try {
    const { data } = await supabase.from('products').select('title')
      .ilike('title', `%${q}%`).gte('updated_at', sinceDate()).limit(5);
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
