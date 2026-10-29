const assert = require('node:assert/strict');
const http = require('node:http');
const { initializeApp } = require('../functions/node_modules/firebase-admin/app');
const { getFirestore, FieldValue } = require('../functions/node_modules/firebase-admin/firestore');
const { getAuth } = require('../functions/node_modules/firebase-admin/auth');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-vamo-rachar';
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'fake-api-key';

try {
  initializeApp({ projectId: PROJECT_ID });
} catch {
  // App já inicializada pelo carregamento do módulo functions/src/index.js
}

const app = require('../functions/src/server');

// Cliente HTTP que mantém o token apenas em memória (sem logs de credenciais)
function createMemoryApiClient(baseUrl) {
  let bearerToken = null;

  return {
    setToken(token) {
      bearerToken = typeof token === 'string' ? token : null;
    },
    clearToken() {
      bearerToken = null;
    },
    async checkServerHealth() {
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    },
    async checkCorsPreflight(origin) {
      const response = await fetch(`${baseUrl}/api/listMenu`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, Authorization'
        }
      });
      return {
        status: response.status,
        allowOrigin: response.headers.get('access-control-allow-origin')
      };
    },
    async callOperation(operation, payload, options = {}) {
      const headers = { 'Content-Type': 'application/json' };
      const activeToken = options.overrideToken !== undefined ? options.overrideToken : bearerToken;
      if (activeToken) {
        headers.Authorization = `Bearer ${activeToken}`;
      }
      const response = await fetch(`${baseUrl}/api/${operation}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload || {}),
        signal: options.signal
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body };
    }
  };
}

async function fetchIdTokenForUid(auth, uid) {
  const customToken = await auth.createCustomToken(uid);
  const baseAuthUrl = process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`
    : 'https://identitytoolkit.googleapis.com/v1';

  const response = await fetch(
    `${baseAuthUrl}/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );
  if (!response.ok) {
    throw new Error(`Falha ao obter token de teste (status ${response.status}).`);
  }
  const data = await response.json();
  return data.idToken;
}

async function setupIsolatedTestData(db) {
  const restA = db.collection('restaurants').doc('rest-rede-a');
  const restB = db.collection('restaurants').doc('rest-rede-b');

  await Promise.all([
    restA.set({ name: 'Restaurante A', active: true }, { merge: true }),
    restB.set({ name: 'Restaurante B', active: true }, { merge: true }),
    restA.collection('staff').doc('staff-waiter-a').set({
      active: true,
      roles: ['waiter'],
      updatedAt: FieldValue.serverTimestamp()
    }),
    restA.collection('staff').doc('staff-kitchen-a').set({
      active: true,
      roles: ['kitchen'],
      updatedAt: FieldValue.serverTimestamp()
    }),
    restA.collection('tables').doc('mesa-rede-01').set({
      activeSessionId: null
    }),
    restA.collection('tables').doc('mesa-rede-02').set({
      activeSessionId: null
    }),
    restA.collection('menuItems').doc('item-rede-1').set({
      name: 'Porção Teste',
      description: 'Item de verificação de rede',
      priceCents: 2500,
      sector: 'kitchen',
      available: true
    })
  ]);
}

async function runNetworkTests() {
  const db = getFirestore();
  const auth = getAuth();
  await setupIsolatedTestData(db);

  let server = null;
  let baseUrl = process.env.API_BASE_URL;

  if (!baseUrl) {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  try {
    const client = createMemoryApiClient(baseUrl);

    // 1. Verificar /health (apenas disponibilidade do servidor HTTP, não testa o banco)
    const health = await client.checkServerHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');

    // 2. Verificar CORS para a origem do Front-end
    const corsCheck = await client.checkCorsPreflight('http://localhost:5173');
    assert.equal(corsCheck.status, 204);
    assert.equal(corsCheck.allowOrigin, 'http://localhost:5173');

    // 3. Testar falta de token (401 unauthenticated)
    client.clearToken();
    const noTokenRes = await client.callOperation('listMenu', {
      restaurantId: 'rest-rede-a',
      sessionId: 'sessao-inexistente'
    });
    assert.equal(noTokenRes.status, 401);
    assert.equal(noTokenRes.body.error, 'unauthenticated');

    // 4. Testar token inválido ou expirado (401 unauthenticated)
    const invalidTokenRes = await client.callOperation(
      'listMenu',
      { restaurantId: 'rest-rede-a', sessionId: 'sessao-inexistente' },
      { overrideToken: 'token-invalido-ou-expirado' }
    );
    assert.equal(invalidTokenRes.status, 401);
    assert.equal(invalidTokenRes.body.error, 'unauthenticated');

    // 5. Testar papel errado (funcionário de cozinha tentando usar operação exclusiva de garçom)
    const kitchenToken = await fetchIdTokenForUid(auth, 'staff-kitchen-a');
    client.setToken(kitchenToken);
    const wrongRoleRes = await client.callOperation('listReadyItems', {
      restaurantId: 'rest-rede-a'
    });
    assert.equal(wrongRoleRes.status, 403);
    assert.equal(wrongRoleRes.body.error, 'permission-denied');

    // 6. Testar isolamento entre restaurantes (garçom do Restaurante A tentando abrir mesa no Restaurante B)
    const waiterToken = await fetchIdTokenForUid(auth, 'staff-waiter-a');
    client.setToken(waiterToken);
    const crossRestaurantRes = await client.callOperation('openTableSession', {
      restaurantId: 'rest-rede-b',
      tableId: 'mesa-rede-01',
      requestId: 'req-isolamento-01'
    });
    assert.equal(crossRestaurantRes.status, 403);
    assert.equal(crossRestaurantRes.body.error, 'permission-denied');

    // 7. Testar repetição de requisição (idempotência com mesmo requestId) e conflito (409)
    const openFirst = await client.callOperation('openTableSession', {
      restaurantId: 'rest-rede-a',
      tableId: 'mesa-rede-01',
      requestId: 'req-idempotente-01'
    });
    assert.equal(openFirst.status, 200);
    assert.ok(openFirst.body.result.sessionId);

    const openDuplicate = await client.callOperation('openTableSession', {
      restaurantId: 'rest-rede-a',
      tableId: 'mesa-rede-01',
      requestId: 'req-idempotente-01'
    });
    assert.equal(openDuplicate.status, 200);
    assert.equal(openDuplicate.body.result.sessionId, openFirst.body.result.sessionId);

    const openConflict = await client.callOperation('openTableSession', {
      restaurantId: 'rest-rede-a',
      tableId: 'mesa-rede-02',
      requestId: 'req-idempotente-01'
    });
    assert.equal(openConflict.status, 409);
    assert.equal(openConflict.body.error, 'already-exists');

    // 8. Testar acesso real ao banco de dados (cliente entra na sessão, consulta cardápio e repete pedido)
    const customerToken = await fetchIdTokenForUid(auth, 'cliente-rede-01');
    client.setToken(customerToken);

    const joinRes = await client.callOperation('joinTable', {
      restaurantId: 'rest-rede-a',
      tableId: 'mesa-rede-01',
      displayName: 'Cliente Rede'
    });
    assert.equal(joinRes.status, 200);
    const activeSessionId = joinRes.body.result.sessionId;

    const menuRes = await client.callOperation('listMenu', {
      restaurantId: 'rest-rede-a',
      sessionId: activeSessionId
    });
    assert.equal(menuRes.status, 200);
    assert.ok(Array.isArray(menuRes.body.result.items));
    assert.ok(menuRes.body.result.items.some((item) => item.id === 'item-rede-1'));

    // Isolamento de cliente: tentar listar cardápio passando outro restaurante
    const crossClientRes = await client.callOperation('listMenu', {
      restaurantId: 'rest-rede-b',
      sessionId: activeSessionId
    });
    assert.equal(crossClientRes.status, 403);

    // Repetição de pedido (createOrder idempotente)
    const orderPayload = {
      restaurantId: 'rest-rede-a',
      sessionId: activeSessionId,
      requestId: 'pedido-idempotente-01',
      items: [{ menuItemId: 'item-rede-1', quantity: 1 }]
    };
    const orderFirst = await client.callOperation('createOrder', orderPayload);
    const orderSecond = await client.callOperation('createOrder', orderPayload);
    assert.equal(orderFirst.status, 200);
    assert.equal(orderSecond.status, 200);
    assert.equal(orderFirst.body.result.orderId, orderSecond.body.result.orderId);

    // 9. Simular perda/interrupção de conexão (AbortController)
    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      () =>
        client.callOperation(
          'listMenu',
          { restaurantId: 'rest-rede-a', sessionId: activeSessionId },
          { signal: abortController.signal }
        ),
      (err) => err.name === 'AbortError'
    );

    console.log('=== TESTES DE SEGURANCA E REDE (3.2) CONCLUIDOS COM SUCESSO ===');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

runNetworkTests().catch((err) => {
  console.error('Falha nos testes de rede:', err.message);
  process.exit(1);
});