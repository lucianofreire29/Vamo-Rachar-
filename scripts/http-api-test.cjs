const assert = require('node:assert/strict');
const fs = require('node:fs');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, getDocs, collection } = require('firebase/firestore');
process.env.GCLOUD_PROJECT = 'demo-vamo-rachar';
process.env.STAFF_CODE_PEPPER = 'test-only-pepper-with-more-than-32-characters';
const app = require('../functions/src/server');
const functions = require('../functions/src/index');

async function main() {
  const env = await initializeTestEnvironment({ projectId: 'demo-vamo-rachar', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, token, data) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    };
    const signup = async () => {
      const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
      assert.equal(response.status, 200); return response.json();
    };
    const [admin, plaza, kitchen, customer] = await Promise.all([signup(), signup(), signup(), signup()]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'restaurants/http'), { name: 'Teste' });
      await setDoc(doc(ctx.firestore(), `restaurants/http/admins/${admin.localId}`), { active: true });
      await setDoc(doc(ctx.firestore(), 'restaurants/http/tables/13'), { number: 13 });
      await setDoc(doc(ctx.firestore(), 'restaurants/http/menuItems/juice'), { name: 'Suco', available: true, priceCents: 900, sector: 'kitchen' });
    });
    // MFA é simulado neste teste de handlers; o token real com segundo fator será validado em integração própria.
    const adminAuth = { uid: admin.localId, token: { firebase: { sign_in_second_factor: 'test-factor' } } };
    const manager = await functions.createEmployeeCode.run({ auth: adminAuth, data: { restaurantId: 'http', employeeId: 'manager', displayName: 'Gerente', role: 'manager' } });
    const waiter = await functions.createEmployeeCode.run({ auth: adminAuth, data: { restaurantId: 'http', employeeId: 'waiter', displayName: 'Garçom', role: 'waiter' } });
    assert.equal((await (await fetch(`${base}/health`)).json()).status, 'ok');
    const openData = { restaurantId: 'http', tableId: '13', requestId: 'start', code: waiter.code };
    assert.equal((await request('/api/openTableWithCode', null, openData)).status, 401);
    assert.equal((await request('/api/openTableWithCode', 'invalid', openData)).status, 401);
    assert.equal((await request('/api/openTableSession', plaza.idToken, openData)).status, 404);
    assert.equal((await request('/api/openTableWithCode', plaza.idToken, openData)).status, 403);
    assert.equal((await request('/api/activateSharedDevice', plaza.idToken, { restaurantId: 'http', screen: 'plaza', code: waiter.code })).status, 403);
    assert.equal((await request('/api/activateSharedDevice', plaza.idToken, { restaurantId: 'http', screen: 'plaza', code: manager.code })).status, 200);
    assert.equal((await request('/api/activateSharedDevice', kitchen.idToken, { restaurantId: 'http', screen: 'kitchen', code: manager.code })).status, 200);
    const opened = await request('/api/openTableWithCode', plaza.idToken, openData);
    assert.equal(opened.status, 200);
    assert.equal((await request('/api/openTableWithCode', plaza.idToken, openData)).body.result.sessionId, opened.body.result.sessionId);
    const sessionId = opened.body.result.sessionId;
    const join = await request('/api/joinTable', customer.idToken, { restaurantId: 'http', tableId: '13', displayName: 'Ana', auth: { uid: plaza.localId } });
    assert.equal(join.status, 200); assert.equal(join.body.result.participantId, customer.localId);
    const menu = await request('/api/listMenu', customer.idToken, { restaurantId: 'http', sessionId });
    assert.equal(menu.status, 200); assert.equal(menu.body.result.items[0].priceCents, 900);
    async function createOrder(requestId) {
      const response = await request('/api/createOrder', customer.idToken, { restaurantId: 'http', sessionId, requestId, items: [{ menuItemId: 'juice', quantity: 1 }] });
      assert.equal(response.status, 200);
      const list = await request('/api/listWorkQueue', kitchen.idToken, { restaurantId: 'http', sector: 'kitchen' });
      assert.equal(list.status, 200);
      return { orderId: response.body.result.orderId, itemId: list.body.result.items.find((i) => i.orderId === response.body.result.orderId).itemId };
    }
    const first = await createOrder('order-1');
    const cancelFirst = { restaurantId: 'http', sessionId, ...first, code: waiter.code, reason: 'Solicitado pelo cliente' };
    assert.equal((await request('/api/cancelItemWithCode', customer.idToken, cancelFirst)).status, 403);
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, cancelFirst)).status, 200);
    const second = await createOrder('order-2');
    assert.equal((await request('/api/transitionItem', kitchen.idToken, { restaurantId: 'http', itemId: second.itemId, action: 'start' })).status, 200);
    const cancelSecond = { restaurantId: 'http', sessionId, ...second, code: waiter.code, reason: 'Erro no pedido' };
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, cancelSecond)).status, 403);
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, { ...cancelSecond, code: manager.code })).status, 200);
    const third = await createOrder('order-3');
    for (const action of ['start', 'ready']) assert.equal((await request('/api/transitionItem', kitchen.idToken, { restaurantId: 'http', itemId: third.itemId, action })).status, 200);
    for (const action of ['pickup', 'deliver']) assert.equal((await request('/api/transitionItem', plaza.idToken, { restaurantId: 'http', itemId: third.itemId, action })).status, 200);
    const cancelThird = { restaurantId: 'http', sessionId, ...third, code: waiter.code, reason: 'Erro no pedido' };
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, cancelThird)).status, 403);
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, { ...cancelThird, code: manager.code })).status, 200);
    const fourth = await createOrder('order-4');
    const participantPath = `restaurants/http/sessions/${sessionId}/participants/${customer.localId}`;
    await env.withSecurityRulesDisabled(async (ctx) => updateDoc(doc(ctx.firestore(), participantPath), { status: 'payment_pending' }));
    const cancelFourth = { restaurantId: 'http', sessionId, ...fourth, code: manager.code, reason: 'Revisão' };
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, cancelFourth)).status, 400);
    await env.withSecurityRulesDisabled(async (ctx) => updateDoc(doc(ctx.firestore(), participantPath), { status: 'active' }));
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, cancelFourth)).status, 200);
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'restaurants/http/menuItems/dual'), { name: 'Combo', available: true, priceCents: 3100, sectors: ['bar', 'kitchen'] }));
    const dualOrder = await request('/api/createOrder', customer.idToken, { restaurantId: 'http', sessionId, requestId: 'dual-order', items: [{ menuItemId: 'dual', quantity: 1 }] });
    assert.equal(dualOrder.status, 200);
    const dualQueue = await request('/api/listWorkQueue', kitchen.idToken, { restaurantId: 'http', sector: 'kitchen' });
    const dualItem = dualQueue.body.result.items.find((entry) => entry.orderId === dualOrder.body.result.orderId);
    assert.ok(dualItem);
    assert.equal((await request('/api/markItemUnavailable', kitchen.idToken, { restaurantId: 'http', itemId: dualItem.itemId, sector: 'kitchen', reason: 'Esgotado' })).status, 200);
    assert.equal((await request('/api/quoteCheckout', customer.idToken, { restaurantId: 'http', sessionId, includeService: false })).status, 400);
    const dualCancel = { restaurantId: 'http', sessionId, orderId: dualOrder.body.result.orderId, itemId: dualItem.itemId, reason: 'Indisponível', code: waiter.code };
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, dualCancel)).status, 403);
    assert.equal((await request('/api/cancelItemWithCode', plaza.idToken, { ...dualCancel, code: manager.code })).status, 200);
    const quote = await request('/api/quoteCheckout', customer.idToken, { restaurantId: 'http', sessionId, includeService: false });
    assert.equal(quote.status, 200); assert.equal(quote.body.result.consumptionCents, 0);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const events = await getDocs(collection(ctx.firestore(), `restaurants/http/sessions/${sessionId}/events`));
      const cancelled = events.docs.filter((event) => event.data().action === 'item_cancelled');
      assert.equal(cancelled.length, 5);
      assert.equal(cancelled.find((event) => event.data().targetId === second.itemId).data().actorId, 'manager');
      assert.ok(!JSON.stringify(cancelled.map((event) => event.data())).includes(manager.code));
    });
    const otherPlaza = await signup();
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'restaurants/http/tables/14'), { number: 14 }));
    assert.equal((await request('/api/activateSharedDevice', otherPlaza.idToken, { restaurantId: 'http', screen: 'plaza', code: manager.code })).status, 200);
    const simultaneous = await Promise.all([
      request('/api/openTableWithCode', plaza.idToken, { restaurantId: 'http', tableId: '14', requestId: 'race-1', code: waiter.code }),
      request('/api/openTableWithCode', otherPlaza.idToken, { restaurantId: 'http', tableId: '14', requestId: 'race-2', code: manager.code })
    ]);
    assert.deepEqual(simultaneous.map((result) => result.status).sort(), [200, 400]);
    const devices = await functions.listAdminDevices.run({ auth: adminAuth, data: { restaurantId: 'http' } });
    assert.equal(devices.devices.length, 3);
    await functions.disableSharedDevice.run({ auth: adminAuth, data: { restaurantId: 'http', deviceId: kitchen.localId } });
    assert.equal((await request('/api/listWorkQueue', kitchen.idToken, { restaurantId: 'http', sector: 'kitchen' })).status, 403);
    const newWaiter = await functions.rotateEmployeeCode.run({ auth: adminAuth, data: { restaurantId: 'http', employeeId: 'waiter' } });
    assert.equal((await request('/api/openTableWithCode', plaza.idToken, { ...openData, requestId: 'old-code', code: waiter.code })).status, 403);
    assert.equal((await request('/api/openTableWithCode', plaza.idToken, { ...openData, requestId: 'new-code', code: newWaiter.code })).status, 400);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'restaurants/rate-limit'), { name: 'Teste' });
      await setDoc(doc(ctx.firestore(), `restaurants/rate-limit/admins/${admin.localId}`), { active: true });
    });
    const limitedManager = await functions.createEmployeeCode.run({ auth: adminAuth, data: { restaurantId: 'rate-limit', employeeId: 'manager', displayName: 'Gerente', role: 'manager' } });
    const badCode = limitedManager.code === '00000000' ? '00000001' : '00000000';
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/activateSharedDevice', plaza.idToken, { restaurantId: 'rate-limit', screen: 'plaza', code: badCode })).status, 403);
    assert.equal((await request('/api/activateSharedDevice', plaza.idToken, { restaurantId: 'rate-limit', screen: 'plaza', code: limitedManager.code })).status, 429);
    assert.equal((await request('/api/startSandboxCheckout', customer.idToken, {})).status, 404);
    console.log('HTTP device activation, codes, permissions and cancellation passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await env.cleanup();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
