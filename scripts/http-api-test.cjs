const assert = require('node:assert/strict');
const fs = require('node:fs');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
process.env.GCLOUD_PROJECT = 'demo-vamo-rachar';
const app = require('../functions/src/server');

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
      assert.equal(response.status, 200);
      return response.json();
    };
    const [waiter, customer] = await Promise.all([signup(), signup()]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `restaurants/http/staff/${waiter.localId}`), { active: true, roles: ['waiter'] });
      await setDoc(doc(ctx.firestore(), 'restaurants/http/tables/13'), { number: 13 });
      await setDoc(doc(ctx.firestore(), 'restaurants/http/menuItems/juice'), { name: 'Suco', available: true, priceCents: 900, sector: 'bar' });
    });
    assert.equal((await (await fetch(`${base}/health`)).json()).status, 'ok');
    const openData = { restaurantId: 'http', tableId: '13', requestId: 'start' };
    assert.equal((await request('/api/openTableSession', null, openData)).status, 401);
    assert.equal((await request('/api/openTableSession', 'invalid', openData)).status, 401);
    assert.equal((await request('/api/openTableSession', customer.idToken, openData)).status, 403);
    const opened = await request('/api/openTableSession', waiter.idToken, openData);
    assert.equal(opened.status, 200);
    const join = await request('/api/joinTable', customer.idToken, { restaurantId: 'http', tableId: '13', displayName: 'Ana', auth: { uid: waiter.localId } });
    assert.equal(join.status, 200);
    assert.equal(join.body.result.participantId, customer.localId);
    const menu = await request('/api/listMenu', customer.idToken, { restaurantId: 'http', sessionId: opened.body.result.sessionId });
    assert.equal(menu.status, 200);
    assert.equal(menu.body.result.items[0].priceCents, 900);
    assert.equal((await request('/api/startSandboxCheckout', customer.idToken, {})).status, 404);
    console.log('HTTP API authentication, authorization and Firebase emulator integration passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await env.cleanup();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
