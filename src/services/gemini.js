const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function categorizeTransaction(description) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `Analiza esta transacción financiera y responde SOLO con un JSON válido (sin markdown, sin \`\`\`):

Transacción: "${description}"

Responde con este formato exacto:
{
  "type": "expense" o "income",
  "category": "categoría apropiada",
  "amount": número extraído o null
}

Categorías válidas para gastos: Alimentación, Transporte, Entretenimiento, Salud, Servicios, Compras, Otros
Categorías válidas para ingresos: Salario, Freelance, Inversiones, Otros

Ejemplos:
"Gasté 5000 en supermercado" → {"type":"expense","category":"Alimentación","amount":5000}
"Recibí mi sueldo de 500000" → {"type":"income","category":"Salario","amount":500000}
"Uber a casa 3500" → {"type":"expense","category":"Transporte","amount":3500}`;

    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();
    
    // Limpiar respuesta por si tiene markdown
    const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
    
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('Error en Gemini:', error);
    return {
      type: "expense",
      category: "Otros",
      amount: null
    };
  }
}

module.exports = { categorizeTransaction };