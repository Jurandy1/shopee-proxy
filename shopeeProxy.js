const express = require('express');const express = require('express');
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

async function shopeeFetch(query, variables, appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query, variables });
  const signature = generateSignature(appId, timestamp, payload, secret);

  console.log('[Proxy] Chamando API Shopee...');

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

// Endpoint: Conversões (Ajustado conforme o Schema Real da Shopee)
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    // Mantendo como inteiros puros para o mapeamento Int64 do GraphQL
    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate).getTime() / 1000);

    console.log(`[Proxy] Conversões: ${startDate} → ${endDate}`);

    // Removido o argumento "page" e revertido estritamente para Int64
    const query = `
      query ($purchaseTimeStart: Int64, $purchaseTimeEnd: Int64) {
        conversionReport(
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
          pageInfo {
            page
            hasNextPage
          }
        }
      }
    `;

    const data = await shopeeFetch(query, {
      purchaseTimeStart: startTs,
      purchaseTimeEnd: endTs,
    }, appId, secret);

    const nodes = data?.conversionReport?.nodes || [];

    // Mapeamento reconstrói o itemReportList exigido pelo seu front-end da Vercel
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

    console.log(`[Proxy] Total conversões mapeadas: ${transformed.length}`);
    res.json({ success: true, data: transformed });
  } catch (error) {
    console.error('[Proxy] Erro conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Cliques (Ajustado conforme o Schema Real da Shopee)
app.post('/api/shopee/clicks', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate).getTime() / 1000);

    console.log(`[Proxy] Cliques: ${startDate} → ${endDate}`);

    // Revertido estritamente para Int64 e sem o argumento page
    const query = `
      query ($clickTimeStart: Int64, $clickTimeEnd: Int64) {
        clickReport(
          clickTimeStart: $clickTimeStart,
          clickTimeEnd: $clickTimeEnd
        ) {
          nodes {
            clickTime
            subId1
          }
          pageInfo {
            page
            hasNextPage
          }
        }
      }
    `;

    const data = await shopeeFetch(query, {
      clickTimeStart: startTs,
      clickTimeEnd: endTs,
    }, appId, secret);

    const nodes = data?.clickReport?.nodes || [];

    const transformed = nodes.map(node => ({
      clickTime: node.clickTime,
      subId1:    node.subId1 || null,
    }));

    console.log(`[Proxy] Total cliques mapeados: ${transformed.length}`);
    res.json({ success: true, data: transformed });
  } catch (error) {
    console.error('[Proxy] Erro cliques:', error.message);
    res.json({ success: true, data: [], warning: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Shopee Proxy rodando na porta ${PORT}`);
});
