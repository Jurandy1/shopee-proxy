const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

function generateSignature(appId, timestamp, payload, secret) {
  const baseStr = appId + timestamp + payload + secret;
  return crypto.createHash('sha256').update(baseStr).digest('hex');
}

async function shopeeFetch(query, appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  // Sem variáveis — timestamps inline na query
  const payload = JSON.stringify({ query });
  const signature = generateSignature(appId, timestamp, payload, secret);

  console.log('[Proxy] Chamando API Shopee...');
  console.log('[Proxy] Query:', query.trim().slice(0, 200));

  const response = await fetch(SHOPEE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: payload,
  });

  const text = await response.text();
  console.log('[Proxy] Status:', response.status);
  console.log('[Proxy] Resposta:', text.slice(0, 1000));

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

// Endpoint: Conversões
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate).getTime() / 1000);

    console.log(`[Proxy] Conversões: ${startDate} → ${endDate}`);
    console.log(`[Proxy] Timestamps: ${startTs} → ${endTs}`);

    // Timestamps inline na query (sem variáveis) para evitar problema de tipo Int64
    const query = `{
      conversionReport(
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
        pageInfo {
          page
          hasNextPage
        }
      }
    }`;

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

    console.log(`[Proxy] Total conversões: ${transformed.length}`);
    if (transformed.length > 0) console.log('[Proxy] Exemplo:', JSON.stringify(transformed[0], null, 2));

    res.json({ success: true, data: transformed });
  } catch (error) {
    console.error('[Proxy] Erro conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Cliques — API Shopee BR não suporta clickReport
app.post('/api/shopee/clicks', async (req, res) => {
  console.log('[Proxy] clickReport não disponível na API Shopee BR — retornando vazio');
  res.json({ success: true, data: [] });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Shopee Proxy rodando na porta ${PORT}`);
});
