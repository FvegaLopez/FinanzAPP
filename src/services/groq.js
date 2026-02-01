const OpenAI = require('openai');

const groq = new OpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY
});

async function categorizeTransaction(description) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Eres un clasificador de transacciones financieras. 
Responde SOLO con un JSON válido, sin markdown, sin explicaciones.

Formato exacto:
{"type": "expense" o "income", "category": "categoría", "amount": número o null}

Categorías válidas para gastos: Alimentación, Transporte, Entretenimiento, Salud, Servicios, Compras, Otros
Categorías válidas para ingresos: Salario, Freelance, Inversiones, Otros

Ejemplos:
"Gasté 5000 en supermercado" → {"type":"expense","category":"Alimentación","amount":5000}
"Recibí mi sueldo de 500000" → {"type":"income","category":"Salario","amount":500000}
"Uber a casa 3500" → {"type":"expense","category":"Transporte","amount":3500}
"Compré zapatillas en 45000" → {"type":"expense","category":"Compras","amount":45000}`
        },
        {
          role: 'user',
          content: `Transacción: "${description}"`
        }
      ],
      temperature: 0,
      max_tokens: 100
    });

    const text = response.choices[0].message.content.trim();
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    
    console.log('Groq respuesta:', cleaned);
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('Error en Groq:', error.message);
    return {
      type: 'expense',
      category: 'Otros',
      amount: null
    };
  }
}

module.exports = { categorizeTransaction };