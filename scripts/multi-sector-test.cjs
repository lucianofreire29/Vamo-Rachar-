const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.GCLOUD_PROJECT = 'demo-vamo-rachar';
process.env.STAFF_CODE_PEPPER = 'test-only-pepper-with-more-than-32-characters';
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');
const functions = require('../functions/src/index');
async function signup() {
  const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
  assert.equal(response.status, 200); return response.json();
}
async function call(user, op, data, expected = 200) {
  const response = await fetch(`http://127.0.0.1:5001/demo-vamo-rachar/us-central1/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${user.idToken}` }, body: JSON.stringify({ data }) });
  const body = await response.json(); assert.equal(response.status, expected, `${op}: ${JSON.stringify(body)}`); return body.result;
}
async function main() {
  const env = await initializeTestEnvironment({ projectId: 'demo-vamo-rachar', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } });
  try {
    const [staff, client] = await Promise.all([signup(), signup()]);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, `restaurants/multi/staff/${staff.localId}`), { active: true, roles: ['waiter', 'bar', 'kitchen'] });
      await setDoc(doc(db, 'restaurants/multi'), { name: 'Teste' });
      await setDoc(doc(db, `restaurants/multi/admins/${staff.localId}`), { active: true });
      await setDoc(doc(db, 'restaurants/multi/tables/13'), { number: 13 });
      await setDoc(doc(db, 'restaurants/multi/menuItems/duo'), { name: 'Combo', priceCents: 3100, sectors: ['bar', 'kitchen'], available: true });
    });
    const restaurantId = 'multi';
    const adminProduct = { restaurantId, productId: 'managed', name: 'Combo gerenciado', priceCents: 1200, sectors: ['kitchen', 'bar'], available: true, photoUrl: 'https://example.com/produto.png' };
    await assert.rejects(functions.saveAdminProduct.run({ auth: { uid: staff.localId, token: {} }, data: adminProduct }), (err) => err.code === 'permission-denied');
    await functions.saveAdminProduct.run({ auth: { uid: staff.localId, token: { firebase: { sign_in_second_factor: 'test-factor' } } }, data: adminProduct });
    await assert.rejects(functions.saveAdminProduct.run({ auth: { uid: client.localId, token: { firebase: { sign_in_second_factor: 'test-factor' } } }, data: adminProduct }), (err) => err.code === 'permission-denied');
    const adminAuth = { uid: staff.localId, token: { firebase: { sign_in_second_factor: 'test-factor' } } };
    const employeeData = { restaurantId, employeeId: 'garcom-1', displayName: 'Garçom', role: 'waiter' };
    await assert.rejects(functions.createEmployeeCode.run({ auth: { uid: staff.localId, token: {} }, data: employeeData }), (err) => err.code === 'permission-denied');
    const employee = await functions.createEmployeeCode.run({ auth: adminAuth, data: employeeData });
    assert.match(employee.code, /^\d{8}$/);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const record = await getDoc(doc(ctx.firestore(), 'restaurants/multi/employees/garcom-1'));
      assert.equal(record.data().active, true);
      assert.ok(!JSON.stringify(record.data()).includes(employee.code));
    });
    const listed = await functions.listAdminEmployees.run({ auth: adminAuth, data: { restaurantId } });
    assert.deepEqual(listed.employees, [{ employeeId: 'garcom-1', displayName: 'Garçom', role: 'waiter', active: true }]);
    const products = await functions.listAdminProducts.run({ auth: adminAuth, data: { restaurantId } });
    assert.ok(products.products.some((product) => product.productId === 'managed' && product.sectors.length === 2));
    await assert.rejects(functions.listAdminEmployees.run({ auth: { uid: client.localId, token: { firebase: { sign_in_second_factor: 'test-factor' } } }, data: { restaurantId } }), (err) => err.code === 'permission-denied');
    await functions.disableEmployeeCode.run({ auth: adminAuth, data: { restaurantId, employeeId: 'garcom-1' } });
    await env.withSecurityRulesDisabled(async (ctx) => {
      const record = await getDoc(doc(ctx.firestore(), 'restaurants/multi/employees/garcom-1'));
      assert.equal(record.data().active, false);
    });
    const opened = await call(staff, 'openTableSession', { restaurantId, tableId: '13', requestId: 'open' });
    const sessionId = opened.sessionId;
    await call(client, 'joinTable', { restaurantId, tableId: '13', displayName: 'Ana' });
    const order = await call(client, 'createOrder', { restaurantId, sessionId, requestId: 'order', items: [{ menuItemId: 'duo', quantity: 1 }] });
    const bar = await call(staff, 'listWorkQueue', { restaurantId, sector: 'bar' });
    const kitchen = await call(staff, 'listWorkQueue', { restaurantId, sector: 'kitchen' });
    assert.equal(bar.items.length, 1); assert.equal(kitchen.items.length, 1);
    const itemId = bar.items[0].itemId; assert.equal(kitchen.items[0].itemId, itemId);
    const base = { restaurantId, itemId };
    await call(staff, 'transitionItem', { ...base, action: 'start' }, 404);
    for (const action of ['start', 'ready', 'pickup', 'deliver']) await call(staff, 'transitionItem', { ...base, sector: 'bar', action });
    const partial = await call(client, 'listMyOrderItems', { restaurantId, sessionId, orderId: order.orderId });
    assert.equal(partial.items[0].status, 'received');
    const pending = await call(client, 'quoteCheckout', { restaurantId, sessionId, includeService: false });
    assert.equal(pending.consumptionCents, 3100);
    for (const action of ['start', 'ready', 'pickup', 'deliver']) await call(staff, 'transitionItem', { ...base, sector: 'kitchen', action });
    const complete = await call(client, 'listMyOrderItems', { restaurantId, sessionId, orderId: order.orderId });
    assert.equal(complete.items[0].status, 'delivered');
    assert.equal((await call(client, 'quoteCheckout', { restaurantId, sessionId, includeService: false })).consumptionCents, 3100);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const item = await getDoc(doc(ctx.firestore(), `restaurants/multi/sessions/${sessionId}/orders/${order.orderId}/items/${itemId}`));
      assert.deepEqual(item.data().sectorStatuses, { bar: 'delivered', kitchen: 'delivered' });
    });
    const second = await call(client, 'createOrder', { restaurantId, sessionId, requestId: 'order-2', items: [{ menuItemId: 'duo', quantity: 1 }] });
    const currentBar = await call(staff, 'listWorkQueue', { restaurantId, sector: 'bar' });
    const unavailable = currentBar.items.find((entry) => entry.orderId === second.orderId);
    assert.ok(unavailable);
    await call(staff, 'markItemUnavailable', { restaurantId, itemId: unavailable.itemId, sector: 'bar', reason: 'Esgotado' });
    const secondItems = await call(client, 'listMyOrderItems', { restaurantId, sessionId, orderId: second.orderId });
    assert.equal(secondItems.items[0].status, 'attention_required');
    assert.equal(secondItems.items[0].sectorStatuses.bar, 'unavailable');
    await call(client, 'quoteCheckout', { restaurantId, sessionId, includeService: false }, 400);
    const guest = await signup();
    await call(guest, 'joinTable', { restaurantId, tableId: '13', displayName: 'Bruno' });
    const shared = await call(client, 'createOrder', { restaurantId, sessionId, requestId: 'shared', items: [{ menuItemId: 'duo', quantity: 1, inviteeIds: [guest.localId] }] });
    for (const sector of ['bar', 'kitchen']) {
      const q = await call(staff, 'listWorkQueue', { restaurantId, sector });
      assert.ok(!q.items.some((entry) => entry.orderId === shared.orderId));
    }
    const invitation = (await call(guest, 'listInvitations', { restaurantId, sessionId })).invitations.find((entry) => entry.orderId === shared.orderId);
    assert.ok(invitation);
    await call(guest, 'respondToShare', { restaurantId, sessionId, orderId: shared.orderId, itemId: invitation.itemId, accept: true });
    for (const sector of ['bar', 'kitchen']) {
      const q = await call(staff, 'listWorkQueue', { restaurantId, sector });
      assert.ok(q.items.some((entry) => entry.orderId === shared.orderId));
    }
    console.log('Multi-sector progress, shared consent, single charge and partial unavailability passed.');
  } finally { await env.cleanup(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
