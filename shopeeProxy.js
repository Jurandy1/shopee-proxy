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

const PAGE_LIMIT = 500;
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
// Endpoint: Conversões — paginação por scrollId, item fake com itemPrice=0
// (pra não inflar o GMV no dashboard enquanto não puxamos o item real)
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

      if (hasNext && !nextScroll) {
        console.warn('[Proxy] hasNextPage=true mas sem scrollId. Parando por segurança.');
        break;
      }
      scrollId = nextScroll;
    }

    const transformed = allNodes.map(node => {
      const totalComm  = parseFloat(node.totalCommission  || '0') || 0;
      const sellerComm = parseFloat(node.sellerCommission || '0') || 0;
      const netComm    = parseFloat(node.netCommission    || '0') || 0;
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
        subId1:   node.utmContent || node.referrer || null,
        referrer: node.referrer || '',
        device:   node.device   || '',
        buyerType: node.buyerType || '',
        itemReportList: [{
          itemName:       'Venda Shopee',
          itemPrice:      0,                                  // ← antes era totalComm * 10 (chute). Zerado pra não inflar GMV.
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
// Endpoint de DEBUG: schema completo (última rodada)
// Agora introspecta também ConversionReportOrderItem (preço/nome do item)
// e os ENUMS (pra saber os valores reais de status e atribuição).
// ---------------------------------------------------------------------------
async function runSchema(appId, secret, res) {
  try {
    if (!appId || !secret) {
      return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });
    }

    const query = `{
      ConversionReportOrder: __type(name: "ConversionReportOrder") {
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
      ConversionReportOrderItem: __type(name: "ConversionReportOrderItem") {
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
      }
      ConversionStatus: __type(name: "ConversionStatus") {
        enumValues { name }
      }
      DisplayOrderStatus: __type(name: "DisplayOrderStatus") {
        enumValues { name }
      }
      AttributionType: __type(name: "AttributionType") {
        enumValues { name }
      }
    }`;

    const data = await shopeeFetch(query, appId, secret);

    res.json({
      success: true,
      ConversionReportOrder_fields:     data?.ConversionReportOrder?.fields     || null,
      ConversionReportOrderItem_fields: data?.ConversionReportOrderItem?.fields || null,
      ConversionStatus_values:          data?.ConversionStatus?.enumValues       || null,
      DisplayOrderStatus_values:        data?.DisplayOrderStatus?.enumValues     || null,
      AttributionType_values:           data?.AttributionType?.enumValues        || null,
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

app.post('/api/shopee/clicks', async (req, res) => {
  res.json({ success: true, data: [], message: "Cliques vazios passados por compatibilidade." });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Shopee Proxy rodando liso na porta ${PORT}`);
});
