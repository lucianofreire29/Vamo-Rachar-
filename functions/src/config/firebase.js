const { getApps, getApp, initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

function getFirebaseApp() {
  return getApps().length ? getApp() : initializeApp();
}

function db() {
  getFirebaseApp();
  return getFirestore();
}

function auth() {
  getFirebaseApp();
  return getAuth();
}

module.exports = {
  getFirebaseApp,
  db,
  auth,
  FieldValue
};