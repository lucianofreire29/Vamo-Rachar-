const { auth } = require('../config/firebase');

async function requireAuth(req, res, next) {
  const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
  if (!match) {
    return res.status(401).json({ error: 'unauthenticated' });
  }

  try {
    const token = await auth().verifyIdToken(match[1], true);
    req.auth = { uid: token.uid, token };
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthenticated' });
  }
}

module.exports = requireAuth;