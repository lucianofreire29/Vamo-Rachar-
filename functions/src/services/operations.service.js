const functions = require('../index');

const OPERATIONS = Object.freeze([
  'openTableSession',
  'joinTable',
  'listMenu',
  'createOrder',
  'respondToShare',
  'getShare',
  'listInvitations',
  'resolveRejectedSplit',
  'listWorkQueue',
  'transitionItem',
  'listReadyItems',
  'markItemUnavailable',
  'listMyOrderItems',
  'listMyOrders',
  'quoteCheckout',
  'listSessionParticipants',
  'requestAssistance'
]);

function isValidOperation(operation) {
  return OPERATIONS.includes(operation);
}

async function runOperation(operation, data, authContext) {
  return functions[operation].run({ data, auth: authContext });
}

module.exports = {
  OPERATIONS,
  isValidOperation,
  runOperation
};