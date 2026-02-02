const OpenAI = require('openai');

const groq = new OpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY
});

// Detectar si el mensaje es una transacción o otra cosa
async function detectIntention(message) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Eres un clasificador de intenciones para una app de finanzas personales llamada FinanzApp.

Tu única tarea es clasificar el mensaje del usuario en una de estas categorías:

1. "transaction" → El usuario quiere registrar un gasto o ingreso. Ejemplos: "Gasté 5000 en supermercado", "Recibí mi sueldo", "Uber 3500", "Compré zapatillas por 45000", "Pagué 12000 en arriendo"
2. "greeting" → El usuario saluda o hace conversación casual. Ejemplos: "Hola", "Buenos días", "Qué onda", "Hey", "Hola amigo"
3. "help" → El usuario pide ayuda o no sabe cómo usar la app. Ejemplos: "Ayuda", "Cómo uso esto", "Qué puedo hacer", "Help", "Opciones"
4. "balance" → El usuario quiere ver su balance o un resumen. Ejemplos: "Cuánto tengo", "Mi balance", "Resumen", "Estado de cuenta", "Cuánto me queda"
5. "unknown" → No encaja en ninguna categoría anterior.

Responde SOLO con un JSON válido, sin markdown, sin explicaciones:
{"intention": "categoría"}`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 50
    });

    const text = response.choices[0].message.content.trim();
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const result = JSON.parse(cleaned);
    
    console.log(`Intención detectada: ${result.intention} (mensaje: "${message}")`);
    return result.intention;
  } catch (error) {
    console.error('Error detectando intención:', error.message);
    return 'unknown';
  }
}

// Categorizar transacción financiera
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

module.exports = { detectIntention, categorizeTransaction };