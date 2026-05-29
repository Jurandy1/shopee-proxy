const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Configuração explícita de CORS para aceitar qualquer origem com segurança
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
    throw new Error('Resposta inválida da Shopee: ' + text.slice(0, 200));
  }

  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }

  return data.data;
}

// Endpoint: Conversões (Extração Máxima de Dados)
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate).getTime() / 1000);

    console.log(`[Proxy] Coletando Conversões: ${startDate} → ${endDate}`);

    let allNodes = [];
    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      console.log(`[Proxy] Buscando página de conversões: ${currentPage}...`);
      
      const query = `{
        conversionReport(
          page: ${currentPage},
          limit: 100,
          purchaseTimeStart: ${startTs},
          purchaseTimeEnd: ${endTs}
        ) {
          nodes {
            purchaseTime
            clickTime
            completeTime
            conversionId
            conversionStatus
            totalCommission
            sellerCommission
            shopeeCommission
            extInfo
            currency
            matchingType
            salesVolume
          }
          pageInfo {
            page
            hasNextPage
          }
        }
      }`;

      const data = await shopeeFetch(query, appId, secret);
      const report = data?.conversionReport;
      const nodes = report?.nodes || [];

      allNodes = allNodes.concat(nodes);
      hasNextPage = report?.pageInfo?.hasNextPage || false;
      
      if (hasNextPage) {
        currentPage++;
      }
    }

    const transformed = allNodes.map(node => ({
      purchaseTime:     node.purchaseTime,
      clickTime:        node.clickTime,
      completeTime:     node.completeTime || null,
      conversionId:     node.conversionId,
      orderId:          node.conversionId,
      orderStatus:      node.conversionStatus || '',
      currency:         node.currency || 'BRL',
      matchingType:     node.matchingType || '',
      salesVolume:      parseFloat(node.salesVolume || 0),
      totalCommission:  parseFloat(node.totalCommission  || 0),
      sellerCommission: parseFloat(node.sellerCommission || 0),
      shopeeCommission: parseFloat(node.shopeeCommission || 0),
      subId1:           node.extInfo || null,
      itemReportList: [{
        itemName:       'Venda Shopee',
        itemPrice:      parseFloat(node.salesVolume || 0),
        qty:            1,
        commission:     parseFloat(node.totalCommission || 0),
        atributionType: node.matchingType || '',
      }],
    }));

    console.log(`[Proxy] Sucesso! Enviando ${transformed.length} registros para o front.`);
    res.json({ success: true, data: transformed });

  } catch (error) {
    console.error('[Proxy] Erro nas conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Cliques (Respondendo vazio estruturado para o front-end não falhar)
app.post('/api/shopee/clicks', async (req, res) => {
  console.log('[Proxy] Rota de cliques chamada — respondendo array vazio.');
  res.json({ success: true, data: [] });
});

// Health check corrigido
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Inicialização do servidor corrigida
app.listen(PORT, () => {
  console.log(`🚀 Shopee Proxy ativo e rodando na porta ${PORT}`);
});
