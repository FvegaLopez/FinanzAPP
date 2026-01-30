require('dotenv').config();
const express = require('express');
const { categorizeTransaction } = require('./services/gemini');
const { getUserByWhatsApp, createUser, createTransaction, getUserAccounts } = require('./services/firebase');
const { sendWhatsAppMessage } = require('./services/whatsapp');

const app = express();
app.use(express.json());

// Verificación del webhook (requerido por WhatsApp)
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
        const from = message.from; // Número de WhatsApp del usuario
        const messageBody = message.text?.body;

        console.log(`Mensaje recibido de ${from}: ${messageBody}`);

        // Buscar o crear usuario
        let user = await getUserByWhatsApp(from);
        
        if (!user) {
          user = await createUser(from);
          await sendWhatsAppMessage(from, '¡Bienvenido a FinanzApp! 🎉\n\nYa puedes empezar a registrar tus gastos e ingresos.\n\nEjemplos:\n- "Gasté 5000 en supermercado"\n- "Recibí 50000 de freelance"');
        }

        // Categorizar con Gemini
        const analysis = await categorizeTransaction(messageBody);
        
        // Obtener cuenta del usuario
        const accounts = await getUserAccounts(user.id);
        const defaultAccount = accounts[0]; // Por ahora usamos la primera cuenta

        if (!defaultAccount) {
          await sendWhatsAppMessage(from, 'Error: No tienes cuentas configuradas. Contacta soporte.');
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
          date: new Date()
        });

        // Responder al usuario
        const emoji = analysis.type === 'income' ? '💰' : '💸';
        const typeText = analysis.type === 'income' ? 'Ingreso' : 'Gasto';
        
        let response = `${emoji} ${typeText} registrado\n\n`;
        response += `📝 Categoría: ${analysis.category}\n`;
        response += `💵 Monto: $${analysis.amount?.toLocaleString('es-CL') || 'No detectado'}\n`;
        response += `📊 Balance actual: $${(defaultAccount.balance + (analysis.type === 'income' ? analysis.amount : -analysis.amount)).toLocaleString('es-CL')}`;

        await sendWhatsAppMessage(from, response);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.sendStatus(500);
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