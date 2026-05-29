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

async function shopeeFetch(query, appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  
  // Como estamos injetando as variáveis direto na query, não precisamos enviar o objeto "variables"
  const payload = JSON.stringify({ query });
  
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

// Endpoint: Conversões (Livre do "wrong type")
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    // Garantimos que o timestamp gerado seja estritamente um número inteiro base 10
    const startTs = parseInt(Math.floor(new Date(startDate).getTime() / 1000), 10);
    const endTs   = parseInt(Math.floor(new Date(endDate).getTime() / 1000), 10);

    console.log(`[Proxy] Buscando conversões: ${startDate} (${startTs}) → ${endDate} (${endTs})`);

    // A mágica: Colocamos os números DIRETAMENTE na string da query GraphQL,
    // sem usar o mecanismo de variáveis do GraphQL (ex: $purchaseTimeStart),
    // o que evita totalmente o erro "wrong type" da API da Shopee.
    const query = `{
      conversionReport(
        limit: 100,
        purchaseTimeStart: ${startTs},
        purchaseTimeEnd: ${endTs}
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
    }`;

    // Chamamos a Shopee mandando apenas a Query crua
    const data = await shopeeFetch(query, appId, secret);

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
        itemPrice:      parseFloat(node.totalCommission || 0) * 10,
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
