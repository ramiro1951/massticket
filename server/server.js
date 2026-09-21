// massticket.mx — backend
// Varios eventos, cada uno con su cupo y sus boletos. Crea preferencias de
// pago en Mercado Pago (Checkout Pro), confirma los pagos por webhook
// (nunca por el regreso del navegador) y emite/valida boletos.

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR apunta a una carpeta permanente (un "Volume" en Railway) para que
// los eventos y boletos NO se borren cada vez que se actualiza el sitio.
// Si no está configurada, usa la carpeta local de siempre (para desarrollo).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const {
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  PUBLIC_URL = "http://localhost:3000",
  ADMIN_KEY,
  PORT = 3000,
} = process.env;

if (!MP_ACCESS_TOKEN) console.warn("⚠️  Falta MP_ACCESS_TOKEN en las variables de entorno.");
if (!MP_WEBHOOK_SECRET) console.warn("⚠️  Falta MP_WEBHOOK_SECRET: el webhook no podrá verificar firmas.");
if (!ADMIN_KEY) console.warn("⚠️  Falta ADMIN_KEY: el panel de organizador quedaría sin contraseña.");

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/* ---------------- Almacenamiento (archivo JSON con candado simple) ---------------- */

let escribiendo = Promise.resolve();
function conCandado(fn) {
  const resultado = escribiendo.then(fn, fn);
  escribiendo = resultado.catch(() => {});
  return resultado;
}

async function leerDB() {
  try {
    const texto = await fs.readFile(DB_PATH, "utf8");
    const db = JSON.parse(texto);
    if (!Array.isArray(db.eventos)) db.eventos = [];
    if (!Array.isArray(db.ventas)) db.ventas = [];
    if (!Array.isArray(db.boletos)) db.boletos = [];
    return db;
  } catch {
    return { eventos: [], ventas: [], boletos: [] };
  }
}
async function escribirDB(datos) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(datos, null, 2));
}

/* ---------------- Utilidades ---------------- */

const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function folioNuevo(i) {
  let s = "";
  for (let k = 0; k < 4; k++) s += ABC[Math.floor(Math.random() * ABC.length)];
  return "MT-" + s + "-" + String(i).padStart(4, "0");
}

// Cuántos lugares ya están tomados de un evento: boletos ya emitidos
// más ventas pendientes de pago (para no vender de más mientras alguien
// todavía está pagando en Mercado Pago).
function ocupadosDe(db, eventoId) {
  const enBoletos = db.boletos.filter((b) => b.eventoId === eventoId).length;
  const enPendientes = db.ventas
    .filter((v) => v.eventoId === eventoId && v.estado === "pendiente")
    .reduce((s, v) => s + v.cantidad, 0);
  return enBoletos + enPendientes;
}

function requiereAdmin(req, res, next) {
  const clave = req.get("x-admin-key");
  if (!ADMIN_KEY || clave !== ADMIN_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// Verifica que la notificación realmente venga de Mercado Pago.
// https://www.mercadopago.com.mx/developers/es/docs/checkout-pro/additional-content/notifications/webhooks
function verificarFirma(req) {
  const xSignature = req.get("x-signature");
  const xRequestId = req.get("x-request-id");
  const dataId = (req.query["data.id"] || "").toLowerCase();
  if (!xSignature || !xRequestId || !dataId || !MP_WEBHOOK_SECRET) return false;

  const partes = Object.fromEntries(
    xSignature.split(",").map((p) => p.trim().split("=")).map(([k, v]) => [k, v])
  );
  const { ts, v1 } = partes;
  if (!ts || !v1) return false;

  const manifiesto = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const firmaCalculada = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifiesto)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(firmaCalculada), Buffer.from(v1));
  } catch {
    return false;
  }
}

/* ---------------- App ---------------- */

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // 12mb: alcanza para el cartel del evento en base64
app.use(express.static(path.join(__dirname, "..", "public")));

// -------- Eventos: listar (público, para la página de inicio) --------
app.get("/api/eventos", async (req, res) => {
  const db = await leerDB();
  const lista = db.eventos.map((e) => ({
    ...e,
    vendidos: ocupadosDe(db, e.id),
  }));
  res.json(lista);
});

// -------- Un evento (público, para la página de compra de ese evento) --------
app.get("/api/eventos/:id", async (req, res) => {
  const db = await leerDB();
  const evento = db.eventos.find((e) => e.id === req.params.id);
  if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
  res.json({ ...evento, vendidos: ocupadosDe(db, evento.id) });
});

// -------- Crear evento (admin) --------
app.post("/api/eventos", requiereAdmin, async (req, res) => {
  const { nombre, fecha, lugar, precio, cupo, imagen } = req.body || {};
  await conCandado(async () => {
    const db = await leerDB();
    const nuevo = {
      id: uuid(),
      nombre: (nombre || "Evento sin nombre").trim(),
      fecha: fecha || "",
      lugar: (lugar || "").trim(),
      precio: Math.max(0, Number(precio) || 0),
      cupo: Math.max(1, Number(cupo) || 1),
      imagen: typeof imagen === "string" ? imagen : "",
      creado: new Date().toISOString(),
    };
    db.eventos.push(nuevo);
    await escribirDB(db);
    res.json(nuevo);
  });
});

// -------- Editar evento (admin) --------
app.put("/api/eventos/:id", requiereAdmin, async (req, res) => {
  const { nombre, fecha, lugar, precio, cupo, imagen } = req.body || {};
  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === req.params.id);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    evento.nombre = (nombre || evento.nombre || "Evento sin nombre").trim();
    evento.fecha = fecha ?? evento.fecha;
    evento.lugar = (lugar ?? evento.lugar ?? "").trim();
    evento.precio = Math.max(0, Number(precio) || 0);
    evento.cupo = Math.max(1, Number(cupo) || 1);
    if (typeof imagen === "string" && imagen) evento.imagen = imagen;
    await escribirDB(db);
    res.json(evento);
  });
});

// -------- Borrar evento (admin) --------
app.delete("/api/eventos/:id", requiereAdmin, async (req, res) => {
  await conCandado(async () => {
    const db = await leerDB();
    const tieneBoletos = db.boletos.some((b) => b.eventoId === req.params.id);
    if (tieneBoletos) {
      return res.status(409).json({ error: "Este evento ya tiene boletos emitidos; no se puede borrar." });
    }
    db.eventos = db.eventos.filter((e) => e.id !== req.params.id);
    await escribirDB(db);
    res.json({ ok: true });
  });
});

// -------- Limpieza única de eventos de prueba (temporal) --------
// Para usarla: abre en el navegador
//   https://TU-SITIO/api/admin/limpiar-prueba?key=TU_ADMIN_KEY
// (reemplazando TU_ADMIN_KEY por la misma clave que usas para entrar al panel de organizador).
// Es seguro: solo borra los 2 eventos de prueba de abajo (por su id exacto),
// nunca toca ningún otro evento, pasado o futuro.
app.get("/api/admin/limpiar-prueba", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).send("No autorizado");
  }
  const idsPrueba = [
    "976dbaf8-f119-4583-95fe-cf38abd5f701",
    "cf211dfc-3f37-44de-8cb0-7bbbbc07810a",
  ];
  await conCandado(async () => {
    const db = await leerDB();
    db.eventos = db.eventos.filter((e) => !idsPrueba.includes(e.id));
    db.boletos = db.boletos.filter((b) => !idsPrueba.includes(b.eventoId));
    await escribirDB(db);
    res.send("Listo. Eventos de prueba borrados. Eventos restantes: " + db.eventos.length);
  });
});

// -------- Comprar (público): crea la preferencia y devuelve el link de pago --------
app.post("/api/comprar", async (req, res) => {
  try {
    const eventoId = String(req.body?.eventoId || "");
    const nombre = String(req.body?.nombre || "").trim();
    const contacto = String(req.body?.contacto || "").trim();
    const cantidad = Math.max(1, Math.min(20, parseInt(req.body?.cantidad) || 1));
    if (!nombre) return res.status(400).json({ error: "Falta el nombre de quien compra" });

    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === eventoId);
    if (!evento) return res.status(404).json({ error: "Ese evento ya no está disponible" });

    if (ocupadosDe(db, eventoId) + cantidad > evento.cupo) {
      return res.status(409).json({ error: "Ya no hay cupo suficiente para esa cantidad" });
    }

    const ventaId = uuid();
    const precio = Number(evento.precio) || 0;

    const preference = new Preference(mpClient);
    const resultado = await preference.create({
      body: {
        items: [
          {
            id: ventaId,
            title: evento.nombre || "Boleto de evento",
            quantity: cantidad,
            unit_price: precio,
            currency_id: "MXN",
          },
        ],
        payer: contacto.includes("@") ? { email: contacto } : undefined,
        external_reference: ventaId,
        back_urls: {
          success: `${PUBLIC_URL}/gracias.html?venta=${ventaId}`,
          pending: `${PUBLIC_URL}/gracias.html?venta=${ventaId}`,
          failure: `${PUBLIC_URL}/comprar.html?evento=${eventoId}&pago=fallo`,
        },
        auto_return: "approved",
        notification_url: `${PUBLIC_URL}/api/webhook/mercadopago`,
        statement_descriptor: "MASSTICKET",
      },
    });

    await conCandado(async () => {
      const db2 = await leerDB();
      db2.ventas.push({
        id: ventaId,
        eventoId,
        nombre,
        contacto,
        cantidad,
        precioUnit: precio,
        preferenceId: resultado.id,
        estado: "pendiente",
        creado: new Date().toISOString(),
      });
      await escribirDB(db2);
    });

    res.json({ ventaId, initPoint: resultado.init_point });
  } catch (err) {
    console.error("Error creando preferencia:", err);
    res.status(500).json({ error: "No se pudo iniciar el pago. Intenta de nuevo." });
  }
});

// -------- Estado de una venta (para la página de gracias) --------
app.get("/api/venta/:id", async (req, res) => {
  const db = await leerDB();
  const venta = db.ventas.find((v) => v.id === req.params.id);
  if (!venta) return res.status(404).json({ error: "Venta no encontrada" });
  const boletos = db.boletos.filter((b) => b.ventaId === venta.id);
  const evento = db.eventos.find((e) => e.id === venta.eventoId) || null;
  res.json({ estado: venta.estado, evento, boletos });
});

// -------- Webhook de Mercado Pago: única fuente de verdad del pago --------
app.post("/api/webhook/mercadopago", async (req, res) => {
  // Responder rápido evita reintentos innecesarios de Mercado Pago;
  // el trabajo pesado va después de contestar.
  res.sendStatus(200);

  try {
    const tipo = req.query.type || req.body?.type;
    if (tipo !== "payment") return;

    if (MP_WEBHOOK_SECRET && !verificarFirma(req)) {
      console.warn("Webhook con firma inválida, se ignora.");
      return;
    }

    const paymentId = req.query["data.id"] || req.body?.data?.id;
    if (!paymentId) return;

    const paymentApi = new Payment(mpClient);
    const pago = await paymentApi.get({ id: paymentId });

    if (pago.status !== "approved") return;

    const ventaId = pago.external_reference;
    await conCandado(async () => {
      const db = await leerDB();
      const venta = db.ventas.find((v) => v.id === ventaId);
      if (!venta) return;
      if (venta.estado === "pagado") return; // idempotencia: ya se procesó este pago

      venta.estado = "pagado";
      venta.pagoId = pago.id;
      venta.pagadoEn = new Date().toISOString();

      for (let i = 0; i < venta.cantidad; i++) {
        db.boletos.push({
          folio: folioNuevo(db.boletos.length + 1),
          eventoId: venta.eventoId,
          ventaId: venta.id,
          nombre: venta.nombre,
          contacto: venta.contacto,
          metodo: "Mercado Pago",
          precio: venta.precioUnit,
          estado: "valido",
          creado: new Date().toISOString(),
          usadoEn: null,
        });
      }
      await escribirDB(db);
    });
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

// -------- Admin: venta manual (efectivo/cortesía en puerta) --------
app.post("/api/ventas-manuales", requiereAdmin, async (req, res) => {
  const eventoId = String(req.body?.eventoId || "");
  const nombre = String(req.body?.nombre || "").trim();
  const contacto = String(req.body?.contacto || "").trim();
  const cantidad = Math.max(1, Math.min(20, parseInt(req.body?.cantidad) || 1));
  const metodo = String(req.body?.metodo || "Efectivo");
  if (!nombre) return res.status(400).json({ error: "Falta el nombre" });

  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === eventoId);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    if (ocupadosDe(db, eventoId) + cantidad > evento.cupo) {
      return res.status(409).json({ error: "Ya no hay cupo" });
    }
    const precio = metodo === "Cortesía" ? 0 : Number(evento.precio) || 0;
    const nuevos = [];
    for (let i = 0; i < cantidad; i++) {
      const b = {
        folio: folioNuevo(db.boletos.length + 1),
        eventoId,
        ventaId: null,
        nombre,
        contacto,
        metodo,
        precio,
        estado: "valido",
        creado: new Date().toISOString(),
        usadoEn: null,
      };
      db.boletos.push(b);
      nuevos.push(b);
    }
    await escribirDB(db);
    res.json({ boletos: nuevos });
  });
});

// -------- Admin: listar boletos (opcionalmente filtrados por evento) --------
app.get("/api/boletos", requiereAdmin, async (req, res) => {
  const db = await leerDB();
  const { eventoId } = req.query;
  const lista = eventoId ? db.boletos.filter((b) => b.eventoId === eventoId) : db.boletos;
  res.json(lista);
});

// -------- Puerta: validar folio (admin) --------
app.post("/api/validar", requiereAdmin, async (req, res) => {
  const folio = String(req.body?.folio || "").trim().toUpperCase();
  await conCandado(async () => {
    const db = await leerDB();
    const b = db.boletos.find((x) => x.folio === folio);
    if (!b) return res.status(404).json({ resultado: "no_existe" });
    if (b.estado === "usado") {
      return res.json({ resultado: "repetido", nombre: b.nombre, usadoEn: b.usadoEn });
    }
    b.estado = "usado";
    b.usadoEn = new Date().toISOString();
    await escribirDB(db);
    res.json({ resultado: "ok", nombre: b.nombre, folio: b.folio });
  });
});

// -------- Panel (admin), opcionalmente filtrado por evento --------
app.get("/api/panel", requiereAdmin, async (req, res) => {
  const db = await leerDB();
  const { eventoId } = req.query;
  const boletos = eventoId ? db.boletos.filter((b) => b.eventoId === eventoId) : db.boletos;
  const ventas = eventoId ? db.ventas.filter((v) => v.eventoId === eventoId) : db.ventas;
  const cupo = eventoId
    ? (db.eventos.find((e) => e.id === eventoId)?.cupo || 0)
    : db.eventos.reduce((s, e) => s + e.cupo, 0);

  const usados = boletos.filter((b) => b.estado === "usado").length;
  const ingresos = boletos.reduce((s, b) => s + Number(b.precio || 0), 0);
  const porMetodo = {};
  boletos.forEach((b) => (porMetodo[b.metodo] = (porMetodo[b.metodo] || 0) + Number(b.precio || 0)));

  res.json({
    vendidos: boletos.length,
    usados,
    ingresos,
    cupo,
    porMetodo,
    pendientesDePago: ventas.filter((v) => v.estado === "pendiente").length,
  });
});

app.listen(PORT, () => {
  console.log(`massticket backend escuchando en el puerto ${PORT}`);
  console.log(`URL pública configurada: ${PUBLIC_URL}`);
});
