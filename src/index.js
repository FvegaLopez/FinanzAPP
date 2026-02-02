require('dotenv').config();
const express = require('express');
const { detectIntention, categorizeTransaction } = require('./services/groq');
const { findUserByPhone, createTransaction, getUserAccounts } = require('./services/firebase');
const { sendWhatsAppMessage } = require('./services/whatsapp');

const app = express();
app.use(express.json());

// Cache en memoria para evitar duplicados
const processedMessages = new Map();
const MAX_CACHE_SIZE = 100;

// Cache para rastrear primeros mensajes
const firstMessageCache = new Map();

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

// Respuestas según intención
function getGreetingResponse(userName) {
  const greetings = [
    `¡Hola ${userName}! 👋 ¿En qué puedo ayudarte?\n\n💸 Para registrar un gasto escribe algo como:\n"Gasté 5000 en supermercado"\n\n💰 Para registrar un ingreso:\n"Recibí 50000 de freelance"\n\n📊 Para ver tu balance:\n"Cuánto tengo"`,
    `¡Buenos días ${userName}! ☀️ Soy FinanzApp, tu asistente de finanzas.\n\nPuedo ayudarte a:\n💸 Registrar gastos\n💰 Registrar ingresos\n📊 Ver tu balance\n\n¡Dime qué necesitas!`,
    `¡Qué onda ${userName}! 👋 Estoy listo para ayudarte con tus finanzas.\n\nEscribe algo como "Gasté 3000 en comida" y lo registro por ti. O pídeme tu balance.`
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
}

function getHelpResponse() {
  return (
    '📖 *Guía de uso de FinanzApp*\n\n' +
    '💸 *Registrar un gasto:*\n' +
    '  "Gasté 5000 en supermercado"\n' +
    '  "Uber a casa 3500"\n' +
    '  "Compré zapatillas por 45000"\n\n' +
    '💰 *Registrar un ingreso:*\n' +
    '  "Recibí mi sueldo de 500000"\n' +
    '  "Freelance 80000"\n\n' +
    '📊 *Ver balance:*\n' +
    '  "Cuánto tengo"\n' +
    '  "Mi balance"\n\n' +
    '🌐 *Dashboard web:*\n' +
    '  https://finanzapp-76702.web.app\n\n' +
    '¡Eso es todo! Intenta con algo 😄'
  );
}

async function getBalanceResponse(userId) {
  const accounts = await getUserAccounts(userId);
  
  if (accounts.length === 0) {
    return '⚠️ No tienes cuentas configuradas. Crea una desde la web:\nhttps://finanzapp-76702.web.app';
  }

  let response = '📊 *Tu resumen financiero*\n\n';
  
  accounts.forEach(account => {
    const emoji = account.balance >= 0 ? '💚' : '🔴';
    response += `${emoji} ${account.name}: $${account.balance?.toLocaleString('es-CL') || 0}\n`;
  });

  response += '\n🌐 Ver detalle en: https://finanzapp-76702.web.app';
  return response;
}

function getUnknownResponse() {
  return (
    '🤔 No entendí bien ese mensaje.\n\n' +
    'Puedo ayudarte con:\n' +
    '💸 Registrar gastos → "Gasté 5000 en supermercado"\n' +
    '💰 Registrar ingresos → "Recibí 50000"\n' +
    '📊 Ver balance → "Cuánto tengo"\n' +
    '❓ Ver ayuda → "Ayuda"'
  );
}

// Verificación del webhook
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

// Recepción de mensajes de WhatsApp
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

        console.log(`Mensaje recibido de ${from}: ${messageBody} (ID: ${messageId})`);

        // ✅ PROTECCIÓN CONTRA DUPLICADOS
        if (isDuplicate(messageId)) {
          console.log(`⚠️ Mensaje duplicado ignorado: ${messageId}`);
          return res.sendStatus(200);
        }
        markAsProcessed(messageId);

        // 🔍 BUSCAR USUARIO
        let user = await findUserByPhone(from);

        // ❌ CASO 1: Usuario NO existe
        if (!user) {
          console.log('❌ Usuario no encontrado. Enviando enlace de registro...');
          if (isFirstMessage(from)) {
            try {
              await sendWhatsAppMessage(from,
                '👋 ¡Hola! Bienvenido a *FinanzApp*\n\n' +
                '⚠️ Para usar el bot necesitas crear una cuenta primero.\n\n' +
                '📲 Regístrate aquí:\n' +
                'https://finanzapp-76702.web.app/register\n\n' +
                '💡 Una vez registrado, agrega este número de WhatsApp en tu perfil.'
              );
              markAsWelcomed(from);
            } catch (err) {
              console.log('Error enviando mensaje de registro:', err.message);
            }
          }
          return res.sendStatus(200);
        }

        // ⚠️ CASO 2: Usuario sin email (cuenta incompleta)
        if (!user.email) {
          console.log('⚠️ Usuario sin email. Enviando enlace de registro...');
          if (isFirstMessage(from)) {
            try {
              await sendWhatsAppMessage(from,
                '⚠️ Tu cuenta está incompleta.\n\n' +
                'Completa tu registro:\n' +
                'https://finanzapp-76702.web.app/register\n\n' +
                '💡 Usa este número de WhatsApp al registrarte.'
              );
              markAsWelcomed(from);
            } catch (err) {
              console.log('Error enviando mensaje:', err.message);
            }
          }
          return res.sendStatus(200);
        }

        // ✅ CASO 3: Usuario completo
        console.log(`✅ Usuario encontrado: ${user.name} (${user.id})`);

        // 🎉 Primer mensaje → bienvenida
        if (isFirstMessage(from)) {
          markAsWelcomed(from);
          try {
            await sendWhatsAppMessage(from, getGreetingResponse(user.name));
          } catch (err) {
            console.log('Error enviando bienvenida:', err.message);
          }
          return res.sendStatus(200);
        }

        // 🤖 DETECTAR INTENCIÓN DEL MENSAJE
        const intention = await detectIntention(messageBody);

        switch (intention) {
          case 'greeting':
            console.log('→ Intención: saludo');
            try {
              await sendWhatsAppMessage(from, getGreetingResponse(user.name));
            } catch (err) {
              console.log('Error enviando respuesta:', err.message);
            }
            break;

          case 'help':
            console.log('→ Intención: ayuda');
            try {
              await sendWhatsAppMessage(from, getHelpResponse());
            } catch (err) {
              console.log('Error enviando ayuda:', err.message);
            }
            break;

          case 'balance':
            console.log('→ Intención: balance');
            try {
              const balanceResponse = await getBalanceResponse(user.id);
              await sendWhatsAppMessage(from, balanceResponse);
            } catch (err) {
              console.log('Error enviando balance:', err.message);
            }
            break;

          case 'transaction':
            console.log('→ Intención: transacción');

            const analysis = await categorizeTransaction(messageBody);
            console.log('Análisis de Groq:', analysis);

            const accounts = await getUserAccounts(user.id);
            const defaultAccount = accounts[0];

            if (!defaultAccount) {
              try {
                await sendWhatsAppMessage(from,
                  '⚠️ No tienes cuentas configuradas.\n\n' +
                  'Crea una desde la web:\nhttps://finanzapp-76702.web.app'
                );
              } catch (err) {
                console.log('Error enviando mensaje:', err.message);
              }
              break;
            }

            const transaction = await createTransaction({
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

            console.log('✅ Transacción creada:', transaction.id);

            try {
              const emoji = analysis.type === 'income' ? '💰' : '💸';
              const typeText = analysis.type === 'income' ? 'Ingreso' : 'Gasto';
              const newBalance = defaultAccount.balance + (analysis.type === 'income' ? analysis.amount : -analysis.amount);

              let response = `${emoji} ${typeText} registrado\n\n`;
              response += `📝 Categoría: ${analysis.category}\n`;
              response += `💵 Monto: $${analysis.amount?.toLocaleString('es-CL') || 'No detectado'}\n`;
              response += `📊 Balance: $${newBalance.toLocaleString('es-CL')}`;

              await sendWhatsAppMessage(from, response);
            } catch (err) {
              console.log('Error enviando confirmación:', err.message);
            }
            break;

          case 'unknown':
          default:
            console.log('→ Intención: desconocida');
            try {
              await sendWhatsAppMessage(from, getUnknownResponse());
            } catch (err) {
              console.log('Error enviando respuesta:', err.message);
            }
            break;
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.sendStatus(200);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'FinanzApp Backend está funcionando',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});