const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

// Permite apenas o seu site (troque pelo domínio real se for usar domínio próprio)
app.use(cors()); 
app.use(express.json());

// 🛡️ PROTEÇÃO: Limita a 40 requisições por minuto por IP
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 40, 
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' }
});
app.use('/api/', limiter);

const REEF_API_KEY = process.env.REEF_API_KEY;

// ==========================================
// 🧠 HELPERS E CACHE INTELIGENTE
// ==========================================
const cache = new Map();
const pendingCache = new Map(); // Para evitar picos de requisições simultâneas
const alertsDB = []; // Banco de dados temporário (memória)

function getCache(key) {
  const c = cache.get(key);
  if (c && Date.now() < c.expiry) return c.data;
  cache.delete(key);
  return null;
}

function setCache(key, data, ms) {
  if (cache.size > 5000) cache.delete(cache.keys().next().value); // Evita vazar memória
  cache.set(key, { data, expiry: Date.now() + ms });
}

// Converte preços no formato "1.299,00" para 1299.00
function parsePrice(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const cleanStr = String(val).replace(/\./g, '').replace(',', '.');
  return parseFloat(cleanStr) || 0;
}

// Mapeia o produto da Amazon para o formato do site
function mapAmazonItem(item) {
  if (!item.price) return null;
  const price = parsePrice(item.price);
  if (price <= 0) return null;
  
  const originalPrice = parsePrice(item.original_price || item.old_price || item.list_price) || null;
  
  return {
    id: item.asin,
    title: item.title,
    price: price,
    originalPrice: originalPrice,
    url: item.url || `https://www.amazon.com.br/dp/${item.asin}`,
    image: item.image,
    store: 'Amazon',
    storeLogo: '🅰️',
    rating: item.rating || null
  };
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

// ==========================================
// ROTAS
// ==========================================

app.post('/api/suggest', async (req, res) => {
  const { query } = req.body;
  // 🛡️ PROTEÇÃO: Valida se é string para não derrubar o servidor
  if (typeof query !== 'string' || !query.trim() || query.length > 100) {
    return res.status(400).json({ error: 'Termo inválido' });
  }

  const cacheKey = `sug:${query.toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    // 💰 ECONOMIA: Busca apenas na Amazon (1 chamada em vez de 2)
    const amazonData = await reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 3 }).catch(() => null);
    
    let titles = [];
    if (amazonData?.data?.results) {
      titles.push(...amazonData.data.results.map(i => i.title));
    }
    
    const uniqueTitles = [...new Set(titles)].filter(Boolean).slice(0, 5);
    const responseData = { suggestions: uniqueTitles };
    
    if (uniqueTitles.length > 0) setCache(cacheKey, responseData, 1000 * 60 * 60); // 1 hora
    res.json(responseData);
  } catch (error) {
    res.json({ suggestions: [] });
  }
});

app.post('/api/trending', async (req, res) => {
  const cacheKey = 'trending_v2';
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  // 🛡️ PROTEÇÃO DE PICO: Se já tem alguém buscando, espera a mesma promessa
  if (pendingCache.has(cacheKey)) {
    try {
      const result = await pendingCache.get(cacheKey);
      return res.json(result);
    } catch (e) {
      return res.status(502).json({ error: 'Falha ao carregar' });
    }
  }

  const fetchPromise = (async () => {
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
    if (uniqueResults.length === 0) throw new Error("Nenhum produto encontrado nas APIs.");

    return { results: uniqueResults.sort(() => Math.random() - 0.5) };
  })();

  pendingCache.set(cacheKey, fetchPromise);

  try {
    const responseData = await fetchPromise;
    setCache(cacheKey, responseData, 1000 * 60 * 10); // 10 mins
    pendingCache.delete(cacheKey);
    res.json(responseData);
  } catch (error) {
    pendingCache.delete(cacheKey);
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (typeof query !== 'string' || !query.trim() || query.length > 100) {
    return res.status(400).json({ error: 'Termo inválido' });
  }

  const cacheKey = `search:${query.toLowerCase()}`;
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
      const meliItems = meliResult.value.results || meliResult.value.data?.results || meliResult.value.data?.items || [];
      meliItems.forEach(item => {
        const priceNum = parsePrice(item.price);
        if (priceNum > 0) {
          results.push({ 
            id: item.id, 
            title: item.title, 
            price: priceNum, 
            originalPrice: parsePrice(item.original_price || item.old_price) || null,
            url: item.permalink || item.url || `https://produto.mercadolivre.com.br/${item.id}`, 
            image: item.thumbnail || item.image || null, 
            store: 'Mercado Livre', 
            storeLogo: '🟡', 
            rating: item.rating || null 
          });
        }
      });
    }

    if (results.length === 0) throw new Error("Nenhum produto encontrado.");

    const responseData = { results };
    setCache(cacheKey, responseData, 1000 * 60 * 10); // 10 mins
    res.json(responseData);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/history', async (req, res) => {
  const { product_id, period = '12m' } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id obrigatório' });

  const cacheKey = `hist:${product_id}:${period}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await reefRequest('zoom-buscape', 'price_history', { product_id, period });
    setCache(cacheKey, data, 1000 * 60 * 60); // 1 hora de cache
    res.json(data);
  } catch (error) { 
    // Não salva erro no cache
    res.status(500).json({ error: error.message }); 
  }
});

app.post('/api/alert', (req, res) => {
  const { product_id, target_price, contact } = req.body;
  if(!product_id || !target_price || !contact) return res.status(400).json({error: 'Dados inválidos'});
  
  // Salva na memória (Para produção, troque por um banco de dados real)
  alertsDB.push({ product_id, target_price, contact, date: new Date() });
  
  console.log(`[ALERTA] Alerta cadastrado. Total: ${alertsDB.length}`);
  res.json({ success: true, message: 'Alerta salvo!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
