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
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('Resposta inválida: ' + text.slice(0, 200)); }

  if (data.errors && data.errors.length > 0) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }
  return data.data;
}

// Query completa: desce até items pra pegar nome/preço/qtd/comissão reais.
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
        referrer
        utmContent
        device
        buyerType
        orders {
          orderId
          orderStatus
          shopType
          items {
            itemId
            itemName
            itemPrice
            actualAmount
            refundAmount
            qty
            itemCommission
            itemTotalCommission
            itemSellerCommission
            itemShopeeCommissionRate
            shopId
            shopName
            categoryLv1Name
            categoryLv2Name
            categoryLv3Name
            attributionType
            channelType
            displayItemStatus
            imageUrl
          }
        }
      }
      pageInfo {
        hasNextPage
        scrollId
      }
    }
  }`;
}

// Traduz o enum AttributionType pro vocabulário PT-BR que o shopeeRepository
// detecta (includes("mesma") => direta).
function translateAttribution(attr) {
  if (attr === 'ORDERED_IN_SAME_SHOP') return 'Pedido em loja mesma';
  if (attr === 'ORDERED_IN_DIFFERENT_SHOP') return 'Pedido em loja diferente';
  return attr || '';
}

// ---------------------------------------------------------------------------
// Endpoint: Conversões — com itens reais, GMV real, atribuição traduzida.
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

    // FLATTEN: emite uma entrada "order-like" por ORDER (não por conversion).
    // Uma conversion pode ter várias orders (lojas diferentes); cada order
    // tem N items. O shopeeRepository.js itera "conversions" e dentro de cada
    // um espera um itemReportList — então cada order vira uma "conversion"
    // do ponto de vista do repo.
    const transformed = [];
    let totalItems = 0;

    for (const node of allNodes) {
      const orders = node.orders || [];
      const baseSubId = node.utmContent || node.referrer || null;

      if (orders.length === 0) {
        // Salvaguarda: conversão sem orders. Não deve acontecer mas, se acontecer,
        // mando uma entrada vazia pro repo não quebrar.
        transformed.push({
          purchaseTime:     node.purchaseTime,
          clickTime:        node.clickTime,
          conversionId:     String(node.conversionId || ''),
          orderId:          String(node.conversionId || ''),
          orderStatus:      node.conversionStatus || '',
          totalCommission:  parseFloat(node.totalCommission || '0') || 0,
          sellerCommission: parseFloat(node.sellerCommission || '0') || 0,
          netCommission:    parseFloat(node.netCommission || '0') || 0,
          subId1:           baseSubId,
          referrer:         node.referrer || '',
          device:           node.device || '',
          buyerType:        node.buyerType || '',
          itemReportList:   [],
        });
        continue;
      }

      for (const ord of orders) {
        const items = ord.items || [];

        const itemReportList = items.map(it => {
          const price   = parseFloat(it.itemPrice    || '0') || 0;
          const actual  = parseFloat(it.actualAmount || '0') || 0;
          const refund  = parseFloat(it.refundAmount || '0') || 0;
          const qty     = parseInt(it.qty, 10) || 1;
          const comm    = parseFloat(it.itemCommission || it.itemTotalCommission || '0') || 0;

          // GMV real: valor pago menos reembolso. Se actualAmount não vier,
          // cai pro preço * qtd.
          const faturamento = (actual > 0 ? actual : price * qty) - refund;

          return {
            itemName:       it.itemName || 'Produto Sem Nome',
            itemPrice:      faturamento,                          // ← lido como gmv_total pelo repo
            unitPrice:      price,                                // (informativo)
            qty:            qty,
            commission:     comm,
            commissionRate: it.itemShopeeCommissionRate || '',
            atributionType: translateAttribution(it.attributionType),
            itemId:         String(it.itemId || ''),
            shopId:         String(it.shopId || ''),
            shopName:       it.shopName || '',
            categoria:      [it.categoryLv1Name, it.categoryLv2Name, it.categoryLv3Name].filter(Boolean).join(' > '),
            imageUrl:       it.imageUrl || '',
            channelType:    it.channelType || '',
            displayItemStatus: it.displayItemStatus || '',
            refundAmount:   refund,
          };
        });

        totalItems += itemReportList.length;

        transformed.push({
          purchaseTime:     node.purchaseTime,
          clickTime:        node.clickTime,
          conversionId:     String(node.conversionId || ''),
          // orderStatus DA ORDEM (DisplayOrderStatus) — repo lowercaseia e checa
          // includes("cancel") / includes("completed") etc. Os enums COMPLETED,
          // PENDING, CANCELLED, UNPAID já batem direto.
          orderId:          String(ord.orderId || node.conversionId || ''),
          orderStatus:      ord.orderStatus || node.conversionStatus || '',
          shopType:         ord.shopType || '',
          totalCommission:  parseFloat(node.totalCommission  || '0') || 0,
          sellerCommission: parseFloat(node.sellerCommission || '0') || 0,
          netCommission:    parseFloat(node.netCommission    || '0') || 0,
          subId1:           baseSubId,
          referrer:         node.referrer || '',
          device:           node.device || '',
          buyerType:        node.buyerType || '',
          itemReportList:   itemReportList,
        });
      }
    }

    console.log(`[Proxy] ${allNodes.length} conversões → ${transformed.length} orders → ${totalItems} items em ${pageCount} página(s)`);
    res.json({
      success: true,
      data: transformed,
      meta: { pages: pageCount, conversions: allNodes.length, orders: transformed.length, items: totalItems }
    });

  } catch (error) {
    console.error('[Proxy] Erro nas conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Endpoint de DEBUG (mantido pra eventual nova introspecção).
// Considere remover em produção.
// ---------------------------------------------------------------------------
async function runSchema(appId, secret, res) {
  try {
    if (!appId || !secret) {
      return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });
    }
    const query = `{
      ConversionReportOrderItem: __type(name: "ConversionReportOrderItem") {
        fields { name type { kind name ofType { kind name } } }
      }
      ConversionStatus: __type(name: "ConversionStatus") { enumValues { name } }
      DisplayOrderStatus: __type(name: "DisplayOrderStatus") { enumValues { name } }
      AttributionType: __type(name: "AttributionType") { enumValues { name } }
    }`;
    const data = await shopeeFetch(query, appId, secret);
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
app.post('/api/shopee/schema', (req, res) => runSchema(req.body?.appId, req.body?.secret, res));
app.get('/api/shopee/schema', (req, res) => runSchema(req.query?.appId, req.query?.secret, res));

app.post('/api/shopee/clicks', async (req, res) => {
  res.json({ success: true, data: [], message: "Cliques vazios passados por compatibilidade." });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Shopee Proxy rodando liso na porta ${PORT}`);
});
