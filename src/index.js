require('dotenv').config();
const express = require('express');
const { detectIntention, categorizeTransaction, detectAccountInMessage, extractTransferAmount, parseInviteCommand } = require('./services/groq');
const { findUserByPhone, findUserByEmailOrPhone, createTransaction, getUserAccounts, createAccount, deleteAccount, setDefaultAccount, createInvitation, getPendingInvitations, acceptInvitation, rejectInvitation, isMessageProcessed, markMessageAsProcessed } = require('./services/firebase');
const { sendWhatsAppMessage, sendWhatsAppButtons, sendWhatsAppList } = require('./services/whatsapp');
const { db } = require('./config/firebase-admin');
const { getMonthlyReport, getAccountMonthlyReport, formatGlobalReport, formatAccountReport, formatCategoryBreakdown, parseMonthFromText } = require('./services/reports');

const app = express();
app.use(express.json());

// Cache en memoria
const processedMessages = new Map();
const firstMessageCache = new Map();
const conversationState = new Map();
const MAX_CACHE_SIZE = 100;

function isDuplicate(messageId) {
  return processedMessages.has(messageId);
}

function markAsProcessed(messageId) {
  if (processedMessages.size >= MAX_CACHE_SIZE) {
    const firstKey = processedMessages.keys().next().value;
    processedMessages.delete(firstKey);
  }
  processedMessages.set(messageId, Date.now());
}

function isFirstMessage(phone) {
  return !firstMessageCache.has(phone);
}

function markAsWelcomed(phone) {
  firstMessageCache.set(phone, Date.now());
}

function setConversationState(phone, state) {
  conversationState.set(phone, { ...state, timestamp: Date.now() });
}

function getConversationState(phone) {
  const state = conversationState.get(phone);
  if (!state) return null;
  
  if (Date.now() - state.timestamp > 5 * 60 * 1000) {
    conversationState.delete(phone);
    return null;
  }
  
  return state;
}

function clearConversationState(phone) {
  conversationState.delete(phone);
}

// Respuestas
function getGreetingResponse(userName) {
  return `¡Hola ${userName}! 👋\n\n💸 Registrar gasto:\n"Gasté 5000 en supermercado"\n"Uber 3500 en efectivo"\n\n💰 Ver balance:\n"Mis cuentas"\n\n🏦 Gestionar cuentas:\n"Crear cuenta Tarjeta"\n"Eliminar cuenta Efectivo"\n\n👥 Compartir:\n"Invitar a 932518131 a Gastos del Hogar"\n\n💱 Transferir:\n"Transferir 10000 de Débito a Efectivo"`;
}

function getHelpResponse() {
  return '📖 *Comandos disponibles*\n\n' +
    '💸 *Transacciones:*\n' +
    '"Gasté 5000 en supermercado"\n' +
    '"Recibí 50000 de freelance"\n' +
    '"Uber 3500 en efectivo"\n\n' +
    '🏦 *Cuentas:*\n' +
    '"Mis cuentas"\n' +
    '"Crear cuenta Ahorros"\n' +
    '"Eliminar cuenta Efectivo"\n' +
    '"Renombrar Efectivo a Billetera"\n\n' +
    '📊 *Resúmenes:*\n' +
    '"Resumen mensual"\n' +
    '"Resumen de Efectivo"\n' +
    '"Resumen de enero"\n\n' +
    '👥 *Compartir:*\n' +
    '"Invitar a 932518131 a Gastos del Hogar"\n\n' +
    '💱 *Transferencias:*\n' +
    '"Transferir 10000 de Débito a Efectivo"';
}

async function getAccountsListResponse(userId) {
  const accounts = await getUserAccounts(userId);
  
  if (accounts.length === 0) {
    return '⚠️ No tienes cuentas. Crea una con:\n"Crear cuenta Efectivo"';
  }

  let response = '🏦 *Tus cuentas:*\n\n';
  let total = 0;
  
  accounts.forEach(account => {
    const icon = account.name.toLowerCase().includes('efectivo') ? '💵' :
                 account.name.toLowerCase().includes('debito') ? '💳' :
                 account.name.toLowerCase().includes('ahorro') ? '🏦' : '💼';
    const defaultMark = account.isDefault ? ' ⭐' : '';
    const sharedMark = account.owners && account.owners.length > 1 ? ' 👥' : '';
    response += `${icon} ${account.name}${defaultMark}${sharedMark}: $${account.balance?.toLocaleString('es-CL') || 0}\n`;
    total += account.balance || 0;
  });
  
  response += `\n💰 *Total:* $${total.toLocaleString('es-CL')}`;
  return response;
}

// Webhooks
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (messages && messages.length > 0) {
        const message = messages[0];
        const messageId = message.id;
        const from = message.from;
        
        let messageBody = message.text?.body;

        if (message.type === 'interactive') {
          if (message.interactive.type === 'button_reply') {
            messageBody = message.interactive.button_reply.title;
          } else if (message.interactive.type === 'list_reply') {
            messageBody = message.interactive.list_reply.id;
          }
        }

        console.log(`Mensaje: ${messageBody} de ${from} (${messageId})`);

        // DOBLE PROTECCIÓN: Caché + Firestore
        
        // 1. Verificar caché en memoria (súper rápido)
        if (isDuplicate(messageId)) {
          console.log(`⚠️ Duplicado ignorado (caché): ${messageId}`);
          return res.sendStatus(200);
        }

        // 2. Marcar en caché INMEDIATAMENTE
        markAsProcessed(messageId);

        // 3. Verificar en Firestore (persistente)
        const alreadyProcessed = await isMessageProcessed(messageId);
        if (alreadyProcessed) {
          console.log(`⚠️ Duplicado ignorado (Firestore): ${messageId}`);
          return res.sendStatus(200);
        }

        // 4. Marcar en Firestore
        await markMessageAsProcessed(messageId);
        console.log(`✅ Mensaje procesado: ${messageId}`);

        let user = await findUserByPhone(from);

        if (!user || !user.email) {
          if (isFirstMessage(from)) {
            try {
              await sendWhatsAppMessage(from,
                '👋 ¡Hola! Para usar FinanzApp primero regístrate:\n\nhttps://finanzapp-76702.web.app/register\n\n💡 Agrega este número de WhatsApp en tu perfil.');
              markAsWelcomed(from);
            } catch (err) {
              console.log('Error:', err.message);
            }
          }
          return res.sendStatus(200);
        }

        console.log(`✅ Usuario: ${user.name}`);

        // Verificar invitaciones pendientes al primer mensaje
        // Verificar si es primera vez REAL (nunca ha usado el bot)
        const userTransactionsSnapshot = await db.collection('transactions')
          .where('userId', '==', user.id)
          .limit(1)
          .get();

        const isReallyFirstTime = userTransactionsSnapshot.empty;

        if (isReallyFirstTime) {
          // Primera vez en la historia
          const pendingInvites = await getPendingInvitations(from);
          
          if (pendingInvites.length > 0) {
            for (const invite of pendingInvites) {
              const inviterName = invite.inviter?.name || 'Un usuario';
              const accountName = invite.account?.name || 'una cuenta';
              
              try {
                await sendWhatsAppButtons(from, 
                  `👋 ${inviterName} te invitó a la cuenta compartida "${accountName}"\n\n¿Aceptas?`,
                  [
                    { title: 'Aceptar' },
                    { title: 'Rechazar' }
                  ]
                );

                setConversationState(from, {
                  type: 'awaiting_invitation_response',
                  invitationId: invite.id
                });
              } catch (err) {
                console.log('Error enviando invitación:', err.message);
              }
            }
            return res.sendStatus(200);
          }

          try {
            await sendWhatsAppMessage(from, getGreetingResponse(user.name));
          } catch (err) {}
          return res.sendStatus(200);
        }

        // Usuario que ya usó el bot antes (bienvenida corta + continuar)
        // Usuario que ya usó el bot antes
        if (isFirstMessage(from)) {
          markAsWelcomed(from);
          
          // Detectar intención para decidir tipo de bienvenida
          const welcomeIntention = await detectIntention(messageBody);
          
          if (welcomeIntention === 'greeting' || welcomeIntention === 'help') {
            // Si es saludo/ayuda → Bienvenida completa
            try {
              await sendWhatsAppMessage(from, 
                `¡Bienvenido de vuelta, ${user.name}! 👋\n\n` +
                `Recuerda que conmigo puedes:\n\n` +
                `💸 Registrar gastos: "Gasté 5000 en supermercado"\n\n` +
                `💰 Ver balance: "Mis cuentas"\n\n` +
                `🏦 Gestionar cuentas: "Crear cuenta Tarjeta"\n\n` +
                `👥 Compartir: "Invitar a 932518131 a Gastos del Hogar"\n\n` +
                `💱 Transferir: "Transferir 10000 de Débito a Efectivo"`
              );
            } catch (err) {}
            return res.sendStatus(200);
          } else {
            // Si es comando/transacción → Solo "Bienvenido de vuelta" y continuar
            try {
              await sendWhatsAppMessage(from, `¡Bienvenido de vuelta, ${user.name}! 👋`);
            } catch (err) {}
            // NO hacer return, seguir procesando
          }
        }

        // VERIFICAR ESTADO DE CONVERSACIÓN
        const state = getConversationState(from);

        // CASO: Esperando selección de cuenta para transacción
        if (state && state.type === 'awaiting_account_selection') {
          const accounts = await getUserAccounts(user.id);
          
          let selectedAccount = null;
          
          const accountIndex = parseInt(messageBody.trim()) - 1;
          if (!isNaN(accountIndex) && accountIndex >= 0 && accountIndex < accounts.length) {
            selectedAccount = accounts[accountIndex];
          } else {
            selectedAccount = accounts.find((acc, i) => 
              messageBody.includes(acc.name) || 
              messageBody.startsWith(`${i + 1}`)
            );
          }

          if (selectedAccount) {
            await createTransaction({
              accountId: selectedAccount.id,
              userId: user.id,
              type: state.transaction.type,
              amount: state.transaction.amount,
              category: state.transaction.category,
              description: state.transaction.description,
              createdAt: new Date(),
              source: 'whatsapp',
              whatsappMessageId: messageId
            });

            const emoji = state.transaction.type === 'income' ? '💰' : '💸';
            const typeText = state.transaction.type === 'income' ? 'Ingreso' : 'Gasto';
            const newBalance = selectedAccount.balance + (state.transaction.type === 'income' ? state.transaction.amount : -state.transaction.amount);

            try {
              await sendWhatsAppMessage(from,
                `${emoji} ${typeText} registrado en ${selectedAccount.name}\n\n` +
                `📝 Categoría: ${state.transaction.category}\n` +
                `💵 Monto: $${state.transaction.amount.toLocaleString('es-CL')}\n` +
                `📊 Balance: $${newBalance.toLocaleString('es-CL')}`
              );
            } catch (err) {}

            clearConversationState(from);
            return res.sendStatus(200);
          } else {
            try {
              await sendWhatsAppMessage(from, '⚠️ Opción inválida. Intenta de nuevo o escribe "cancelar".');
            } catch (err) {}
            return res.sendStatus(200);
          }
        }

        // CASO: Esperando confirmación de renombrar cuenta
        if (state && state.type === 'awaiting_rename_confirmation') {
          if (messageBody.toLowerCase().includes('renombrar')) {
            try {
              const admin = require('firebase-admin');
              await admin.firestore().collection('accounts').doc(state.accountId).update({
                name: state.newName
              });
              
              await sendWhatsAppMessage(from, 
                `✅ Cuenta renombrada\n\n"${state.oldName}" → "${state.newName}"`
              );
            } catch (err) {
              await sendWhatsAppMessage(from, '⚠️ Error al renombrar la cuenta');
            }
          } else {
            await sendWhatsAppMessage(from, 'Renombrado cancelado.');
          }
          clearConversationState(from);
          return res.sendStatus(200);
        }

        // CASO: Esperando confirmación de eliminación
        if (state && state.type === 'awaiting_delete_confirmation') {
          if (messageBody.toLowerCase() === 'confirmar') {
            try {
              await deleteAccount(state.accountId);
              await sendWhatsAppMessage(from, `✅ Cuenta "${state.accountName}" eliminada correctamente.`);
            } catch (err) {
              await sendWhatsAppMessage(from, '⚠️ Error al eliminar la cuenta.');
            }
            clearConversationState(from);
          } else {
            await sendWhatsAppMessage(from, 'Eliminación cancelada.');
            clearConversationState(from);
          }
          return res.sendStatus(200);
        }

        // CASO: Esperando confirmación de invitación (usuario existe)
        if (state && state.type === 'awaiting_invite_confirmation') {
          if (messageBody.toLowerCase().includes('invitar')) {
            try {
              await createInvitation(state.accountId, user.id, state.inviteeIdentifier);
              await sendWhatsAppMessage(from, 
                `✅ Invitación enviada a ${state.foundUser.name}\n\n` +
                `Recibirá una notificación para aceptar la invitación.`
              );

              if (state.foundUser.whatsappNumber) {
                try {
                  await sendWhatsAppButtons(state.foundUser.whatsappNumber,
                    `👋 ${user.name} te invitó a la cuenta compartida "${state.accountName}"\n\n¿Aceptas?`,
                    [
                      { title: 'Aceptar' },
                      { title: 'Rechazar' }
                    ]
                  );

                  setConversationState(state.foundUser.whatsappNumber, {
                    type: 'awaiting_invitation_response',
                    inviterName: user.name,
                    accountName: state.accountName
                  });
                } catch (err) {
                  console.log('Error notificando invitado:', err.message);
                }
              }
            } catch (err) {
              await sendWhatsAppMessage(from, '⚠️ Error al enviar la invitación');
            }
          } else {
            await sendWhatsAppMessage(from, 'Invitación cancelada.');
          }
          clearConversationState(from);
          return res.sendStatus(200);
        }

        // CASO: Esperando confirmación para invitar a registrarse (usuario NO existe)
        if (state && state.type === 'awaiting_invite_to_register') {
          if (messageBody.toLowerCase().includes('invitar')) {
            try {
              await createInvitation(state.accountId, user.id, state.inviteeIdentifier);
              await sendWhatsAppMessage(from, 
                `✅ Invitación pendiente creada\n\n` +
                `Cuando ${state.inviteeIdentifier} se registre en FinanzApp, ` +
                `automáticamente se unirá a "${state.accountName}"`
              );
            } catch (err) {
              await sendWhatsAppMessage(from, '⚠️ Error al crear la invitación');
            }
          } else {
            await sendWhatsAppMessage(from, 'Invitación cancelada.');
          }
          clearConversationState(from);
          return res.sendStatus(200);
        }

        // CASO: Esperando respuesta a invitación
        if (state && state.type === 'awaiting_invitation_response') {
          const pendingInvites = await getPendingInvitations(from);
          
          if (pendingInvites.length > 0) {
            const invite = pendingInvites[0];

            if (messageBody.toLowerCase().includes('aceptar')) {
              try {
                await acceptInvitation(invite.id, user.id);
                await sendWhatsAppMessage(from, 
                  `✅ Ahora compartes "${invite.account.name}" con ${invite.inviter.name}`
                );

                if (invite.inviter?.whatsappNumber) {
                  try {
                    await sendWhatsAppMessage(invite.inviter.whatsappNumber,
                      `✅ ${user.name} aceptó tu invitación a "${invite.account.name}"`
                    );
                  } catch (err) {}
                }
              } catch (err) {
                await sendWhatsAppMessage(from, '⚠️ Error al aceptar la invitación');
              }
            } else {
              try {
                await rejectInvitation(invite.id);
                await sendWhatsAppMessage(from, 'Invitación rechazada.');

                if (invite.inviter?.whatsappNumber) {
                  try {
                    await sendWhatsAppMessage(invite.inviter.whatsappNumber,
                      `❌ ${user.name} rechazó tu invitación a "${invite.account.name}"`
                    );
                  } catch (err) {}
                }
              } catch (err) {}
            }
          } else {
            await sendWhatsAppMessage(from, '⚠️ No encontré invitaciones pendientes');
          }
          clearConversationState(from);
          return res.sendStatus(200);
        }

        // CASO: Esperando respuesta sobre desglose de categorías
        if (state && state.type === 'awaiting_category_breakdown') {
          if (messageBody.toLowerCase().includes('mostrar') || messageBody.toLowerCase().includes('sí')) {
            try {
              const message = formatCategoryBreakdown(state.report);
              await sendWhatsAppMessage(from, message);
            } catch (err) {
              await sendWhatsAppMessage(from, '⚠️ Error al generar desglose.');
            }
          } else {
            await sendWhatsAppMessage(from, 'De acuerdo, si necesitas algo más avísame 👍');
          }
          clearConversationState(from);
          return res.sendStatus(200);
        }

        // CASO: Cancelar flujo
        if (messageBody.toLowerCase() === 'cancelar') {
          clearConversationState(from);
          try {
            await sendWhatsAppMessage(from, '❌ Operación cancelada.');
          } catch (err) {}
          return res.sendStatus(200);
        }

        const msgLower = messageBody.toLowerCase();
        // RESUMEN MENSUAL GLOBAL
        if (msgLower === 'resumen mensual' || msgLower === 'resumen') {
          try {
            const report = await getMonthlyReport(user.id);
            const message = formatGlobalReport(report);
            
            await sendWhatsAppButtons(from,
              message + '\n\n¿Deseas un desglose por categoría?',
              [
                { title: 'Sí, mostrar' },
                { title: 'No, gracias' }
              ]
            );

            setConversationState(from, {
              type: 'awaiting_category_breakdown',
              report: report
            });
          } catch (err) {
            console.error('Error generando resumen:', err);
            await sendWhatsAppMessage(from, '⚠️ Error al generar el resumen.');
          }
          return res.sendStatus(200);
        }

        // RESUMEN DE CUENTA ESPECÍFICA O MES
        if (msgLower.startsWith('resumen de ') || msgLower.startsWith('resumen ')) {
          const accounts = await getUserAccounts(user.id);
          const monthIndex = parseMonthFromText(messageBody);
          const currentYear = new Date().getFullYear();
          
          let accountName = null;
          
          for (const acc of accounts) {
            if (msgLower.includes(acc.name.toLowerCase())) {
              accountName = acc.name;
              break;
            }
          }

          try {
            if (accountName) {
              const report = await getAccountMonthlyReport(user.id, accountName, monthIndex);
              const message = formatAccountReport(report);
              await sendWhatsAppMessage(from, message);
            } else if (monthIndex !== null) {
              const report = await getMonthlyReport(user.id, monthIndex, currentYear);
              const message = formatGlobalReport(report);
              
              await sendWhatsAppButtons(from,
                message + '\n\n¿Deseas un desglose por categoría?',
                [
                  { title: 'Sí, mostrar' },
                  { title: 'No, gracias' }
                ]
              );

              setConversationState(from, {
                type: 'awaiting_category_breakdown',
                report: report
              });
            } else {
              await sendWhatsAppMessage(from, 
                '⚠️ No entendí qué resumen necesitas.\n\n' +
                'Ejemplos:\n' +
                '• "Resumen mensual"\n' +
                '• "Resumen de Efectivo"\n' +
                '• "Resumen de enero"'
              );
            }
          } catch (err) {
            console.error('Error generando resumen:', err);
            await sendWhatsAppMessage(from, '⚠️ Error al generar el resumen.');
          }
          return res.sendStatus(200);
        }

        // DETECTAR INTENCIÓN
        const intention = await detectIntention(messageBody);

        switch (intention) {
          case 'greeting':
            try {
              await sendWhatsAppMessage(from, getGreetingResponse(user.name));
            } catch (err) {}
            break;

          case 'help':
            try {
              await sendWhatsAppMessage(from, getHelpResponse());
            } catch (err) {}
            break;

          case 'balance':
            try {
              const response = await getAccountsListResponse(user.id);
              await sendWhatsAppMessage(from, response);
            } catch (err) {}
            break;

          case 'transaction':
            console.log('→ Transacción');

            const analysis = await categorizeTransaction(messageBody);
            const accounts = await getUserAccounts(user.id);

            if (accounts.length === 0) {
              try {
                await sendWhatsAppMessage(from, '⚠️ No tienes cuentas. Crea una con:\n"Crear cuenta Efectivo"');
              } catch (err) {}
              break;
            }

            const detectedAccount = await detectAccountInMessage(messageBody, accounts);

            if (detectedAccount) {
              await createTransaction({
                accountId: detectedAccount.id,
                userId: user.id,
                type: analysis.type,
                amount: analysis.amount,
                category: analysis.category,
                description: messageBody,
                createdAt: new Date(),
                source: 'whatsapp',
                whatsappMessageId: messageId
              });

              const emoji = analysis.type === 'income' ? '💰' : '💸';
              const typeText = analysis.type === 'income' ? 'Ingreso' : 'Gasto';
              const newBalance = detectedAccount.balance + (analysis.type === 'income' ? analysis.amount : -analysis.amount);

              try {
                await sendWhatsAppMessage(from,
                  `${emoji} ${typeText} registrado en ${detectedAccount.name}\n\n` +
                  `📝 Categoría: ${analysis.category}\n` +
                  `💵 Monto: $${analysis.amount?.toLocaleString('es-CL') || 'No detectado'}\n` +
                  `📊 Balance: $${newBalance.toLocaleString('es-CL')}`
                );
              } catch (err) {}
            } else if (accounts.length === 1) {
              const defaultAccount = accounts[0];
              
              await createTransaction({
                accountId: defaultAccount.id,
                userId: user.id,
                type: analysis.type,
                amount: analysis.amount,
                category: analysis.category,
                description: messageBody,
                createdAt: new Date(),
                source: 'whatsapp',
                whatsappMessageId: messageId
              });

              const emoji = analysis.type === 'income' ? '💰' : '💸';
              const typeText = analysis.type === 'income' ? 'Ingreso' : 'Gasto';
              const newBalance = defaultAccount.balance + (analysis.type === 'income' ? analysis.amount : -analysis.amount);

              try {
                await sendWhatsAppMessage(from,
                  `${emoji} ${typeText} registrado\n\n` +
                  `📝 Categoría: ${analysis.category}\n` +
                  `💵 Monto: $${analysis.amount?.toLocaleString('es-CL') || 'No detectado'}\n` +
                  `📊 Balance: $${newBalance.toLocaleString('es-CL')}`
                );
              } catch (err) {}
            } else {
              const emoji = analysis.type === 'income' ? 'Ingreso' : 'Gasto';
              const bodyText = `💸 ${emoji} de $${analysis.amount?.toLocaleString('es-CL')} en ${analysis.category}\n\n¿En qué cuenta?`;

              try {
                if (accounts.length <= 3) {
                  await sendWhatsAppButtons(from, bodyText, accounts.map((acc, i) => ({
                    title: `${i + 1}. ${acc.name}`.substring(0, 20)
                  })));
                } else {
                  await sendWhatsAppList(from, bodyText, 'Seleccionar cuenta', [{
                    title: 'Cuentas',
                    rows: accounts.map((acc, i) => ({
                      id: `${i + 1}`,
                      title: acc.name.substring(0, 24),
                      description: `Balance: $${acc.balance?.toLocaleString('es-CL')}`
                    }))
                  }]);
                }

                setConversationState(from, {
                  type: 'awaiting_account_selection',
                  transaction: {
                    type: analysis.type,
                    amount: analysis.amount,
                    category: analysis.category,
                    description: messageBody
                  }
                });
              } catch (err) {
                console.log('Error enviando selección:', err.message);
              }
            }
            break;

            // INVITAR USUARIO
            const inviteCommand = parseInviteCommand(messageBody);
            if (inviteCommand) {
              const accounts = await getUserAccounts(user.id);
              const account = accounts.find(a => 
                a.name.toLowerCase() === inviteCommand.accountName.toLowerCase()
              );

              if (!account) {
                try {
                  await sendWhatsAppMessage(from, 
                    `⚠️ No encontré la cuenta "${inviteCommand.accountName}"\n\n` +
                    `Tus cuentas: ${accounts.map(a => a.name).join(', ')}`
                  );
                } catch (err) {}
                break;
              }

              let identifier = inviteCommand.phoneNumber;
              if (!identifier.includes('@')) {
                if (!identifier.startsWith('56')) {
                  identifier = '56' + identifier;
                }
              }

              const foundUser = await findUserByEmailOrPhone(identifier);

              if (foundUser) {
                try {
                  await sendWhatsAppButtons(from,
                    `✅ Usuario encontrado:\n\n` +
                    `Nombre: ${foundUser.name}\n` +
                    `${foundUser.email ? 'Email: ' + foundUser.email + '\n' : ''}` +
                    `${foundUser.whatsappNumber ? 'WhatsApp: ' + foundUser.whatsappNumber + '\n' : ''}` +
                    `\n¿Invitar a la cuenta "${account.name}"?`,
                    [
                      { title: 'Sí, invitar' },
                      { title: 'Cancelar' }
                    ]
                  );

                  setConversationState(from, {
                    type: 'awaiting_invite_confirmation',
                    accountId: account.id,
                    accountName: account.name,
                    inviteeIdentifier: identifier,
                    foundUser: foundUser
                  });
                } catch (err) {
                  console.log('Error:', err.message);
                }
              } else {
                try {
                  await sendWhatsAppButtons(from,
                    `⚠️ Usuario no encontrado\n\n` +
                    `No existe un usuario con: ${identifier}\n\n` +
                    `¿Quieres invitarlo a registrarse en FinanzApp?\n` +
                    `Cuando se registre, automáticamente se unirá a "${account.name}"`,
                    [
                      { title: 'Invitar a registrarse' },
                      { title: 'Cancelar' }
                    ]
                  );

                  setConversationState(from, {
                    type: 'awaiting_invite_to_register',
                    accountId: account.id,
                    accountName: account.name,
                    inviteeIdentifier: identifier
                  });
                } catch (err) {
                  console.log('Error:', err.message);
                }
              }
              break;
            }

            // CREAR CUENTA
            if (msgLower.startsWith('crear cuenta ')) {
              const accountName = messageBody.substring(13).trim();
              if (accountName) {
                try {
                  await createAccount(user.id, accountName);
                  await sendWhatsAppMessage(from, `✅ Cuenta "${accountName}" creada con balance $0`);
                } catch (err) {
                  await sendWhatsAppMessage(from, '⚠️ Error al crear la cuenta.');
                }
              } else {
                await sendWhatsAppMessage(from, '⚠️ Especifica el nombre. Ej: "Crear cuenta Efectivo"');
              }
              break;
            }

            // ELIMINAR CUENTA
            if (msgLower.startsWith('eliminar cuenta ')) {
              const accountName = messageBody.substring(16).trim();
              const accounts = await getUserAccounts(user.id);
              const account = accounts.find(a => a.name.toLowerCase() === accountName.toLowerCase());

              if (account) {
                setConversationState(from, {
                  type: 'awaiting_delete_confirmation',
                  accountId: account.id,
                  accountName: account.name
                });
                try {
                  await sendWhatsAppMessage(from,
                    `⚠️ ¿Eliminar "${account.name}"?\n` +
                    `Balance actual: $${account.balance?.toLocaleString('es-CL') || 0}\n\n` +
                    `Responde "confirmar" para eliminar.`
                  );
                } catch (err) {}
              } else {
                try {
                  await sendWhatsAppMessage(from, `⚠️ No encontré la cuenta "${accountName}"`);
                } catch (err) {}
              }
              break;
            }

            // MIS CUENTAS
            if (msgLower === 'mis cuentas' || msgLower === 'cuentas') {
              try {
                const response = await getAccountsListResponse(user.id);
                await sendWhatsAppMessage(from, response);
              } catch (err) {}
              break;
            }

            // TRANSFERIR
            if (msgLower.startsWith('transferir ')) {
              const amount = extractTransferAmount(messageBody);
              const accounts = await getUserAccounts(user.id);
              
              let fromAccount = null;
              let toAccount = null;
              
              for (const acc of accounts) {
                if (msgLower.includes(` de ${acc.name.toLowerCase()} `)) {
                  fromAccount = acc;
                }
                if (msgLower.includes(` a ${acc.name.toLowerCase()}`)) {
                  toAccount = acc;
                }
              }

              if (amount && fromAccount && toAccount) {
                if (fromAccount.balance < amount) {
                  try {
                    await sendWhatsAppMessage(from, `⚠️ ${fromAccount.name} no tiene suficiente saldo.`);
                  } catch (err) {}
                } else {
                  await createTransaction({
                    accountId: fromAccount.id,
                    userId: user.id,
                    type: 'expense',
                    amount: amount,
                    category: 'Transferencia',
                    description: `Transferencia a ${toAccount.name}`,
                    createdAt: new Date(),
                    source: 'whatsapp'
                  });

                  await createTransaction({
                    accountId: toAccount.id,
                    userId: user.id,
                    type: 'income',
                    amount: amount,
                    category: 'Transferencia',
                    description: `Transferencia desde ${fromAccount.name}`,
                    createdAt: new Date(),
                    source: 'whatsapp'
                  });

                  try {
                    await sendWhatsAppMessage(from,
                      `✅ Transferencia realizada\n\n` +
                      `${fromAccount.name}: $${(fromAccount.balance - amount).toLocaleString('es-CL')} (-$${amount.toLocaleString('es-CL')})\n` +
                      `${toAccount.name}: $${(toAccount.balance + amount).toLocaleString('es-CL')} (+$${amount.toLocaleString('es-CL')})`
                    );
                  } catch (err) {}
                }
              } else {
                try {
                  await sendWhatsAppMessage(from,
                    '⚠️ Formato: "Transferir 10000 de Débito a Efectivo"'
                  );
                } catch (err) {}
              }
              break;
            }

            // RENOMBRAR CUENTA
            if (msgLower.startsWith('renombrar ')) {
              // Formato: "Renombrar Efectivo a Billetera"
              const regex = /renombrar\s+(.+)\s+a\s+(.+)/i;
              const match = messageBody.match(regex);

              if (match) {
                const oldName = match[1].trim();
                const newName = match[2].trim();
                const accounts = await getUserAccounts(user.id);
                const account = accounts.find(a => a.name.toLowerCase() === oldName.toLowerCase());

                if (account) {
                  try {
                    await sendWhatsAppButtons(from,
                      `¿Renombrar "${account.name}" a "${newName}"?`,
                      [
                        { title: 'Sí, renombrar' },
                        { title: 'Cancelar' }
                      ]
                    );

                    setConversationState(from, {
                      type: 'awaiting_rename_confirmation',
                      accountId: account.id,
                      oldName: account.name,
                      newName: newName
                    });
                  } catch (err) {
                    console.log('Error:', err.message);
                  }
                } else {
                  try {
                    await sendWhatsAppMessage(from, `⚠️ No encontré la cuenta "${oldName}"`);
                  } catch (err) {}
                }
              } else {
                try {
                  await sendWhatsAppMessage(from, '⚠️ Formato: "Renombrar Efectivo a Billetera"');
                } catch (err) {}
              }
              break;
            }

            try {
              await sendWhatsAppMessage(from,
                '🤔 No entendí ese comando.\n\nEscribe "ayuda" para ver las opciones.'
              );
            } catch (err) {}
            break;
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error:', error);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'FinanzApp Backend funcionando',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});