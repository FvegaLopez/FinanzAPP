require('dotenv').config();
const express = require('express');
const { categorizeTransaction } = require('./services/groq');
const { findUserByPhone, createUser, createTransaction, getUserAccounts } = require('./services/firebase');
const { sendWhatsAppMessage } = require('./services/whatsapp');

const app = express();
app.use(express.json());

// Cache en memoria para evitar duplicados
// Guarda los últimos 100 message_id procesados
const processedMessages = new Map();
const MAX_CACHE_SIZE = 100;

function isDuplicate(messageId) {
  return processedMessages.has(messageId);
}

function markAsProcessed(messageId) {
  // Si el cache está lleno, eliminar la entrada más antigua
  if (processedMessages.size >= MAX_CACHE_SIZE) {
    const firstKey = processedMessages.keys().next().value;
    processedMessages.delete(firstKey);
  }
  processedMessages.set(messageId, Date.now());
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
        const messageId = message.id;       // ID único que envía Meta
        const from = message.from;
        const messageBody = message.text?.body;

        console.log(`Mensaje recibido de ${from}: ${messageBody} (ID: ${messageId})`);

        // ✅ PROTECCIÓN CONTRA DUPLICADOS
        if (isDuplicate(messageId)) {
          console.log(`⚠️ Mensaje duplicado ignorado: ${messageId}`);
          return res.sendStatus(200);
        }
        markAsProcessed(messageId);

        // Buscar usuario por teléfono
        let user = await findUserByPhone(from);

        if (!user) {
          console.log('Usuario no encontrado, creando nuevo...');
          user = await createUser(`+${from}`);

          try {
            await sendWhatsAppMessage(from,
              '¡Bienvenido a FinanzApp! 🎉\n\n' +
              'Ya puedes registrar tus gastos e ingresos.\n\n' +
              'Ejemplos:\n' +
              '- "Gasté 5000 en supermercado"\n' +
              '- "Recibí 50000 de freelance"\n\n' +
              '💡 Si ya tienes cuenta en la web, agrega tu número de WhatsApp en tu perfil para sincronizar.'
            );
          } catch (err) {
            console.log('Error enviando bienvenida:', err.message);
          }
        } else {
          console.log(`Usuario encontrado: ${user.name} (${user.id})`);
        }

        // Categorizar con Groq
        const analysis = await categorizeTransaction(messageBody);
        console.log('Análisis de Groq:', analysis);

        // Obtener cuentas del usuario
        const accounts = await getUserAccounts(user.id);
        const defaultAccount = accounts[0];

        if (!defaultAccount) {
          console.error('Usuario no tiene cuentas');
          try {
            await sendWhatsAppMessage(from, '⚠️ No tienes cuentas configuradas. Revisa tu perfil en la web.');
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
          whatsappMessageId: messageId  // Guardar ID para referencia
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
    res.sendStatus(200); // Retornar 200 para que Meta no reintente
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
