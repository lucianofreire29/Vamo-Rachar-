const { initializeApp, cert } = require('../functions/node_modules/firebase-admin/app');
const { getFirestore, FieldValue } = require('../functions/node_modules/firebase-admin/firestore');
const { getAuth } = require('../functions/node_modules/firebase-admin/auth');

const RESTAURANT_ID = process.env.SEED_RESTAURANT_ID || 'restaurante-demo';
const STAFF_UID = process.env.SEED_STAFF_UID || 'staff-gerente-demo';
const STAFF_EMAIL = process.env.SEED_STAFF_EMAIL || 'equipe@vamorachar.demo';
const STAFF_PASSWORD = process.env.SEED_STAFF_PASSWORD || 'VamoRachar@2026';

const adminOptions = {
  projectId: process.env.FIREBASE_PROJECT_ID || 'demo-vamo-rachar'
};

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  adminOptions.credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
}

initializeApp(adminOptions);

const MENU_ITEMS = [
  {
    id: 'fries',
    name: 'Fritas da casa',
    description: 'Crocantes, com aioli de ervas.',
    detail: 'Porção de 400 g de batatas douradas e crocantes, acompanhadas de aioli de ervas.',
    priceCents: 3600,
    category: 'Porções',
    sector: 'kitchen',
    image: 'fries.png',
    available: true
  },
  {
    id: 'burger',
    name: 'Burger da casa',
    description: 'Brioche, carne e cheddar.',
    detail: 'Pão brioche, hambúrguer da casa e cheddar. Feito na hora.',
    priceCents: 3200,
    category: 'Lanches',
    sector: 'kitchen',
    image: 'burger.png',
    available: true
  },
  {
    id: 'lemonade',
    name: 'Limonada natural',
    description: 'Limão fresquinho. Copo 400 mL.',
    detail: 'Limão fresquinho e gelo. Copo de 400 mL.',
    priceCents: 1000,
    category: 'Bebidas',
    sector: 'bar',
    image: 'lemonade.png',
    available: true
  }
];

async function ensureStaffIdentity(auth, db, restaurantRef) {
  try {
    await auth.getUser(STAFF_UID);
    await auth.updateUser(STAFF_UID, {
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
      displayName: 'Equipe Vamo Rachar'
    });
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      await auth.createUser({
        uid: STAFF_UID,
        email: STAFF_EMAIL,
        password: STAFF_PASSWORD,
        displayName: 'Equipe Vamo Rachar'
      });
    } else {
      throw err;
    }
  }

  await restaurantRef.collection('staff').doc(STAFF_UID).set(
    {
      active: true,
      roles: ['waiter', 'manager', 'kitchen', 'bar'],
      email: STAFF_EMAIL,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function seedPrototypeData() {
  const db = getFirestore();
  const auth = getAuth();
  const restaurantRef = db.collection('restaurants').doc(RESTAURANT_ID);

  await restaurantRef.set(
    {
      name: 'Vamo Rachar Demo Bar',
      active: true,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await ensureStaffIdentity(auth, db, restaurantRef);

  for (const item of MENU_ITEMS) {
    const { id, ...data } = item;
    await restaurantRef.collection('menuItems').doc(id).set(
      {
        ...data,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }

  for (let i = 1; i <= 20; i++) {
    const tableId = `mesa-${String(i).padStart(2, '0')}`;
    const tableRef = restaurantRef.collection('tables').doc(tableId);
    const tableSnap = await tableRef.get();

    if (!tableSnap.exists) {
      await tableRef.set({
        number: i,
        label: `Mesa ${i}`,
        activeSessionId: null,
        createdAt: FieldValue.serverTimestamp()
      });
    }
  }

  const mainTableId = 'mesa-13';
  const mainTableRef = restaurantRef.collection('tables').doc(mainTableId);
  let activeSessionId = null;

  await db.runTransaction(async (tx) => {
    const tableDoc = await tx.get(mainTableRef);
    const existingSessionId = tableDoc.data()?.activeSessionId;

    if (existingSessionId) {
      const sessionDoc = await tx.get(restaurantRef.collection('sessions').doc(existingSessionId));
      if (sessionDoc.exists && sessionDoc.data().status === 'open') {
        activeSessionId = existingSessionId;
        return;
      }
    }

    const newSessionRef = restaurantRef.collection('sessions').doc('sessao-mesa-13-ativa');
    activeSessionId = newSessionRef.id;

    tx.set(
      newSessionRef,
      {
        tableId: mainTableId,
        status: 'open',
        openedAt: FieldValue.serverTimestamp(),
        openedBy: STAFF_UID
      },
      { merge: true }
    );

    tx.set(mainTableRef, { activeSessionId }, { merge: true });
    tx.set(newSessionRef.collection('events').doc(), {
      action: 'session_opened',
      actorId: STAFF_UID,
      occurredAt: FieldValue.serverTimestamp()
    });
  });

  console.log('=== SEED DO PROTOTIPO CONCLUIDO ===');
  console.log(`Restaurante ID : ${RESTAURANT_ID}`);
  console.log(`Mesa Principal : ${mainTableId}`);
  console.log(`Sessao Ativa   : ${activeSessionId}`);
  console.log(`Conta Equipe   : ${STAFF_EMAIL} (UID: ${STAFF_UID})`);
}

seedPrototypeData().catch((err) => {
  console.error('Erro ao executar seed:', err);
  process.exit(1);
});