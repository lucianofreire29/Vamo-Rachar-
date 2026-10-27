const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, getDocs, collection } = require('firebase/firestore');
const fs = require('node:fs');

async function main() {
  const env = await initializeTestEnvironment({ projectId: 'demo-vamo-rachar', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } });
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'restaurants/a/sessions/s1/participants/ana'), { authUid: 'ana', displayName: 'Ana' });
      await setDoc(doc(db, 'restaurants/a/sessions/s1/participants/bruno'), { authUid: 'bruno', displayName: 'Bruno' });
      await setDoc(doc(db, 'restaurants/b/sessions/s2/participants/outro'), { authUid: 'outro', displayName: 'Outro' });
      await setDoc(doc(db, 'restaurants/a/staff/funcionario'), { active: true, roles: ['waiter'] });
      await setDoc(doc(db, 'restaurants/b/staff/outro-funcionario'), { active: true, roles: ['manager'] });
    });
    const ana = env.authenticatedContext('ana').firestore();
    const staff = env.authenticatedContext('funcionario').firestore();
    const guest = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(ana, 'restaurants/a/sessions/s1/participants/ana')));
    await assertFails(getDoc(doc(ana, 'restaurants/a/sessions/s1/participants/bruno')));
    await assertFails(getDoc(doc(ana, 'restaurants/b/sessions/s2/participants/outro')));
    await assertFails(getDoc(doc(guest, 'restaurants/a/sessions/s1/participants/ana')));
    await assertFails(getDocs(collection(ana, 'restaurants/a/sessions/s1/participants')));
    await assertFails(setDoc(doc(ana, 'restaurants/a/sessions/s1/participants/ana'), { authUid: 'ana', displayName: 'Alterado' }));
    await assertFails(setDoc(doc(ana, 'restaurants/a/staff/ana'), { active: true, roles: ['manager'] }));
    await assertSucceeds(getDoc(doc(staff, 'restaurants/a/staff/funcionario')));
    await assertFails(getDoc(doc(staff, 'restaurants/b/staff/outro-funcionario')));
    await assertFails(getDoc(doc(staff, 'restaurants/a/sessions/s1/participants/ana')));
    console.log('Identity and restaurant isolation rules passed.');
  } finally {
    await env.cleanup();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
