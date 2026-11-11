const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const REEF_API_KEY = process.env.REEF_API_KEY;

// ==========================================================
// 📌 MAPEAMENTO DE LINKS DE AFILIADOS (Apenas Mercado Livre)
// ==========================================================
const affiliateLinks = {
  // Mercado Livre - Ex: TV TCL 50"
  'MLB67136040': 'https://meli.la/2ybEUuM'
};
// ==========================================================

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
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ReefAPI ${engine}/${action} falhou: ${response.status} - ${errorText}`);
  }
  return response.json();
}

// Rota de busca (Apenas Amazon e Mercado Livre)
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Termo obrigatório' });

  try {
    // Busca em paralelo na Amazon e Mercado Livre
    const [amazonData, meliData] = await Promise.all([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 10 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 10 })
    ]);

    const results = [];

    // 1. Amazon
    if (amazonData.data && amazonData.data.results) {
      amazonData.data.results.forEach(item => {
        results.push({ 
          id: item.asin, 
          title: item.title, 
          price: item.price, 
          url: item.url, 
          image: item.image, 
          store: 'Amazon', 
          storeLogo: '🅰️' 
        });
      });
    }

    // 2. Mercado Livre
    if (meliData.data && meliData.data.results) {
      meliData.data.results.forEach(item => {
        results.push({ 
          id: item.id, 
          title: item.title, 
          price: item.price, 
          // Usa o seu link de afiliado se o ID bater, senão usa o link normal
          url: affiliateLinks[item.id] || item.permalink, 
          image: item.thumbnail, 
          store: 'Mercado Livre', 
          storeLogo: '🟡' 
        });
      });
    }

    res.json({ results });
  } catch (error) {
    console.error("Erro na busca:", error);
    res.status(500).json({ error: error.message });
  }
});

// Rota de histórico de preços
app.post('/api/history', async (req, res) => {
  const { product_id, period = '12m' } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id obrigatório' });

  try {
    const data = await reefRequest('zoom-buscape', 'price_history', { product_id, period });
    res.json(data);
  } catch (error) {
    console.error("Erro no histórico:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
