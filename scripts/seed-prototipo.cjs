const { createRequire } = require('node:module');
const functionRequire = createRequire(require('node:path').resolve(__dirname, '../functions/package.json'));
const { initializeApp } = functionRequire('firebase-admin/app');
const { getFirestore, FieldValue } = functionRequire('firebase-admin/firestore');

// Este seed só popula dados fictícios no emulador; não cria contas nem senhas.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Execute apenas com os emuladores Firestore e Authentication ativos.');
  process.exit(1);
}
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'demo-vamo-rachar';
if (!projectId.startsWith('demo-')) {
  console.error('O seed exige um projeto de demonstração cujo ID comece com demo-.');
  process.exit(1);
}
initializeApp({ projectId });
const db = getFirestore();
const restaurant = db.collection('restaurants').doc('restaurante-demo');
const products = [
  { id: 'fries', name: 'Fritas da casa', description: 'Crocantes, com aioli de ervas.', priceCents: 3600, category: 'Porções', sector: 'kitchen', image: 'fries.png', available: true },
  { id: 'burger', name: 'Burger da casa', description: 'Brioche, carne e cheddar.', priceCents: 3200, category: 'Lanches', sector: 'kitchen', image: 'burger.png', available: true },
  { id: 'lemonade', name: 'Limonada natural', description: 'Limão fresquinho. Copo 400 mL.', priceCents: 1000, category: 'Bebidas', sector: 'bar', image: 'lemonade.png', available: true }
];

async function createIfMissing(ref, data) {
  try { await ref.create(data); }
  catch (error) {
    if (error.code !== 6 && error.code !== 'already-exists') throw error;
  }
}
async function main() {
  await createIfMissing(restaurant, { name: 'Vamo Rachar Demo Bar', active: true, createdAt: FieldValue.serverTimestamp() });
  for (const product of products) {
    const { id, ...data } = product;
    await createIfMissing(restaurant.collection('menuItems').doc(id), { ...data, createdAt: FieldValue.serverTimestamp() });
  }
  for (let i = 1; i <= 20; i++) {
    const id = `mesa-${String(i).padStart(2, '0')}`;
    await createIfMissing(restaurant.collection('tables').doc(id), { number: i, label: `Mesa ${i}`, activeSessionId: null, createdAt: FieldValue.serverTimestamp() });
  }
  console.log('Dados fictícios preparados no emulador; contas e sessões não foram criadas.');
}
main().catch((error) => { console.error('Falha ao preparar dados fictícios:', error.message); process.exitCode = 1; });
