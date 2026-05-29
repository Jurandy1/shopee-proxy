const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

function generateSignature(appId, timestamp, payload, secret) {
  const baseStr = appId + timestamp + payload + secret;
  return crypto.createHash('sha256').update(baseStr).digest('hex');
}

async function shopeeFetch(query, variables, appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query, variables });
  const signature = generateSignature(appId, timestamp, payload, secret);

  const response = await fetch(SHOPEE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: payload,
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Resposta inválida: ' + text.slice(0, 200));
  }

  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }

  return data.data;
}

// Endpoint: Conversões (Versão Simplificada que Funciona na Shopee BR)
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate).getTime() / 1000);

    console.log(`[Proxy] Buscando conversões: ${startDate} → ${endDate}`);

    // Query purista, apenas com os campos aprovados para o BR, usando o limit para tentar trazer 100 registros de uma vez.
    const query = `
      query ($purchaseTimeStart: Int64, $purchaseTimeEnd: Int64) {
        conversionReport(
          limit: 100,
          purchaseTimeStart: $purchaseTimeStart,
          purchaseTimeEnd: $purchaseTimeEnd
        ) {
          nodes {
            purchaseTime
            clickTime
            conversionId
            conversionStatus
            totalCommission
            sellerCommission
          }
        }
      }
    `;

    const data = await shopeeFetch(query, {
      purchaseTimeStart: startTs,
      purchaseTimeEnd: endTs,
    }, appId, secret);

    const nodes = data?.conversionReport?.nodes || [];

    const transformed = nodes.map(node => ({
      purchaseTime:     node.purchaseTime,
      clickTime:        node.clickTime,
      conversionId:     node.conversionId,
      orderId:          node.conversionId,
      orderStatus:      node.conversionStatus || '',
      totalCommission:  parseFloat(node.totalCommission  || 0),
      sellerCommission: parseFloat(node.sellerCommission || 0),
      subId1:           null,
      itemReportList: [{
        itemName:       'Venda Shopee',
        itemPrice:      parseFloat(node.totalCommission || 0) * 10, // Preço estimado
        qty:            1,
        commission:     parseFloat(node.totalCommission || node.sellerCommission || 0),
        atributionType: '',
      }],
    }));

    console.log(`[Proxy] Total de conversões extraídas: ${transformed.length}`);
    res.json({ success: true, data: transformed });

  } catch (error) {
    console.error('[Proxy] Erro nas conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Cliques
app.post('/api/shopee/clicks', async (req, res) => {
  res.json({ success: true, data: [], message: "Cliques vazios passados por compatibilidade." });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Shopee Proxy rodando liso na porta ${PORT}`);
});
