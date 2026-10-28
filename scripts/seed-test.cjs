const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, updateDoc } = require('firebase/firestore');
const fs = require('node:fs');

async function main() {
  const env = await initializeTestEnvironment({ projectId: 'demo-vamo-rachar', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } });
  const seed = (extra = {}) => spawnSync(process.execPath, ['scripts/seed-prototipo.cjs'], { env: { ...process.env, ...extra }, encoding: 'utf8' });
  try {
    const first = seed();
    assert.equal(first.status, 0, first.stderr);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = 'restaurants/restaurante-demo';
      assert.equal((await getDocs(collection(db, `${base}/sessions`))).size, 0);
      assert.equal((await getDocs(collection(db, `${base}/staff`))).size, 0);
      assert.equal((await getDocs(collection(db, `${base}/tables`))).size, 20);
      await updateDoc(doc(db, `${base}/menuItems/fries`), { priceCents: 999 });
      await setDoc(doc(db, `${base}/tables/mesa-13`), { number: 13, activeSessionId: 'previous' });
      await setDoc(doc(db, `${base}/sessions/previous`), { status: 'closed' });
    });
    const second = seed();
    assert.equal(second.status, 0, second.stderr);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = 'restaurants/restaurante-demo';
      assert.equal((await getDoc(doc(db, `${base}/menuItems/fries`))).data().priceCents, 999);
      assert.equal((await getDoc(doc(db, `${base}/tables/mesa-13`))).data().activeSessionId, 'previous');
      assert.equal((await getDoc(doc(db, `${base}/sessions/previous`))).data().status, 'closed');
      assert.equal((await getDocs(collection(db, `${base}/sessions`))).size, 1);
    });
    const blocked = seed({ FIRESTORE_EMULATOR_HOST: '', FIREBASE_AUTH_EMULATOR_HOST: '' });
    assert.notEqual(blocked.status, 0);
    const wrongProject = seed({ GCLOUD_PROJECT: 'not-a-demo' });
    assert.notEqual(wrongProject.status, 0);
    console.log('Seed preserves data and refuses execution outside demo emulators.');
  } finally { await env.cleanup(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
