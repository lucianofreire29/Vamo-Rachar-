const assert = require('node:assert/strict');
const fs = require('node:fs');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
async function signup() {
  const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  assert.equal(response.status, 200);
  return response.json();
}
async function call(user, operation, data, expected = 200) {
  const response = await fetch(`http://127.0.0.1:5001/demo-vamo-rachar/us-central1/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${user.idToken}` }, body: JSON.stringify({ data }) });
  const body = await response.json();
  assert.equal(response.status, expected, `${operation}: ${JSON.stringify(body)}`);
  return body.result;
}
async function main() {
  const env = await initializeTestEnvironment({ projectId: 'demo-vamo-rachar', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } });
  try {
    const [waiter, kitchen, ana, bruno] = await Promise.all([signup(), signup(), signup(), signup()]);
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, `restaurants/full-flow/staff/${waiter.localId}`), { active: true, roles: ['waiter'] });
      await setDoc(doc(db, `restaurants/full-flow/staff/${kitchen.localId}`), { active: true, roles: ['kitchen'] });
      await setDoc(doc(db, 'restaurants/full-flow/tables/13'), { number: 13 });
      await setDoc(doc(db, 'restaurants/full-flow/menuItems/fries'), { name: 'Fritas', priceCents: 3100, sector: 'kitchen', available: true });
    });
    const restaurantId = 'full-flow';
    const opened = await call(waiter, 'openTableSession', { restaurantId, tableId: '13', requestId: 'open' });
    const sessionId = opened.sessionId;
    await call(ana, 'joinTable', { restaurantId, tableId: '13', displayName: 'Ana' });
    await call(bruno, 'joinTable', { restaurantId, tableId: '13', displayName: 'Bruno' });
    await call(ana, 'createOrder', { restaurantId, sessionId, requestId: 'order', items: [{ menuItemId: 'fries', quantity: 1, inviteeIds: [bruno.localId] }] });
    const invitation = (await call(bruno, 'listInvitations', { restaurantId, sessionId })).invitations[0];
    assert.equal(invitation.amountCents, 1550);
    assert.equal((await call(kitchen, 'listWorkQueue', { restaurantId, sector: 'kitchen' })).items.length, 0);
    await call(bruno, 'respondToShare', { restaurantId, sessionId, orderId: invitation.orderId, itemId: invitation.itemId, accept: true });
    const item = { restaurantId, itemId: invitation.itemId };
    await call(kitchen, 'transitionItem', { ...item, action: 'start' });
    await call(kitchen, 'transitionItem', { ...item, action: 'ready' });
    await call(waiter, 'transitionItem', { ...item, action: 'pickup' });
    await call(waiter, 'transitionItem', { ...item, action: 'deliver' });
    const anaPayment = await call(ana, 'startSandboxCheckout', { restaurantId, sessionId, requestId: 'ana-payment', includeService: true });
    assert.equal(anaPayment.totalCents, 1705);
    const anaProof = { restaurantId, sessionId, paymentId: anaPayment.paymentId };
    await call(ana, 'submitSandboxProof', anaProof);
    await call(waiter, 'reviewSandboxPayment', { ...anaProof, approve: true });
    await call(waiter, 'closeSandboxTableSession', { restaurantId, sessionId }, 400);
    const brunoPayment = await call(bruno, 'startSandboxCheckout', { restaurantId, sessionId, requestId: 'bruno-payment', includeService: false });
    assert.equal(brunoPayment.totalCents, 1550);
    const brunoProof = { restaurantId, sessionId, paymentId: brunoPayment.paymentId };
    await call(bruno, 'submitSandboxProof', brunoProof);
    await call(waiter, 'reviewSandboxPayment', { ...brunoProof, approve: true });
    assert.equal((await call(waiter, 'closeSandboxTableSession', { restaurantId, sessionId })).status, 'closed');
    console.log('Full split order, separate sandbox payments and table close passed.');
  } finally { await env.cleanup(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
