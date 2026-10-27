const assert = require('node:assert/strict');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection } = require('firebase/firestore');
const fs = require('node:fs');

async function signup() {
  const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true })
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function call(token, data, operation = 'openTableSession') {
  const response = await fetch(`http://127.0.0.1:5001/demo-vamo-rachar/us-central1/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data })
  });
  return { status: response.status, body: await response.json() };
}
async function main() {
  const env = await initializeTestEnvironment({ projectId: 'demo-vamo-rachar', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } });
  try {
    const waiter = await signup();
    const outsider = await signup();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, `restaurants/test-session/staff/${waiter.localId}`), { active: true, roles: ['waiter'] });
      await setDoc(doc(db, 'restaurants/test-session/tables/13'), { number: 13 });
      await setDoc(doc(db, 'restaurants/test-session/menuItems/burger'), { name: 'Hambúrguer', priceCents: 3100, sector: 'kitchen', available: true });
      await setDoc(doc(db, 'restaurants/test-session/menuItems/unavailable'), { name: 'Indisponível', priceCents: 500, sector: 'bar', available: false });
    });
    const data = { restaurantId: 'test-session', tableId: '13', requestId: 'request-1' };
    assert.equal((await call(null, data)).status, 401);
    assert.equal((await call(outsider.idToken, data)).status, 403);
    const [first, retry] = await Promise.all([call(waiter.idToken, data), call(waiter.idToken, data)]);
    assert.equal(first.status, 200); assert.equal(retry.status, 200);
    assert.equal(first.body.result.sessionId, retry.body.result.sessionId);
    assert.equal((await call(waiter.idToken, { ...data, requestId: 'request-2' })).status, 400);
    assert.equal((await call(waiter.idToken, { ...data, tableId: '../bad' })).status, 400);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const table = await getDoc(doc(db, 'restaurants/test-session/tables/13'));
      assert.equal(table.data().activeSessionId, first.body.result.sessionId);
      const sessions = await getDocs(collection(db, 'restaurants/test-session/sessions'));
      assert.equal(sessions.size, 1);
      const events = await getDocs(collection(db, `restaurants/test-session/sessions/${first.body.result.sessionId}/events`));
      assert.equal(events.size, 1);
    });
    const joinData = { restaurantId: 'test-session', tableId: '13', displayName: '  Ana  ' };
    assert.equal((await call(null, joinData, 'joinTable')).status, 401);
    assert.equal((await call(outsider.idToken, { ...joinData, tableId: 'missing' }, 'joinTable')).status, 400);
    assert.equal((await call(outsider.idToken, { ...joinData, displayName: ' ' }, 'joinTable')).status, 400);
    const [join, joinRetry] = await Promise.all([call(outsider.idToken, joinData, 'joinTable'), call(outsider.idToken, joinData, 'joinTable')]);
    assert.equal(join.status, 200); assert.equal(joinRetry.status, 200);
    assert.equal(join.body.result.sessionId, first.body.result.sessionId);
    assert.equal(join.body.result.participantId, outsider.localId);
    assert.deepEqual(join.body.result, joinRetry.body.result);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = `restaurants/test-session/sessions/${first.body.result.sessionId}`;
      const participant = await getDoc(doc(db, `${base}/participants/${outsider.localId}`));
      assert.equal(participant.data().displayName, 'Ana');
      assert.equal((await getDocs(collection(db, `${base}/participants`))).size, 1);
      assert.equal((await getDocs(collection(db, `${base}/events`))).size, 2);
    });
    const menuData = { restaurantId: 'test-session', sessionId: first.body.result.sessionId };
    assert.equal((await call(null, menuData, 'listMenu')).status, 401);
    assert.equal((await call(waiter.idToken, menuData, 'listMenu')).status, 403);
    assert.equal((await call(outsider.idToken, { ...menuData, restaurantId: 'other' }, 'listMenu')).status, 403);
    const menu = await call(outsider.idToken, menuData, 'listMenu');
    assert.equal(menu.status, 200);
    assert.deepEqual(menu.body.result.items, [{ id: 'burger', name: 'Hambúrguer', description: '', priceCents: 3100, sector: 'kitchen' }]);
    const orderData = { ...menuData, requestId: 'order-1', items: [{ menuItemId: 'burger', quantity: 2, notes: 'sem cebola' }] };
    assert.equal((await call(waiter.idToken, orderData, 'createOrder')).status, 403);
    assert.equal((await call(outsider.idToken, { ...orderData, items: [{ menuItemId: 'burger', quantity: 1, priceCents: 1 }] }, 'createOrder')).status, 400);
    assert.equal((await call(outsider.idToken, { ...orderData, items: [{ menuItemId: 'unavailable', quantity: 1 }] }, 'createOrder')).status, 400);
    const [order, orderRetry] = await Promise.all([call(outsider.idToken, orderData, 'createOrder'), call(outsider.idToken, orderData, 'createOrder')]);
    assert.equal(order.status, 200); assert.equal(orderRetry.status, 200);
    assert.equal(order.body.result.orderId, orderRetry.body.result.orderId);
    assert.equal((await call(outsider.idToken, { ...orderData, items: [{ menuItemId: 'burger', quantity: 1 }] }, 'createOrder')).status, 409);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = `restaurants/test-session/sessions/${first.body.result.sessionId}`;
      assert.equal((await getDocs(collection(db, `${base}/orders`))).size, 1);
      const items = await getDocs(collection(db, `${base}/orders/${order.body.result.orderId}/items`));
      assert.equal(items.size, 1);
      assert.equal(items.docs[0].data().totalCents, 6200);
      assert.equal(items.docs[0].data().sectorSnapshot, 'kitchen');
      const share = await getDoc(doc(db, `${items.docs[0].ref.path}/shares/${outsider.localId}`));
      assert.equal(share.data().amountCents, 6200);
    });
    const second = await signup();
    await call(second.idToken, { ...joinData, displayName: 'Bruno' }, 'joinTable');
    const split = await call(outsider.idToken, { ...orderData, requestId: 'split-1', items: [{ menuItemId: 'burger', quantity: 1, inviteeIds: [second.localId] }] }, 'createOrder');
    assert.equal(split.status, 200);
    let itemId;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const base = `restaurants/test-session/sessions/${first.body.result.sessionId}/orders/${split.body.result.orderId}/items`;
      const items = await getDocs(collection(ctx.firestore(), base));
      itemId = items.docs[0].id;
      assert.equal(items.docs[0].data().status, 'awaiting_split');
    });
    const shareData = { ...menuData, orderId: split.body.result.orderId, itemId };
    const invitations = await call(second.idToken, menuData, 'listInvitations');
    assert.equal(invitations.status, 200);
    assert.equal(invitations.body.result.invitations.length, 1);
    assert.equal(invitations.body.result.invitations[0].itemId, itemId);
    const preview = await call(second.idToken, shareData, 'getShare');
    assert.equal(preview.status, 200);
    assert.equal(preview.body.result.amountCents, 1550);
    assert.equal(preview.body.result.totalCents, 3100);
    assert.equal((await call(waiter.idToken, shareData, 'getShare')).status, 403);
    const accepted = await call(second.idToken, { ...shareData, accept: true }, 'respondToShare');
    assert.equal(accepted.body.result.status, 'received');
    assert.equal((await call(second.idToken, { ...shareData, accept: true }, 'respondToShare')).status, 200);
    assert.equal((await call(second.idToken, { ...shareData, accept: false }, 'respondToShare')).status, 400);
    assert.equal((await call(second.idToken, menuData, 'listInvitations')).body.result.invitations.length, 0);
    const third = await signup();
    await call(third.idToken, { ...joinData, displayName: 'Carla' }, 'joinTable');
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), 'restaurants/test-session/menuItems/odd'), { name: 'Porção', priceCents: 3101, sector: 'kitchen', available: true }));
    const odd = await call(outsider.idToken, { ...orderData, requestId: 'odd', items: [{ menuItemId: 'odd', quantity: 1, inviteeIds: [second.localId, third.localId] }] }, 'createOrder');
    assert.equal(odd.status, 200);
    let oddItem;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const path = `restaurants/test-session/sessions/${first.body.result.sessionId}/orders/${odd.body.result.orderId}/items`;
      const items = await getDocs(collection(ctx.firestore(), path));
      oddItem = items.docs[0].id;
      const shares = await getDocs(collection(ctx.firestore(), `${path}/${oddItem}/shares`));
      const amounts = shares.docs.map((x) => x.data().amountCents).sort((a,b) => a-b);
      assert.deepEqual(amounts, [1033, 1034, 1034]);
    });
    const oddData = { ...menuData, orderId: odd.body.result.orderId, itemId: oddItem };
    assert.equal((await call(second.idToken, { ...oddData, accept: false }, 'respondToShare')).body.result.status, 'split_rejected');
    assert.equal((await call(third.idToken, menuData, 'listInvitations')).body.result.invitations.length, 0);
    assert.equal((await call(third.idToken, { ...oddData, accept: true }, 'respondToShare')).status, 400);
    const resolution = { ...oddData, requestId: 'resolution-1', action: 'assume' };
    assert.equal((await call(second.idToken, resolution, 'resolveRejectedSplit')).status, 403);
    const assumed = await call(outsider.idToken, resolution, 'resolveRejectedSplit');
    assert.equal(assumed.status, 200);
    assert.deepEqual((await call(outsider.idToken, resolution, 'resolveRejectedSplit')).body.result, assumed.body.result);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const base = `restaurants/test-session/sessions/${first.body.result.sessionId}/orders/${odd.body.result.orderId}/items`;
      const previous = await getDoc(doc(ctx.firestore(), `${base}/${oddItem}`));
      const replacement = await getDoc(doc(ctx.firestore(), `${base}/${assumed.body.result.itemId}`));
      assert.equal(previous.data().status, 'cancelled');
      assert.equal(replacement.data().status, 'received');
      assert.equal(replacement.data().totalCents, 3101);
      const share = await getDoc(doc(ctx.firestore(), `${base}/${assumed.body.result.itemId}/shares/${outsider.localId}`));
      assert.equal(share.data().amountCents, 3101);
    });
    for (const action of ['cancel', 'reinvite']) {
      const created = await call(outsider.idToken, { ...orderData, requestId: `order-${action}`, items: [{ menuItemId: 'burger', quantity: 1, inviteeIds: [second.localId] }] }, 'createOrder');
      const list = await call(second.idToken, menuData, 'listInvitations');
      const invitation = list.body.result.invitations.find((i) => i.orderId === created.body.result.orderId);
      assert.ok(invitation);
      const rejected = { ...menuData, orderId: invitation.orderId, itemId: invitation.itemId };
      assert.equal((await call(second.idToken, { ...rejected, accept: false }, 'respondToShare')).status, 200);
      const result = await call(outsider.idToken, { ...rejected, requestId: `resolve-${action}`, action, ...(action === 'reinvite' ? { inviteeIds: [third.localId] } : {}) }, 'resolveRejectedSplit');
      assert.equal(result.status, 200);
      if (action === 'cancel') assert.equal(result.body.result.itemId, null);
      else {
        const newInvites = await call(third.idToken, menuData, 'listInvitations');
        assert.ok(newInvites.body.result.invitations.some((i) => i.itemId === result.body.result.itemId));
      }
    }
    const kitchen = await signup();
    const bar = await signup();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, `restaurants/test-session/staff/${kitchen.localId}`), { active: true, roles: ['kitchen'] });
      await setDoc(doc(db, `restaurants/test-session/staff/${bar.localId}`), { active: true, roles: ['bar'] });
    });
    const queueData = { restaurantId: 'test-session', sector: 'kitchen' };
    assert.equal((await call(bar.idToken, queueData, 'listWorkQueue')).status, 403);
    const queue = await call(kitchen.idToken, queueData, 'listWorkQueue');
    assert.equal(queue.status, 200);
    assert.ok(queue.body.result.items.some((i) => i.itemId === itemId));
    const transition = { restaurantId: 'test-session', itemId };
    assert.equal((await call(bar.idToken, { ...transition, action: 'start' }, 'transitionItem')).status, 403);
    assert.equal((await call(kitchen.idToken, { ...transition, action: 'ready' }, 'transitionItem')).status, 400);
    assert.equal((await call(kitchen.idToken, { ...transition, action: 'start' }, 'transitionItem')).body.result.status, 'in_preparation');
    assert.equal((await call(kitchen.idToken, { ...transition, action: 'ready' }, 'transitionItem')).body.result.status, 'ready');
    const ready = await call(waiter.idToken, { restaurantId: 'test-session' }, 'listReadyItems');
    assert.ok(ready.body.result.items.some((i) => i.itemId === itemId));
    assert.equal((await call(kitchen.idToken, { ...transition, action: 'pickup' }, 'transitionItem')).status, 403);
    assert.equal((await call(waiter.idToken, { ...transition, action: 'pickup' }, 'transitionItem')).body.result.status, 'picked_up');
    assert.equal((await call(waiter.idToken, { ...transition, action: 'deliver' }, 'transitionItem')).body.result.status, 'delivered');
    const candidate = queue.body.result.items.find((i) => i.itemId !== itemId);
    assert.ok(candidate);
    const beforeUnavailable = await call(outsider.idToken, { ...menuData, includeService: false }, 'quoteCheckout');
    const unavailable = { restaurantId: 'test-session', itemId: candidate.itemId, reason: 'Estoque esgotado' };
    assert.equal((await call(bar.idToken, unavailable, 'markItemUnavailable')).status, 403);
    assert.equal((await call(kitchen.idToken, { ...unavailable, reason: ' ' }, 'markItemUnavailable')).status, 400);
    assert.equal((await call(kitchen.idToken, unavailable, 'markItemUnavailable')).body.result.status, 'unavailable');
    assert.equal((await call(kitchen.idToken, { ...transition, reason: 'teste' }, 'markItemUnavailable')).status, 400);
    assert.ok(!(await call(kitchen.idToken, queueData, 'listWorkQueue')).body.result.items.some((i) => i.itemId === candidate.itemId));
    await env.withSecurityRulesDisabled(async (ctx) => {
      const item = await getDoc(doc(ctx.firestore(), `restaurants/test-session/sessions/${candidate.sessionId}/orders/${candidate.orderId}/items/${candidate.itemId}`));
      assert.equal(item.data().unavailableReason, 'Estoque esgotado');
    });
    const myItems = await call(outsider.idToken, { ...menuData, orderId: candidate.orderId }, 'listMyOrderItems');
    assert.equal(myItems.status, 200);
    const unavailableView = myItems.body.result.items.find((entry) => entry.itemId === candidate.itemId);
    assert.equal(unavailableView.status, 'unavailable');
    assert.equal(unavailableView.unavailableReason, 'Estoque esgotado');
    const afterUnavailable = await call(outsider.idToken, { ...menuData, includeService: false }, 'quoteCheckout');
    assert.equal(beforeUnavailable.body.result.consumptionCents - afterUnavailable.body.result.consumptionCents, unavailableView.amountCents);
    assert.ok(!('participantIds' in unavailableView));
    assert.equal((await call(waiter.idToken, { ...menuData, orderId: candidate.orderId }, 'listMyOrderItems')).status, 403);
    const creatorOrders = await call(outsider.idToken, menuData, 'listMyOrders');
    assert.equal(creatorOrders.status, 200);
    assert.ok(creatorOrders.body.result.orderIds.includes(candidate.orderId));
    const inviteeOrders = await call(second.idToken, menuData, 'listMyOrders');
    assert.ok(inviteeOrders.body.result.orderIds.includes(split.body.result.orderId));
    const otherOrders = await call(waiter.idToken, menuData, 'listMyOrders');
    assert.equal(otherOrders.status, 403);
    const quote = await call(second.idToken, { ...menuData, includeService: true }, 'quoteCheckout');
    assert.equal(quote.status, 200);
    assert.deepEqual(quote.body.result, { consumptionCents: 1550, serviceCents: 155, totalCents: 1705 });
    const noService = await call(second.idToken, { ...menuData, includeService: false }, 'quoteCheckout');
    assert.deepEqual(noService.body.result, { consumptionCents: 1550, serviceCents: 0, totalCents: 1550 });
    assert.equal((await call(waiter.idToken, { ...menuData, includeService: true }, 'quoteCheckout')).status, 403);
    assert.equal((await call(second.idToken, { ...menuData, includeService: 'yes' }, 'quoteCheckout')).status, 400);
    const checkoutData = { ...menuData, requestId: 'checkout-1', includeService: true };
    const checkout = await call(second.idToken, checkoutData, 'startSandboxCheckout');
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.result.totalCents, 1705);
    assert.deepEqual((await call(second.idToken, checkoutData, 'startSandboxCheckout')).body.result, checkout.body.result);
    assert.equal((await call(second.idToken, { ...checkoutData, requestId: 'checkout-2' }, 'startSandboxCheckout')).status, 400);
    assert.equal((await call(second.idToken, { ...orderData, requestId: 'after-checkout' }, 'createOrder')).status, 403);
    const paymentData = { ...menuData, paymentId: checkout.body.result.paymentId };
    assert.equal((await call(waiter.idToken, { ...paymentData, approve: true }, 'reviewSandboxPayment')).status, 400);
    assert.equal((await call(outsider.idToken, paymentData, 'submitSandboxProof')).status, 403);
    assert.equal((await call(second.idToken, paymentData, 'submitSandboxProof')).body.result.status, 'proof_submitted');
    assert.equal((await call(kitchen.idToken, { ...paymentData, approve: true }, 'reviewSandboxPayment')).status, 403);
    assert.equal((await call(waiter.idToken, { ...paymentData, approve: true }, 'reviewSandboxPayment')).body.result.status, 'confirmed');
    assert.equal((await call(waiter.idToken, { ...paymentData, approve: true }, 'reviewSandboxPayment')).body.result.status, 'confirmed');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const person = await getDoc(doc(ctx.firestore(), `restaurants/test-session/sessions/${menuData.sessionId}/participants/${second.localId}`));
      assert.equal(person.data().status, 'paid');
    });
    const closeData = { restaurantId: 'test-session', sessionId: menuData.sessionId };
    assert.equal((await call(kitchen.idToken, closeData, 'closeSandboxTableSession')).status, 403);
    assert.equal((await call(waiter.idToken, closeData, 'closeSandboxTableSession')).status, 400);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'restaurants/test-session/tables/14'), { number: 14 });
    });
    const nextTable = await call(waiter.idToken, { restaurantId: 'test-session', tableId: '14', requestId: 'open-14' });
    assert.equal(nextTable.status, 200);
    const nextClose = { restaurantId: 'test-session', sessionId: nextTable.body.result.sessionId };
    assert.equal((await call(waiter.idToken, nextClose, 'closeSandboxTableSession')).body.result.status, 'closed');
    assert.equal((await call(waiter.idToken, nextClose, 'closeSandboxTableSession')).body.result.status, 'closed');
    const reopened = await call(waiter.idToken, { restaurantId: 'test-session', tableId: '14', requestId: 'open-14-again' });
    assert.equal(reopened.status, 200);
    assert.notEqual(reopened.body.result.sessionId, nextTable.body.result.sessionId);
    const visitor = await signup();
    const newJoin = { restaurantId: 'test-session', tableId: '14', displayName: 'Visitante' };
    assert.equal((await call(visitor.idToken, newJoin, 'joinTable')).status, 200);
    const leaveData = { restaurantId: 'test-session', sessionId: reopened.body.result.sessionId };
    assert.equal((await call(waiter.idToken, leaveData, 'closeSandboxTableSession')).status, 400);
    assert.equal((await call(visitor.idToken, leaveData, 'leaveSandboxWithoutConsumption')).body.result.status, 'left');
    assert.equal((await call(visitor.idToken, leaveData, 'leaveSandboxWithoutConsumption')).body.result.status, 'left');
    assert.equal((await call(visitor.idToken, newJoin, 'joinTable')).status, 400);
    assert.equal((await call(waiter.idToken, leaveData, 'closeSandboxTableSession')).body.result.status, 'closed');
    assert.equal((await call(outsider.idToken, menuData, 'leaveSandboxWithoutConsumption')).status, 400);
    console.log('Session, checkout, payment review, no-consumption exit and session close passed.');
  } finally { await env.cleanup(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
