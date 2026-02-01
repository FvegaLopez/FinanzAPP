const { db } = require('../config/firebase-admin');
const admin = require('firebase-admin');

// Buscar usuario por número de WhatsApp (todas las variantes de formato)
async function findUserByPhone(phoneNumber) {
  const normalized = phoneNumber.replace(/[\s\-\(\)\+]/g, '');

  const variants = [
    phoneNumber,                        // Original: 56932518131
    `+${normalized}`,                   // Con +: +56932518131
    normalized,                         // Solo números: 56932518131
    `+56${normalized.slice(-9)}`,       // Chile format: +56XXXXXXXXX
  ];

  for (const variant of variants) {
    const snapshot = await db.collection('users')
      .where('whatsappNumber', '==', variant)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      console.log(`Usuario encontrado con variante: ${variant}`);
      return { id: doc.id, ...doc.data() };
    }
  }

  return null;
}

// Crear usuario nuevo desde WhatsApp
async function createUser(whatsappNumber) {
  const userData = {
    name: 'Usuario WhatsApp',
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

  await db.collection('accounts').add(accountData);

  return { id: docRef.id, ...userData };
}

// Crear transacción
async function createTransaction(data) {
  const transaction = {
    ...data,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    source: data.source || 'whatsapp'
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

// Obtener cuentas del usuario
async function getUserAccounts(userId) {
  const snapshot = await db.collection('accounts')
    .where('owners', 'array-contains', userId)
    .get();

  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

module.exports = {
  findUserByPhone,
  createUser,
  createTransaction,
  getUserAccounts
};