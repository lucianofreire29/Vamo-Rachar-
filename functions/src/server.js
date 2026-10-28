const express = require('express');
const { getAuth } = require('firebase-admin/auth');
const functions = require('./index');
const corsMiddleware = require('./middlewares/cors.middleware');

const operations = [
  'joinTable', 'listMenu', 'createOrder', 'respondToShare',
  'getShare', 'listInvitations', 'resolveRejectedSplit', 'listWorkQueue',
  'transitionItem', 'listReadyItems', 'markItemUnavailable', 'listMyOrderItems',
  'listMyOrders', 'quoteCheckout', 'listSessionParticipants', 'saveAdminProduct', 'createEmployeeCode', 'disableEmployeeCode', 'listAdminProducts', 'listAdminEmployees', 'activateSharedDevice', 'openTableWithCode', 'cancelItemWithCode', 'rotateEmployeeCode', 'listAdminDevices', 'disableSharedDevice'
];
const statusCodes = {
  'invalid-argument': 400, 'failed-precondition': 400, unauthenticated: 401,
  'permission-denied': 403, 'not-found': 404, 'already-exists': 409,
  'resource-exhausted': 429, aborted: 409, unavailable: 503
};
const app = express();
app.disable('x-powered-by');
app.use(corsMiddleware);
app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/:operation', async (req, res) => {
  const { operation } = req.params;
  if (!operations.includes(operation)) return res.status(404).json({ error: 'not-found' });
  const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ error: 'unauthenticated' });
  let token;
  try { token = await getAuth().verifyIdToken(match[1], true); }
  catch { return res.status(401).json({ error: 'unauthenticated' }); }
  try {
    const result = await functions[operation].run({ data: req.body, auth: { uid: token.uid, token } });
    return res.json({ result });
  } catch (error) {
    const code = error.code && statusCodes[error.code] ? error.code : 'internal';
    return res.status(statusCodes[code] || 500).json({ error: code, message: code === 'internal' ? 'Erro interno.' : error.message });
  }
});
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload-too-large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid-json' });
  return res.status(500).json({ error: 'internal' });
});
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`API pronta na porta ${port}`));
}
module.exports = app;