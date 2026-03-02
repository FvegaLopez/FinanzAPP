const { getUserAccounts } = require('./firebase');
const { db } = require('../config/firebase-admin');

// Obtener resumen mensual global
async function getMonthlyReport(userId, month = null, year = null) {
  const now = new Date();
  const targetMonth = month !== null ? month : now.getMonth();
  const targetYear = year !== null ? year : now.getFullYear();

  // Calcular rango de fechas del mes
  const startDate = new Date(targetYear, targetMonth, 1);
  const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

  const accounts = await getUserAccounts(userId);
  
  if (accounts.length === 0) {
    return null;
  }

  const accountIds = accounts.map(a => a.id);

  // Obtener todas las transacciones del mes
  const transactionsSnapshot = await db.collection('transactions')
    .where('userId', '==', userId)
    .where('accountId', 'in', accountIds)
    .where('createdAt', '>=', startDate)
    .where('createdAt', '<=', endDate)
    .get();

  const transactions = transactionsSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  // Calcular totales globales
  let totalIncome = 0;
  let totalExpense = 0;

  const accountSummaries = {};
  const categorySummaries = {};

  // Inicializar resúmenes por cuenta
  accounts.forEach(acc => {
    accountSummaries[acc.id] = {
      name: acc.name,
      income: 0,
      expense: 0,
      balance: acc.balance || 0
    };
  });

  // Procesar transacciones
  transactions.forEach(t => {
    const amount = t.amount || 0;
    
    if (t.type === 'income') {
      totalIncome += amount;
      accountSummaries[t.accountId].income += amount;
    } else {
      totalExpense += amount;
      accountSummaries[t.accountId].expense += amount;
    }

    // Sumar por categoría
    if (!categorySummaries[t.category]) {
      categorySummaries[t.category] = {
        income: 0,
        expense: 0
      };
    }

    if (t.type === 'income') {
      categorySummaries[t.category].income += amount;
    } else {
      categorySummaries[t.category].expense += amount;
    }
  });

  const totalSavings = totalIncome - totalExpense;

  return {
    month: targetMonth,
    year: targetYear,
    monthName: getMonthName(targetMonth),
    global: {
      income: totalIncome,
      expense: totalExpense,
      savings: totalSavings
    },
    accounts: accountSummaries,
    categories: categorySummaries,
    transactionCount: transactions.length
  };
}

// Obtener resumen de una cuenta específica
async function getAccountMonthlyReport(userId, accountName, month = null, year = null) {
  const now = new Date();
  const targetMonth = month !== null ? month : now.getMonth();
  const targetYear = year !== null ? year : now.getFullYear();

  const startDate = new Date(targetYear, targetMonth, 1);
  const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

  const accounts = await getUserAccounts(userId);
  const account = accounts.find(a => a.name.toLowerCase() === accountName.toLowerCase());

  if (!account) {
    return null;
  }

  const transactionsSnapshot = await db.collection('transactions')
    .where('userId', '==', userId)
    .where('accountId', '==', account.id)
    .where('createdAt', '>=', startDate)
    .where('createdAt', '<=', endDate)
    .get();

  const transactions = transactionsSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  let totalIncome = 0;
  let totalExpense = 0;
  const categorySummaries = {};

  transactions.forEach(t => {
    const amount = t.amount || 0;
    
    if (t.type === 'income') {
      totalIncome += amount;
    } else {
      totalExpense += amount;
    }

    if (!categorySummaries[t.category]) {
      categorySummaries[t.category] = 0;
    }

    if (t.type === 'expense') {
      categorySummaries[t.category] += amount;
    }
  });

  // Ordenar categorías por gasto
  const topCategories = Object.entries(categorySummaries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, amount]) => ({
      category,
      amount,
      percentage: totalExpense > 0 ? Math.round((amount / totalExpense) * 100) : 0
    }));

  return {
    month: targetMonth,
    year: targetYear,
    monthName: getMonthName(targetMonth),
    accountName: account.name,
    balance: account.balance || 0,
    income: totalIncome,
    expense: totalExpense,
    savings: totalIncome - totalExpense,
    topCategories,
    transactionCount: transactions.length
  };
}

// Formatear resumen global para WhatsApp
function formatGlobalReport(report) {
  if (!report) {
    return '⚠️ No tienes transacciones para generar un resumen.';
  }

  const { monthName, year, global, accounts } = report;

  let message = `📊 *Resumen de ${monthName} ${year}*\n\n`;
  
  // Global
  message += `💰 *GLOBAL:*\n`;
  message += `Ingresaste: $${global.income.toLocaleString('es-CL')}\n`;
  message += `Gastaste: $${global.expense.toLocaleString('es-CL')}\n`;
  
  const savingsEmoji = global.savings >= 0 ? '📈' : '📉';
  message += `${savingsEmoji} ${global.savings >= 0 ? 'Ahorraste' : 'Déficit'}: $${Math.abs(global.savings).toLocaleString('es-CL')}\n\n`;

  // Por cuenta
  message += `🏦 *POR CUENTA:*\n`;
  Object.values(accounts).forEach(acc => {
    const icon = getAccountIcon(acc.name);
    const change = acc.income - acc.expense;
    const changeSymbol = change >= 0 ? '+' : '';
    message += `${icon} ${acc.name}: $${acc.balance.toLocaleString('es-CL')} (${changeSymbol}$${change.toLocaleString('es-CL')})\n`;
  });

  return message;
}

// Formatear resumen de cuenta específica
function formatAccountReport(report) {
  if (!report) {
    return '⚠️ No encontré esa cuenta o no tiene transacciones.';
  }

  const { monthName, year, accountName, balance, income, expense, savings, topCategories } = report;

  let message = `📊 *Resumen de ${monthName} ${year} - ${accountName}*\n\n`;
  
  message += `Balance actual: $${balance.toLocaleString('es-CL')}\n`;
  message += `Ingresos: $${income.toLocaleString('es-CL')}\n`;
  message += `Gastos: $${expense.toLocaleString('es-CL')}\n`;
  
  const savingsEmoji = savings >= 0 ? '📈' : '📉';
  message += `${savingsEmoji} ${savings >= 0 ? 'Ahorraste' : 'Déficit'}: $${Math.abs(savings).toLocaleString('es-CL')}\n\n`;

  if (topCategories.length > 0) {
    message += `*Top categorías de gasto:*\n`;
    topCategories.forEach((cat, i) => {
      message += `${i + 1}. ${cat.category}: $${cat.amount.toLocaleString('es-CL')} (${cat.percentage}%)\n`;
    });
  }

  return message;
}

// Formatear desglose por categorías
function formatCategoryBreakdown(report) {
  if (!report || !report.categories) {
    return '⚠️ No hay datos de categorías.';
  }

  const { monthName, year, categories } = report;

  let message = `📋 *Desglose por Categorías - ${monthName} ${year}*\n\n`;

  // Separar gastos e ingresos
  const expenses = [];
  const incomes = [];

  Object.entries(categories).forEach(([category, data]) => {
    if (data.expense > 0) {
      expenses.push({ category, amount: data.expense });
    }
    if (data.income > 0) {
      incomes.push({ category, amount: data.income });
    }
  });

  // Ordenar por monto
  expenses.sort((a, b) => b.amount - a.amount);
  incomes.sort((a, b) => b.amount - a.amount);

  if (expenses.length > 0) {
    message += `💸 *Gastos:*\n`;
    expenses.forEach((exp, i) => {
      message += `${i + 1}. ${exp.category}: $${exp.amount.toLocaleString('es-CL')}\n`;
    });
    message += '\n';
  }

  if (incomes.length > 0) {
    message += `💰 *Ingresos:*\n`;
    incomes.forEach((inc, i) => {
      message += `${i + 1}. ${inc.category}: $${inc.amount.toLocaleString('es-CL')}\n`;
    });
  }

  return message;
}

function getMonthName(monthIndex) {
  const months = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];
  return months[monthIndex];
}

function getAccountIcon(name) {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('efectivo')) return '💵';
  if (nameLower.includes('debito') || nameLower.includes('débito')) return '💳';
  if (nameLower.includes('ahorro')) return '🏦';
  if (nameLower.includes('credito') || nameLower.includes('crédito')) return '💰';
  return '💼';
}

// Parsear mes del texto
function parseMonthFromText(text) {
  const monthsMap = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3,
    'mayo': 4, 'junio': 5, 'julio': 6, 'agosto': 7,
    'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
  };

  const textLower = text.toLowerCase();
  
  for (const [name, index] of Object.entries(monthsMap)) {
    if (textLower.includes(name)) {
      return index;
    }
  }

  return null;
}

module.exports = {
  getMonthlyReport,
  getAccountMonthlyReport,
  formatGlobalReport,
  formatAccountReport,
  formatCategoryBreakdown,
  parseMonthFromText
};