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

// Cuánto tiempo se le reserva el lugar a alguien que fue a pagar a Mercado
// Pago pero todavía no confirma: pasado esto, si nunca volvió, se asume que
// abandonó la compra y su lugar deja de estar "apartado" (aunque la venta
// siga viéndose como "pendiente" en el panel, para que quede el registro).
// Si de verdad completa el pago después de esto, el webhook lo confirma
// igual y se le emite su boleto -no se pierde el pago, solo deja de tapar
// el cupo de otros mientras tanto.
const VENTANA_RESERVA_MS = 45 * 60 * 1000; // 45 minutos

// Cuántos lugares ya están tomados de un evento: boletos ya emitidos más
// ventas pendientes de pago RECIENTES (para no vender de más mientras
// alguien todavía está pagando en Mercado Pago, sin dejar bloqueado el
// cupo para siempre por gente que nunca terminó de pagar).
function ocupadosDe(db, eventoId) {
  const ahora = Date.now();
  const enBoletos = db.boletos.filter((b) => b.eventoId === eventoId).length;
  const enPendientes = db.ventas
    .filter((v) => {
      if (v.eventoId !== eventoId || v.estado !== "pendiente") return false;
      const creado = v.creado ? new Date(v.creado).getTime() : 0;
      return ahora - creado < VENTANA_RESERVA_MS;
    })
    .reduce((s, v) => s + v.cantidad, 0);
  return enBoletos + enPendientes;
}

// "Hoy" según la hora de México (no la de UTC, que ya es "mañana" desde las
// 6 pm). Un evento sigue vigente toda la noche: deja de ser "de hoy" hasta las
// 6:00 am del día siguiente, para que la puerta y la venta sigan abiertas
// mientras dura el evento aunque pase de la medianoche.
function hoyMX(ahora = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ahora - 6 * 3600 * 1000));
}

/* ---------------- Zonas (precios distintos dentro de un mismo evento) ---------------- */
// Un evento puede tener "zonas" (Luneta, Preferente, Palco...). Cada zona:
//   nombre, precio  = lo que cuesta UNA compra de esa zona,
//   personas        = cuántos boletos (personas) incluye cada compra
//                     (1 para zonas normales; 2 o 4 para palcos),
//   cupo            = lugares (personas) disponibles en total en esa zona.
// Cada boleto individual vale precio / personas.
function zonasDe(evento) {
  return Array.isArray(evento?.zonas) ? evento.zonas : [];
}
function limpiarZonas(entrada) {
  if (!Array.isArray(entrada)) return [];
  const vistos = new Set();
  const zonas = [];
  for (const z of entrada) {
    const nombre = String(z?.nombre || "").trim().slice(0, 80);
    if (!nombre) continue;
    let id = String(z?.id || "").trim().slice(0, 60);
    if (!id || vistos.has(id)) id = uuid();
    vistos.add(id);
    zonas.push({
      id,
      nombre,
      precio: Math.max(0, Number(z?.precio) || 0),
      personas: Math.max(1, Math.min(20, parseInt(z?.personas) || 1)),
      cupo: Math.max(0, parseInt(z?.cupo) || 0),
    });
  }
  return zonas;
}
function precioPorBoleto(z) {
  return Math.round(((Number(z.precio) || 0) / (z.personas || 1)) * 100) / 100;
}
// Lugares ya tomados en una zona: boletos emitidos + compras pendientes recientes.
function ocupadosZona(db, eventoId, zonaId) {
  const ahora = Date.now();
  const enBoletos = db.boletos.filter((b) => b.eventoId === eventoId && b.zonaId === zonaId).length;
  const enPendientes = db.ventas
    .filter((v) => {
      if (v.eventoId !== eventoId || v.estado !== "pendiente" || !Array.isArray(v.lineas)) return false;
      const creado = v.creado ? new Date(v.creado).getTime() : 0;
      return ahora - creado < VENTANA_RESERVA_MS;
    })
    .reduce(
      (s, v) =>
        s + v.lineas.filter((l) => l.zonaId === zonaId).reduce((t, l) => t + l.cantidad * l.personas, 0),
      0
    );
  return enBoletos + enPendientes;
}
// Evento listo para mandarse al público: con lugares vendidos y, si tiene zonas,
// cuántos lugares quedan en cada una.
function conOcupacion(db, e) {
  const zonas = zonasDe(e);
  const salida = { ...e, vendidos: ocupadosDe(db, e.id) };
  if (zonas.length) {
    salida.zonas = zonas.map((z) => {
      const vendidos = ocupadosZona(db, e.id, z.id);
      return { ...z, vendidos, disponibles: Math.max(0, z.cupo - vendidos) };
    });
  }
  return salida;
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
    if (b.zona) doc.fontSize(12).fillColor("#111").text(`Zona: ${b.zona}`, { align: "center" });
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
  const hoy = hoyMX(); // "AAAA-MM-DD"
  const mostrarTodos = req.query.todos === "1";
  const lista = db.eventos
    .filter((e) => mostrarTodos || !e.fecha || e.fecha >= hoy)
    .map((e) => conOcupacion(db, e))
    // Orden cronológico: el evento más próximo primero. Los que no tienen
    // fecha todavía ("por confirmar") se van al final, no al principio.
    .sort((a, b) => {
      if (!a.fecha && !b.fecha) return 0;
      if (!a.fecha) return 1;
      if (!b.fecha) return -1;
      return a.fecha.localeCompare(b.fecha);
    });
  res.json(lista);
});

// -------- Un evento (público, para la página de compra de ese evento) --------
app.get("/api/eventos/:id", async (req, res) => {
  const db = await leerDB();
  const evento = db.eventos.find((e) => e.id === req.params.id);
  if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
  res.json(conOcupacion(db, evento));
});

// -------- Crear evento (admin) --------
app.post("/api/eventos", requiereAdmin, async (req, res) => {
  const { nombre, fecha, lugar, precio, cupo, imagen, zonas } = req.body || {};
  await conCandado(async () => {
    const db = await leerDB();
    const zs = limpiarZonas(zonas);
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
    if (zs.length) {
      // Con zonas, el cupo total y el precio "desde" salen de las zonas.
      nuevo.zonas = zs;
      nuevo.cupo = Math.max(1, zs.reduce((t, z) => t + z.cupo, 0));
      nuevo.precio = Math.min(...zs.map(precioPorBoleto));
    }
    db.eventos.push(nuevo);
    await escribirDB(db);
    res.json(nuevo);
  });
});

// -------- Editar evento (admin) --------
app.put("/api/eventos/:id", requiereAdmin, async (req, res) => {
  const { nombre, fecha, lugar, precio, cupo, imagen, zonas } = req.body || {};
  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === req.params.id);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });

    // Zonas: se revisa antes de cambiar nada para no dejar el evento a medias.
    let zs = null;
    if (Array.isArray(zonas)) {
      zs = limpiarZonas(zonas);
      const boletosEv = db.boletos.filter((b) => b.eventoId === evento.id);
      if (zs.length && boletosEv.some((b) => !b.zonaId)) {
        return res.status(409).json({ error: "Este evento ya vendió boletos sin zona; no se le pueden agregar zonas." });
      }
      const usadas = new Set(boletosEv.filter((b) => b.zonaId).map((b) => b.zonaId));
      for (const id of usadas) {
        if (!zs.some((z) => z.id === id)) {
          return res.status(409).json({ error: "No puedes quitar una zona que ya tiene boletos vendidos." });
        }
      }
      for (const z of zs) {
        const ocup = ocupadosZona(db, evento.id, z.id);
        if (z.cupo < ocup) {
          return res.status(409).json({ error: `La zona "${z.nombre}" ya tiene ${ocup} lugares vendidos o apartados; su cupo no puede ser menor.` });
        }
      }
    }

    evento.nombre = (nombre || evento.nombre || "Evento sin nombre").trim();
    evento.fecha = fecha ?? evento.fecha;
    evento.lugar = (lugar ?? evento.lugar ?? "").trim();
    if (zs && zs.length) {
      evento.zonas = zs;
      evento.cupo = Math.max(1, zs.reduce((t, z) => t + z.cupo, 0));
      evento.precio = Math.min(...zs.map(precioPorBoleto));
    } else if (zonasDe(evento).length && !zs) {
      // Evento con zonas y la petición no trae zonas: no se tocan precio ni cupo.
    } else {
      if (zs) delete evento.zonas; // se mandó la lista vacía: vuelve a precio único
      evento.precio = Math.max(0, Number(precio) || 0);
      evento.cupo = Math.max(1, Number(cupo) || 1);
    }
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
  const ventaId = uuid();
  let ventaCreada = false;
  try {
    const eventoId = String(req.body?.eventoId || "");
    const nombre = String(req.body?.nombre || "").trim();
    const contacto = String(req.body?.contacto || "").trim();
    const telefono = String(req.body?.telefono || "").trim();
    const cantidadSimple = Math.max(1, Math.min(20, parseInt(req.body?.cantidad) || 1));
    const pedidoZonas = Array.isArray(req.body?.zonas) ? req.body.zonas : [];
    if (!nombre) return res.status(400).json({ error: "Falta el nombre de quien compra" });

    // Se revisa el cupo y se aparta el lugar en el MISMO paso (con candado),
    // para que dos compras al mismo tiempo no vendan el mismo lugar dos veces.
    let falla = null;
    let evento = null;
    const items = [];
    await conCandado(async () => {
      const db = await leerDB();
      evento = db.eventos.find((e) => e.id === eventoId);
      if (!evento) { falla = { status: 404, error: "Ese evento ya no está disponible" }; return; }

      const hoy = hoyMX();
      if (evento.fecha && evento.fecha < hoy) {
        falla = { status: 409, error: "Ese evento ya pasó, ya no se pueden comprar boletos" };
        return;
      }

      const zonas = zonasDe(evento);
      let lineas = null;
      let totalBoletos = 0;
      if (zonas.length) {
        lineas = [];
        for (const p of pedidoZonas) {
          const z = zonas.find((x) => x.id === String(p?.zonaId || ""));
          const cant = Math.max(0, Math.min(10, parseInt(p?.cantidad) || 0));
          if (!z || cant < 1 || lineas.some((l) => l.zonaId === z.id)) continue;
          lineas.push({ zonaId: z.id, zonaNombre: z.nombre, personas: z.personas, cantidad: cant, precioUnit: z.precio });
        }
        if (!lineas.length) { falla = { status: 400, error: "Elige al menos un boleto." }; return; }
        for (const l of lineas) {
          const z = zonas.find((x) => x.id === l.zonaId);
          const n = l.cantidad * l.personas;
          if (ocupadosZona(db, eventoId, l.zonaId) + n > z.cupo) {
            falla = { status: 409, error: `Ya no hay lugares suficientes en ${z.nombre}.` };
            return;
          }
          totalBoletos += n;
          items.push({
            id: l.zonaId,
            title: `${evento.nombre} — ${l.zonaNombre}`.slice(0, 250),
            quantity: l.cantidad,
            unit_price: l.precioUnit,
            currency_id: "MXN",
          });
        }
      } else {
        if (ocupadosDe(db, eventoId) + cantidadSimple > evento.cupo) {
          falla = { status: 409, error: "Ya no hay cupo suficiente para esa cantidad" };
          return;
        }
        totalBoletos = cantidadSimple;
        items.push({
          id: ventaId,
          title: evento.nombre || "Boleto de evento",
          quantity: cantidadSimple,
          unit_price: Number(evento.precio) || 0,
          currency_id: "MXN",
        });
      }

      db.ventas.push({
        id: ventaId,
        eventoId,
        nombre,
        contacto,
        telefono,
        cantidad: totalBoletos,
        ...(lineas ? { lineas } : { precioUnit: Number(evento.precio) || 0 }),
        preferenceId: null,
        estado: "pendiente",
        creado: new Date().toISOString(),
      });
      await escribirDB(db);
      ventaCreada = true;
    });
    if (falla) return res.status(falla.status).json({ error: falla.error });

    const preference = new Preference(mpClient);
    const resultado = await preference.create({
      body: {
        items,
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
      const v = db2.ventas.find((x) => x.id === ventaId);
      if (v) { v.preferenceId = resultado.id; await escribirDB(db2); }
    });

    res.json({ ventaId, initPoint: resultado.init_point });
  } catch (err) {
    console.error("Error creando preferencia:", err);
    // Si ya se había apartado el lugar pero Mercado Pago falló, se libera.
    if (ventaCreada) {
      try {
        await conCandado(async () => {
          const db3 = await leerDB();
          db3.ventas = db3.ventas.filter((v) => v.id !== ventaId);
          await escribirDB(db3);
        });
      } catch (e2) {
        console.error("No se pudo liberar la venta fallida:", e2);
      }
    }
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

// Aplica un pago YA APROBADO de Mercado Pago a una venta pendiente: la marca
// como pagada y emite sus boletos. La usan tanto el webhook (apenas llega el
// aviso) como la reconciliación manual del panel (por si el webhook se
// perdió, por ejemplo porque el sitio estaba caído justo en ese momento).
// Devuelve los datos para el correo, o null si no había nada que hacer
// (venta no encontrada, o ya se había procesado antes).
async function aplicarPagoAprobado(ventaId, pago) {
  let resultado = null;
  await conCandado(async () => {
    const db = await leerDB();
    const venta = db.ventas.find((v) => v.id === ventaId);
    if (!venta) return;
    if (venta.estado === "pagado") return; // idempotencia: ya se procesó este pago

    venta.estado = "pagado";
    venta.pagoId = pago.id;
    venta.pagadoEn = new Date().toISOString();

    const nuevos = [];
    // Compra con zonas: cada línea trae su zona y cuántos boletos incluye cada
    // compra (palco de 2 o de 4 = 2 o 4 boletos, cada uno con su QR).
    const lineas =
      Array.isArray(venta.lineas) && venta.lineas.length
        ? venta.lineas
        : [{ zonaId: null, zonaNombre: "", personas: 1, cantidad: venta.cantidad, precioUnit: venta.precioUnit }];
    for (const l of lineas) {
      const n = l.cantidad * l.personas;
      const precioBoleto = Math.round(((Number(l.precioUnit) || 0) / l.personas) * 100) / 100;
      for (let i = 0; i < n; i++) {
        const b = {
          folio: folioNuevo(db.boletos.length + 1),
          eventoId: venta.eventoId,
          ventaId: venta.id,
          nombre: venta.nombre,
          contacto: venta.contacto,
          telefono: venta.telefono || "",
          metodo: "Mercado Pago",
          precio: precioBoleto,
          ...(l.zonaId ? { zonaId: l.zonaId, zona: l.zonaNombre } : {}),
          estado: "valido",
          creado: new Date().toISOString(),
          usadoEn: null,
        };
        db.boletos.push(b);
        nuevos.push(b);
      }
    }
    await escribirDB(db);

    resultado = {
      evento: db.eventos.find((e) => e.id === venta.eventoId) || null,
      boletos: nuevos,
      nombre: venta.nombre,
      contacto: venta.contacto,
    };
  });
  return resultado;
}

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

    const resultado = await aplicarPagoAprobado(pago.external_reference, pago);
    if (resultado?.evento && resultado.boletos?.length) {
      await enviarBoletosPorEmail({
        evento: resultado.evento,
        nombre: resultado.nombre,
        contacto: resultado.contacto,
        boletos: resultado.boletos,
      });
    }
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

// -------- Admin: revisar con Mercado Pago las ventas "pendientes" --------
// Por si el aviso automático (webhook) nunca llegó -por ejemplo si el sitio
// estaba caído justo en ese momento-, esto le pregunta a Mercado Pago,
// venta por venta, si en realidad ya está aprobada. Las que sí lo están se
// confirman aquí también: se emiten sus boletos y se manda el correo con el
// PDF, exactamente igual que si el webhook hubiera funcionado a tiempo.
app.post("/api/admin/reconciliar-pagos", requiereAdmin, async (req, res) => {
  try {
    const db = await leerDB();
    const pendientes = db.ventas.filter((v) => v.estado === "pendiente");
    const paymentApi = new Payment(mpClient);
    const confirmadas = [];
    const sinCambio = [];

    for (const venta of pendientes) {
      try {
        const busqueda = await paymentApi.search({
          options: { external_reference: venta.id },
        });
        const pago = (busqueda.results || []).find((p) => p.status === "approved");
        if (!pago) {
          sinCambio.push({ nombre: venta.nombre });
          continue;
        }
        const resultado = await aplicarPagoAprobado(venta.id, pago);
        if (resultado?.evento && resultado.boletos?.length) {
          await enviarBoletosPorEmail({
            evento: resultado.evento,
            nombre: resultado.nombre,
            contacto: resultado.contacto,
            boletos: resultado.boletos,
          });
          confirmadas.push({
            nombre: resultado.nombre,
            evento: resultado.evento?.nombre || "",
            boletos: resultado.boletos.length,
          });
        }
      } catch (err) {
        console.error("Error reconciliando venta", venta.id, err);
        sinCambio.push({ nombre: venta.nombre, error: true });
      }
    }

    res.json({ revisadas: pendientes.length, confirmadas, sinCambio });
  } catch (err) {
    console.error("Error en reconciliación de pagos:", err);
    res.status(500).json({ error: "No se pudo revisar los pagos pendientes." });
  }
});

// -------- Admin: venta manual (efectivo/cortesía/promoción en puerta) --------
app.post("/api/ventas-manuales", requiereAdmin, async (req, res) => {
  const eventoId = String(req.body?.eventoId || "");
  const nombre = String(req.body?.nombre || "").trim();
  const contacto = String(req.body?.contacto || "").trim();
  const telefono = String(req.body?.telefono || "").trim();
  // Tope de 100: suficiente para una promoción o venta por mayoreo, sin
  // dejar que un error de dedo registre una cantidad absurda por accidente.
  const cantidad = Math.max(1, Math.min(100, parseInt(req.body?.cantidad) || 1));
  const metodo = String(req.body?.metodo || "Efectivo");
  const zonaId = String(req.body?.zonaId || "");
  if (!nombre) return res.status(400).json({ error: "Falta el nombre" });

  // Precio especial opcional (por ejemplo, una promoción de mayoreo a un
  // precio menor al del evento). Si se deja vacío, se usa el precio normal
  // del evento como siempre; "Cortesía" siempre es gratis sin importar lo
  // que se haya escrito aquí.
  const precioManualTexto = String(req.body?.precioManual ?? "").trim();
  const precioManual = precioManualTexto === "" ? null : Math.max(0, Number(precioManualTexto) || 0);

  let eventoParaCorreo, boletosParaCorreo, ventaIdManual = null;
  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === eventoId);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    if (ocupadosDe(db, eventoId) + cantidad > evento.cupo) {
      return res.status(409).json({ error: "Ya no hay cupo" });
    }
    // Si el evento tiene zonas, hay que elegir una; "cantidad" son boletos
    // (personas) y el precio normal es el de un boleto individual de la zona.
    const zonasEv = zonasDe(evento);
    let zona = null;
    if (zonasEv.length) {
      zona = zonasEv.find((z) => z.id === zonaId);
      if (!zona) return res.status(400).json({ error: "Elige la zona." });
      if (ocupadosZona(db, eventoId, zona.id) + cantidad > zona.cupo) {
        return res.status(409).json({ error: `Ya no hay lugares suficientes en ${zona.nombre}.` });
      }
    }
    const precioBase = zona ? precioPorBoleto(zona) : Number(evento.precio) || 0;
    const precio = metodo === "Cortesía" ? 0 : (precioManual !== null ? precioManual : precioBase);
    // Cada venta manual también queda registrada como "venta" (ya pagada) para
    // que tenga su propia página de boletos con QR, que se puede mandar por
    // WhatsApp con el enlace /gracias.html?venta=...
    ventaIdManual = uuid();
    db.ventas.push({
      id: ventaIdManual,
      eventoId,
      nombre,
      contacto,
      telefono,
      cantidad,
      precioUnit: precio,
      ...(zona ? { zonaNombre: zona.nombre } : {}),
      estado: "pagado",
      manual: true,
      metodo,
      creado: new Date().toISOString(),
    });
    const nuevos = [];
    for (let i = 0; i < cantidad; i++) {
      const b = {
        folio: folioNuevo(db.boletos.length + 1),
        eventoId,
        ventaId: ventaIdManual,
        nombre,
        contacto,
        telefono,
        metodo,
        precio,
        ...(zona ? { zonaId: zona.id, zona: zona.nombre } : {}),
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
    res.json({ boletos: nuevos, ventaId: ventaIdManual, evento: { nombre: evento.nombre, fecha: evento.fecha }, urlBoletos: `${PUBLIC_URL}/gracias.html?venta=${ventaIdManual}` });
  });

  // Se envía después de responder, para no hacer esperar al organizador
  // mientras se genera el PDF y se manda el correo.
  if (eventoParaCorreo && boletosParaCorreo) {
    enviarBoletosPorEmail({ evento: eventoParaCorreo, nombre, contacto, boletos: boletosParaCorreo });
  }
});

// -------- Admin: clientes (junta todos los boletos por comprador) --------
// Agrupa por correo si hay uno; si no, por teléfono; si tampoco hay eso,
// por nombre (mejor esfuerzo -dos personas con el mismo nombre y sin
// correo ni teléfono se verían como una sola, pero es un caso raro).
app.get("/api/clientes", requiereAdmin, async (req, res) => {
  const db = await leerDB();
  const esEmail = (s) => String(s || "").includes("@");
  const grupos = new Map();

  for (const b of db.boletos) {
    const contacto = String(b.contacto || "").trim();
    const email = esEmail(contacto) ? contacto.toLowerCase() : "";
    const telefono = String(b.telefono || "").trim() || (contacto && !esEmail(contacto) ? contacto : "");
    const clave = email || telefono.replace(/\D/g, "") || "nombre:" + String(b.nombre || "").trim().toLowerCase();

    if (!grupos.has(clave)) {
      grupos.set(clave, {
        nombre: b.nombre || "",
        email: "",
        telefono: "",
        boletos: 0,
        gastado: 0,
        eventos: new Set(),
        primeraCompra: b.creado || "",
        ultimaCompra: b.creado || "",
      });
    }
    const g = grupos.get(clave);
    g.boletos += 1;
    g.gastado += Number(b.precio || 0);
    if (b.eventoId) g.eventos.add(b.eventoId);
    if (!g.email && email) g.email = email;
    if (!g.telefono && telefono) g.telefono = telefono;
    if (b.nombre && b.nombre.length > g.nombre.length) g.nombre = b.nombre;
    if (b.creado && (!g.ultimaCompra || b.creado > g.ultimaCompra)) g.ultimaCompra = b.creado;
    if (b.creado && (!g.primeraCompra || b.creado < g.primeraCompra)) g.primeraCompra = b.creado;
  }

  const lista = [...grupos.values()]
    .map((g) => ({
      nombre: g.nombre,
      email: g.email,
      telefono: g.telefono,
      boletos: g.boletos,
      eventos: g.eventos.size,
      gastado: g.gastado,
      primeraCompra: g.primeraCompra,
      ultimaCompra: g.ultimaCompra,
    }))
    // Solo se listan clientes con algún dato de contacto (correo o celular).
    // Los boletos de quien no dejó ninguno siguen en la pestaña Boletos.
    .filter((c) => c.email || c.telefono)
    .sort((a, b) => (b.ultimaCompra || "").localeCompare(a.ultimaCompra || ""));

  res.json(lista);
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
      return res.json({ resultado: "repetido", nombre: b.nombre, usadoEn: b.usadoEn, zona: b.zona || "" });
    }
    b.estado = "usado";
    b.usadoEn = new Date().toISOString();
    await escribirDB(db);
    res.json({ resultado: "ok", nombre: b.nombre, folio: b.folio, zona: b.zona || "" });
  });
});

// -------- Panel (admin), opcionalmente filtrado por evento --------
app.get("/api/panel", requiereAdmin, async (req, res) => {
  const db = await leerDB();
  const { eventoId, eventoIds } = req.query;
  // Un evento, un grupo de eventos (actuales o pasados, separados por comas;
  // vacío = grupo sin eventos) o, sin filtro, todos.
  let ids = null;
  if (eventoId) ids = [eventoId];
  else if (eventoIds !== undefined) ids = String(eventoIds).split(",").filter(Boolean);
  const boletos = ids ? db.boletos.filter((b) => ids.includes(b.eventoId)) : db.boletos;
  const ventas = ids ? db.ventas.filter((v) => ids.includes(v.eventoId)) : db.ventas;
  const cupo = (ids ? db.eventos.filter((e) => ids.includes(e.id)) : db.eventos)
    .reduce((s, e) => s + (Number(e.cupo) || 0), 0);

  const usados = boletos.filter((b) => b.estado === "usado").length;
  const ingresos = boletos.reduce((s, b) => s + Number(b.precio || 0), 0);
  const porMetodo = {};
  boletos.forEach((b) => (porMetodo[b.metodo] = (porMetodo[b.metodo] || 0) + Number(b.precio || 0)));

  // Desglose por zona cuando se mira un solo evento que tiene zonas.
  let porZona;
  if (eventoId) {
    const ev = db.eventos.find((e) => e.id === eventoId);
    const zs = zonasDe(ev);
    if (zs.length) {
      porZona = zs.map((z) => {
        const bz = boletos.filter((b) => b.zonaId === z.id);
        return {
          nombre: z.nombre,
          vendidos: bz.length,
          cupo: z.cupo,
          ingresos: bz.reduce((t, b) => t + Number(b.precio || 0), 0),
        };
      });
    }
  }

  res.json({
    vendidos: boletos.length,
    usados,
    ingresos,
    cupo,
    porMetodo,
    ...(porZona ? { porZona } : {}),
    pendientesDePago: ventas.filter((v) => v.estado === "pendiente").length,
  });
});

app.listen(PORT, () => {
  console.log(`massticket backend escuchando en el puerto ${PORT}`);
  console.log(`URL pública configurada: ${PUBLIC_URL}`);
});
