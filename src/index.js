require('dotenv').config();
const express = require('express');
const { categorizeTransaction } = require('./services/groq');
const { findUserByPhone, createTransaction, getUserAccounts } = require('./services/firebase');
const { sendWhatsAppMessage } = require('./services/whatsapp');

const app = express();
app.use(express.json());

// Cache en memoria para evitar duplicados
const processedMessages = new Map();
const MAX_CACHE_SIZE = 100;

// Cache para rastrear primeros mensajes (evita spam de bienvenida)
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

        // 🔍 VERIFICAR SI ES PRIMER MENSAJE (para evitar spam de bienvenida)
        const isFirst = isFirstMessage(from);

        // 🔍 BUSCAR USUARIO POR TELÉFONO
        let user = await findUserByPhone(from);

        // ❌ CASO 1: Usuario NO existe en absoluto
        if (!user) {
          console.log('❌ Usuario no encontrado. Enviando enlace de registro...');
          
          if (isFirst) {
            try {
              await sendWhatsAppMessage(from,
                '👋 ¡Hola! Bienvenido a *FinanzApp*\n\n' +
                '⚠️ Para usar el bot de WhatsApp necesitas crear una cuenta primero.\n\n' +
                '📲 Regístrate aquí:\n' +
                'https://finanzapp-76702.web.app/register\n\n' +
                '💡 Una vez registrado, agrega este número de WhatsApp en tu perfil y podrás registrar tus gastos e ingresos directamente desde aquí.'
              );
              markAsWelcomed(from);
            } catch (err) {
              console.log('Error enviando mensaje de registro:', err.message);
            }
          }
          return res.sendStatus(200); // ⛔ NO procesar el mensaje
        }

        // ⚠️ CASO 2: Usuario existe pero NO tiene email (cuenta incompleta/fantasma)
        if (!user.email) {
          console.log('⚠️ Usuario sin email. Enviando enlace de registro...');
          
          if (isFirst) {
            try {
              await sendWhatsAppMessage(from,
                '⚠️ Tu cuenta está incompleta.\n\n' +
                'Para usar todas las funciones, completa tu registro:\n' +
                'https://finanzapp-76702.web.app/register\n\n' +
                '💡 Usa este número de WhatsApp al registrarte.'
              );
              markAsWelcomed(from);
            } catch (err) {
              console.log('Error enviando mensaje:', err.message);
            }
          }
          return res.sendStatus(200); // ⛔ NO procesar el mensaje
        }

        // ✅ CASO 3: Usuario completo (tiene email)
        console.log(`✅ Usuario encontrado: ${user.name} (${user.id})`);

        // 🎉 Si es el primer mensaje, dar bienvenida personalizada
        if (isFirst) {
          try {
            await sendWhatsAppMessage(from,
              `¡Hola ${user.name}! 👋\n\n` +
              'Ya puedes registrar tus gastos e ingresos desde WhatsApp.\n\n' +
              '📝 Ejemplos:\n' +
              '- "Gasté 5000 en supermercado"\n' +
              '- "Recibí 50000 de freelance"\n' +
              '- "Uber a casa 3500"\n\n' +
              '¡Adelante con tu mensaje! 🚀'
            );
            markAsWelcomed(from);
            return res.sendStatus(200); // Solo dar bienvenida, no procesar
          } catch (err) {
            console.log('Error enviando bienvenida:', err.message);
          }
        }

        // 🤖 PROCESAR MENSAJE COMO TRANSACCIÓN
        const analysis = await categorizeTransaction(messageBody);
        console.log('Análisis de Groq:', analysis);

        // Obtener cuentas del usuario
        const accounts = await getUserAccounts(user.id);
        const defaultAccount = accounts[0];

        if (!defaultAccount) {
          console.error('Usuario no tiene cuentas');
          try {
            await sendWhatsAppMessage(from, 
              '⚠️ No tienes cuentas configuradas.\n\n' +
              'Crea una cuenta desde la web:\n' +
              'https://finanzapp-76702.web.app'
            );
          } catch (err) {
            console.log('Error enviando mensaje:', err.message);
          }
          return res.sendStatus(200);
        }

        // Crear transacción
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

        // Enviar confirmación por WhatsApp
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
