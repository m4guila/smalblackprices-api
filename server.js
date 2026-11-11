const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const REEF_API_KEY = process.env.REEF_API_KEY;

// Função auxiliar para chamar qualquer endpoint da ReefAPI
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

// Rota de busca multi-loja
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Termo obrigatório' });

  try {
    // Executa buscas em paralelo na Amazon, Mercado Livre e Magalu
    const [amazonData, meliData, magaluData] = await Promise.all([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 8 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 8 }),
      reefRequest('magalu', 'search', { query, country: 'br', page_size: 8 })
    ]);

    const results = [];

    // Normaliza Amazon
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

    // Normaliza Mercado Livre
    if (meliData.data && meliData.data.results) {
      meliData.data.results.forEach(item => {
        results.push({
          id: item.id,
          title: item.title,
          price: item.price,
          url: item.permalink,
          image: item.thumbnail,
          store: 'Mercado Livre',
          storeLogo: '🟡'
        });
      });
    }

    // Normaliza Magalu
    if (magaluData.data && magaluData.data.results) {
      magaluData.data.results.forEach(item => {
        results.push({
          id: item.product_id,
          title: item.title,
          price: item.price,
          url: item.url,
          image: item.image,
          store: 'Magazine Luiza',
          storeLogo: '🔵'
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
    // Usa o engine 'zoom-buscape' para histórico de preços
    const data = await reefRequest('zoom-buscape', 'price_history', {
      product_id,
      period
    });
    res.json(data);
  } catch (error) {
    console.error("Erro no histórico:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
