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

// Endpoint: Conversões (Extração Máxima de Dados)
app.post('/api/shopee/conversions', async (req, res) => {
  try {
    const { startDate, endDate, appId, secret } = req.body;
    if (!appId || !secret) return res.status(400).json({ success: false, error: 'appId e secret são obrigatórios' });

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate).getTime() / 1000);

    console.log(`[Proxy] Buscando volume máximo de dados: ${startDate} → ${endDate}`);

    let allNodes = [];
    let currentPage = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      console.log(`[Proxy] Coletando página ${currentPage}...`);
      
      // Query com todos os campos existentes no relatório de conversão de afiliados Shopee
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

    // Mapeamento completo injetando os dados reais obtidos da API
    const transformed = allNodes.map(node => ({
      purchaseTime:     node.purchaseTime,                        // Timestamp da compra
      clickTime:        node.clickTime,                           // Timestamp do clique no link
      completeTime:     node.completeTime || null,                // Timestamp de conclusão da ordem
      conversionId:     node.conversionId,                        // ID único da conversão
      orderId:          node.conversionId,                        // Espelhado para compatibilidade do front
      orderStatus:      node.conversionStatus || '',              // Status (Pendente, Pago, Cancelado, etc.)
      currency:         node.currency || 'BRL',                   // Moeda da transação
      matchingType:     node.matchingType || '',                  // Tipo de atribuição (ex: Direta/Indireta)
      salesVolume:      parseFloat(node.salesVolume || 0),        // Valor total que o cliente gastou na compra
      totalCommission:  parseFloat(node.totalCommission  || 0),  // Comissão total gerada
      sellerCommission: parseFloat(node.sellerCommission || 0),  // Comissão paga pelo vendedor
      shopeeCommission: parseFloat(node.shopeeCommission || 0),  // Comissão paga pela Shopee
      subId1:           node.extInfo || null,                     // Parâmetro personalizado de rastreamento (subId)
      
      // Reconstruindo a lista de itens com os dados financeiros máximos possíveis
      itemReportList: [{
        itemName:       'Venda Shopee',
        itemPrice:      parseFloat(node.salesVolume || 0),        // Preço real mapeado do volume de vendas
        qty:            1,
        commission:     parseFloat(node.totalCommission || 0),    // Comissão integral do nó
        atributionType: node.matchingType || '',
      }],
    }));

    console.log(`[Proxy] Sucesso! ${transformed.length} registros ricos exportados.`);
    res.json({ success: true, data: transformed });

  } catch (error) {
    console.error('[Proxy] Erro na mineração de conversões:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Cliques
app.post('/api/shopee/clicks', async (req, res) => {
  res.json({ success: true, data: [], message: "Use o endpoint de conversões para pegar dados de cliques cruzados via clickTime" });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
