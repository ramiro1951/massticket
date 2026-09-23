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
import { Resend } from "resend";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";

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
  RESEND_API_KEY,
  EMAIL_FROM = "MassTicket <boletos@massticket.mx>",
  PORT = 3000,
} = process.env;

if (!MP_ACCESS_TOKEN) console.warn("⚠️  Falta MP_ACCESS_TOKEN en las variables de entorno.");
if (!MP_WEBHOOK_SECRET) console.warn("⚠️  Falta MP_WEBHOOK_SECRET: el webhook no podrá verificar firmas.");
if (!ADMIN_KEY) console.warn("⚠️  Falta ADMIN_KEY: el panel de organizador quedaría sin contraseña.");
if (!RESEND_API_KEY) console.warn("⚠️  Falta RESEND_API_KEY: los boletos no se enviarán por correo automáticamente.");

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

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

/* ---------------- Boletos por correo (PDF con QR) ---------------- */

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
function fechaLegibleServidor(iso) {
  if (!iso) return "Fecha por confirmar";
  const [y, m, d] = String(iso).split("-");
  const mi = parseInt(m, 10) - 1;
  if (!y || !d || !MESES[mi]) return iso;
  return `${parseInt(d, 10)} de ${MESES[mi]} de ${y}`;
}

// Arma un PDF con el cartel del evento y, por cada boleto, su folio y su
// código QR (el mismo folio que se valida en la puerta). Devuelve el PDF
// ya completo como Buffer, listo para adjuntar a un correo.
async function generarPDFBoletos({ evento, boletos }) {
  const doc = new PDFDocument({ size: "A5", margin: 28 });
  const partes = [];
  doc.on("data", (parte) => partes.push(parte));
  const listo = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(partes)));
    doc.on("error", reject);
  });

  for (let i = 0; i < boletos.length; i++) {
    const b = boletos[i];
    if (i > 0) doc.addPage();

    if (evento?.imagen && evento.imagen.startsWith("data:image")) {
      try {
        const base64 = evento.imagen.split(",")[1];
        const bufImagen = Buffer.from(base64, "base64");
        doc.image(bufImagen, doc.page.margins.left, doc.y, {
          fit: [doc.page.width - doc.page.margins.left - doc.page.margins.right, 160],
          align: "center",
        });
        doc.moveDown(0.5);
        doc.y = Math.max(doc.y, 190);
      } catch {
        // Si la imagen viene corrupta, seguimos sin ella; el boleto sigue siendo válido.
      }
    }

    doc.fontSize(17).fillColor("#111").text(evento?.nombre || "Evento", { align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor("#555").text(
      `${fechaLegibleServidor(evento?.fecha)}  ·  ${evento?.lugar || "Lugar por confirmar"}`,
      { align: "center" }
    );
    doc.moveDown(1);

    doc.fontSize(13).fillColor("#111").text(`Boleto de: ${b.nombre}`, { align: "center" });
    doc.fontSize(11).fillColor("#555").text(`Folio: ${b.folio}`, { align: "center" });
    doc.moveDown(0.8);

    const qrBuffer = await QRCode.toBuffer(b.folio, { width: 220, margin: 1 });
    const qrAncho = 160;
    doc.image(qrBuffer, (doc.page.width - qrAncho) / 2, doc.y, { width: qrAncho });
    doc.y += qrAncho + 12;

    doc.fontSize(9).fillColor("#888").text(
      "Presenta este código (impreso o desde tu teléfono) en la entrada del evento.",
      { align: "center" }
    );
  }

  doc.end();
  return listo;
}

// Envía por correo los boletos recién emitidos (compra en línea o venta
// manual). No hace nada si Resend no está configurado, o si el "contacto"
// que se guardó no parece un correo (por ejemplo, si es un teléfono).
async function enviarBoletosPorEmail({ evento, nombre, contacto, boletos }) {
  if (!resend) return;
  if (!contacto || !contacto.includes("@")) return;
  if (!boletos || !boletos.length) return;
  try {
    const pdf = await generarPDFBoletos({ evento, boletos });
    const cantidad = boletos.length;
    await resend.emails.send({
      from: EMAIL_FROM,
      to: contacto,
      subject: `Tus boleto${cantidad > 1 ? "s" : ""} para ${evento?.nombre || "tu evento"}`,
      html: `
        <p>Hola ${nombre || ""},</p>
        <p>Aquí tienes tu${cantidad > 1 ? "s" : ""} boleto${cantidad > 1 ? "s" : ""} para
        <strong>${evento?.nombre || "el evento"}</strong>
        (${fechaLegibleServidor(evento?.fecha)}, ${evento?.lugar || "lugar por confirmar"}).</p>
        <p>Va adjunto en PDF con tu código QR: solo muéstralo (impreso o desde tu teléfono) en la entrada.</p>
        <p style="color:#888;font-size:12px;margin-top:24px;">
          Este es un mensaje automático, por favor no respondas a este correo.
        </p>
      `,
      attachments: [
        {
          filename: `boletos-${(evento?.nombre || "evento").replace(/[^a-z0-9]+/gi, "-")}.pdf`,
          content: pdf.toString("base64"),
        },
      ],
    });
  } catch (err) {
    console.error("Error enviando boletos por correo:", err);
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
  // Por defecto (la página pública) solo se muestran eventos de hoy en
  // adelante; al día siguiente del evento deja de aparecer solo, sin que
  // nadie tenga que borrarlo. El panel de organizador pide ?todos=1 para
  // seguir viendo TODOS los eventos (incluidos los ya pasados), porque ahí
  // se siguen administrando boletos y borrando eventos a mano.
  const hoy = new Date().toISOString().slice(0, 10); // "AAAA-MM-DD"
  const mostrarTodos = req.query.todos === "1";
  const lista = db.eventos
    .filter((e) => mostrarTodos || !e.fecha || e.fecha >= hoy)
    .map((e) => ({
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

    const hoy = new Date().toISOString().slice(0, 10);
    if (evento.fecha && evento.fecha < hoy) {
      return res.status(409).json({ error: "Ese evento ya pasó, ya no se pueden comprar boletos" });
    }

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
    let eventoParaCorreo, boletosParaCorreo, nombreParaCorreo, contactoParaCorreo;
    await conCandado(async () => {
      const db = await leerDB();
      const venta = db.ventas.find((v) => v.id === ventaId);
      if (!venta) return;
      if (venta.estado === "pagado") return; // idempotencia: ya se procesó este pago

      venta.estado = "pagado";
      venta.pagoId = pago.id;
      venta.pagadoEn = new Date().toISOString();

      const nuevos = [];
      for (let i = 0; i < venta.cantidad; i++) {
        const b = {
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
        };
        db.boletos.push(b);
        nuevos.push(b);
      }
      await escribirDB(db);

      eventoParaCorreo = db.eventos.find((e) => e.id === venta.eventoId) || null;
      boletosParaCorreo = nuevos;
      nombreParaCorreo = venta.nombre;
      contactoParaCorreo = venta.contacto;
    });

    if (eventoParaCorreo && boletosParaCorreo?.length) {
      await enviarBoletosPorEmail({
        evento: eventoParaCorreo,
        nombre: nombreParaCorreo,
        contacto: contactoParaCorreo,
        boletos: boletosParaCorreo,
      });
    }
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

  let eventoParaCorreo, boletosParaCorreo;
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
    eventoParaCorreo = evento;
    boletosParaCorreo = nuevos;
    res.json({ boletos: nuevos });
  });

  // Se envía después de responder, para no hacer esperar al organizador
  // mientras se genera el PDF y se manda el correo.
  if (eventoParaCorreo && boletosParaCorreo) {
    enviarBoletosPorEmail({ evento: eventoParaCorreo, nombre, contacto, boletos: boletosParaCorreo });
  }
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
