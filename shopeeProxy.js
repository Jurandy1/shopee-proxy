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

// Limite por página. A API da Shopee aceita até 500 por requisição.
const PAGE_LIMIT = 500;
// Trava de segurança pra não entrar em loop infinito (500 * 200 = 100k pedidos)
const MAX_PAGES = 200;

function generateSignature(appId, timestamp, payload, secret) {
  const baseStr = appId + timestamp + payload + secret;
  return crypto.createHash('sha256').update(baseStr).digest('hex');
}

async function shopeeFetch(query, appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);

  // Injetamos as variáveis direto na query, então só mandamos { query }
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

// Monta a query de uma página específica.
// Mantemos os timestamps E o page injetados DIRETAMENTE na string
// (sem o mecanismo de $variables do GraphQL) pra continuar fugindo do
// erro "wrong type" da API da Shopee.
function buildConversionQuery(startTs, endTs, page) {
  return `{
    conversionReport(
      limit: ${PAGE_LIMIT},
      page: ${page},
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
        subId1
        itemReportList {
          itemName
          itemPrice
          qty
          commission
          commissionRate
          atributionType
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }`;
}

// Endpoint: Conversões (com PAGINAÇÃO)
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) {
      return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });
    }

    const startTs = parseInt(Math.floor(new Date(startDate).getTime() / 1000), 10);
    const endTs   = parseInt(Math.floor(new Date(endDate).getTime() / 1000), 10);

    console.log(`[Proxy] Buscando conversões: ${startDate} (${startTs}) → ${endDate} (${endTs})`);

    const allNodes = [];
    let page = 1;
    let hasNextPage = true;

    // LOOP de paginação: continua puxando até a API dizer que não há mais páginas
    while (hasNextPage && page <= MAX_PAGES) {
      const query = buildConversionQuery(startTs, endTs, page);
      const data = await shopeeFetch(query, appId, secret);

      const report = data?.conversionReport || {};
      const nodes = report.nodes || [];
      allNodes.push(...nodes);

      hasNextPage = report.pageInfo?.hasNextPage === true;
      console.log(`[Proxy] Página ${page}: ${nodes.length} pedidos (acumulado: ${allNodes.length}) | próxima? ${hasNextPage}`);
      page++;
    }

    if (page > MAX_PAGES && hasNextPage) {
      console.warn('[Proxy] Atingiu MAX_PAGES — pode haver dados não buscados.');
    }

    // Transforma para o formato que o front espera.
    // Se a API trouxer itemReportList real, usamos ele; senão caímos no fallback.
    const transformed = allNodes.map(node => {
      const items = (node.itemReportList && node.itemReportList.length > 0)
        ? node.itemReportList.map(it => ({
            itemName:       it.itemName || 'Venda Shopee',
            itemPrice:      parseFloat(it.itemPrice || 0),
            qty:            parseInt(it.qty, 10) || 1,
            commission:     parseFloat(it.commission || 0),
            commissionRate: it.commissionRate || '',
            atributionType: it.atributionType || '',
          }))
        : [{
            itemName:       'Venda Shopee',
            itemPrice:      parseFloat(node.totalCommission || 0) * 10,
            qty:            1,
            commission:     parseFloat(node.totalCommission || node.sellerCommission || 0),
            atributionType: '',
          }];

      return {
        purchaseTime:     node.purchaseTime,
        clickTime:        node.clickTime,
        conversionId:     node.conversionId,
        orderId:          node.conversionId,
        orderStatus:      node.conversionStatus || '',
        totalCommission:  parseFloat(node.totalCommission  || 0),
        sellerCommission: parseFloat(node.sellerCommission || 0),
        subId1:           node.subId1 || null,
        itemReportList:   items,
      };
    });

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
