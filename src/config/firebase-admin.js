const admin = require('firebase-admin');
const serviceAccount = require('../../config/serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };