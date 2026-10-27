const assert = require('node:assert/strict');

async function main() {
  const health = await fetch('http://127.0.0.1:5001/demo-vamo-rachar/us-central1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const auth = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true })
  });
  assert.equal(auth.status, 200);
  const { idToken } = await auth.json();
  assert.ok(idToken);
  const db = await fetch('http://127.0.0.1:8080/v1/projects/demo-vamo-rachar/databases/(default)/documents/restaurants/test', {
    method: 'PATCH', headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { name: { stringValue: 'test' } } })
  });
  assert.equal(db.status, 403, 'Firestore must deny direct writes');
  console.log('Health, anonymous Auth and Firestore deny-by-default passed.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
