const { db } = require('../config/firebase-admin');
const admin = require('firebase-admin');

async function getUserByWhatsApp(whatsappNumber) {
  const snapshot = await db.collection('users')
    .where('whatsappNumber', '==', whatsappNumber)
    .limit(1)
    .get();
  
  if (snapshot.empty) return null;
  
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function createUser(whatsappNumber, name) {
  const userData = {
    name: name || 'Usuario WhatsApp',
    whatsappNumber,
    sharedAccounts: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  
  const docRef = await db.collection('users').add(userData);
  
  // Crear cuenta personal por defecto
  const accountData = {
    name: 'Cuenta Personal',
    owners: [docRef.id],
    balance: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  
  const accountRef = await db.collection('accounts').add(accountData);
  
  return { id: docRef.id, ...userData, defaultAccountId: accountRef.id };
}

async function createTransaction(data) {
  const transaction = {
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'whatsapp'
  };
  
  const docRef = await db.collection('transactions').add(transaction);
  
  // Actualizar balance de la cuenta
  if (data.accountId && data.amount) {
    const accountRef = db.collection('accounts').doc(data.accountId);
    const increment = data.type === 'income' ? data.amount : -data.amount;
    
    await accountRef.update({
      balance: admin.firestore.FieldValue.increment(increment)
    });
  }
  
  return { id: docRef.id, ...transaction };
}

async function getUserAccounts(userId) {
  const snapshot = await db.collection('accounts')
    .where('owners', 'array-contains', userId)
    .get();
  
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

module.exports = {
  getUserByWhatsApp,
  createUser,
  createTransaction,
  getUserAccounts
};