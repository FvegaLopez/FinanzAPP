const axios = require('axios');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

async function sendWhatsAppMessage(to, message) {
  try {
    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error enviando mensaje de WhatsApp:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { sendWhatsAppMessage };