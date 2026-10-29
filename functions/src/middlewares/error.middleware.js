const statusCodes = {
  'invalid-argument': 400,
  'failed-precondition': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  'resource-exhausted': 429,
  aborted: 409,
  unavailable: 503
};

function handleFunctionError(error) {
  const code = error && error.code && statusCodes[error.code] ? error.code : 'internal';
  const status = statusCodes[code] || 500;
  const message = code === 'internal' ? 'Erro interno.' : error.message;
  return { status, body: { error: code, message } };
}

function globalErrorMiddleware(err, _req, res, _next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload-too-large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid-json' });
  }
  return res.status(500).json({ error: 'internal' });
}

module.exports = {
  statusCodes,
  handleFunctionError,
  globalErrorMiddleware
};