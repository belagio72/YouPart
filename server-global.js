const express = require('express');
const axios = require('axios');
const cors = require('cors');
const getToken = require('./getToken'); // ✅ Използваме динамичен токен

const app = express();
const PORT = 3001;

app.use(cors());

app.get('/search-global', async (req, res) => {
  const { part = '', offset = 0 } = req.query;

  try {
    const accessToken = await getToken();

    const response = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        q: part,
        limit: 20,
        offset: offset
      }
    });

    const items = (response.data.itemSummaries || []).map(item => ({
      itemId: item.itemId,
      title: item.title,
      image: item.image?.imageUrl || '',
      priceBGN: (parseFloat(item.price?.value || 0) * 1.95).toFixed(2),
      priceEUR: parseFloat(item.price?.value || 0).toFixed(2),
      ebayLink: item.itemWebUrl || ''
    }));

    res.json({ results: items, total: response.data.total || 0 });
  } catch (err) {
    console.error('❌ Грешка при глобално търсене:', err.message);
    res.status(500).json({ error: 'Global fetch failed' });
  }
});
app.use(express.static(path.join(__dirname)));
app.listen(PORT, () => {
  console.log(`🌍 Глобалният сървър стартиран на http://localhost:${PORT}`);
});

