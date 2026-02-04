const admin = require('firebase-admin');

let serviceAccount;

// En producción (Render), usar variable de entorno
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (error) {
    console.error('Error parsing FIREBASE_SERVICE_ACCOUNT:', error);
    throw error;
  }
} else {
  // En desarrollo local
  serviceAccount = require('../../config/serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };