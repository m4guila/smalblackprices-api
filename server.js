const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('Servidor Online!'));
app.get('/api', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Termo obrigatório' });

  try {
    const reefKey = process.env.REEF_API_KEY; 
    if (!reefKey) throw new Error("A chave REEF_API_KEY não foi configurada.");

    const response = await fetch('https://api.reefapi.com/amazon/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': reefKey },
      body: JSON.stringify({ query: query, marketplace: 'com.br', max_results: 12 })
    });

    if (!response.ok) throw new Error(`ReefAPI status ${response.status}`);

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("ERRO NO SERVIDOR:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor rodando na porta ' + PORT));
