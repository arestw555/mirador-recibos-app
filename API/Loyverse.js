// /api/loyverse.js

/**
 * IMPORTANTE: Este archivo actúa como tu backend seguro.
 * - Se comunica con la API de Loyverse.
 * - Se comunica con la base de datos de Firebase (Firestore).
 * - Protege tus Access Tokens y credenciales de Firebase.
 */

// Importaciones de Firebase
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- CONFIGURACIÓN DE SEGURIDAD ---
// Estos valores DEBEN ser configurados como "Environment Variables" en tu plataforma de hosting (Vercel, Firebase, etc.)
const LOYVERSE_ACCESS_TOKEN = process.env.LOYVERSE_ACCESS_TOKEN;

// Configuración de las credenciales de servicio de Firebase
// El contenido de tu archivo JSON de credenciales de servicio debe estar en esta variable de entorno
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

// Inicializar la app de Firebase SOLO si no se ha hecho antes
if (!getApps().length) {
  if (!FIREBASE_SERVICE_ACCOUNT) {
    console.error("FIREBASE_SERVICE_ACCOUNT no está configurada en el servidor.");
  } else {
    initializeApp({
      credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
    });
  }
}

const db = getFirestore();

// Función principal que maneja todas las peticiones del frontend
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    if (!LOYVERSE_ACCESS_TOKEN || !FIREBASE_SERVICE_ACCOUNT) {
        return res.status(500).json({ message: 'Error de configuración del servidor: Faltan credenciales.' });
    }

    const { action, payload } = req.body;

    try {
        switch (action) {
            case 'getReceipt':
                return await getReceipt(payload, res);
            case 'getReceiptsByDate':
                return await getReceiptsByDate(payload, res);
            case 'saveCustomerData':
                return await saveCustomerData(payload, res);
            // Agrega aquí más acciones en el futuro (ej. 'updateReceipt')
            default:
                return res.status(400).json({ message: 'Acción no válida.' });
        }
    } catch (error) {
        console.error(`Error en la acción '${action}':`, error);
        return res.status(500).json({ message: 'Error interno del servidor.', details: error.message });
    }
}

/**
 * Busca un recibo específico por su número.
 * Combina datos de Loyverse y de la base de datos (Firestore).
 */
async function getReceipt({ receiptNumber }, res) {
    const loyverseApiUrl = `https://api.loyverse.com/v1.0/receipts/${receiptNumber}?expand=lines,payments`;
    
    const loyverseResponse = await fetch(loyverseApiUrl, {
        headers: { 'Authorization': `Bearer ${LOYVERSE_ACCESS_TOKEN}` }
    });

    if (!loyverseResponse.ok) {
        if (loyverseResponse.status === 404) {
             return res.status(404).json({ message: `Recibo no encontrado en Loyverse (${receiptNumber}).` });
        }
        return res.status(loyverseResponse.status).json({ message: `Error al comunicar con Loyverse.` });
    }

    const loyverseReceipt = await loyverseResponse.json();

    // Paso 2: Buscar datos adicionales en Firestore.
    const firestoreDocRef = db.collection('receipts').doc(loyverseReceipt.receipt_id);
    const firestoreSnap = await firestoreDocRef.get();
    const firestoreData = firestoreSnap.exists ? firestoreSnap.data() : {};

    // Paso 3: Combinar los datos y adaptarlos al formato que el frontend espera.
    const combinedData = formatReceiptForFrontend(loyverseReceipt, firestoreData);

    return res.status(200).json(combinedData);
}

/**
 * Guarda o actualiza los datos del cliente para un recibo en Firestore.
 */
async function saveCustomerData({ loyverseId, customerData }, res) {
    if (!loyverseId || !customerData) {
        return res.status(400).json({ message: 'Faltan datos para guardar.' });
    }

    const firestoreDocRef = db.collection('receipts').doc(loyverseId);
    
    const dataToSave = {
        customerData: customerData,
        status: 'processing', // Cambia el estado a "En Proceso"
        updatedAt: new Date().toISOString()
    };

    // Usamos `set` con `merge: true` para crear el documento si no existe, o actualizarlo si ya existe.
    await firestoreDocRef.set(dataToSave, { merge: true });

    return res.status(200).json({ message: 'Datos guardados exitosamente.' });
}


/**
 * Busca una lista de recibos por rango de fechas para el panel de admin.
 */
async function getReceiptsByDate({ startDate, endDate }, res) {
    const createdAtMin = startDate ? new Date(startDate).toISOString() : '';
    const createdAtMax = endDate ? new Date(endDate).toISOString() : '';

    let loyverseApiUrl = `https://api.loyverse.com/v1.0/receipts?expand=lines,payments&limit=250`;
    if (createdAtMin) loyverseApiUrl += `&created_at_min=${createdAtMin}`;
    if (createdAtMax) loyverseApiUrl += `&created_at_max=${createdAtMax}`;
    
    const loyverseResponse = await fetch(loyverseApiUrl, {
        headers: { 'Authorization': `Bearer ${LOYVERSE_ACCESS_TOKEN}` }
    });

    if (!loyverseResponse.ok) {
        return res.status(loyverseResponse.status).json({ message: 'Error al obtener recibos de Loyverse.' });
    }

    const loyverseData = await loyverseResponse.json();
    const loyverseReceipts = loyverseData.receipts || [];

    // Para cada recibo de Loyverse, buscamos sus datos complementarios en Firestore.
    const combinedReceiptsPromises = loyverseReceipts.map(async (receipt) => {
        const firestoreDocRef = db.collection('receipts').doc(receipt.receipt_id);
        const firestoreSnap = await firestoreDocRef.get();
        const firestoreData = firestoreSnap.exists ? firestoreSnap.data() : {};
        return formatReceiptForFrontend(receipt, firestoreData);
    });

    const combinedReceipts = await Promise.all(combinedReceiptsPromises);

    return res.status(200).json(combinedReceipts);
}


// --- FUNCIONES DE UTILIDAD ---
function formatReceiptForFrontend(loyverseReceipt, firestoreData) {
    const payment = loyverseReceipt.payments && loyverseReceipt.payments.length > 0 ? loyverseReceipt.payments[0] : {};
    
    return {
        loyverseId: loyverseReceipt.receipt_id,
        receiptNumber: loyverseReceipt.receipt_number,
        orderNumber: loyverseReceipt.order || 'N/A',
        date: new Date(loyverseReceipt.created_at).toISOString().split('T')[0],
        time: new Date(loyverseReceipt.created_at).toTimeString().split(' ')[0].substring(0, 8),
        paymentType: payment.name || 'Desconocido',
        items: loyverseReceipt.line_items.map(item => ({
            name: item.item_name,
            quantity: parseFloat(item.quantity),
            price: parseFloat(item.price)
        })),
        subtotal: parseFloat(loyverseReceipt.total_money) - parseFloat(loyverseReceipt.total_tax),
        tax: parseFloat(loyverseReceipt.total_tax),
        total: parseFloat(loyverseReceipt.total_money),
        status: firestoreData.status || 'pending',
        invoiceLinks: firestoreData.invoiceLinks || [],
        customerData: firestoreData.customerData || null
    };
}