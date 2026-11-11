const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const REEF_API_KEY = process.env.REEF_API_KEY;

// ==========================================
// 📌 CACHE GLOBAL
// ==========================================
const CACHE_DURATION = 1000 * 60 * 10; // 10 mins para buscas normais
const SUGGEST_CACHE_DURATION = 1000 * 60 * 60; // 1 hora para autocomplete
const cache = new Map();

const affiliateLinks = {
  'MLB67136040': 'https://meli.la/2ybEUuM'
};

async function reefRequest(engine, action, body) {
  const url = `https://api.reefapi.com/${engine}/v1/${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': REEF_API_KEY
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`ReefAPI ${engine}/${action} falhou: ${response.status}`);
  return response.json();
}

// ==========================================
// 📌 ROTA DE AUTOCOMPLETE (RÁPIDA)
// ==========================================
app.post('/api/suggest', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ suggestions: [] });

  const cacheKey = `sug:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) {
    return res.json(cache.get(cacheKey).data);
  }

  try {
    // Busca apenas 3 itens em cada loja para ser ultra rápido
    const [amazonData, meliData] = await Promise.all([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 3 }).catch(() => null),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 3 }).catch(() => null)
    ]);

    let titles = [];
    if (amazonData?.data?.results) titles.push(...amazonData.data.results.map(i => i.title));
    if (meliData?.data?.results) titles.push(...meliData.data.results.map(i => i.title));

    // Remove duplicados e pega os 5 primeiros
    const uniqueTitles = [...new Set(titles)].slice(0, 5);
    const responseData = { suggestions: uniqueTitles };

    // Salva no cache
    cache.set(cacheKey, { data: responseData, expiry: Date.now() + SUGGEST_CACHE_DURATION });
    res.json(responseData);
  } catch (error) {
    res.json({ suggestions: [] });
  }
});

// ==========================================
// 📌 ROTA DE BUSCA NORMAL
// ==========================================
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Termo obrigatório' });

  const cacheKey = `search:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() < cached.expiry) return res.json(cached.data);
    else cache.delete(cacheKey);
  }

  try {
    const [amazonData, meliData] = await Promise.all([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 10 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 10 })
    ]);

    const results = [];
    if (amazonData.data && amazonData.data.results) {
      amazonData.data.results.forEach(item => {
        if (item.price && item.price > 0) {
          results.push({ id: item.asin, title: item.title, price: item.price, url: item.url, image: item.image, store: 'Amazon', storeLogo: '🅰️', rating: item.rating || null });
        }
      });
    }

    if (meliData.data && meliData.data.results) {
      meliData.data.results.forEach(item => {
        if (item.price && item.price > 0) {
          results.push({ id: item.id, title: item.title, price: item.price, url: affiliateLinks[item.id] || item.permalink, image: item.thumbnail, store: 'Mercado Livre', storeLogo: '🟡', rating: item.rating || null });
        }
      });
    }

    const responseData = { results };
    cache.set(cacheKey, { data: responseData, expiry: Date.now() + CACHE_DURATION });
    res.json(responseData);
  } catch (error) {
    console.error("Erro na busca:", error);
    res.status(500).json({ error: error.message });
  }
});

// Rotas de histórico e alerta continuam iguais...
app.post('/api/history', async (req, res) => {
  const { product_id, period = '12m' } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id obrigatório' });
  try {
    const data = await reefRequest('zoom-buscape', 'price_history', { product_id, period });
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/alert', (req, res) => {
  const { product_id, target_price, email } = req.body;
  console.log(`[ALERTA] Produto: ${product_id} | Alvo: R$ ${target_price} | Contato: ${email}`);
  res.json({ success: true, message: 'Alerta salvo!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
