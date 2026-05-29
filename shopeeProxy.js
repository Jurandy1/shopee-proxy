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

// A API aceita até 500 por requisição. Subimos de 100 -> 500.
const PAGE_LIMIT = 500;

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

// ---------------------------------------------------------------------------
// Endpoint: Conversões — VERSÃO SEGURA (só campos que a API já aceitou)
// Sem "page", sem "subId1", sem "itemReportList" (a API recusou esses).
// Só subimos o limit pra 500. Volta a funcionar imediatamente.
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

    const query = `{
      conversionReport(
        limit: ${PAGE_LIMIT},
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

// ---------------------------------------------------------------------------
// Endpoint TEMPORÁRIO de DEBUG: descobre o schema real da API.
// Chame com POST (ou GET) passando appId e secret e me mande o JSON de volta.
// Ele revela:
//  - os ARGUMENTOS aceitos pelo conversionReport (achar como paginar: scrollId?)
//  - os CAMPOS do nó ConversionReport (achar o nome real de sub_id / itens)
//  - os campos de PageInfo (hasNextPage, scrollId, endCursor?)
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
      PageInfo: __type(name: "PageInfo") {
        fields { name type { kind name } }
      }
    }`;

    const data = await shopeeFetch(query, appId, secret);

    // Filtra só o conversionReport pra facilitar a leitura
    const convField = (data?.Query?.fields || []).find(f => f.name === 'conversionReport');

    res.json({
      success: true,
      conversionReport_args: convField?.args || 'campo conversionReport não encontrado',
      conversionReport_returnType: convField?.type || null,
      ConversionReport_node_fields: data?.ConversionReport?.fields || 'tipo ConversionReport não encontrado',
      PageInfo_fields: data?.PageInfo?.fields || 'tipo PageInfo não encontrado',
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

// Versão GET pra você poder abrir direto no navegador:
//   https://SEU-PROXY/api/shopee/schema?appId=XXX&secret=YYY
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
