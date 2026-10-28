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
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { createHash } = require('node:crypto');
const adminOptions = {};
if (process.env.FIREBASE_PROJECT_ID) adminOptions.projectId = process.env.FIREBASE_PROJECT_ID;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try { adminOptions.credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON inválido.'); }
}
initializeApp(adminOptions);

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

// Produtos legados usam `sector`; novos produtos podem usar `sectors`.
function productSectors(product) {
  const sectors = product.sectors === undefined ? [product.sector] : product.sectors;
  if (!Array.isArray(sectors) || !sectors.length || sectors.length > 2 || new Set(sectors).size !== sectors.length || sectors.some((s) => !['bar', 'kitchen'].includes(s))) return null;
  return [...sectors].sort();
}
function queueId(itemId, sector, sectors) {
  return sectors.length === 1 ? itemId : `${itemId}--${sector}`;
}
function queueEntries(tx, restaurant, itemId, sectors, fields) {
  for (const sector of sectors) tx.create(restaurant.collection('workQueue').doc(queueId(itemId, sector, sectors)), { ...fields, itemId, sector, status: 'received', createdAt: FieldValue.serverTimestamp() });
}
function aggregateSectorStatus(statuses) {
  const values = Object.values(statuses);
  if (values.includes('unavailable')) return values.every((s) => s === 'unavailable') ? 'unavailable' : 'attention_required';
  const order = ['received', 'in_preparation', 'ready', 'picked_up', 'delivered'];
  if (!values.length || values.some((value) => !order.includes(value))) throw new HttpsError('failed-precondition', 'Estado de setor inválido.');
  return order[Math.min(...values.map((value) => order.indexOf(value)))];
}

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
    const result = { id: item.id, name: data.name, description: data.description || '', priceCents: data.priceCents };
    if (data.sectors !== undefined) result.sectors = data.sectors; else result.sector = data.sector;
    if (data.photoUrl) result.photoUrl = data.photoUrl;
    return result;
  }) };
});

exports.createOrder = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, requestId, items } = request.data || {};
  if (![restaurantId, sessionId, requestId].every(validId) || !Array.isArray(items) || !items.length || items.length > 20 || items.some((item) => !item || Object.keys(item).some((key) => !['menuItemId', 'quantity', 'notes', 'inviteeIds'].includes(key)) || !validId(item.menuItemId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || (item.notes !== undefined && (typeof item.notes !== 'string' || item.notes.length > 500)) || (item.inviteeIds !== undefined && (!Array.isArray(item.inviteeIds) || item.inviteeIds.length > 19 || item.inviteeIds.some((id) => !validId(id) || id === request.auth.uid) || new Set(item.inviteeIds).size !== item.inviteeIds.length)))) {
    throw new HttpsError('invalid-argument', 'Dados do pedido inválidos.');
  }
  if (items.reduce((sum, item) => sum + (item.inviteeIds || []).length, 0) > 130) throw new HttpsError('invalid-argument', 'Convites demais no pedido.');
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
      if (!snapshot.exists || product.available !== true || typeof product.name !== 'string' || !Number.isSafeInteger(product.priceCents) || product.priceCents < 0 || !productSectors(product) || !Number.isSafeInteger(product.priceCents * item.quantity)) {
        throw new HttpsError('failed-precondition', 'Produto indisponível ou inválido.');
      }
      return { ...item, nameSnapshot: product.name, unitPriceCents: product.priceCents, totalCents: product.priceCents * item.quantity, sectorSnapshot: productSectors(product)[0], sectorsSnapshot: productSectors(product), status: item.inviteeIds.length ? 'awaiting_split' : 'received' };
    });
    transaction.create(order, { createdByParticipantId: participant.id, createdAt: FieldValue.serverTimestamp() });
    for (const id of new Set([participant.id, ...invitedIds])) {
      transaction.set(session.collection('participants').doc(id).collection('orderRefs').doc(order.id), { orderId: order.id, createdAt: FieldValue.serverTimestamp() });
    }
    for (const item of snapshots) {
      const itemRef = order.collection('items').doc();
      const { inviteeIds, ...storedItem } = item;
      const participantIds = [participant.id, ...inviteeIds].sort();
      transaction.create(itemRef, { ...storedItem, participantIds, sectorStatuses: Object.fromEntries(storedItem.sectorsSnapshot.map((sector) => [sector, 'received'])) });
      if (storedItem.status === 'received') queueEntries(transaction, restaurant, itemRef.id, storedItem.sectorsSnapshot, { sessionId, tableId: sessionSnapshot.data().tableId, orderId: order.id, name: storedItem.nameSnapshot, quantity: storedItem.quantity, notes: storedItem.notes });
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
      queueEntries(transaction, restaurant, itemId, data.sectorsSnapshot || [data.sectorSnapshot], { sessionId, tableId: sessionSnapshot.data().tableId, orderId, name: data.nameSnapshot, quantity: data.quantity, notes: data.notes });
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
      transaction.create(replacement, { menuItemId: old.menuItemId, quantity: old.quantity, notes: old.notes, nameSnapshot: old.nameSnapshot, unitPriceCents: old.unitPriceCents, totalCents: old.totalCents, sectorSnapshot: old.sectorSnapshot, sectorsSnapshot: old.sectorsSnapshot || [old.sectorSnapshot], sectorStatuses: Object.fromEntries((old.sectorsSnapshot || [old.sectorSnapshot]).map((sector) => [sector, 'received'])), status: normalized.length ? 'awaiting_split' : 'received', participantIds, previousItemId: itemId });
      if (!normalized.length) queueEntries(transaction, getFirestore().collection('restaurants').doc(restaurantId), replacement.id, old.sectorsSnapshot || [old.sectorSnapshot], { sessionId, tableId: sessionDoc.data().tableId, orderId, name: old.nameSnapshot, quantity: old.quantity, notes: old.notes });
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
  const [staff, device] = await Promise.all([restaurant.collection('staff').doc(request.auth.uid).get(), restaurant.collection('devices').doc(request.auth.uid).get()]);
  if (!permittedOperationalDevice(staff, device, sector)) throw new HttpsError('permission-denied', 'Sem permissão para este setor.');
  const queue = await restaurant.collection('workQueue').where('sector', '==', sector).where('status', 'in', ['received', 'in_preparation', 'ready']).limit(100).get();
  return { items: queue.docs.map((doc) => {
    const { sessionId, tableId, orderId, itemId, status, name, quantity, notes } = doc.data();
    return { sessionId, tableId, orderId, itemId, status, name, quantity, notes };
  }).filter((item) => ['received', 'in_preparation', 'ready'].includes(item.status)) };
});

exports.transitionItem = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, itemId, action, sector } = request.data || {};
  const transitions = { start: ['received', 'in_preparation'], ready: ['in_preparation', 'ready'], pickup: ['ready', 'picked_up'], deliver: ['picked_up', 'delivered'] };
  if (!validId(restaurantId) || !validId(itemId) || !Object.hasOwn(transitions, action)) throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  if (sector !== undefined && !['bar', 'kitchen'].includes(sector)) throw new HttpsError('invalid-argument', 'Setor inválido.');
  const queue = restaurant.collection('workQueue').doc(sector ? `${itemId}--${sector}` : itemId);
  const legacyQueue = restaurant.collection('workQueue').doc(itemId);
  const staff = restaurant.collection('staff').doc(request.auth.uid);
  return getFirestore().runTransaction(async (transaction) => {
    const [staffDoc, deviceDoc, primary, legacy] = await Promise.all([transaction.get(staff), transaction.get(restaurant.collection('devices').doc(request.auth.uid)), transaction.get(queue), ...(sector ? [transaction.get(legacyQueue)] : [Promise.resolve(null)])]);
    const entry = primary.exists ? primary : legacy;
    if (!entry || !entry.exists || (sector && entry.data().sector !== sector)) throw new HttpsError('not-found', 'Item não encontrado.');
    const data = entry.data();
    const required = ['start', 'ready'].includes(action) ? data.sector : 'waiter';
    if (!permittedOperationalDevice(staffDoc, deviceDoc, required)) throw new HttpsError('permission-denied', 'Sem permissão para esta operação.');
    const item = restaurant.collection('sessions').doc(data.sessionId).collection('orders').doc(data.orderId).collection('items').doc(itemId);
    const itemDoc = await transaction.get(item);
    const sectorStatuses = itemDoc.data()?.sectorStatuses || { [data.sector]: itemDoc.data()?.status };
    if (!itemDoc.exists || data.status !== transitions[action][0] || sectorStatuses[data.sector] !== data.status) throw new HttpsError('failed-precondition', 'Transição inválida.');
    const status = transitions[action][1];
    sectorStatuses[data.sector] = status;
    const itemStatus = aggregateSectorStatus(sectorStatuses);
    transaction.update(entry.ref, { status, updatedAt: FieldValue.serverTimestamp() });
    transaction.update(item, { status: itemStatus, sectorStatuses, updatedAt: FieldValue.serverTimestamp() });
    transaction.create(restaurant.collection('sessions').doc(data.sessionId).collection('events').doc(), { action: `item_${status}`, actorId: request.auth.uid, targetId: itemId, occurredAt: FieldValue.serverTimestamp() });
    return { itemId, status };
  });
});

exports.listReadyItems = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId } = request.data || {};
  if (!validId(restaurantId)) throw new HttpsError('invalid-argument', 'Restaurante inválido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const [staff, device] = await Promise.all([restaurant.collection('staff').doc(request.auth.uid).get(), restaurant.collection('devices').doc(request.auth.uid).get()]);
  if (!permittedOperationalDevice(staff, device, 'waiter')) throw new HttpsError('permission-denied', 'Sem permissão de garçom.');
  const queue = await restaurant.collection('workQueue').where('status', 'in', ['ready', 'picked_up']).limit(100).get();
  return { items: queue.docs.map((doc) => {
    const { sessionId, tableId, orderId, itemId, sector, status, name, quantity, notes } = doc.data();
    return { sessionId, tableId, orderId, itemId, sector, status, name, quantity, notes };
  }) };
});

exports.markItemUnavailable = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, itemId, reason, sector } = request.data || {};
  if (!validId(restaurantId) || !validId(itemId) || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw new HttpsError('invalid-argument', 'Informe um motivo válido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  if (sector !== undefined && !['bar', 'kitchen'].includes(sector)) throw new HttpsError('invalid-argument', 'Setor inválido.');
  const queue = restaurant.collection('workQueue').doc(sector ? `${itemId}--${sector}` : itemId);
  const legacyQueue = restaurant.collection('workQueue').doc(itemId);
  const staff = restaurant.collection('staff').doc(request.auth.uid);
  return getFirestore().runTransaction(async (transaction) => {
    const [staffDoc, deviceDoc, primary, legacy] = await Promise.all([transaction.get(staff), transaction.get(restaurant.collection('devices').doc(request.auth.uid)), transaction.get(queue), ...(sector ? [transaction.get(legacyQueue)] : [Promise.resolve(null)])]);
    const entry = primary.exists ? primary : legacy;
    if (!entry || !entry.exists || (sector && entry.data().sector !== sector)) throw new HttpsError('not-found', 'Item não encontrado.');
    const data = entry.data();
    if (!permittedOperationalDevice(staffDoc, deviceDoc, data.sector)) throw new HttpsError('permission-denied', 'Sem permissão para este setor.');
    const session = restaurant.collection('sessions').doc(data.sessionId);
    const item = session.collection('orders').doc(data.orderId).collection('items').doc(itemId);
    const itemDoc = await transaction.get(item);
    const sectorStatuses = itemDoc.data()?.sectorStatuses || { [data.sector]: itemDoc.data()?.status };
    if (!itemDoc.exists || !['received', 'in_preparation'].includes(data.status) || sectorStatuses[data.sector] !== data.status) throw new HttpsError('failed-precondition', 'Item não pode ser marcado indisponível.');
    sectorStatuses[data.sector] = 'unavailable';
    transaction.update(entry.ref, { status: 'unavailable', updatedAt: FieldValue.serverTimestamp() });
    transaction.update(item, { status: aggregateSectorStatus(sectorStatuses), sectorStatuses, unavailableReason: reason.trim(), updatedAt: FieldValue.serverTimestamp() });
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
    return { itemId: item.id, name: data.nameSnapshot, quantity: data.quantity, totalCents: data.totalCents, amountCents: share.data().amountCents, acceptanceStatus: share.data().acceptanceStatus, status: data.status, sectorStatuses: data.sectorStatuses || null, unavailableReason: data.unavailableReason || null };
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
      const share = await transaction.get(item.ref.collection('shares').doc(request.auth.uid));
      if (!share.exists || share.data().acceptanceStatus !== 'accepted') return 0;
      if (item.data().status === 'attention_required') throw new HttpsError('failed-precondition', 'Item com indisponibilidade parcial requer revisão.');
      if (!['received', 'in_preparation', 'ready', 'picked_up', 'delivered'].includes(item.data().status)) return 0;
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

exports.listSandboxPaymentsForReview = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const staff = await restaurant.collection('staff').doc(request.auth.uid).get();
  if (!staff.exists || staff.data().active !== true || !Array.isArray(staff.data().roles) || !staff.data().roles.some((role) => ['waiter', 'manager'].includes(role))) throw new HttpsError('permission-denied', 'Sem permissão para conferir pagamento.');
  const results = await restaurant.collection('sessions').doc(sessionId).collection('paymentAttempts').where('status', '==', 'proof_submitted').limit(101).get();
  if (results.size > 100) throw new HttpsError('resource-exhausted', 'Muitos pagamentos para consulta.');
  return { payments: results.docs.map((doc) => {
    const { participantId, consumptionCents, serviceCents, totalCents, status } = doc.data();
    return { paymentId: doc.id, participantId, consumptionCents, serviceCents, totalCents, status };
  }) };
});

exports.getSandboxPayment = onCall(async (request) => {
  requireEmulator();
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, paymentId } = request.data || {};
  if (![restaurantId, sessionId, paymentId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const payment = await getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId).collection('paymentAttempts').doc(paymentId).get();
  if (!payment.exists || payment.data().participantId !== request.auth.uid) throw new HttpsError('permission-denied', 'Sem acesso ao pagamento.');
  const { consumptionCents, serviceCents, totalCents, status } = payment.data();
  return { paymentId, consumptionCents, serviceCents, totalCents, status };
});

exports.listSessionParticipants = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId } = request.data || {};
  if (![restaurantId, sessionId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const session = getFirestore().collection('restaurants').doc(restaurantId).collection('sessions').doc(sessionId);
  return getFirestore().runTransaction(async (tx) => {
    const [sessionDoc, requester] = await Promise.all([tx.get(session), tx.get(session.collection('participants').doc(request.auth.uid))]);
    if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !requester.exists || requester.data().status !== 'active' || requester.data().authUid !== request.auth.uid) throw new HttpsError('permission-denied', 'Participante sem acesso à sessão.');
    const participants = await tx.get(session.collection('participants').where('status', '==', 'active').limit(101));
    if (participants.size > 100) throw new HttpsError('resource-exhausted', 'Muitos participantes; paginação necessária.');
    return { participants: participants.docs.map((doc) => ({ participantId: doc.id, displayName: doc.data().displayName })) };
  }, { readOnly: true });
});

// A identidade do administrador deve ser provisionada de forma confiável antes do uso.
exports.saveAdminProduct = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const secondFactor = request.auth.token?.firebase?.sign_in_second_factor;
  if (typeof secondFactor !== 'string' || !secondFactor) throw new HttpsError('permission-denied', 'Autenticação em duas etapas necessária.');
  const { restaurantId, productId, name, description = '', priceCents, sectors, available, photoUrl = '' } = request.data || {};
  if (![restaurantId, productId].every(validId) || typeof name !== 'string' || !name.trim() || name.trim().length > 120 || typeof description !== 'string' || description.length > 1000 || !Number.isSafeInteger(priceCents) || priceCents < 0 || !productSectors({ sectors }) || typeof available !== 'boolean' || typeof photoUrl !== 'string' || photoUrl.length > 2048) throw new HttpsError('invalid-argument', 'Produto inválido.');
  if (photoUrl) {
    try { const url = new URL(photoUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); }
    catch { throw new HttpsError('invalid-argument', 'URL da foto deve usar HTTPS.'); }
  }
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const product = restaurant.collection('menuItems').doc(productId);
  return getFirestore().runTransaction(async (transaction) => {
    const [membership, restaurantDoc] = await Promise.all([
      transaction.get(restaurant.collection('admins').doc(request.auth.uid)), transaction.get(restaurant)
    ]);
    if (!membership.exists || membership.data().active !== true || !restaurantDoc.exists) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    transaction.set(product, { name: name.trim(), description: description.trim(), priceCents, sectors: productSectors({ sectors }), available, photoUrl, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.create(restaurant.collection('adminEvents').doc(), { action: 'product_saved', actorId: request.auth.uid, targetId: productId, occurredAt: FieldValue.serverTimestamp() });
    return { productId };
  });
});

function staffCodeDigest(restaurantId, code) {
  const pepper = process.env.STAFF_CODE_PEPPER;
  if (typeof pepper !== 'string' || pepper.length < 32) throw new HttpsError('failed-precondition', 'Configuração segura dos códigos ausente.');
  return require('node:crypto').createHmac('sha256', pepper).update(JSON.stringify([restaurantId, code])).digest('hex');
}
function requireAdminSecondFactor(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const factor = request.auth.token?.firebase?.sign_in_second_factor;
  if (typeof factor !== 'string' || !factor) throw new HttpsError('permission-denied', 'Autenticação em duas etapas necessária.');
}
exports.createEmployeeCode = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId, employeeId, displayName, role } = request.data || {};
  if (![restaurantId, employeeId].every(validId) || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 120 || !['waiter', 'manager'].includes(role)) throw new HttpsError('invalid-argument', 'Dados de funcionário inválidos.');
  const code = String(require('node:crypto').randomInt(0, 100000000)).padStart(8, '0');
  const digest = staffCodeDigest(restaurantId, code);
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const employee = restaurant.collection('employees').doc(employeeId);
  const index = restaurant.collection('employeeCodeIndex').doc(digest);
  await getFirestore().runTransaction(async (tx) => {
    const [admin, establishment, existing, collision] = await Promise.all([
      tx.get(restaurant.collection('admins').doc(request.auth.uid)), tx.get(restaurant), tx.get(employee), tx.get(index)
    ]);
    if (!admin.exists || admin.data().active !== true || !establishment.exists) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    if (existing.exists) throw new HttpsError('already-exists', 'Funcionário já cadastrado.');
    if (collision.exists) throw new HttpsError('aborted', 'Não foi possível gerar o código; tente novamente.');
    tx.create(employee, { displayName: displayName.trim(), role, active: true, codeDigest: digest, createdAt: FieldValue.serverTimestamp() });
    tx.create(index, { employeeId, active: true });
    tx.create(restaurant.collection('adminEvents').doc(), { action: 'employee_created', actorId: request.auth.uid, targetId: employeeId, occurredAt: FieldValue.serverTimestamp() });
  });
  // O código é devolvido apenas uma vez. Nunca armazená-lo ou registrá-lo em logs.
  return { employeeId, code };
});

exports.disableEmployeeCode = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId, employeeId } = request.data || {};
  if (![restaurantId, employeeId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const employee = restaurant.collection('employees').doc(employeeId);
  return getFirestore().runTransaction(async (tx) => {
    const [admin, existing] = await Promise.all([tx.get(restaurant.collection('admins').doc(request.auth.uid)), tx.get(employee)]);
    if (!admin.exists || admin.data().active !== true) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    if (!existing.exists) throw new HttpsError('not-found', 'Funcionário não encontrado.');
    if (existing.data().active !== true) return { employeeId, active: false };
    const digest = existing.data().codeDigest;
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new HttpsError('failed-precondition', 'Registro de código inválido.');
    tx.update(employee, { active: false, disabledAt: FieldValue.serverTimestamp() });
    tx.update(restaurant.collection('employeeCodeIndex').doc(digest), { active: false });
    tx.create(restaurant.collection('adminEvents').doc(), { action: 'employee_disabled', actorId: request.auth.uid, targetId: employeeId, occurredAt: FieldValue.serverTimestamp() });
    return { employeeId, active: false };
  });
});

exports.listAdminProducts = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId } = request.data || {};
  if (!validId(restaurantId)) throw new HttpsError('invalid-argument', 'Restaurante inválido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  return getFirestore().runTransaction(async (tx) => {
    const admin = await tx.get(restaurant.collection('admins').doc(request.auth.uid));
    if (!admin.exists || admin.data().active !== true) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    const products = await tx.get(restaurant.collection('menuItems').limit(101));
    if (products.size > 100) throw new HttpsError('resource-exhausted', 'Muitos produtos; paginação necessária.');
    return { products: products.docs.map((doc) => {
      const data = doc.data();
      return { productId: doc.id, name: data.name, description: data.description || '', priceCents: data.priceCents, sectors: productSectors(data), available: data.available === true, photoUrl: data.photoUrl || '' };
    }) };
  }, { readOnly: true });
});

exports.listAdminEmployees = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId } = request.data || {};
  if (!validId(restaurantId)) throw new HttpsError('invalid-argument', 'Restaurante inválido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  return getFirestore().runTransaction(async (tx) => {
    const admin = await tx.get(restaurant.collection('admins').doc(request.auth.uid));
    if (!admin.exists || admin.data().active !== true) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    const employees = await tx.get(restaurant.collection('employees').limit(101));
    if (employees.size > 100) throw new HttpsError('resource-exhausted', 'Muitos funcionários; paginação necessária.');
    return { employees: employees.docs.map((doc) => ({ employeeId: doc.id, displayName: doc.data().displayName, role: doc.data().role, active: doc.data().active === true })) };
  }, { readOnly: true });
});

// Tentações inválidas são contabilizadas na transação antes de retornar erro.
async function readEmployeeAuthorization(tx, restaurant, code) {
  if (typeof code !== 'string' || !/^\d{8}$/.test(code)) throw new HttpsError('invalid-argument', 'Código deve ter oito dígitos.');
  const now = Date.now();
  const digest = staffCodeDigest(restaurant.id, code);
  const limit = restaurant.collection('security').doc('employeeCodeAttempts');
  const [limitDoc, index] = await Promise.all([tx.get(limit), tx.get(restaurant.collection('employeeCodeIndex').doc(digest))]);
  const previous = limitDoc.data() || {};
  const withinWindow = Number.isSafeInteger(previous.windowStartMs) && now >= previous.windowStartMs && now - previous.windowStartMs < 300000;
  const count = withinWindow && Number.isSafeInteger(previous.failures) ? previous.failures : 0;
  if (count >= 10) throw new HttpsError('resource-exhausted', 'Muitas tentativas. Tente mais tarde.');
  let employee = null;
  if (index.exists && index.data().active === true && validId(index.data().employeeId)) {
    employee = await tx.get(restaurant.collection('employees').doc(index.data().employeeId));
  }
  return { now, limit, windowStartMs: withinWindow ? previous.windowStartMs : now, count, employee, digest, index };
}
function employeeAllowed(auth, roles) {
  return auth.employee?.exists && auth.employee.data().active === true && auth.employee.data().codeDigest === auth.digest && roles.includes(auth.employee.data().role);
}
function recordInvalidCode(tx, auth) {
  tx.set(auth.limit, { windowStartMs: auth.windowStartMs, failures: auth.count + 1 });
}
function activeDevice(doc, screen, now) {
  return doc.exists && doc.data().active === true && doc.data().screen === screen && Number.isSafeInteger(doc.data().expiresAtMs) && doc.data().expiresAtMs > now;
}
function permittedOperationalDevice(staff, device, role) {
  const screen = role === 'waiter' ? 'plaza' : role;
  if (activeDevice(device, screen, Date.now())) return true;
  return process.env.FUNCTIONS_EMULATOR === 'true' && staff.exists && staff.data().active === true && Array.isArray(staff.data().roles) && staff.data().roles.includes(role);
}

exports.activateSharedDevice = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, screen, code } = request.data || {};
  if (!validId(restaurantId) || !['plaza', 'bar', 'kitchen'].includes(screen)) throw new HttpsError('invalid-argument', 'Dados inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const result = await getFirestore().runTransaction(async (tx) => {
    const authorization = await readEmployeeAuthorization(tx, restaurant, code);
    if (!employeeAllowed(authorization, ['manager'])) { recordInvalidCode(tx, authorization); return { denied: true }; }
    const device = restaurant.collection('devices').doc(request.auth.uid);
    tx.set(device, { active: true, screen, activatedBy: authorization.employee.id, expiresAtMs: authorization.now + 12 * 60 * 60 * 1000, activatedAt: FieldValue.serverTimestamp() });
    tx.create(restaurant.collection('adminEvents').doc(), { action: 'device_activated', actorId: authorization.employee.id, targetId: request.auth.uid, screen, occurredAt: FieldValue.serverTimestamp() });
    return { screen, expiresAtMs: authorization.now + 12 * 60 * 60 * 1000 };
  });
  if (result.denied) throw new HttpsError('permission-denied', 'Código não autorizado.');
  return result;
});

exports.openTableWithCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, tableId, requestId, code } = request.data || {};
  if (![restaurantId, tableId, requestId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const device = restaurant.collection('devices').doc(request.auth.uid);
  const table = restaurant.collection('tables').doc(tableId);
  const session = restaurant.collection('sessions').doc();
  const key = createHash('sha256').update(JSON.stringify([request.auth.uid, requestId])).digest('hex');
  const operation = restaurant.collection('sessionOpenRequests').doc(key);
  const result = await getFirestore().runTransaction(async (tx) => {
    const authorization = await readEmployeeAuthorization(tx, restaurant, code);
    const [deviceDoc, tableDoc, prior] = await Promise.all([tx.get(device), tx.get(table), tx.get(operation)]);
    if (!activeDevice(deviceDoc, 'plaza', authorization.now)) throw new HttpsError('permission-denied', 'Dispositivo da praça não autorizado.');
    if (!employeeAllowed(authorization, ['waiter', 'manager'])) { recordInvalidCode(tx, authorization); return { denied: true }; }
    const actorId = authorization.employee.id;
    if (prior.exists) {
      if (prior.data().tableId !== tableId || prior.data().employeeId !== actorId) throw new HttpsError('already-exists', 'Identificador já utilizado.');
      return { sessionId: prior.data().sessionId, tableId, status: 'open' };
    }
    if (!tableDoc.exists) throw new HttpsError('not-found', 'Mesa não encontrada.');
    if (tableDoc.data().activeSessionId) throw new HttpsError('failed-precondition', 'Mesa já possui sessão ativa.');
    tx.create(session, { tableId, status: 'open', openedAt: FieldValue.serverTimestamp(), openedByEmployeeId: actorId });
    tx.update(table, { activeSessionId: session.id });
    tx.create(operation, { tableId, employeeId: actorId, sessionId: session.id, createdAt: FieldValue.serverTimestamp() });
    tx.create(session.collection('events').doc(), { action: 'session_opened', actorId, actorType: 'employee', occurredAt: FieldValue.serverTimestamp() });
    return { sessionId: session.id, tableId, status: 'open' };
  });
  if (result.denied) throw new HttpsError('permission-denied', 'Código não autorizado.');
  return result;
});

exports.cancelItemWithCode = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Autenticação necessária.');
  const { restaurantId, sessionId, orderId, itemId, code, reason } = request.data || {};
  if (![restaurantId, sessionId, orderId, itemId].every(validId) || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw new HttpsError('invalid-argument', 'Dados ou motivo inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const session = restaurant.collection('sessions').doc(sessionId);
  const item = session.collection('orders').doc(orderId).collection('items').doc(itemId);
  const result = await getFirestore().runTransaction(async (tx) => {
    const authorization = await readEmployeeAuthorization(tx, restaurant, code);
    const [device, sessionDoc, itemDoc] = await Promise.all([tx.get(restaurant.collection('devices').doc(request.auth.uid)), tx.get(session), tx.get(item)]);
    if (!activeDevice(device, 'plaza', authorization.now)) throw new HttpsError('permission-denied', 'Dispositivo da praça não autorizado.');
    if (!employeeAllowed(authorization, ['waiter', 'manager'])) { recordInvalidCode(tx, authorization); return { denied: true }; }
    if (!sessionDoc.exists || sessionDoc.data().status !== 'open' || !itemDoc.exists) throw new HttpsError('failed-precondition', 'Sessão ou item inválido.');
    const data = itemDoc.data();
    const statuses = data.sectorStatuses || { [data.sectorSnapshot]: data.status };
    const started = Object.values(statuses).some((status) => ['in_preparation', 'ready', 'picked_up', 'delivered', 'unavailable'].includes(status));
    if (started && authorization.employee.data().role !== 'manager') throw new HttpsError('permission-denied', 'Somente gerente pode cancelar após o início do preparo.');
    if (data.status === 'cancelled') return { itemId, status: 'cancelled' };
    if (!['awaiting_split', 'split_rejected', 'received', 'in_preparation', 'ready', 'picked_up', 'delivered', 'attention_required'].includes(data.status) || !Array.isArray(data.participantIds) || data.participantIds.some((id) => !validId(id))) throw new HttpsError('failed-precondition', 'Item não pode ser cancelado.');
    const sectors = data.sectorsSnapshot || [data.sectorSnapshot];
    if (!productSectors({ sectors })) throw new HttpsError('failed-precondition', 'Setores inválidos.');
    const [people, invitations, queues] = await Promise.all([
      Promise.all(data.participantIds.map((id) => tx.get(session.collection('participants').doc(id)))),
      Promise.all(data.participantIds.map((id) => tx.get(session.collection('participants').doc(id).collection('invitations').doc(itemId)))),
      Promise.all(sectors.map((sector) => tx.get(restaurant.collection('workQueue').doc(queueId(itemId, sector, sectors)))))
    ]);
    if (people.some((person) => !person.exists || person.data().status !== 'active')) throw new HttpsError('failed-precondition', 'Comanda indisponível ou pagamento em andamento; revise com o gestor.');
    for (const invitation of invitations) if (invitation.exists && invitation.data().acceptanceStatus === 'pending') tx.update(invitation.ref, { acceptanceStatus: 'cancelled' });
    for (const queue of queues) if (queue.exists) tx.update(queue.ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() });
    tx.update(item, { status: 'cancelled', cancellationReason: reason.trim(), cancelledAt: FieldValue.serverTimestamp(), cancelledByEmployeeId: authorization.employee.id });
    tx.create(session.collection('events').doc(), { action: 'item_cancelled', actorId: authorization.employee.id, actorType: 'employee', targetId: itemId, reason: reason.trim(), occurredAt: FieldValue.serverTimestamp() });
    return { itemId, status: 'cancelled' };
  });
  if (result.denied) throw new HttpsError('permission-denied', 'Código não autorizado.');
  return result;
});

exports.rotateEmployeeCode = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId, employeeId } = request.data || {};
  if (![restaurantId, employeeId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const code = String(require('node:crypto').randomInt(0, 100000000)).padStart(8, '0');
  const digest = staffCodeDigest(restaurantId, code);
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const employee = restaurant.collection('employees').doc(employeeId);
  await getFirestore().runTransaction(async (tx) => {
    const [admin, existing, collision] = await Promise.all([tx.get(restaurant.collection('admins').doc(request.auth.uid)), tx.get(employee), tx.get(restaurant.collection('employeeCodeIndex').doc(digest))]);
    if (!admin.exists || admin.data().active !== true) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    if (!existing.exists || existing.data().active !== true) throw new HttpsError('failed-precondition', 'Funcionário ausente ou desativado.');
    if (collision.exists) throw new HttpsError('aborted', 'Não foi possível gerar o código; tente novamente.');
    const oldDigest = existing.data().codeDigest;
    if (typeof oldDigest !== 'string' || !/^[a-f0-9]{64}$/.test(oldDigest)) throw new HttpsError('failed-precondition', 'Registro de código inválido.');
    tx.update(restaurant.collection('employeeCodeIndex').doc(oldDigest), { active: false });
    tx.create(restaurant.collection('employeeCodeIndex').doc(digest), { employeeId, active: true });
    tx.update(employee, { codeDigest: digest, codeRotatedAt: FieldValue.serverTimestamp() });
    tx.create(restaurant.collection('adminEvents').doc(), { action: 'employee_code_rotated', actorId: request.auth.uid, targetId: employeeId, occurredAt: FieldValue.serverTimestamp() });
  });
  return { employeeId, code };
});

exports.listAdminDevices = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId } = request.data || {};
  if (!validId(restaurantId)) throw new HttpsError('invalid-argument', 'Restaurante inválido.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  return getFirestore().runTransaction(async (tx) => {
    const admin = await tx.get(restaurant.collection('admins').doc(request.auth.uid));
    if (!admin.exists || admin.data().active !== true) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    const devices = await tx.get(restaurant.collection('devices').limit(101));
    if (devices.size > 100) throw new HttpsError('resource-exhausted', 'Muitos dispositivos; paginação necessária.');
    return { devices: devices.docs.map((doc) => ({ deviceId: doc.id, screen: doc.data().screen, active: doc.data().active === true, expiresAtMs: doc.data().expiresAtMs })) };
  }, { readOnly: true });
});
exports.disableSharedDevice = onCall(async (request) => {
  requireAdminSecondFactor(request);
  const { restaurantId, deviceId } = request.data || {};
  if (![restaurantId, deviceId].every(validId)) throw new HttpsError('invalid-argument', 'IDs inválidos.');
  const restaurant = getFirestore().collection('restaurants').doc(restaurantId);
  const device = restaurant.collection('devices').doc(deviceId);
  return getFirestore().runTransaction(async (tx) => {
    const [admin, existing] = await Promise.all([tx.get(restaurant.collection('admins').doc(request.auth.uid)), tx.get(device)]);
    if (!admin.exists || admin.data().active !== true) throw new HttpsError('permission-denied', 'Sem permissão administrativa.');
    if (!existing.exists) throw new HttpsError('not-found', 'Dispositivo não encontrado.');
    if (existing.data().active === true) {
      tx.update(device, { active: false, disabledAt: FieldValue.serverTimestamp() });
      tx.create(restaurant.collection('adminEvents').doc(), { action: 'device_disabled', actorId: request.auth.uid, targetId: deviceId, occurredAt: FieldValue.serverTimestamp() });
    }
    return { deviceId, active: false };
  });
});
