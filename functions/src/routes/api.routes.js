const express = require('express');
const requireAuth = require('../middlewares/auth.middleware');
const {
  validateOperation,
  handleOperation,
  healthCheck
} = require('../controllers/api.controller');

const router = express.Router();

router.get('/health', healthCheck);
router.post('/api/:operation', validateOperation, requireAuth, handleOperation);

module.exports = router;