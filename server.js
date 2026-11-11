const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const REEF_API_KEY = process.env.REEF_API_KEY;

// 📌 MAPEAMENTO DE LINKS DE AFILIADOS
// Aqui você coloca os IDs dos produtos e os seus links de afiliado correspondentes.
const affiliateLinks = {
  // Mercado Livre (TV TCL 50")
  'XKEYBZ-D83T': 'https://meli.la/2ybEUuM',
  'MLB67136040': 'https://meli.la/2ybEUuM', 
  // Magazine Luiza (TV TCL 50")
  'MAGALU_ID_DA_TV': 'https://magazineluiza.onelink.me/589508454/wo12r91d' 
};

// Função auxiliar para chamar a ReefAPI
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
    // Busca em paralelo na Amazon, Mercado Livre e Magalu
    const [amazonData, meliData, magaluData] = await Promise.all([
      reefRequest('amazon', 'search', { query, marketplace: 'com.br', max_results: 8 }),
      reefRequest('mercadolibre', 'search', { query, site_id: 'MLB', limit: 8 }),
      reefRequest('magalu', 'search', { query, country: 'br', page_size: 8 })
    ]);

    const results = [];

    // 1. Amazon
    if (amazonData.data && amazonData.data.results) {
      amazonData.data.results.forEach(item => {
        results.push({
          id: item.asin,
          title: item.title,
          price: item.price,
          url: item.url, // O frontend vai adicionar a tag da Amazon automaticamente
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
          url: affiliateLinks[item.id] || item.permalink, // Troca para o link de afiliado se existir
          image: item.thumbnail,
          store: 'Mercado Livre',
          storeLogo: '🟡'
        });
      });
    }

    // 3. Magazine Luiza
    if (magaluData.data && magaluData.data.results) {
      magaluData.data.results.forEach(item => {
        results.push({
          id: item.product_id,
          title: item.title,
          price: item.price,
          url: affiliateLinks[item.product_id] || affiliateLinks['MAGALU_ID_DA_TV'] || item.url, // Usa o link da loja como fallback
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
