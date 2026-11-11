const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const REEF_API_KEY = process.env.REEF_API_KEY;

// ==========================================
// 📌 CACHE DE RESULTADOS (10 MINUTOS)
// ==========================================
const CACHE_DURATION = 1000 * 60 * 10; 
const cache = new Map();

// 📌 MAPEAMENTO DE LINKS DE AFILIADOS
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

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Termo obrigatório' });

  // Verifica o cache
  const cacheKey = `search:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() < cached.expiry) {
      console.log(`[Cache] Resultado para: ${query}`);
      return res.json(cached.data);
    } else {
      cache.delete(cacheKey);
    }
  }

  try {
    const [amazonData, meliData] = await Promise.all([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 10 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 10 })
    ]);

    const results = [];

    if (amazonData.data && amazonData.data.results) {
      amazonData.data.results.forEach(item => {
        results.push({
          id: item.asin, title: item.title, price: item.price, url: item.url, image: item.image, store: 'Amazon', storeLogo: '🅰️',
          rating: item.rating || null 
        });
      });
    }

    if (meliData.data && meliData.data.results) {
      meliData.data.results.forEach(item => {
        results.push({
          id: item.id, title: item.title, price: item.price, url: affiliateLinks[item.id] || item.permalink, image: item.thumbnail, store: 'Mercado Livre', storeLogo: '🟡',
          rating: item.rating || null
        });
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

app.post('/api/history', async (req, res) => {
  const { product_id, period = '12m' } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id obrigatório' });
  try {
    const data = await reefRequest('zoom-buscape', 'price_history', { product_id, period });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📌 ENDPOINT DE ALERTA DE PREÇO
// ==========================================
app.post('/api/alert', (req, res) => {
  const { product_id, target_price, email } = req.body;
  if (!product_id || !target_price) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }
  // Em produção, você salvaria isso num banco de dados.
  // Por enquanto, exibimos no console do Render.
  console.log(`[ALERTA] Produto: ${product_id} | Alvo: R$ ${target_price} | Contato: ${email || 'Não informado'}`);
  res.json({ success: true, message: 'Alerta salvo! Avisaremos quando o preço cair.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
