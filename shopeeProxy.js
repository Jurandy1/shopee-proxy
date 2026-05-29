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

// Limite por página (a API costuma aceitar até 500).
const PAGE_LIMIT = 500;
// Trava de segurança contra loop infinito (500 * 200 = 100k pedidos).
const MAX_PAGES = 200;

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
    throw new Error('Resposta inválida: ' + text.slice(0, 200));
  }

  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }

  return data.data;
}

// Monta a query de UMA página. Continuamos injetando os valores
// direto na string (sem usar $variables) pra fugir do erro "wrong type".
// scrollId é String, então JSON.stringify cuida das aspas/escapes.
function buildConversionQuery(startTs, endTs, scrollId) {
  const scrollClause = scrollId ? `, scrollId: ${JSON.stringify(scrollId)}` : '';
  return `{
    conversionReport(
      limit: ${PAGE_LIMIT},
      purchaseTimeStart: ${startTs},
      purchaseTimeEnd: ${endTs}${scrollClause}
    ) {
      nodes {
        purchaseTime
        clickTime
        conversionId
        checkoutId
        conversionStatus
        totalCommission
        sellerCommission
        netCommission
        estimatedTotalCommission
        grossCommission
        referrer
        utmContent
        device
        buyerType
      }
      pageInfo {
        hasNextPage
        scrollId
      }
    }
  }`;
}

// ---------------------------------------------------------------------------
// Endpoint: Conversões — com PAGINAÇÃO via scrollId
// ---------------------------------------------------------------------------
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
    let scrollId = null;
    let hasNext = true;
    let pageCount = 0;

    while (hasNext && pageCount < MAX_PAGES) {
      pageCount++;
      const query = buildConversionQuery(startTs, endTs, scrollId);
      const data = await shopeeFetch(query, appId, secret);

      const report = data?.conversionReport || {};
      const nodes = report.nodes || [];
      allNodes.push(...nodes);

      const pi = report.pageInfo || {};
      hasNext = pi.hasNextPage === true;
      const nextScroll = pi.scrollId || null;

      console.log(`[Proxy] Página ${pageCount}: +${nodes.length} (acumulado: ${allNodes.length}) | próxima? ${hasNext}`);

      // Se a API diz que tem próxima mas não devolve scrollId, paramos pra
      // não cair em loop infinito puxando sempre a mesma página.
      if (hasNext && !nextScroll) {
        console.warn('[Proxy] hasNextPage=true mas sem scrollId. Parando por segurança.');
        break;
      }
      scrollId = nextScroll;
    }

    if (pageCount >= MAX_PAGES && hasNext) {
      console.warn('[Proxy] Atingiu MAX_PAGES — pode haver dados não buscados.');
    }

    // Transforma pro formato que o shopeeRepository.js já espera.
    // Comissões vêm como String — parseFloat em tudo.
    const transformed = allNodes.map(node => {
      const totalComm  = parseFloat(node.totalCommission   || '0') || 0;
      const sellerComm = parseFloat(node.sellerCommission  || '0') || 0;
      const netComm    = parseFloat(node.netCommission     || '0') || 0;
      const estComm    = parseFloat(node.estimatedTotalCommission || '0') || 0;

      return {
        purchaseTime:     node.purchaseTime,
        clickTime:        node.clickTime,
        conversionId:     String(node.conversionId || ''),
        orderId:          String(node.conversionId || ''),
        checkoutId:       String(node.checkoutId || ''),
        orderStatus:      node.conversionStatus || '',
        totalCommission:  totalComm,
        sellerCommission: sellerComm,
        netCommission:    netComm,
        estimatedCommission: estComm,
        // A API não tem "subId1" nesse nó. O melhor proxy disponível é o
        // utmContent (onde o link de afiliado costuma carregar o sub_id).
        // Se ele vier vazio, caímos no referrer.
        subId1: node.utmContent || node.referrer || null,
        referrer: node.referrer || '',
        device:   node.device   || '',
        buyerType: node.buyerType || '',
        // Não temos detalhe por item via API ainda — mantemos o item sintético
        // pra não quebrar o pipeline atual do shopeeRepository.js.
        itemReportList: [{
          itemName:       'Venda Shopee',
          itemPrice:      totalComm * 10,
          qty:            1,
          commission:     totalComm || sellerComm,
          atributionType: '',
        }],
      };
    });

    console.log(`[Proxy] Total de conversões extraídas: ${transformed.length} em ${pageCount} página(s)`);
    res.json({ success: true, data: transformed, meta: { pages: pageCount, total: transformed.length } });

  } catch (error) {
    console.error('[Proxy] Erro nas conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Endpoint de DEBUG: introspecta o schema.
// Agora também revela ConversionReportOrder (pra eu/você descobrir
// os campos de item-level depois).
// ---------------------------------------------------------------------------
async function runSchema(appId, secret, res) {
  try {
    if (!appId || !secret) {
      return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });
    }

    const query = `{
      Query: __type(name: "Query") {
        fields {
          name
          args { name type { kind name ofType { kind name } } }
          type { kind name ofType { kind name } }
        }
      }
      ConversionReport: __type(name: "ConversionReport") {
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
      ConversionReportOrder: __type(name: "ConversionReportOrder") {
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
      PageInfo: __type(name: "PageInfo") {
        fields { name type { kind name } }
      }
    }`;

    const data = await shopeeFetch(query, appId, secret);
    const convField = (data?.Query?.fields || []).find(f => f.name === 'conversionReport');

    res.json({
      success: true,
      conversionReport_args: convField?.args || null,
      conversionReport_returnType: convField?.type || null,
      ConversionReport_node_fields: data?.ConversionReport?.fields || null,
      ConversionReportOrder_fields: data?.ConversionReportOrder?.fields || null,
      PageInfo_fields: data?.PageInfo?.fields || null,
    });
  } catch (error) {
    console.error('[Proxy] Erro no schema:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

app.post('/api/shopee/schema', (req, res) => {
  const { appId, secret } = req.body || {};
  runSchema(appId, secret, res);
});
app.get('/api/shopee/schema', (req, res) => {
  const { appId, secret } = req.query || {};
  runSchema(appId, secret, res);
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
