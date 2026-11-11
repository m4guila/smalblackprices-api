const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const REEF_API_KEY = process.env.REEF_API_KEY;

const CACHE_DURATION = 1000 * 60 * 10; 
const SUGGEST_CACHE_DURATION = 1000 * 60 * 60; 
const cache = new Map();

const affiliateLinks = {
  'MLB67136040': 'https://meli.la/2ybEUuM'
};

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

app.post('/api/suggest', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ suggestions: [] });
  const cacheKey = `sug:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) return res.json(cache.get(cacheKey).data);

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
      const results = meliData.value.results || meliData.value.data?.results || [];
      titles.push(...results.map(i => i.title));
    }
    const uniqueTitles = [...new Set(titles)].filter(Boolean).slice(0, 5);
    cache.set(cacheKey, { data: { suggestions: uniqueTitles }, expiry: Date.now() + SUGGEST_CACHE_DURATION });
    res.json({ suggestions: uniqueTitles });
  } catch (error) {
    res.json({ suggestions: [] });
  }
});

app.post('/api/trending', async (req, res) => {
  const cacheKey = 'trending_v1';
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() < cached.expiry) return res.json(cached.data);
  }

  try {
    const queries = ['smart tv 4k', 'iphone', 'air fryer'];
    const promises = queries.map(q => reefRequest('amazon', 'search', { query: q, marketplace: 'com.br', max_results: 4 }).catch(() => null));
    const responses = await Promise.all(promises);
    
    let allResults = [];
    responses.forEach(data => {
      if (data?.data?.results) {
        data.data.results.forEach(item => {
          if (item.price && item.price > 0) {
            allResults.push({
              id: item.asin, title: item.title, price: parseFloat(item.price), 
              url: item.url || `https://www.amazon.com.br/dp/${item.asin}`, 
              image: item.image, store: 'Amazon', storeLogo: '🅰️', rating: item.rating || null
            });
          }
        });
      }
    });

    const uniqueResults = Array.from(new Map(allResults.map(item => [item.id, item])).values());
    const responseData = { results: uniqueResults.sort(() => Math.random() - 0.5) };
    
    cache.set(cacheKey, { data: responseData, expiry: Date.now() + CACHE_DURATION });
    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Termo obrigatório' });

  const cacheKey = `search:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() < cached.expiry) return res.json(cached.data);
  }

  try {
    const [amazonResult, meliResult] = await Promise.allSettled([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 10 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 10 })
    ]);

    const results = [];

    if (amazonResult.status === 'fulfilled' && amazonResult.value.data?.results) {
      amazonResult.value.data.results.forEach(item => {
        if (item.price && item.price > 0) {
          results.push({ 
            id: item.asin, title: item.title, price: parseFloat(item.price), 
            url: item.url || `https://www.amazon.com.br/dp/${item.asin}`, 
            image: item.image, store: 'Amazon', storeLogo: '🅰️', rating: item.rating || null 
          });
        }
      });
    }

    if (meliResult.status === 'fulfilled') {
      const meliItems = meliResult.value.results || meliResult.value.data?.results || meliResult.value.data?.items || [];
      meliItems.forEach(item => {
        const priceNum = parseFloat(item.price);
        if (priceNum && priceNum > 0) {
          results.push({ 
            id: item.id, title: item.title, price: priceNum, 
            url: affiliateLinks[item.id] || item.permalink || item.url || `https://produto.mercadolivre.com.br/${item.id}`, 
            image: item.thumbnail || item.image || null, store: 'Mercado Livre', storeLogo: '🟡', rating: item.rating || null 
          });
        }
      });
    }

    const responseData = { results };
    cache.set(cacheKey, { data: responseData, expiry: Date.now() + CACHE_DURATION });
    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
  // Simulação de validação do servidor
  if(!product_id || !target_price || !email) return res.status(400).json({error: 'Dados inválidos'});
  console.log(`[ALERTA] Produto: ${product_id} | Alvo: R$ ${target_price} | Contato: ${email}`);
  res.json({ success: true, message: 'Alerta salvo!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
