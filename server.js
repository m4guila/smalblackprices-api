const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: 'https://smalblackprices.netlify.app' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 60, message: { error: 'Muitas requisições.' } });
app.use('/api/', limiter);

const REEF_API_KEY = process.env.REEF_API_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const cache = new Map();
const pendingCache = new Map();

function getCache(key) {
  const c = cache.get(key);
  if (c && Date.now() < c.expiry) return c.data;
  cache.delete(key);
  return null;
}

function setCache(key, data, ms) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiry: Date.now() + ms });
}

function parsePrice(val) {
  if (typeof val === 'number') return val;
  const s = String(val || '').replace(/[^\d.,]/g, '');
  return parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) || 0;
}

async function savePrices(results) {
  if (!supabase || !results || results.length === 0) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const upserts = results.map(p => ({ product_id: p.id, day: today, price: p.price }));
    
    const { error } = await supabase.from('prices').upsert(upserts, { onConflict: 'product_id,day', ignoreDuplicates: true });
    if (error) console.error("❌ ERRO SUPABASE:", error.message);
    else console.log(`✅ ${upserts.length} preços salvos no Supabase!`);
  } catch (e) { console.error("❌ ERRO FATAL SUPABASE:", e.message); }
}

async function reefRequest(engine, action, body) {
  const url = `https://api.reefapi.com/${engine}/v1/${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': REEF_API_KEY },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`ReefAPI falhou: ${response.status}`);
  return response.json();
}

function mapAmazonItem(item) {
  if (!item.price) return null;
  const price = parsePrice(item.price);
  if (price <= 0) return null;
  const originalPrice = parsePrice(item.original_price || item.old_price || item.list_price) || null;
  return {
    id: item.asin, title: item.title, price: price, originalPrice: originalPrice,
    url: item.url || `https://www.amazon.com.br/dp/${item.asin}`,
    image: item.image, store: 'Amazon', storeLogo: '🅰️', rating: item.rating || null
  };
}

// Gera o link de afiliado do Mercado Livre caso a API não envie um comissionado
function mapMeliItem(item) {
  const price = parsePrice(item.price);
  if (price <= 0) return null;
  
  // Tenta pegar o link de afiliado do banco, senão tenta o permalink, senão cria um link meli.la fake (para não perder o clique)
  const finalUrl = item.permalink || item.url || `https://mercadolivre.com/sec/${item.id}`;

  return {
    id: item.id, title: item.title, price: price, originalPrice: parsePrice(item.original_price) || null,
    url: finalUrl, image: item.thumbnail || item.image, store: 'Mercado Livre', storeLogo: '🟡', rating: item.rating || null
  };
}

app.post('/api/suggest', async (req, res) => {
  const { query } = req.body;
  if (typeof query !== 'string' || !query.trim() || query.length > 100) return res.status(400).json({ error: 'Inválido' });
  const cacheKey = `sug:${query.trim().toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [amazonData, meliData] = await Promise.allSettled([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 3 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 3 })
    ]);
    
    let titles = [];
    if (amazonData.status === 'fulfilled' && amazonData.value.data?.results) {
      titles.push(...amazonData.value.data.results.map(i => i.title));
    }
    if (meliData.status === 'fulfilled') {
      const res = meliData.value.results || meliData.value.data?.results || [];
      titles.push(...res.map(i => i.title));
    }
    
    const uniqueTitles = [...new Set(titles)].filter(Boolean).slice(0, 5);
    const responseData = { suggestions: uniqueTitles };
    if (uniqueTitles.length > 0) setCache(cacheKey, responseData, 1000 * 60 * 60);
    res.json(responseData);
  } catch (error) { res.json({ suggestions: [] }); }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (typeof query !== 'string' || !query.trim() || query.length > 100) return res.status(400).json({ error: 'Inválido' });
  const cacheKey = `search:${query.trim().toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [amazonResult, meliResult] = await Promise.allSettled([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 10 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 10 })
    ]);

    const results = [];
    if (amazonResult.status === 'fulfilled' && amazonResult.value.data?.results) {
      amazonResult.value.data.results.forEach(item => {
        const mapped = mapAmazonItem(item);
        if (mapped) results.push(mapped);
      });
    }
    if (meliResult.status === 'fulfilled') {
      const items = meliResult.value.results || meliResult.value.data?.results || meliResult.value.data?.items || [];
      items.forEach(item => {
        const mapped = mapMeliItem(item);
        if (mapped) results.push(mapped);
      });
    }

    if (results.length === 0) throw new Error("Nenhum produto encontrado.");

    await savePrices(results);
    const responseData = { results };
    setCache(cacheKey, responseData, 1000 * 60 * 10);
    res.json(responseData);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/trending', async (req, res) => {
  const cacheKey = 'trending_v4';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const queries = ['smart tv 4k', 'iphone', 'air fryer'];
    const promises = queries.map(q => reefRequest('amazon', 'search', { query: q, marketplace: 'com.br', max_results: 4 }).catch(() => null));
    const responses = await Promise.all(promises);
    
    let allResults = [];
    responses.forEach(data => {
      if (data?.data?.results) {
        data.data.results.forEach(item => {
          const mapped = mapAmazonItem(item);
          if (mapped) allResults.push(mapped);
        });
      }
    });

    const uniqueResults = Array.from(new Map(allResults.map(item => [item.id, item])).values());
    if (uniqueResults.length === 0) throw new Error("Sem resultados");

    await savePrices(uniqueResults);
    const responseData = { results: uniqueResults.sort(() => Math.random() - 0.5) };
    setCache(cacheKey, responseData, 1000 * 60 * 10);
    res.json(responseData);
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/history', async (req, res) => {
  const { product_id } = req.body;
  if (typeof product_id !== 'string') return res.status(400).json({ error: 'id inválido' });
  if (!supabase) return res.status(500).json({ error: 'Banco não configurado' });

  try {
    const { data, error } = await supabase.from('prices').select('day, price').eq('product_id', product_id).order('day');
    if (error) throw error;
    if (!data || data.length < 2) return res.status(404).json({ error: 'Pouco histórico' });
    
    const vals = data.map(r => +r.price).sort((a,b) => a-b);
    res.json({ data: {
      points: data.map(r => ({ date: r.day, price: +r.price })),
      min: vals[0], max: vals[vals.length-1], median: vals[Math.floor(vals.length/2)]
    }});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
