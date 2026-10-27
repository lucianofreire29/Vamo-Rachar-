const { onRequest } = require('firebase-functions/v2/https');

// Endpoint de disponibilidade; operações de negócio virão nas próximas etapas.
exports.health = onRequest((request, response) => {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  response.status(200).json({ status: 'ok' });
});

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { createHash } = require('node:crypto');
initializeApp();

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

exports.openTableSession = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, tableId, requestId } = request.data || {};
  if (![restaurantId, tableId, requestId].every(validId)) {
    throw new HttpsError('invalid-argument', 'IDs inválidos.');
  }
  const db = getFirestore();
  const restaurant = db.collection('restaurants').doc(restaurantId);
  const staff = restaurant.collection('staff').doc(request.auth.uid);
  const table = restaurant.collection('tables').doc(tableId);
  const key = createHash('sha256').update(JSON.stringify([request.auth.uid, requestId])).digest('hex');
  const operation = restaurant.collection('sessionOpenRequests').doc(key);
  const session = restaurant.collection('sessions').doc();
  return db.runTransaction(async (transaction) => {
    const [member, prior, tableSnapshot] = await Promise.all([
      transaction.get(staff), transaction.get(operation), transaction.get(table)
    ]);
    const membership = member.data();
    if (!membership?.active || !Array.isArray(membership.roles) || !membership.roles.some((role) => ['waiter', 'manager'].includes(role))) {
      throw new HttpsError('permission-denied', 'Funcionário sem permissão.');
    }
    if (prior.exists) {
      if (prior.data().tableId !== tableId) throw new HttpsError('already-exists', 'Identificador já utilizado para outra mesa.');
      return { sessionId: prior.data().sessionId, tableId, status: 'open' };
    }
    if (!tableSnapshot.exists) throw new HttpsError('not-found', 'Mesa não encontrada.');
    if (tableSnapshot.data().activeSessionId) throw new HttpsError('failed-precondition', 'Mesa já possui sessão ativa.');
    transaction.create(session, { tableId, status: 'open', openedAt: FieldValue.serverTimestamp(), openedBy: request.auth.uid });
    transaction.update(table, { activeSessionId: session.id });
    transaction.create(operation, { tableId, sessionId: session.id, createdAt: FieldValue.serverTimestamp() });
    transaction.create(restaurant.collection('sessions').doc(session.id).collection('events').doc(), {
      action: 'session_opened', actorId: request.auth.uid, occurredAt: FieldValue.serverTimestamp()
    });
    return { sessionId: session.id, tableId, status: 'open' };
  });
});

exports.joinTable = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, tableId, displayName } = request.data || {};
  if (![restaurantId, tableId].every(validId) || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80) {
    throw new HttpsError('invalid-argument', 'Dados de entrada inválidos.');
  }
  const db = getFirestore();
  const restaurant = db.collection('restaurants').doc(restaurantId);
  const table = restaurant.collection('tables').doc(tableId);
  return db.runTransaction(async (transaction) => {
    const tableSnapshot = await transaction.get(table);
    const sessionId = tableSnapshot.data()?.activeSessionId;
    if (!validId(sessionId)) throw new HttpsError('failed-precondition', 'Mesa sem sessão aberta.');
    const session = restaurant.collection('sessions').doc(sessionId);
    const participant = session.collection('participants').doc(request.auth.uid);
    const [sessionSnapshot, participantSnapshot] = await Promise.all([transaction.get(session), transaction.get(participant)]);
    if (!sessionSnapshot.exists || sessionSnapshot.data().status !== 'open' || sessionSnapshot.data().tableId !== tableId) {
      throw new HttpsError('failed-precondition', 'Mesa sem sessão aberta.');
    }
    if (participantSnapshot.exists && participantSnapshot.data().status !== 'active') throw new HttpsError('failed-precondition', 'Participação encerrada ou com pagamento pendente.');
    if (!participantSnapshot.exists) {
      transaction.create(participant, { authUid: request.auth.uid, displayName: displayName.trim(), status: 'active', joinedAt: FieldValue.serverTimestamp() });
      transaction.create(session.collection('events').doc(), { action: 'participant_joined', actorId: request.auth.uid, occurredAt: FieldValue.serverTimestamp() });
    }
    return { sessionId, participantId: participant.id };
  });
});

exports.listMenu = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const session = restaurant.collection('sessions').doc(sessionId);
  const [sessionSnapshot, participant] = await Promise.all([
    session.get(), session.collection('participants').doc(request.auth.uid).get()
  ]);
  if (!sessionSnapshot.exists || sessionSnapshot.data().status !== 'open' || !participant.exists || participant.data().authUid !== request.auth.uid || participant.data().status !== 'active') {
    throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
  }
  const items = await restaurant.collection('menuItems').where('available', '==', true).limit(100).get();
  return { items: items.docs.map((item) => {
    const data = item.data();
    return { id: item.id, name: data.name, description: data.description || '', priceCents: data.priceCents, sector: data.sector };
  }) };
});

exports.createOrder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, requestId, items } = request.data || {};
  if (![restaurantId, sessionId, requestId].every(validId) || !Array.isArray(items) || !items.length || items.length > 20 || items.some((item) => !item || Object.keys(item).some((key) => !['menuItemId', 'quantity', 'notes', 'inviteeIds'].includes(key)) || !validId(item.menuItemId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || (item.notes !== undefined && (typeof item.notes !== 'string' || item.notes.length > 500)) || (item.inviteeIds !== undefined && (!Array.isArray(item.inviteeIds) || item.inviteeIds.length > 19 || item.inviteeIds.some((id) => !validId(id) || id === request.auth.uid) || new Set(item.inviteeIds).size !== item.inviteeIds.length)))) {
    throw new HttpsError('invalid-argument', 'Dados do pedido inválidos.');
  }
  if (items.reduce((sum, item) => sum + (item.inviteeIds || []).length, 0) > 150) throw new HttpsError('invalid-argument', 'Convites demais no pedido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const session = restaurant.collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  const operationKey = createHash('sha256').update(JSON.stringify([request.auth.uid, requestId])).digest('hex');
  const operation = session.collection('orderRequests').doc(operationKey);
  const order = session.collection('orders').doc();
  const normalized = items.map(({ menuItemId, quantity, notes, inviteeIds }) => ({ menuItemId, quantity, notes: (notes || '').trim(), inviteeIds: [...(inviteeIds || [])].sort() }));
  const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return getFirestore().runTransaction(async (transaction) => {
    const [sessionSnapshot, participantSnapshot, prior, ...menu] = await Promise.all([
      transaction.get(session), transaction.get(participant), transaction.get(operation),
      ...normalized.map((item) => transaction.get(restaurant.collection('menuItems').doc(item.menuItemId)))
    ]);
    if (!sessionSnapshot.exists || sessionSnapshot.data().status !== 'open' || !participantSnapshot.exists || participantSnapshot.data().authUid !== request.auth.uid || participantSnapshot.data().status !== 'active') {
      throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
    }
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) throw new HttpsError('already-exists', 'Identificador já utilizado para outro pedido.');
      return { orderId: prior.data().orderId };
    }
    const invitedIds = [...new Set(normalized.flatMap((item) => item.inviteeIds))];
    const invited = await Promise.all(invitedIds.map((id) => transaction.get(session.collection('participants').doc(id))));
    if (invited.some((person) => !person.exists || person.data().status !== 'active')) throw new HttpsError('failed-precondition', 'Participante convidado inválido.');
    const snapshots = menu.map((snapshot, index) => {
      const product = snapshot.data();
      const item = normalized[index];
      if (!snapshot.exists || product.available !== true || typeof product.name !== 'string' || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0 || !['bar', 'kitchen'].includes(product.sector) || !Number.isSafeInteger(product.priceCents * item.quantity)) {
        throw new HttpsError('failed-precondition', 'Produto indisponível ou inválido.');
      }
      return { ...item, nameSnapshot: product.name, unitPriceCents: product.priceCents, totalCents: product.priceCents * item.quantity, sectorSnapshot: product.sector, status: item.inviteeIds.length ? 'awaiting_split' : 'received' };
    });
    transaction.create(order, { createdByParticipantId: participant.id, createdAt: FieldValue.serverTimestamp() });
    for (const id of new Set([participant.id, ...invitedIds])) {
      transaction.set(session.collection('participants').doc(id).collection('orderRefs').doc(order.id), { orderId: order.id, createdAt: FieldValue.serverTimestamp() });
    }
    for (const item of snapshots) {
      const itemRef = order.collection('items').doc();
      const { inviteeIds, ...storedItem } = item;
      const participantIds = [participant.id, ...inviteeIds].sort();
      transaction.create(itemRef, { ...storedItem, participantIds });
      if (storedItem.status === 'received') transaction.create(restaurant.collection('workQueue').doc(itemRef.id), { sessionId, tableId: sessionSnapshot.data().tableId, orderId: order.id, itemId: itemRef.id, sector: storedItem.sectorSnapshot, status: 'received', name: storedItem.nameSnapshot, quantity: storedItem.quantity, notes: storedItem.notes, createdAt: FieldValue.serverTimestamp() });
      const base = Math.floor(item.totalCents / participantIds.length);
      const remainder = item.totalCents % participantIds.length;
      participantIds.forEach((id, index) => {
        const amountCents = base + (index < remainder ? 1 : 0);
        transaction.create(itemRef.collection('shares').doc(id), { participantId: id, amountCents, acceptanceStatus: id === participant.id ? 'accepted' : 'pending' });
        if (id !== participant.id) transaction.create(session.collection('participants').doc(id).collection('invitations').doc(itemRef.id), {
          orderId: order.id, itemId: itemRef.id, name: item.nameSnapshot, quantity: item.quantity,
          totalCents: item.totalCents, amountCents, acceptanceStatus: 'pending', createdAt: FieldValue.serverTimestamp()
        });
      });
    }
    transaction.create(operation, { fingerprint, orderId: order.id, createdAt: FieldValue.serverTimestamp() });
    transaction.create(session.collection('events').doc(), { action: 'order_created', actorId: request.auth.uid, targetId: order.id, occurredAt: FieldValue.serverTimestamp() });
    return { orderId: order.id };
  });
});

exports.respondToShare = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, orderId, itemId, accept } = request.data || {};
  if (![restaurantId, sessionId, orderId, itemId].every(validId) || typeof accept !== 'boolean') throw new HttpsError('invalid-argument', 'Dados de resposta inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const item = session.collection('orders').doc(orderId).collection('items').doc(itemId);
  return getFirestore().runTransaction(async (transaction) => {
    const [sessionSnapshot, participant, itemSnapshot, share] = await Promise.all([
      transaction.get(session), transaction.get(session.collection('participants').doc(request.auth.uid)), transaction.get(item), transaction.get(item.collection('shares').doc(request.auth.uid))
    ]);
    if (!sessionSnapshot.exists || sessionSnapshot.data().status !== 'open' || !participant.exists || participant.data().status !== 'active' || participant.data().authUid !== request.auth.uid || !share.exists) throw new HttpsError('permission-denied', 'Participante sem acesso à divisão.');
    if (!itemSnapshot.exists || !Array.isArray(itemSnapshot.data().participantIds)) throw new HttpsError('failed-precondition', 'Item inválido.');
    const desired = accept ? 'accepted' : 'rejected';
    if (share.data().acceptanceStatus === desired) return { status: itemSnapshot.data().status, acceptanceStatus: desired };
    if (share.data().acceptanceStatus !== 'pending' || itemSnapshot.data().status !== 'awaiting_split') throw new HttpsError('failed-precondition', 'Divisão não está aguardando resposta.');
    const shares = await Promise.all(itemSnapshot.data().participantIds.map((id) => transaction.get(item.collection('shares').doc(id))));
    const ready = accept && shares.every((s) => s.exists && (s.id === request.auth.uid || s.data().acceptanceStatus === 'accepted'));
    const status = accept ? (ready ? 'received' : 'awaiting_split') : 'split_rejected';
    transaction.update(share.ref, { acceptanceStatus: desired, respondedAt: FieldValue.serverTimestamp() });
    transaction.update(session.collection('participants').doc(request.auth.uid).collection('invitations').doc(itemId), { acceptanceStatus: desired, respondedAt: FieldValue.serverTimestamp() });
    if (!accept) {
      for (const other of shares) {
        if (other.exists && other.id !== request.auth.uid && other.data().acceptanceStatus === 'pending') {
          transaction.update(session.collection('participants').doc(other.id).collection('invitations').doc(itemId), { acceptanceStatus: 'cancelled' });
        }
      }
    }
    transaction.update(item, { status });
    if (ready) {
      const data = itemSnapshot.data();
      const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
      transaction.create(restaurant.collection('workQueue').doc(itemId), { sessionId, tableId: sessionSnapshot.data().tableId, orderId, itemId, sector: data.sectorSnapshot, status: 'received', name: data.nameSnapshot, quantity: data.quantity, notes: data.notes, createdAt: FieldValue.serverTimestamp() });
    }
    transaction.create(session.collection('events').doc(), { action: accept ? 'share_accepted' : 'share_rejected', actorId: request.auth.uid, targetId: itemId, occurredAt: FieldValue.serverTimestamp() });
    return { status, acceptanceStatus: desired };
  });
});

exports.getShare = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, orderId, itemId } = request.data || {};
  if (![restaurantId, sessionId, orderId, itemId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const item = session.collection('orders').doc(orderId).collection('items').doc(itemId);
  const [sessionSnapshot, participant, itemSnapshot, share] = await Promise.all([
    session.get(), session.collection('participants').doc(request.auth.uid).get(), item.get(), item.collection('shares').doc(request.auth.uid).get()
  ]);
  if (!sessionSnapshot.exists || sessionSnapshot.data().status !== 'open' || !participant.exists || participant.data().status !== 'active' || participant.data().authUid !== request.auth.uid || !itemSnapshot.exists || !share.exists) throw new HttpsError('permission-denied', 'Participante sem acesso à divisão.');
  const data = itemSnapshot.data();
  return { name: data.nameSnapshot, quantity: data.quantity, totalCents: data.totalCents, amountCents: share.data().amountCents, acceptanceStatus: share.data().acceptanceStatus, itemStatus: data.status };
});

exports.listInvitations = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  const [sessionSnapshot, participantSnapshot] = await Promise.all([session.get(), participant.get()]);
  if (!sessionSnapshot.exists || sessionSnapshot.data().status !== 'open' || !participantSnapshot.exists || participantSnapshot.data().authUid !== request.auth.uid || participantSnapshot.data().status !== 'active') throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
  const invitations = await participant.collection('invitations').where('acceptanceStatus', '==', 'pending').limit(100).get();
  return { invitations: invitations.docs.map((doc) => {
    const { orderId, itemId, name, quantity, totalCents, amountCents } = doc.data();
    return { orderId, itemId, name, quantity, totalCents, amountCents };
  }) };
});

exports.resolveRejectedSplit = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, orderId, itemId, requestId, action, inviteeIds = [] } = request.data || {};
  if (![restaurantId, sessionId, orderId, itemId, requestId].every(validId) || !['cancel', 'assume', 'reinvite'].includes(action) || !Array.isArray(inviteeIds) || inviteeIds.length > 19 || inviteeIds.some((id) => !validId(id) || id === request.auth.uid) || new Set(inviteeIds).size !== inviteeIds.length || (action === 'reinvite' ? inviteeIds.length === 0 : inviteeIds.length !== 0)) throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const normalized = [...inviteeIds].sort();
  const fingerprint = createHash('sha256').update(JSON.stringify([orderId, itemId, action, normalized])).digest('hex');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const order = session.collection('orders').doc(orderId);
  const item = order.collection('items').doc(itemId);
  const replacement = order.collection('items').doc();
  const key = createHash('sha256').update(JSON.stringify([request.auth.uid, requestId])).digest('hex');
  const operation = session.collection('splitResolutionRequests').doc(key);
  return getFirestore().runTransaction(async (transaction) => {
    const [sessionDoc, participant, orderDoc, oldItem, prior, ...invited] = await Promise.all([
      transaction.get(session), transaction.get(session.collection('participants').doc(request.auth.uid)), transaction.get(order), transaction.get(item), transaction.get(operation),
      ...normalized.map((id) => transaction.get(session.collection('participants').doc(id)))
    ]);
    if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !participant.exists || participant.data().status !== 'active' || participant.data().authUid !== request.auth.uid || !orderDoc.exists || orderDoc.data().createdByParticipantId !== request.auth.uid) throw new HttpsError('permission-denied', 'Somente o responsável pode resolver a divisão.');
    if (prior.exists) {
      if (prior.data().fingerprint !== fingerprint) throw new HttpsError('already-exists', 'Identificador já utilizado.');
      return { itemId: prior.data().itemId, action };
    }
    if (!oldItem.exists || oldItem.data().status !== 'split_rejected') throw new HttpsError('failed-precondition', 'Item não está com divisão recusada.');
    if (invited.some((person) => !person.exists || person.data().status !== 'active')) throw new HttpsError('failed-precondition', 'Participante convidado inválido.');
    const old = oldItem.data();
    const newItemId = action === 'cancel' ? null : replacement.id;
    transaction.update(item, { status: 'cancelled', resolvedAt: FieldValue.serverTimestamp(), replacementItemId: newItemId });
    if (newItemId) {
      const participantIds = [request.auth.uid, ...normalized].sort();
      for (const id of normalized) transaction.set(session.collection('participants').doc(id).collection('orderRefs').doc(orderId), { orderId, createdAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.create(replacement, { menuItemId: old.menuItemId, quantity: old.quantity, notes: old.notes, nameSnapshot: old.nameSnapshot, unitPriceCents: old.unitPriceCents, totalCents: old.totalCents, sectorSnapshot: old.sectorSnapshot, status: normalized.length ? 'awaiting_split' : 'received', participantIds, previousItemId: itemId });
      if (!normalized.length) transaction.create(getFirestore().collection('restaurants').doc(restaurantId).collection('workQueue').doc(replacement.id), { sessionId, tableId: sessionDoc.data().tableId, orderId, itemId: replacement.id, sector: old.sectorSnapshot, status: 'received', name: old.nameSnapshot, quantity: old.quantity, notes: old.notes, createdAt: FieldValue.serverTimestamp() });
      const base = Math.floor(old.totalCents / participantIds.length);
      const remainder = old.totalCents % participantIds.length;
      participantIds.forEach((id, index) => {
        const amountCents = base + (index < remainder ? 1 : 0);
        transaction.create(replacement.collection('shares').doc(id), { participantId: id, amountCents, acceptanceStatus: id === request.auth.uid ? 'accepted' : 'pending' });
        if (id !== request.auth.uid) transaction.create(session.collection('participants').doc(id).collection('invitations').doc(replacement.id), { orderId, itemId: replacement.id, name: old.nameSnapshot, quantity: old.quantity, totalCents: old.totalCents, amountCents, acceptanceStatus: 'pending', createdAt: FieldValue.serverTimestamp() });
      });
    }
    transaction.create(operation, { fingerprint, itemId: newItemId, createdAt: FieldValue.serverTimestamp() });
    transaction.create(session.collection('events').doc(), { action: 'split_resolved', resolution: action, actorId: request.auth.uid, targetId: itemId, replacementItemId: newItemId, occurredAt: FieldValue.serverTimestamp() });
    return { itemId: newItemId, action };
  });
});

exports.listWorkQueue = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sector } = request.data || {};
  if (!validId(restaurantId) || !['bar', 'kitchen'].includes(sector)) throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const staff = await restaurant.collection('staff').doc(request.auth.uid).get();
  if (!staff.exists || staff.data().active !== true || !Array.isArray(staff.data().roles) || !staff.data().roles.includes(sector)) throw new HttpsError('permission-denied', 'Sem permissão para este setor.');
  const queue = await restaurant.collection('workQueue').where('sector', '==', sector).where('status', 'in', ['received', 'in_preparation', 'ready']).limit(100).get();
  return { items: queue.docs.map((doc) => {
    const { sessionId, tableId, orderId, itemId, status, name, quantity, notes } = doc.data();
    return { sessionId, tableId, orderId, itemId, status, name, quantity, notes };
  }).filter((item) => ['received', 'in_preparation', 'ready'].includes(item.status)) };
});

exports.transitionItem = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, itemId, action } = request.data || {};
  const transitions = { start: ['received', 'in_preparation'], ready: ['in_preparation', 'ready'], pickup: ['ready', 'picked_up'], deliver: ['picked_up', 'delivered'] };
  if (!validId(restaurantId) || !validId(itemId) || !Object.hasOwn(transitions, action)) throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const queue = restaurant.collection('workQueue').doc(itemId);
  const staff = restaurant.collection('staff').doc(request.auth.uid);
  return getFirestore().runTransaction(async (transaction) => {
    const [staffDoc, entry] = await Promise.all([transaction.get(staff), transaction.get(queue)]);
    if (!entry.exists) throw new HttpsError('not-found', 'Item não encontrado.');
    const data = entry.data();
    const roles = staffDoc.data()?.roles;
    const required = ['start', 'ready'].includes(action) ? data.sector : 'waiter';
    if (!staffDoc.exists || staffDoc.data().active !== true || !Array.isArray(roles) || !roles.includes(required)) throw new HttpsError('permission-denied', 'Sem permissão para esta operação.');
    const item = restaurant.collection('sessions').doc(data.sessionId).collection('orders').doc(data.orderId).collection('items').doc(itemId);
    const itemDoc = await transaction.get(item);
    if (!itemDoc.exists || data.status !== transitions[action][0] || itemDoc.data().status !== data.status) throw new HttpsError('failed-precondition', 'Transição inválida.');
    const status = transitions[action][1];
    transaction.update(queue, { status, updatedAt: FieldValue.serverTimestamp() });
    transaction.update(item, { status, updatedAt: FieldValue.serverTimestamp() });
    transaction.create(restaurant.collection('sessions').doc(data.sessionId).collection('events').doc(), { action: `item_${status}`, actorId: request.auth.uid, targetId: itemId, occurredAt: FieldValue.serverTimestamp() });
    return { itemId, status };
  });
});

exports.listReadyItems = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId } = request.data || {};
  if (!validId(restaurantId)) throw new HttpsError('invalid-argument', 'Restaurante inválido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const staff = await restaurant.collection('staff').doc(request.auth.uid).get();
  if (!staff.exists || staff.data().active !== true || !Array.isArray(staff.data().roles) || !staff.data().roles.includes('waiter')) throw new HttpsError('permission-denied', 'Sem permissão de garçom.');
  const queue = await restaurant.collection('workQueue').where('status', 'in', ['ready', 'picked_up']).limit(100).get();
  return { items: queue.docs.map((doc) => {
    const { sessionId, tableId, orderId, itemId, sector, status, name, quantity, notes } = doc.data();
    return { sessionId, tableId, orderId, itemId, sector, status, name, quantity, notes };
  }) };
});

exports.markItemUnavailable = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, itemId, reason } = request.data || {};
  if (!validId(restaurantId) || !validId(itemId) || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw new HttpsError('invalid-argument', 'Informe um motivo válido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const queue = restaurant.collection('workQueue').doc(itemId);
  const staff = restaurant.collection('staff').doc(request.auth.uid);
  return getFirestore().runTransaction(async (transaction) => {
    const [staffDoc, entry] = await Promise.all([transaction.get(staff), transaction.get(queue)]);
    if (!entry.exists) throw new HttpsError('not-found', 'Item não encontrado.');
    const data = entry.data();
    if (!staffDoc.exists || staffDoc.data().active !== true || !Array.isArray(staffDoc.data().roles) || !staffDoc.data().roles.includes(data.sector)) throw new HttpsError('permission-denied', 'Sem permissão para este setor.');
    const session = restaurant.collection('sessions').doc(data.sessionId);
    const item = session.collection('orders').doc(data.orderId).collection('items').doc(itemId);
    const itemDoc = await transaction.get(item);
    if (!itemDoc.exists || !['received', 'in_preparation'].includes(data.status) || itemDoc.data().status !== data.status) throw new HttpsError('failed-precondition', 'Item não pode ser marcado indisponível.');
    transaction.update(queue, { status: 'unavailable', updatedAt: FieldValue.serverTimestamp() });
    transaction.update(item, { status: 'unavailable', unavailableReason: reason.trim(), updatedAt: FieldValue.serverTimestamp() });
    transaction.create(session.collection('events').doc(), { action: 'item_unavailable', actorId: request.auth.uid, targetId: itemId, reason: reason.trim(), occurredAt: FieldValue.serverTimestamp() });
    return { itemId, status: 'unavailable' };
  });
});

exports.listMyOrderItems = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, orderId } = request.data || {};
  if (![restaurantId, sessionId, orderId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  const [sessionDoc, participantDoc] = await Promise.all([session.get(), participant.get()]);
  if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !participantDoc.exists || participantDoc.data().authUid !== request.auth.uid || participantDoc.data().status !== 'active') throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
  const items = await session.collection('orders').doc(orderId).collection('items').limit(101).get();
  if (items.size > 100) throw new HttpsError('resource-exhausted', 'Pedido excede limite de consulta; paginação necessária.');
  const visible = await Promise.all(items.docs.map(async (item) => {
    const share = await item.ref.collection('shares').doc(request.auth.uid).get();
    if (!share.exists) return null;
    const data = item.data();
    return { itemId: item.id, name: data.nameSnapshot, quantity: data.quantity, totalCents: data.totalCents, amountCents: share.data().amountCents, acceptanceStatus: share.data().acceptanceStatus, status: data.status, unavailableReason: data.unavailableReason || null };
  }));
  return { items: visible.filter(Boolean) };
});

exports.listMyOrders = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  const [sessionDoc, participantDoc] = await Promise.all([session.get(), participant.get()]);
  if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !participantDoc.exists || participantDoc.data().status !== 'active' || participantDoc.data().authUid !== request.auth.uid) throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
  const orders = await participant.collection('orderRefs').limit(101).get();
  if (orders.size > 100) throw new HttpsError('resource-exhausted', 'Muitos pedidos; paginação necessária.');
  return { orderIds: orders.docs.map((doc) => doc.id) };
});

exports.quoteCheckout = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, includeService } = request.data || {};
  if (![restaurantId, sessionId].every(validId) || typeof includeService !== 'boolean') throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  return getFirestore().runTransaction(async (transaction) => {
  const [sessionDoc, participantDoc] = await Promise.all([transaction.get(session), transaction.get(participant)]);
  if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !participantDoc.exists || participantDoc.data().status !== 'active' || participantDoc.data().authUid !== request.auth.uid) throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
  const refs = await transaction.get(participant.collection('orderRefs').limit(101));
  if (refs.size > 100) throw new HttpsError('resource-exhausted', 'Muitos pedidos para consulta.');
  const amounts = await Promise.all(refs.docs.map(async (ref) => {
    const items = await transaction.get(session.collection('orders').doc(ref.id).collection('items').limit(101));
    if (items.size > 100) throw new HttpsError('resource-exhausted', 'Pedido excede limite de consulta.');
    return Promise.all(items.docs.map(async (item) => {
      if (!['received', 'in_preparation', 'ready', 'picked_up', 'delivered'].includes(item.data().status)) return 0;
      const share = await transaction.get(item.ref.collection('shares').doc(request.auth.uid));
      if (!share.exists || share.data().acceptanceStatus !== 'accepted') return 0;
      const amount = share.data().amountCents;
      if (!Number.isSafeInteger(amount) || amount < 0) throw new HttpsError('failed-precondition', 'Parcela inválida.');
      return amount;
    }));
  }));
  const consumptionCents = amounts.flat().reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(consumptionCents) || consumptionCents > Number.MAX_SAFE_INTEGER - 5) throw new HttpsError('resource-exhausted', 'Valor excede limite.');
  const serviceCents = includeService ? Math.floor((consumptionCents + 5) / 10) : 0;
  const totalCents = consumptionCents + serviceCents;
  if (!Number.isSafeInteger(totalCents)) throw new HttpsError('resource-exhausted', 'Valor excede limite.');
  return { consumptionCents, serviceCents, totalCents };
  }, { readOnly: true });
});

// Simulação disponível apenas no emulador; nunca processa pagamentos reais.
function requireEmulator() {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') throw new HttpsError('failed-precondition', 'Disponível apenas no emulador.');
}

exports.startSandboxCheckout = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, requestId, includeService } = request.data || {};
  if (![restaurantId, sessionId, requestId].every(validId) || typeof includeService !== 'boolean') throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  const key = createHash('sha256').update(JSON.stringify([request.auth.uid, requestId])).digest('hex');
  const payment = session.collection('paymentAttempts').doc(key);
  return getFirestore().runTransaction(async (tx) => {
    const [sessionDoc, person, prior] = await Promise.all([tx.get(session), tx.get(participant), tx.get(payment)]);
    if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !person.exists || person.data().authUid !== request.auth.uid) throw new HttpsError('permission-denied', 'Sem acesso à sessão.');
    if (prior.exists) {
      if (prior.data().includeService !== includeService) throw new HttpsError('already-exists', 'Identificador já utilizado.');
      return { paymentId: key, consumptionCents: prior.data().consumptionCents, serviceCents: prior.data().serviceCents, totalCents: prior.data().totalCents };
    }
    if (person.data().status !== 'active') throw new HttpsError('failed-precondition', 'Comanda não está aberta.');
    const refs = await tx.get(participant.collection('orderRefs').limit(101));
    if (refs.size > 100) throw new HttpsError('resource-exhausted', 'Muitos pedidos.');
    const groups = await Promise.all(refs.docs.map((ref) => tx.get(session.collection('orders').doc(ref.id).collection('items').limit(101))));
    if (groups.some((group) => group.size > 100)) throw new HttpsError('resource-exhausted', 'Muitos itens no pedido.');
    const entries = groups.flatMap((group) => group.docs);
    const shares = await Promise.all(entries.map((entry) => tx.get(entry.ref.collection('shares').doc(request.auth.uid))));
    let consumptionCents = 0;
    for (let i = 0; i < entries.length; i++) {
      if (!shares[i].exists) continue;
      const state = entries[i].data().status;
      if (['awaiting_split', 'split_rejected', 'received', 'in_preparation', 'ready', 'picked_up'].includes(state)) throw new HttpsError('failed-precondition', 'Existem itens ou divisões pendentes.');
      if (state === 'delivered' && shares[i].data().acceptanceStatus === 'accepted') {
        const value = shares[i].data().amountCents;
        if (!Number.isSafeInteger(value) || value < 0) throw new HttpsError('failed-precondition', 'Parcela inválida.');
        consumptionCents += value;
      } else if (!['cancelled', 'unavailable'].includes(state)) throw new HttpsError('failed-precondition', 'Item em estado inválido.');
    }
    if (!Number.isSafeInteger(consumptionCents) || consumptionCents <= 0 || consumptionCents > Number.MAX_SAFE_INTEGER - 5) throw new HttpsError('failed-precondition', 'Consumo inválido ou vazio.');
    const serviceCents = includeService ? Math.floor((consumptionCents + 5) / 10) : 0;
    const totalCents = consumptionCents + serviceCents;
    if (!Number.isSafeInteger(totalCents)) throw new HttpsError('resource-exhausted', 'Valor excede limite.');
    tx.create(payment, { participantId: request.auth.uid, includeService, consumptionCents, serviceCents, totalCents, status: 'awaiting_proof', createdAt: FieldValue.serverTimestamp() });
    tx.update(participant, { status: 'payment_pending' });
    tx.create(session.collection('events').doc(), { action: 'sandbox_checkout_started', actorId: request.auth.uid, targetId: key, occurredAt: FieldValue.serverTimestamp() });
    return { paymentId: key, consumptionCents, serviceCents, totalCents };
  });
});

exports.submitSandboxProof = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, paymentId } = request.data || {};
  if (![restaurantId, sessionId, paymentId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const payment = session.collection('paymentAttempts').doc(paymentId);
  return getFirestore().runTransaction(async (tx) => {
    const doc = await tx.get(payment);
    if (!doc.exists || doc.data().participantId !== request.auth.uid) throw new HttpsError('permission-denied', 'Sem acesso ao pagamento.');
    if (doc.data().status === 'proof_submitted') return { status: 'proof_submitted' };
    if (doc.data().status !== 'awaiting_proof') throw new HttpsError('failed-precondition', 'Pagamento não aguarda comprovante.');
    tx.update(payment, { status: 'proof_submitted', proofSubmittedAt: FieldValue.serverTimestamp() });
    tx.create(session.collection('events').doc(), { action: 'sandbox_proof_submitted', actorId: request.auth.uid, targetId: paymentId, occurredAt: FieldValue.serverTimestamp() });
    return { status: 'proof_submitted' };
  });
});

exports.reviewSandboxPayment = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, paymentId, approve } = request.data || {};
  if (![restaurantId, sessionId, paymentId].every(validId) || typeof approve !== 'boolean') throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const session = restaurant.collection('sessions').doc(sessionId);
  const payment = session.collection('paymentAttempts').doc(paymentId);
  return getFirestore().runTransaction(async (tx) => {
    const [staff, attempt] = await Promise.all([tx.get(restaurant.collection('staff').doc(request.auth.uid)), tx.get(payment)]);
    if (!staff.exists || staff.data().active !== true || !Array.isArray(staff.data().roles) || !staff.data().roles.some((role) => ['waiter', 'manager'].includes(role))) throw new HttpsError('permission-denied', 'Sem permissão para conferir pagamento.');
    if (!attempt.exists) throw new HttpsError('not-found', 'Pagamento não encontrado.');
    const status = approve ? 'confirmed' : 'rejected';
    if (attempt.data().status === status) return { status };
    if (attempt.data().status !== 'proof_submitted') throw new HttpsError('failed-precondition', 'Comprovante não está em análise.');
    const participant = session.collection('participants').doc(attempt.data().participantId);
    const person = await tx.get(participant);
    if (!person.exists || person.data().status !== 'payment_pending') throw new HttpsError('failed-precondition', 'Comanda não aguarda pagamento.');
    tx.update(payment, { status, reviewedBy: request.auth.uid, reviewedAt: FieldValue.serverTimestamp() });
    tx.update(participant, { status: approve ? 'paid' : 'active' });
    tx.create(session.collection('events').doc(), { action: `sandbox_payment_${status}`, actorId: request.auth.uid, targetId: paymentId, occurredAt: FieldValue.serverTimestamp() });
    return { status };
  });
});

exports.closeSandboxTableSession = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const session = restaurant.collection('sessions').doc(sessionId);
  return getFirestore().runTransaction(async (tx) => {
    const [staff, sessionDoc] = await Promise.all([tx.get(restaurant.collection('staff').doc(request.auth.uid)), tx.get(session)]);
    if (!staff.exists || staff.data().active !== true || !Array.isArray(staff.data().roles) || !staff.data().roles.some((role) => ['waiter', 'manager'].includes(role))) throw new HttpsError('permission-denied', 'Sem permissão para encerrar mesa.');
    if (!sessionDoc.exists) throw new HttpsError('not-found', 'Sessão não encontrada.');
    if (sessionDoc.data().status === 'closed') return { sessionId, status: 'closed' };
    if (sessionDoc.data().status !== 'open' || !validId(sessionDoc.data().tableId)) throw new HttpsError('failed-precondition', 'Sessão em estado inválido.');
    const table = restaurant.collection('tables').doc(sessionDoc.data().tableId);
    const [tableDoc, participants, payments, orders] = await Promise.all([
      tx.get(table), tx.get(session.collection('participants').limit(101)), tx.get(session.collection('paymentAttempts').limit(101)), tx.get(session.collection('orders').limit(101))
    ]);
    if ([participants, payments, orders].some((snapshot) => snapshot.size > 100)) throw new HttpsError('resource-exhausted', 'Sessão excede limite de verificação.');
    const itemGroups = await Promise.all(orders.docs.map((order) => tx.get(order.ref.collection('items').limit(101))));
    if (itemGroups.some((group) => group.size > 100)) throw new HttpsError('resource-exhausted', 'Pedido excede limite de verificação.');
    if (!tableDoc.exists || tableDoc.data().activeSessionId !== sessionId || participants.docs.some((p) => !['paid', 'left'].includes(p.data().status)) || payments.docs.some((p) => !['confirmed', 'rejected'].includes(p.data().status)) || itemGroups.some((group) => group.docs.some((item) => !['delivered', 'cancelled', 'unavailable'].includes(item.data().status)))) throw new HttpsError('failed-precondition', 'A mesa possui pendências ou está inconsistente.');
    tx.update(session, { status: 'closed', closedAt: FieldValue.serverTimestamp(), closedBy: request.auth.uid });
    tx.update(table, { activeSessionId: null });
    tx.create(session.collection('events').doc(), { action: 'sandbox_session_closed', actorId: request.auth.uid, occurredAt: FieldValue.serverTimestamp() });
    return { sessionId, status: 'closed' };
  });
});

exports.leaveSandboxWithoutConsumption = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  const participant = session.collection('participants').doc(request.auth.uid);
  return getFirestore().runTransaction(async (tx) => {
    const [sessionDoc, person] = await Promise.all([tx.get(session), tx.get(participant)]);
    if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !person.exists || person.data().authUid !== request.auth.uid) throw new HttpsError('permission-denied', 'Sem acesso à sessão.');
    if (person.data().status === 'left') return { status: 'left' };
    if (person.data().status !== 'active') throw new HttpsError('failed-precondition', 'Participação não está aberta.');
    const refs = await tx.get(participant.collection('orderRefs').limit(101));
    if (refs.size > 100) throw new HttpsError('resource-exhausted', 'Muitos pedidos.');
    const groups = await Promise.all(refs.docs.map((ref) => tx.get(session.collection('orders').doc(ref.id).collection('items').limit(101))));
    if (groups.some((group) => group.size > 100)) throw new HttpsError('resource-exhausted', 'Muitos itens.');
    const items = groups.flatMap((group) => group.docs);
    const shares = await Promise.all(items.map((item) => tx.get(item.ref.collection('shares').doc(request.auth.uid))));
    for (let i = 0; i < items.length; i++) {
      if (shares[i].exists && !['cancelled', 'unavailable'].includes(items[i].data().status)) throw new HttpsError('failed-precondition', 'Existem itens ou divisões que impedem a saída.');
    }
    tx.update(participant, { status: 'left', leftAt: FieldValue.serverTimestamp() });
    tx.create(session.collection('events').doc(), { action: 'sandbox_participant_left', actorId: request.auth.uid, occurredAt: FieldValue.serverTimestamp() });
    return { status: 'left' };
  });
});
