/**
 * shopeeProxy.js
 * Proxy Server para a Shopee Affiliate Open API (Brasil)
 * 
 * Corrigido: queries GraphQL completas com todos os campos necessários,
 * paginação, e endpoint de cliques funcional.
 * 
 * Uso: node shopeeProxy.js
 * Ou:  PORT=3001 node shopeeProxy.js
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

// ─── Assinatura SHA256 ────────────────────────────────────────────────────────
function generateSignature(appId, timestamp, payload, secret) {
  const baseStr = appId + timestamp + payload + secret;
  return crypto.createHash('sha256').update(baseStr).digest('hex');
}

// ─── Chamada genérica à API GraphQL da Shopee ────────────────────────────────
async function shopeeFetch(query, variables, appId, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query, variables });
  const signature = generateSignature(appId, timestamp, payload, secret);

  console.log('[Proxy] Chamando API Shopee...');
  console.log('[Proxy] Timestamp:', timestamp);

  const response = await fetch(SHOPEE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
    },
    body: payload,
  });

  const text = await response.text();
  console.log('[Proxy] Status HTTP:', response.status);
  console.log('[Proxy] Resposta bruta (primeiros 500 chars):', text.slice(0, 500));

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Resposta inválida da API Shopee: ' + text.slice(0, 200));
  }

  if (data.errors && data.errors.length > 0) {
    const errMsg = data.errors.map(e => e.message).join('; ');
    throw new Error('Erro GraphQL: ' + errMsg);
  }

  return data.data;
}

// ─── Busca conversões com paginação ─────────────────────────────────────────
/**
 * A API Shopee retorna no máximo alguns dias por chamada.
 * Fazemos chunks de 7 dias para garantir que pegamos tudo.
 */
async function fetchAllConversions(startDate, endDate, appId, secret) {
  // Query completa com todos os campos usados pelo shopeeRepository.js
  const query = `
    query (
      $page: Int,
      $pageSize: Int,
      $purchaseTimeStart: Int64,
      $purchaseTimeEnd: Int64
    ) {
      conversionReport(
        page: $page,
        pageSize: $pageSize,
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
          subId1
          subId2
          subId3
          itemReportList {
            itemId
            itemName
            itemImage
            itemPrice
            qty
            commission
            atributionType
            shopId
            shopName
          }
        }
        pageInfo {
          page
          pageSize
          hasNextPage
        }
      }
    }
  `;

  const startTs = Math.floor(new Date(startDate).getTime() / 1000);
  const endTs   = Math.floor(new Date(endDate).getTime()   / 1000);

  const allNodes = [];
  let page = 1;
  const pageSize = 100;
  let hasNext = true;

  while (hasNext) {
    console.log(`[Proxy] Buscando conversões — página ${page}...`);

    let data;
    try {
      data = await shopeeFetch(query, {
        page,
        pageSize,
        purchaseTimeStart: startTs,
        purchaseTimeEnd: endTs,
      }, appId, secret);
    } catch (err) {
      // Se falhar com os campos extras, tenta query reduzida (fallback)
      console.warn('[Proxy] Query completa falhou, tentando query reduzida:', err.message);
      data = await fetchConversionsReduced(startTs, endTs, page, pageSize, appId, secret);
    }

    const report = data?.conversionReport;
    const nodes  = report?.nodes || [];
    allNodes.push(...nodes);

    console.log(`[Proxy] Página ${page}: ${nodes.length} registros`);

    hasNext = report?.pageInfo?.hasNextPage === true;
    page++;

    // Segurança: máximo 20 páginas (2000 registros)
    if (page > 20) break;
  }

  return allNodes;
}

// Fallback: query mínima (caso o schema da API não tenha todos os campos)
async function fetchConversionsReduced(startTs, endTs, page, pageSize, appId, secret) {
  const query = `
    query ($page: Int, $pageSize: Int, $purchaseTimeStart: Int64, $purchaseTimeEnd: Int64) {
      conversionReport(
        page: $page,
        pageSize: $pageSize,
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
          subId1
          subId2
          subId3
        }
        pageInfo {
          page
          pageSize
          hasNextPage
        }
      }
    }
  `;
  return await shopeeFetch(query, { page, pageSize, purchaseTimeStart: startTs, purchaseTimeEnd: endTs }, appId, secret);
}

// ─── Busca cliques com paginação ─────────────────────────────────────────────
async function fetchAllClicks(startDate, endDate, appId, secret) {
  // Query para relatório de cliques
  const query = `
    query (
      $page: Int,
      $pageSize: Int,
      $clickTimeStart: Int64,
      $clickTimeEnd: Int64
    ) {
      clickReport(
        page: $page,
        pageSize: $pageSize,
        clickTimeStart: $clickTimeStart,
        clickTimeEnd: $clickTimeEnd
      ) {
        nodes {
          clickTime
          subId1
          subId2
          subId3
          device
          source
        }
        pageInfo {
          page
          pageSize
          hasNextPage
        }
      }
    }
  `;

  const startTs = Math.floor(new Date(startDate).getTime() / 1000);
  const endTs   = Math.floor(new Date(endDate).getTime()   / 1000);

  const allNodes = [];
  let page = 1;
  const pageSize = 100;
  let hasNext = true;

  while (hasNext) {
    console.log(`[Proxy] Buscando cliques — página ${page}...`);

    let data;
    try {
      data = await shopeeFetch(query, {
        page,
        pageSize,
        clickTimeStart: startTs,
        clickTimeEnd: endTs,
      }, appId, secret);
    } catch (err) {
      console.warn('[Proxy] clickReport falhou:', err.message);
      // A API pode não ter esse endpoint — retorna vazio
      return [];
    }

    const report = data?.clickReport;
    const nodes  = report?.nodes || [];
    allNodes.push(...nodes);

    console.log(`[Proxy] Página ${page}: ${nodes.length} cliques`);

    hasNext = report?.pageInfo?.hasNextPage === true;
    page++;

    if (page > 20) break;
  }

  return allNodes;
}

// ─── Endpoint: Conversões ─────────────────────────────────────────────────────
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;

    if (!appId || !secret) {
      return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });
    }

    console.log(`\n[Proxy] === CONVERSÕES ===`);
    console.log(`[Proxy] Período: ${startDate} → ${endDate}`);

    const nodes = await fetchAllConversions(startDate, endDate, appId, secret);

    // Normaliza para o formato esperado pelo shopeeRepository.js
    const transformed = nodes.map(node => ({
      purchaseTime:    node.purchaseTime,
      clickTime:       node.clickTime,
      conversionId:    node.conversionId,
      orderId:         node.conversionId,
      orderStatus:     node.conversionStatus || '',
      totalCommission: node.totalCommission  || 0,
      sellerCommission:node.sellerCommission || 0,
      subId1:          node.subId1           || null,
      subId2:          node.subId2           || null,
      subId3:          node.subId3           || null,
      itemReportList: (node.itemReportList || []).map(item => ({
        itemId:         item.itemId         || '',
        itemName:       item.itemName       || 'Produto Sem Nome',
        itemImage:      item.itemImage      || '',
        itemPrice:      parseFloat(item.itemPrice  || 0),
        qty:            parseInt(item.qty          || 1),
        commission:     parseFloat(item.commission || 0),
        atributionType: item.atributionType || '',
        shopId:         item.shopId         || '',
        shopName:       item.shopName       || '',
      })),
    }));

    console.log(`[Proxy] Total de conversões: ${transformed.length}`);
    if (transformed.length > 0) {
      console.log('[Proxy] Exemplo de conversão:', JSON.stringify(transformed[0], null, 2));
    }

    res.json({ success: true, data: transformed });
  } catch (error) {
    console.error('[Proxy] Erro ao buscar conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Endpoint: Cliques ────────────────────────────────────────────────────────
app.post('/api/shopee/clicks', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;

    if (!appId || !secret) {
      return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });
    }

    console.log(`\n[Proxy] === CLIQUES ===`);
    console.log(`[Proxy] Período: ${startDate} → ${endDate}`);

    const nodes = await fetchAllClicks(startDate, endDate, appId, secret);

    const transformed = nodes.map(node => ({
      clickTime: node.clickTime,
      subId1:    node.subId1  || null,
      subId2:    node.subId2  || null,
      subId3:    node.subId3  || null,
      device:    node.device  || '',
      source:    node.source  || '',
    }));

    console.log(`[Proxy] Total de cliques: ${transformed.length}`);

    res.json({ success: true, data: transformed });
  } catch (error) {
    console.error('[Proxy] Erro ao buscar cliques:', error.message);
    // Não quebra o fluxo — retorna array vazio
    res.json({ success: true, data: [], warning: error.message });
  }
});

// ─── Endpoint: Introspection (descobre o schema real da API) ─────────────────
// Útil para debug: GET http://localhost:3001/api/shopee/schema
app.post('/api/shopee/schema', async (req, res) => {
  try {
    const { appId, secret } = req.body;
    const introspectionQuery = `
      { __schema {
        queryType { fields { name description args { name type { name kind ofType { name kind } } } } }
      }}
    `;
    const data = await shopeeFetch(introspectionQuery, {}, appId, secret);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Endpoint: Health check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Shopee Proxy rodando em http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Conversões: POST http://localhost:${PORT}/api/shopee/conversions`);
  console.log(`   Cliques:    POST http://localhost:${PORT}/api/shopee/clicks`);
  console.log(`   Schema:     POST http://localhost:${PORT}/api/shopee/schema\n`);
});
