const { isValidOperation, runOperation } = require('../services/operations.service');
const { handleFunctionError } = require('../middlewares/error.middleware');

function validateOperation(req, res, next) {
  const { operation } = req.params;
  if (!isValidOperation(operation)) {
    return res.status(404).json({ error: 'not-found' });
  }
  return next();
}

async function handleOperation(req, res) {
  const { operation } = req.params;
  try {
    const result = await runOperation(operation, req.body, req.auth);
    return res.json({ result });
  } catch (error) {
    const { status, body } = handleFunctionError(error);
    return res.status(status).json(body);
  }
}

function healthCheck(_req, res) {
  return res.json({ status: 'ok' });
}

module.exports = {
  validateOperation,
  handleOperation,
  healthCheck
};