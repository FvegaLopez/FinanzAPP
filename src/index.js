require('dotenv').config();
const express = require('express');
const { detectIntention, categorizeTransaction, detectAccountInMessage, extractTransferAmount } = require('./services/groq');
const { findUserByPhone, createTransaction, getUserAccounts, createAccount, deleteAccount, setDefaultAccount } = require('./services/firebase');
const { sendWhatsAppMessage, sendWhatsAppList } = require('./services/whatsapp');

const app = express();
app.use(express.json());

// Cache en memoria
const processedMessages = new Map();
const firstMessageCache = new Map();
const conversationState = new Map(); // Para manejar flujos multi-paso
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

// Manejo de estado de conversación
function setConversationState(phone, state) {
  conversationState.set(phone, { ...state, timestamp: Date.now() });
}

function getConversationState(phone) {
  const state = conversationState.get(phone);
  if (!state) return null;
  
  // Expirar estados después de 5 minutos
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
  return `¡Hola ${userName}! 👋\n\n💸 Registrar gasto:\n"Gasté 5000 en supermercado"\n"Uber 3500 en efectivo"\n\n💰 Ver balance:\n"Mis cuentas"\n\n🏦 Gestionar cuentas:\n"Crear cuenta Tarjeta"\n"Eliminar cuenta Efectivo"\n\n💱 Transferir:\n"Transferir 10000 de Débito a Efectivo"`;
}

function getHelpResponse() {
  return '📖 *Comandos disponibles*\n\n💸 *Transacciones:*\n"Gasté 5000 en supermercado"\n"Recibí 50000 de freelance"\n"Uber 3500 en efectivo"\n\n🏦 *Cuentas:*\n"Mis cuentas"\n"Crear cuenta Ahorros"\n"Eliminar cuenta Efectivo"\n\n💱 *Transferencias:*\n"Transferir 10000 de Débito a Efectivo"';
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
    response += `${icon} ${account.name}${defaultMark}: $${account.balance?.toLocaleString('es-CL') || 0}\n`;
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
        const messageBody = message.text?.body;

        console.log(`Mensaje: ${messageBody} de ${from} (${messageId})`);

        if (isDuplicate(messageId)) {
          console.log(`⚠️ Duplicado ignorado`);
          return res.sendStatus(200);
        }
        markAsProcessed(messageId);

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

        if (isFirstMessage(from)) {
          markAsWelcomed(from);
          try {
            await sendWhatsAppMessage(from, getGreetingResponse(user.name));
          } catch (err) {}
          return res.sendStatus(200);
        }

        // VERIFICAR ESTADO DE CONVERSACIÓN
        const state = getConversationState(from);

        // CASO: Esperando selección de cuenta para transacción
        if (state && state.type === 'awaiting_account_selection') {
          const accounts = await getUserAccounts(user.id);
          const selectedAccount = accounts.find((a, i) => (i + 1).toString() === messageBody.trim());

          if (selectedAccount) {
            // Crear transacción
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

        // CASO: Cancelar flujo
        if (messageBody.toLowerCase() === 'cancelar') {
          clearConversationState(from);
          try {
            await sendWhatsAppMessage(from, '❌ Operación cancelada.');
          } catch (err) {}
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

            // Detectar si mencionó una cuenta en el mensaje
            const detectedAccount = await detectAccountInMessage(messageBody, accounts);

            if (detectedAccount) {
              // Cuenta detectada automáticamente
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
              // Solo una cuenta, usarla automáticamente
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
              // Múltiples cuentas → preguntar
              let response = `💸 ${analysis.type === 'income' ? 'Ingreso' : 'Gasto'} de $${analysis.amount?.toLocaleString('es-CL')} en ${analysis.category}\n\n¿En qué cuenta?\n\n`;
              accounts.forEach((acc, i) => {
                const icon = acc.name.toLowerCase().includes('efectivo') ? '💵' :
                             acc.name.toLowerCase().includes('debito') ? '💳' :
                             acc.name.toLowerCase().includes('ahorro') ? '🏦' : '💼';
                response += `${i + 1} - ${icon} ${acc.name}\n`;
              });
              response += '\nResponde con el número de la cuenta.';

              try {
                await sendWhatsAppMessage(from, response);
                setConversationState(from, {
                  type: 'awaiting_account_selection',
                  transaction: {
                    type: analysis.type,
                    amount: analysis.amount,
                    category: analysis.category,
                    description: messageBody
                  }
                });
              } catch (err) {}
            }
            break;

          case 'unknown':
          default:
            // Detectar comandos específicos
            const msgLower = messageBody.toLowerCase();

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
              
              // Intentar detectar cuentas origen y destino
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
                  // Crear dos transacciones (salida y entrada)
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

            // No se reconoció
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