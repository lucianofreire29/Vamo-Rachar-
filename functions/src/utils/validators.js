const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

const STAFF_ROLES = Object.freeze(['waiter', 'manager', 'kitchen', 'bar']);

const SESSION_STATES = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed'
});

const ITEM_STATES = Object.freeze({
  AWAITING_SPLIT: 'awaiting_split',
  RECEIVED: 'received',
  IN_PREPARATION: 'in_preparation',
  READY: 'ready',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  UNAVAILABLE: 'unavailable',
  CANCELLED: 'cancelled'
});

const SPLIT_ACTIONS = Object.freeze(['cancel', 'assume', 'reinvite']);

function validId(value) {
  return typeof value === 'string' && ID_REGEX.test(value);
}

function validNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

module.exports = {
  ID_REGEX,
  STAFF_ROLES,
  SESSION_STATES,
  ITEM_STATES,
  SPLIT_ACTIONS,
  validId,
  validNonEmptyString
};