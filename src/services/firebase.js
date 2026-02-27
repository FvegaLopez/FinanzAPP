const { db } = require('../config/firebase-admin');
const admin = require('firebase-admin');

// Buscar usuario por número de WhatsApp
async function findUserByPhone(phoneNumber) {
  const normalized = phoneNumber.replace(/[\s\-\(\)\+]/g, '');

  const variants = [
    phoneNumber,
    `+${normalized}`,
    normalized,
    `+56${normalized.slice(-9)}`,
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

// Buscar usuario por email
async function findUserByEmail(email) {
  const snapshot = await db.collection('users')
    .where('email', '==', email)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

// Buscar usuario por email O teléfono
async function findUserByEmailOrPhone(emailOrPhone) {
  if (emailOrPhone.includes('@')) {
    return await findUserByEmail(emailOrPhone);
  } else {
    return await findUserByPhone(emailOrPhone);
  }
}

// Crear usuario desde WhatsApp
async function createUser(whatsappNumber) {
  const userData = {
    name: 'Usuario WhatsApp',
    whatsappNumber,
    sharedAccounts: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const docRef = await db.collection('users').add(userData);

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

// Crear cuenta
async function createAccount(userId, accountName) {
  const accountData = {
    name: accountName,
    owners: [userId],
    balance: 0,
    isDefault: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const docRef = await db.collection('accounts').add(accountData);
  return { id: docRef.id, ...accountData };
}

// Eliminar cuenta
async function deleteAccount(accountId) {
  await db.collection('accounts').doc(accountId).delete();
}

// Establecer cuenta por defecto
async function setDefaultAccount(userId, accountId) {
  const accounts = await getUserAccounts(userId);
  
  for (const acc of accounts) {
    await db.collection('accounts').doc(acc.id).update({
      isDefault: acc.id === accountId
    });
  }
}

// Crear invitación (unificada para email, teléfono, usuario existente o no)
async function createInvitation(accountId, inviterUserId, inviteeIdentifier) {
  const invitationData = {
    accountId,
    inviterUserId,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // Determinar si es email o teléfono
  if (inviteeIdentifier.includes('@')) {
    invitationData.inviteeEmail = inviteeIdentifier;
    invitationData.type = 'email';
  } else {
    const normalized = inviteeIdentifier.replace(/\D/g, '');
    invitationData.inviteePhone = normalized.startsWith('56') ? `+${normalized}` : `+56${normalized}`;
    invitationData.type = 'phone';
  }

  // Verificar si el usuario existe
  const existingUser = await findUserByEmailOrPhone(inviteeIdentifier);
  if (existingUser) {
    invitationData.inviteeUserId = existingUser.id;
    invitationData.userExists = true;
  } else {
    invitationData.userExists = false;
  }

  const docRef = await db.collection('invitations').add(invitationData);
  return { id: docRef.id, ...invitationData };
}

// Obtener invitaciones pendientes de un usuario (por email o teléfono)
async function getPendingInvitations(emailOrPhone) {
  let invitations = [];

  if (emailOrPhone.includes('@')) {
    const snapshot = await db.collection('invitations')
      .where('inviteeEmail', '==', emailOrPhone)
      .where('status', '==', 'pending')
      .get();

    for (const doc of snapshot.docs) {
      invitations.push({ id: doc.id, ...doc.data() });
    }
  } else {
    const normalized = emailOrPhone.replace(/\D/g, '');
    const variants = [
      emailOrPhone,
      `+${normalized}`,
      normalized,
      `+56${normalized.slice(-9)}`,
    ];

    for (const variant of variants) {
      const snapshot = await db.collection('invitations')
        .where('inviteePhone', '==', variant)
        .where('status', '==', 'pending')
        .get();
      
      snapshot.docs.forEach(doc => {
        if (!invitations.find(inv => inv.id === doc.id)) {
          invitations.push({ id: doc.id, ...doc.data() });
        }
      });
    }
  }

  // Enriquecer invitaciones
  const enrichedInvitations = [];
  for (const invitation of invitations) {
    const accountDoc = await db.collection('accounts').doc(invitation.accountId).get();
    if (accountDoc.exists) {
      invitation.account = { id: accountDoc.id, ...accountDoc.data() };
    }

    const inviterDoc = await db.collection('users').doc(invitation.inviterUserId).get();
    if (inviterDoc.exists) {
      invitation.inviter = { id: inviterDoc.id, ...inviterDoc.data() };
    }

    enrichedInvitations.push(invitation);
  }

  return enrichedInvitations;
}

// Aceptar invitación
async function acceptInvitation(invitationId, userId) {
  const invitationRef = db.collection('invitations').doc(invitationId);
  const invitationDoc = await invitationRef.get();
  
  if (!invitationDoc.exists) {
    throw new Error('Invitación no encontrada');
  }

  const invitation = invitationDoc.data();
  
  const accountRef = db.collection('accounts').doc(invitation.accountId);
  await accountRef.update({
    owners: admin.firestore.FieldValue.arrayUnion(userId)
  });

  await invitationRef.update({
    status: 'accepted',
    acceptedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { accountId: invitation.accountId };
}

// Rechazar invitación
async function rejectInvitation(invitationId) {
  await db.collection('invitations').doc(invitationId).update({
    status: 'rejected',
    rejectedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// Verificar si mensaje ya fue procesado
async function isMessageProcessed(messageId) {
  const docRef = db.collection('processed_messages').doc(messageId);
  const doc = await docRef.get();
  return doc.exists;
}

// Marcar mensaje como procesado
async function markMessageAsProcessed(messageId) {
  await db.collection('processed_messages').doc(messageId).set({
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000))
  });
}

module.exports = {
  findUserByPhone,
  findUserByEmail,
  findUserByEmailOrPhone,
  createUser,
  createTransaction,
  getUserAccounts,
  createAccount,
  deleteAccount,
  setDefaultAccount,
  createInvitation,
  getPendingInvitations,
  acceptInvitation,
  rejectInvitation,
  isMessageProcessed,
  markMessageAsProcessed
};