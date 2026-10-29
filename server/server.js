// massticket.mx — backend
// Varios eventos, cada uno con su cupo y sus boletos. Crea preferencias de
// pago en Mercado Pago (Checkout Pro), confirma los pagos por webhook
// (nunca por el regreso del navegador) y emite/valida boletos.

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import { readFileSync } from "fs";
import { gzipSync } from "zlib";
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
  BACKUP_EMAIL,
  PORT = 3000,
} = process.env;

if (!MP_ACCESS_TOKEN) console.warn("⚠️  Falta MP_ACCESS_TOKEN en las variables de entorno.");
if (!MP_WEBHOOK_SECRET) console.warn("⚠️  Falta MP_WEBHOOK_SECRET: el webhook rechazará todos los avisos de pago.");
if (!ADMIN_KEY) console.warn("⚠️  Falta ADMIN_KEY: el panel de organizador quedaría sin contraseña.");
if (!RESEND_API_KEY) console.warn("⚠️  Falta RESEND_API_KEY: los boletos no se enviarán por correo automáticamente.");
if (!BACKUP_EMAIL) console.warn("⚠️  Falta BACKUP_EMAIL: el respaldo diario solo se guardará en el servidor, no por correo.");

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/* ---------------- Almacenamiento (archivo JSON con candado simple) ---------------- */

let escribiendo = Promise.resolve();
function conCandado(fn) {
  const resultado = escribiendo.then(fn, fn);
  escribiendo = resultado.catch(() => {});
  return resultado;
}

// Si db.json existe pero no se puede leer (por ejemplo, quedó cortado), el
// sitio se pone "en mantenimiento" en lugar de seguir como si la base
// estuviera vacía: antes eso hacía que la siguiente venta guardara una base
// vacía encima y se perdiera todo. Se arregla restaurando un respaldo y
// reiniciando el servidor.
let dbDañada = false;
async function marcarDBDañada(err) {
  if (dbDañada) return;
  dbDañada = true;
  console.error("🚨 db.json no se pudo leer; el sitio queda en mantenimiento para no perder datos:", err);
  try {
    const copia = path.join(DATA_DIR, `db.corrupto-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await fs.copyFile(DB_PATH, copia);
    console.error("Se guardó una copia del archivo dañado en", copia);
  } catch (e) {
    console.error("No se pudo copiar el archivo dañado:", e);
  }
  if (resend && BACKUP_EMAIL) {
    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: BACKUP_EMAIL,
        subject: "🚨 massticket: db.json dañado, sitio en mantenimiento",
        html: `<p>El servidor no pudo leer <code>db.json</code> y puso el sitio en mantenimiento para no borrar datos.</p>
          <p>Restaura el último respaldo (ver README, sección "Respaldos") y reinicia el servicio en Railway.</p>
          <p>Error: ${String(err?.message || err).replace(/[<>&]/g, "")}</p>`,
      });
    } catch (e) {
      console.error("No se pudo mandar el aviso de db.json dañado:", e);
    }
  }
}

async function leerDB() {
  let db;
  try {
    const texto = await fs.readFile(DB_PATH, "utf8");
    db = JSON.parse(texto);
    if (!db || typeof db !== "object") throw new Error("db.json no contiene un objeto");
  } catch (err) {
    // Solo si el archivo de verdad no existe (sitio nuevo) se empieza en blanco.
    if (err.code === "ENOENT") return { eventos: [], ventas: [], boletos: [] };
    await marcarDBDañada(err);
    throw new Error("db.json dañado");
  }
  if (!Array.isArray(db.eventos)) db.eventos = [];
  if (!Array.isArray(db.ventas)) db.ventas = [];
  if (!Array.isArray(db.boletos)) db.boletos = [];
  // Eventos con mapa de mesas: el cupo sale del mapa, así que si el mapa se
  // corrige (por ejemplo, una mesa de otro tamaño) el evento se actualiza
  // solo, conservando los precios que ya tenía.
  for (const e of db.eventos) {
    if (!e.mapaId) continue;
    const mapa = cargarMapa(e.mapaId);
    if (mapa) aplicarMapaAEvento(e, mapa, zonasDeMapa(mapa, [], zonasDe(e)));
  }
  return db;
}
// Se escribe primero a un archivo temporal y luego se renombra: el cambio de
// nombre es instantáneo, así que db.json nunca queda escrito a medias aunque
// el servidor se caiga o Railway lo reinicie justo en ese momento.
async function escribirDB(datos) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  const temporal = DB_PATH + ".tmp";
  const archivo = await fs.open(temporal, "w");
  try {
    await archivo.writeFile(JSON.stringify(datos, null, 2));
    await archivo.sync();
  } finally {
    await archivo.close();
  }
  await fs.rename(temporal, DB_PATH);
}

/* ---------------- Respaldos ---------------- */
// El plan Hobby de Railway no tiene respaldos automáticos, así que una vez al
// día (poco después de las 6:00 am de México, cuando cambia hoyMX()) se guarda
// una copia en /data/respaldos (se conservan 14 días) y, si hay BACKUP_EMAIL,
// se manda comprimida por correo. La fecha del último respaldo se guarda en un
// archivo para que un reinicio no lo mande dos veces ni se salte un día.
const RESPALDOS_DIR = path.join(DATA_DIR, "respaldos");
const ULTIMO_RESPALDO_PATH = path.join(DATA_DIR, "ultimo-respaldo.txt");
const DIAS_RESPALDOS_LOCALES = 14;
const MAX_ADJUNTO_BYTES = 35 * 1024 * 1024; // Resend acepta hasta 40 MB por correo
const MAX_INTENTOS_RESPALDO = 3; // por día, para no gastar la cuota de Resend si algo falla
const intentosRespaldo = { dia: "", n: 0 };

// Texto actual de db.json, leído dentro del candado para no tomarlo a la mitad
// de una escritura. Falla si el archivo no es JSON válido.
async function textoDB() {
  return conCandado(async () => {
    const texto = await fs.readFile(DB_PATH, "utf8");
    JSON.parse(texto);
    return texto;
  });
}

// Manda por correo a BACKUP_EMAIL una copia comprimida de db.json. Lanza un
// error si el envío falla.
async function enviarRespaldoPorCorreo(texto, { titulo, archivo, descripcion }) {
  if (!resend || !BACKUP_EMAIL) return;
  const comprimido = gzipSync(texto);
  const pesoMB = (comprimido.length / 1024 / 1024).toFixed(1);
  const correo = comprimido.length <= MAX_ADJUNTO_BYTES
    ? {
        subject: `Respaldo massticket ${titulo}`,
        html: `<p>${descripcion} de <code>db.json</code> (${pesoMB} MB comprimido).</p>
          <p>Contiene datos personales de clientes: guárdalo en un lugar seguro.</p>
          <p>Para abrirlo, descomprime el archivo <code>.gz</code>; adentro está el <code>db.json</code>.</p>`,
        attachments: [{ filename: `massticket-respaldo-${archivo}.json.gz`, content: comprimido.toString("base64") }],
      }
    : {
        subject: `⚠️ Respaldo massticket ${titulo}: demasiado grande para el correo`,
        html: `<p>El respaldo pesa ${pesoMB} MB comprimido y no cabe en un correo.</p>
          <p>Se guardó en el servidor y puedes bajarlo con el botón "Descargar respaldo" del Panel.</p>`,
      };
  const { error } = await resend.emails.send({ from: EMAIL_FROM, to: BACKUP_EMAIL, ...correo });
  if (error) throw new Error(error.message || JSON.stringify(error));
}

async function respaldoDiario() {
  const hoy = hoyMX();
  if (dbDañada) return; // ya se avisó; no se respalda un archivo dañado
  try {
    const ultimo = (await fs.readFile(ULTIMO_RESPALDO_PATH, "utf8").catch(() => "")).trim();
    if (ultimo === hoy) return;
    if (intentosRespaldo.dia !== hoy) Object.assign(intentosRespaldo, { dia: hoy, n: 0 });
    if (intentosRespaldo.n >= MAX_INTENTOS_RESPALDO) return;
    intentosRespaldo.n++;

    let texto;
    try {
      texto = await textoDB();
    } catch (err) {
      if (err.code === "ENOENT") return; // todavía no hay datos que respaldar
      throw err;
    }

    // Copia local, borrando las de más de DIAS_RESPALDOS_LOCALES días.
    await fs.mkdir(RESPALDOS_DIR, { recursive: true });
    await fs.writeFile(path.join(RESPALDOS_DIR, `db-${hoy}.json`), texto);
    const locales = (await fs.readdir(RESPALDOS_DIR)).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const viejo of locales.slice(0, Math.max(0, locales.length - DIAS_RESPALDOS_LOCALES))) {
      await fs.unlink(path.join(RESPALDOS_DIR, viejo));
    }

    // Copia por correo, comprimida.
    await enviarRespaldoPorCorreo(texto, { titulo: hoy, archivo: hoy, descripcion: "Respaldo diario" });

    await fs.writeFile(ULTIMO_RESPALDO_PATH, hoy);
    console.log(`Respaldo del ${hoy} listo${resend && BACKUP_EMAIL ? " y enviado a " + BACKUP_EMAIL : " (solo copia local)"}.`);
  } catch (err) {
    console.error("Error haciendo el respaldo diario:", err);
  }
}

// Respaldos extra en días de evento: el respaldo diario sale a las 6:00 am,
// así que sin esto, si el volumen se perdiera en la noche del evento, se
// perderían las ventas del día; las de Mercado Pago se recuperan con
// "Revisar con Mercado Pago", pero las ventas manuales (efectivo, cortesías)
// no. Por eso, los días que hay un evento, cada HORAS_ENTRE_RESPALDOS_EXTRA
// horas (y solo si db.json cambió) se guarda otra copia y se manda por correo.
const HORAS_ENTRE_RESPALDOS_EXTRA = 3;
const MAX_RESPALDOS_EXTRA_LOCALES = 16;
const ULTIMO_RESPALDO_EXTRA_PATH = path.join(DATA_DIR, "ultimo-respaldo-extra.txt");

async function respaldoDiaDeEvento() {
  if (dbDañada) return;
  try {
    const ahora = Date.now();
    const ultimo = Date.parse((await fs.readFile(ULTIMO_RESPALDO_EXTRA_PATH, "utf8").catch(() => "")).trim()) || 0;
    if (ahora - ultimo < HORAS_ENTRE_RESPALDOS_EXTRA * 3600 * 1000) return;
    const info = await fs.stat(DB_PATH).catch(() => null);
    if (!info || info.mtimeMs <= ultimo) return; // no ha cambiado nada desde el último
    const hoy = hoyMX();
    const db = await leerDB();
    if (!db.eventos.some((e) => e.fecha === hoy)) return;

    const texto = await textoDB();
    // Fecha y hora de México (UTC-6, sin horario de verano) para el nombre: "2026-10-23-2315".
    const sello = new Date(ahora - 6 * 3600 * 1000).toISOString().slice(0, 16).replace("T", "-").replace(":", "");
    await fs.mkdir(RESPALDOS_DIR, { recursive: true });
    await fs.writeFile(path.join(RESPALDOS_DIR, `db-${sello}.json`), texto);
    const locales = (await fs.readdir(RESPALDOS_DIR)).filter((f) => /^db-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(f)).sort();
    for (const viejo of locales.slice(0, Math.max(0, locales.length - MAX_RESPALDOS_EXTRA_LOCALES))) {
      await fs.unlink(path.join(RESPALDOS_DIR, viejo));
    }
    // Se anota antes del correo: si el correo falla, se reintenta en el
    // siguiente turno (3 horas) y no cada 15 minutos, para no gastar la cuota.
    await fs.writeFile(ULTIMO_RESPALDO_EXTRA_PATH, new Date(ahora).toISOString());

    const hora = `${sello.slice(11, 13)}:${sello.slice(13, 15)}`;
    await enviarRespaldoPorCorreo(texto, { titulo: `${hoy} ${hora} (día de evento)`, archivo: sello, descripcion: "Respaldo extra del día de evento" });
    console.log(`Respaldo extra ${sello} listo${resend && BACKUP_EMAIL ? " y enviado a " + BACKUP_EMAIL : " (solo copia local)"}.`);
  } catch (err) {
    console.error("Error haciendo el respaldo extra del día de evento:", err);
  }
}

/* ---------------- Utilidades ---------------- */

// Para meter texto (nombres, referencias) dentro del HTML de un correo.
function escaparHtml(t) {
  return String(t ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Aviso por correo al organizador (a BACKUP_EMAIL) de algo que hay que
// revisar a mano. Si el correo no está configurado, queda solo en el log.
async function avisarPorCorreo(asunto, html) {
  if (!resend || !BACKUP_EMAIL) return;
  try {
    const { error } = await resend.emails.send({ from: EMAIL_FROM, to: BACKUP_EMAIL, subject: asunto, html });
    if (error) throw new Error(error.message || JSON.stringify(error));
  } catch (err) {
    console.error("No se pudo mandar el aviso por correo:", asunto, err);
  }
}

// Folio: "MT-K7Q2-X9FD-0142". Las 8 letras salen de un generador seguro
// (crypto), así que no se pueden adivinar (32^8 ≈ un billón de opciones); el
// número del final es el consecutivo, que garantiza que no se repita. Los
// folios viejos (con 4 letras, "MT-3F9K-0142") siguen siendo válidos.
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin I, O, 0 ni 1, que se confunden
function letrasAlAzar(n) {
  let s = "";
  for (let k = 0; k < n; k++) s += ABC[crypto.randomInt(ABC.length)];
  return s;
}
function folioNuevo(i) {
  return "MT-" + letrasAlAzar(4) + "-" + letrasAlAzar(4) + "-" + String(i).padStart(4, "0");
}

// Cuánto tiempo se le reserva el lugar a alguien que fue a pagar a Mercado
// Pago pero todavía no confirma: pasado esto, si nunca volvió, se asume que
// abandonó la compra y su lugar deja de estar "apartado" (aunque la venta
// siga viéndose como "pendiente" en el panel, para que quede el registro).
// Si de verdad completa el pago después de esto, el webhook lo confirma
// igual y se le emite su boleto -no se pierde el pago, solo deja de tapar
// el cupo de otros mientras tanto.
const VENTANA_RESERVA_MS = 20 * 60 * 1000; // 20 minutos

// Apartados con anticipo (se arreglan por WhatsApp, no pasan por Mercado Pago):
// el cliente paga un anticipo y sus lugares quedan apartados hasta "vence".
// Se puede apartar hasta DIAS_CIERRE_APARTADOS días antes del evento, y cada
// apartado tiene DIAS_PARA_LIQUIDAR días para pagar el resto. Con 10 y 7, el
// último apartado vence 3 días antes del evento, y esos 3 días quedan para
// volver a vender lo que no se liquidó. Si no se liquida a tiempo, los lugares
// se liberan solos (el anticipo no se devuelve).
const DIAS_CIERRE_APARTADOS = 10;
const DIAS_PARA_LIQUIDAR = 7;

// ¿Esta venta tiene lugares tomados ahora mismo (sin boletos emitidos todavía)?
//  - "pendiente": alguien está pagando en Mercado Pago (VENTANA_RESERVA_MS).
//  - "apartado": anticipo recibido; aparta hasta su fecha límite (vence).
function retieneLugar(v, ahora = Date.now()) {
  if (v.estado === "pendiente") {
    const creado = v.creado ? new Date(v.creado).getTime() : 0;
    return ahora - creado < VENTANA_RESERVA_MS;
  }
  if (v.estado === "apartado") return ahora < new Date(v.vence).getTime();
  return false;
}

// Cuántos lugares ya están tomados de un evento: boletos ya emitidos más
// ventas pendientes de pago RECIENTES (para no vender de más mientras
// alguien todavía está pagando en Mercado Pago, sin dejar bloqueado el
// cupo para siempre por gente que nunca terminó de pagar).
function ocupadosDe(db, eventoId) {
  const ahora = Date.now();
  const enBoletos = db.boletos.filter((b) => b.eventoId === eventoId).length;
  const enPendientes = db.ventas
    .filter((v) => v.eventoId === eventoId && retieneLugar(v, ahora))
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

/* ---------------- Apartados: fechas ---------------- */
// Fechas "AAAA-MM-DD" (días de calendario, sin hora).
function sumarDias(fecha, n) {
  const [y, m, d] = String(fecha).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function esFechaDia(f) {
  return typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(f + "T00:00:00Z"));
}
// Último segundo de ese día en hora de México.
function finDelDiaMX(fecha) {
  return new Date(`${fecha}T23:59:59-06:00`).toISOString();
}
// Si hoy se puede apartar este evento y cuál sería la fecha límite para liquidar:
// 7 días, pero nunca después de 3 días antes del evento (para que haya
// tiempo de volver a vender lo que no se liquidó).
function infoApartado(evento, hoy = hoyMX()) {
  if (!esFechaDia(evento?.fecha)) return { disponible: false };
  const ultimoDia = sumarDias(evento.fecha, -DIAS_CIERRE_APARTADOS);
  const tope = sumarDias(evento.fecha, -(DIAS_CIERRE_APARTADOS - DIAS_PARA_LIQUIDAR));
  let vence = sumarDias(hoy, DIAS_PARA_LIQUIDAR);
  if (vence > tope) vence = tope < hoy ? hoy : tope;
  return { disponible: hoy <= ultimoDia, ultimoDia, vence, dias: DIAS_PARA_LIQUIDAR };
}
// Apartados de un evento que todavía tienen sus lugares tomados.
function apartadosVigentes(db, eventoId, ahora = Date.now()) {
  return db.ventas.filter((v) => v.eventoId === eventoId && v.estado === "apartado" && retieneLugar(v, ahora));
}

/* ---------------- Zonas (precios distintos dentro de un mismo evento) ---------------- */
// Un evento puede tener "zonas" (Luneta, Preferente, Palco...). Cada zona:
//   nombre, precio  = lo que cuesta UNA compra de esa zona,
//   personas        = cuántos boletos (personas) incluye cada compra
//                     (1 para zonas normales; 2 o 4 para palcos),
//   cupo            = lugares (personas) disponibles en total en esa zona.
// Cada boleto individual vale precio / personas.
// El cartel llega del panel como "data:image/...;base64,...". Cualquier otra
// cosa se rechaza, porque se pone tal cual en <img src> de las páginas.
function imagenValida(imagen) {
  return imagen === "" || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(imagen);
}
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
    .filter((v) => v.eventoId === eventoId && retieneLugar(v, ahora))
    .reduce((s, v) => {
      const enLineas = Array.isArray(v.lineas)
        ? v.lineas.filter((l) => l.zonaId === zonaId).reduce((t, l) => t + l.cantidad * l.personas, 0)
        : 0;
      const enMesas = Array.isArray(v.mesas)
        ? v.mesas.filter((m) => m.zonaId === zonaId).reduce((t, m) => t + m.asientos, 0)
        : 0;
      const enAsientos = Array.isArray(v.asientos) ? v.asientos.filter((a) => a.zonaId === zonaId).length : 0;
      return s + enLineas + enMesas + enAsientos;
    }, 0);
  return enBoletos + enPendientes;
}

/* ---------------- Mapas de mesas ---------------- */
// Cada lugar con mesas tiene un archivo en public/mapas/<id>.json con sus
// secciones y mesas (número, sección, asientos y posición en el plano).
// Las mesas se venden COMPLETAS: una mesa de 4 son 4 boletos, una de 2 son 2.
// Excepción: las mesas que el organizador pone "por asiento" en el evento
// (evento.porAsiento, lista de números de mesa) se venden asiento por asiento
// (mesa compartida). Cada mesa puede traer en el mapa su "area" (VIP 01, 106...).
const cacheMapas = new Map();
function cargarMapa(id) {
  const limpio = String(id || "");
  if (!/^[a-z0-9-]+$/.test(limpio)) return null;
  if (cacheMapas.has(limpio)) return cacheMapas.get(limpio);
  try {
    const mapa = JSON.parse(readFileSync(path.join(__dirname, "..", "public", "mapas", limpio + ".json"), "utf8"));
    cacheMapas.set(limpio, mapa);
    return mapa;
  } catch {
    return null;
  }
}
function mapaDe(evento) {
  return evento?.mapaId ? cargarMapa(evento.mapaId) : null;
}
// Zonas de un evento con mapa: una por sección, con el precio POR PERSONA que
// puso el organizador y el cupo que sale de sumar los asientos de sus mesas.
function zonasDeMapa(mapa, precios, previas) {
  const nuevos = {};
  (Array.isArray(precios) ? precios : []).forEach((z) => {
    if (z && z.id) nuevos[String(z.id)] = Math.max(0, Number(z.precio) || 0);
  });
  return mapa.secciones.map((sec) => ({
    id: sec.id,
    nombre: sec.nombre,
    precio: nuevos[sec.id] ?? (previas || []).find((z) => z.id === sec.id)?.precio ?? 0,
    personas: 1,
    cupo: mapa.mesas.filter((m) => m.seccion === sec.id).reduce((t, m) => t + m.asientos, 0),
  }));
}
function aplicarMapaAEvento(evento, mapa, zonas) {
  evento.mapaId = mapa.id;
  evento.zonas = zonas;
  evento.cupo = Math.max(1, zonas.reduce((t, z) => t + z.cupo, 0));
  evento.precio = Math.min(...zonas.map(precioPorBoleto));
}
// Mesas no disponibles: "vendida" (ya tiene boletos) o "apartada" (alguien
// está pagando en Mercado Pago, o hay un apartado con anticipo; se liberan
// solas pasada la ventana de reserva o la fecha límite del apartado).
function estadoMesas(db, evento) {
  const estado = new Map();
  for (const b of db.boletos) {
    if (b.eventoId === evento.id && b.mesaId) estado.set(String(b.mesaId), "vendida");
  }
  const ahora = Date.now();
  for (const v of db.ventas) {
    if (v.eventoId !== evento.id || !retieneLugar(v, ahora)) continue;
    const ids = [...(Array.isArray(v.mesas) ? v.mesas : []), ...(Array.isArray(v.asientos) ? v.asientos : [])].map((m) => String(m.mesaId));
    for (const id of ids) if (!estado.has(id)) estado.set(id, "apartada");
  }
  return estado;
}
// Mesas del evento que se venden por asiento (mesa compartida).
function mesasPorAsiento(evento) {
  return new Set((Array.isArray(evento?.porAsiento) ? evento.porAsiento : []).map(String));
}
// Asientos no disponibles de cada mesa: Map mesaId -> Map(número -> "vendido"|"apartado").
// Una mesa vendida completa (boletos sin número de asiento, o compra pendiente
// de la mesa completa) ocupa todos sus asientos.
function estadoAsientos(db, evento, mapa) {
  const porMesa = new Map();
  const total = new Map(mapa.mesas.map((m) => [String(m.id), m.asientos]));
  const marcar = (mesaId, n, estado) => {
    const id = String(mesaId);
    if (!porMesa.has(id)) porMesa.set(id, new Map());
    const m = porMesa.get(id);
    if (!m.has(n) || estado === "vendido") m.set(n, estado);
  };
  const toda = (mesaId, estado) => { for (let n = 1; n <= (total.get(String(mesaId)) || 0); n++) marcar(mesaId, n, estado); };
  for (const b of db.boletos) {
    if (b.eventoId !== evento.id || !b.mesaId) continue;
    if (b.asiento) marcar(b.mesaId, Number(b.asiento), "vendido");
    else toda(b.mesaId, "vendido");
  }
  const ahora = Date.now();
  for (const v of db.ventas) {
    if (v.eventoId !== evento.id || !retieneLugar(v, ahora)) continue;
    for (const m of Array.isArray(v.mesas) ? v.mesas : []) toda(m.mesaId, "apartado");
    for (const a of Array.isArray(v.asientos) ? v.asientos : []) marcar(a.mesaId, Number(a.asiento), "apartado");
  }
  return porMesa;
}
// Revisa una lista de asientos pedidos {mesa, asiento} de un evento con mapa.
// Devuelve { asientos: [...] } listos para guardar en la venta, o { error, status }.
const MAX_ASIENTOS_POR_COMPRA = 10;
function revisarAsientosPedidos(db, evento, mapa, pedidos, { max = MAX_ASIENTOS_POR_COMPRA } = {}) {
  const lista = [];
  const vistos = new Set();
  for (const p of Array.isArray(pedidos) ? pedidos : []) {
    const mesaId = String(p?.mesa ?? p?.mesaId ?? "");
    const asiento = parseInt(p?.asiento);
    const clave = mesaId + ":" + asiento;
    if (!mesaId || !Number.isInteger(asiento) || vistos.has(clave)) continue;
    vistos.add(clave);
    lista.push({ mesaId, asiento });
  }
  if (!lista.length) return { asientos: [] };
  if (lista.length > max) return { status: 400, error: `Máximo ${max} asientos por compra.` };
  const porAsiento = mesasPorAsiento(evento);
  const ocupados = estadoAsientos(db, evento, mapa);
  const zonas = zonasDe(evento);
  const salida = [];
  for (const { mesaId, asiento } of lista) {
    const mesa = mapa.mesas.find((m) => String(m.id) === mesaId);
    if (!mesa) return { status: 400, error: `La mesa ${mesaId} no existe.` };
    if (!porAsiento.has(mesaId)) return { status: 409, error: `La mesa ${mesaId} se vende completa, no por asiento.` };
    if (asiento < 1 || asiento > mesa.asientos) return { status: 400, error: `La mesa ${mesaId} no tiene asiento ${asiento}.` };
    if (ocupados.get(mesaId)?.has(asiento)) {
      return { status: 409, error: `El asiento ${asiento} de la mesa ${mesaId} ya no está disponible. Elige otro.` };
    }
    const z = zonas.find((x) => x.id === mesa.seccion);
    salida.push({
      mesaId, asiento, zonaId: mesa.seccion, zonaNombre: z?.nombre || mesa.seccion,
      ...(mesa.area ? { area: mesa.area } : {}), precioPersona: z ? precioPorBoleto(z) : 0,
    });
  }
  salida.sort((a, b) => (a.mesaId === b.mesaId ? a.asiento - b.asiento : 0));
  return { asientos: salida };
}
// Texto corto de dónde se sienta alguien: "VIP 02 · Mesa 11 · Asiento 3".
function lugarDeBoleto(b) {
  return [b.area || b.zona || "", b.mesa ? "Mesa " + b.mesa : "", b.asiento ? "Asiento " + b.asiento : ""].filter(Boolean).join("  ·  ");
}
// Tipos de pago de Mercado Pago que NO se ofrecen: los que se aprueban horas
// o días después de elegirlos (efectivo en tienda como OXXO, pago en banco y
// transferencia SPEI). El lugar solo se aparta VENTANA_RESERVA_MS, así que un
// pago así podía llegar cuando el lugar ya se había vendido a otra persona.
// Quedan tarjetas de crédito/débito y saldo de Mercado Pago.
const TIPOS_PAGO_EXCLUIDOS = ["ticket", "atm", "bank_transfer"];
function sinPagosDiferidos() {
  return { payment_methods: { excluded_payment_types: TIPOS_PAGO_EXCLUIDOS.map((id) => ({ id })) } };
}

// Hora de vencimiento del link de pago de Mercado Pago (hora de México),
// para que nadie pague un lugar después de que se liberó su apartado.
function expiracionMP(minutos) {
  const fmt = (ms) => new Date(ms - 6 * 3600 * 1000).toISOString().replace("Z", "-06:00");
  const ahora = Date.now();
  return { expires: true, expiration_date_from: fmt(ahora), expiration_date_to: fmt(ahora + minutos * 60000) };
}

// Evento listo para mandarse al público: con lugares vendidos y, si tiene zonas,
// cuántos lugares quedan en cada una.
function conOcupacion(db, e) {
  const zonas = zonasDe(e);
  const salida = { ...e, vendidos: ocupadosDe(db, e.id), apartado: infoApartado(e) };
  if (zonas.length) {
    salida.zonas = zonas.map((z) => {
      const vendidos = ocupadosZona(db, e.id, z.id);
      return { ...z, vendidos, disponibles: Math.max(0, z.cupo - vendidos) };
    });
  }
  const mapa = mapaDe(e);
  if (mapa) {
    const estado = estadoMesas(db, e);
    const porAsiento = mesasPorAsiento(e);
    const asientos = porAsiento.size ? estadoAsientos(db, e, mapa) : new Map();
    salida.mesas = mapa.mesas.map((m) => {
      const z = zonasDe(e).find((x) => x.id === m.seccion);
      const pp = z ? precioPorBoleto(z) : 0;
      const base = {
        id: m.id,
        seccion: m.seccion,
        ...(m.area ? { area: m.area } : {}),
        asientos: m.asientos,
        precioPersona: pp,
        precioMesa: Math.round(pp * m.asientos * 100) / 100,
      };
      if (porAsiento.has(String(m.id))) {
        // Por asiento: solo se dice qué números están tomados (no quién los tiene).
        const tomados = [...(asientos.get(String(m.id))?.keys() || [])].sort((a, b) => a - b);
        return { ...base, porAsiento: true, asientosOcupados: tomados, libres: m.asientos - tomados.length,
          ocupada: tomados.length >= m.asientos, estado: tomados.length >= m.asientos ? "vendida" : "libre" };
      }
      return { ...base, ocupada: estado.has(m.id), estado: estado.get(m.id) || "libre" };
    });
  }
  return salida;
}

// Compara la clave de organizador sin que el tiempo de respuesta delate
// cuántos caracteres coinciden (se comparan los hash, que miden lo mismo).
function claveCorrecta(clave) {
  if (!ADMIN_KEY || typeof clave !== "string") return false;
  const a = crypto.createHash("sha256").update(clave).digest();
  const b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// Para que nadie pueda probar claves sin fin: después de MAX_FALLOS_CLAVE
// intentos con clave incorrecta desde la misma IP, esa IP queda bloqueada
// hasta que pasen VENTANA_FALLOS_CLAVE_MS desde el primer fallo.
const MAX_FALLOS_CLAVE = 20;
const VENTANA_FALLOS_CLAVE_MS = 15 * 60 * 1000;
const fallosClave = new Map(); // ip -> { n, desde }
// IP real del visitante. En Railway las peticiones pasan por un CDN antes de
// llegar aquí, así que req.ip resulta ser la IP del CDN (la misma para muchos
// visitantes). La red de Railway escribe la IP real en X-Real-IP y reemplaza
// la que mande el visitante, así que no se puede falsificar. Si no viene (por
// ejemplo, en desarrollo local), se usa req.ip.
function ipVisitante(req) {
  return String(req.get("x-real-ip") || "").trim().slice(0, 64) || req.ip;
}

function requiereAdmin(req, res, next) {
  const ahora = Date.now();
  const ip = ipVisitante(req);
  let f = fallosClave.get(ip);
  if (f && ahora - f.desde > VENTANA_FALLOS_CLAVE_MS) { fallosClave.delete(ip); f = null; }
  if (f && f.n >= MAX_FALLOS_CLAVE) {
    return res.status(429).json({ error: "Demasiados intentos con clave incorrecta. Espera 15 minutos e intenta de nuevo." });
  }
  const clave = req.get("x-admin-key");
  if (!claveCorrecta(clave)) {
    // Una clave vacía no cuenta como intento: no sirve para adivinar nada.
    if (!clave) return res.status(401).json({ error: "No autorizado" });
    if (fallosClave.size > 10000) {
      for (const [k, v] of fallosClave) if (ahora - v.desde > VENTANA_FALLOS_CLAVE_MS) fallosClave.delete(k);
    }
    if (!f) { f = { n: 0, desde: ahora }; fallosClave.set(ip, f); }
    f.n++;
    if (f.n === 1) console.warn(`Clave de organizador incorrecta desde ${ip}.`);
    if (f.n === MAX_FALLOS_CLAVE) console.warn(`Clave de organizador incorrecta ${MAX_FALLOS_CLAVE} veces desde ${ip}: se bloquea esa IP 15 minutos.`);
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// Verifica que la notificación realmente venga de Mercado Pago.
// https://www.mercadopago.com.mx/developers/es/docs/checkout-pro/additional-content/notifications/webhooks
function verificarFirma(req) {
  const xSignature = req.get("x-signature");
  const xRequestId = req.get("x-request-id");
  const dataId = String(req.query["data.id"] || "").toLowerCase();
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
    if (b.mesa) {
      doc.fontSize(15).fillColor("#111").text(lugarDeBoleto(b), { align: "center" });
      if (b.asiento) doc.fontSize(10).fillColor("#555").text("Mesa compartida", { align: "center" });
    }
    else if (b.zona) doc.fontSize(12).fillColor("#111").text(`Zona: ${b.zona}`, { align: "center" });
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
// El resultado queda guardado en la venta (venta.correo) para que el panel
// muestre a quién no le llegaron sus boletos y se los pueda reenviar.
async function enviarBoletosPorEmail({ evento, nombre, contacto, boletos }) {
  if (!resend) return;
  if (!contacto || !contacto.includes("@")) return;
  if (!boletos || !boletos.length) return;
  let error = null;
  try {
    const pdf = await generarPDFBoletos({ evento, boletos });
    const cantidad = boletos.length;
    // Mesas completas: "Mesa 11"; asientos sueltos: "Mesa 11, asientos 1 y 3 (mesa compartida)".
    const porMesa = new Map();
    for (const b of boletos.filter((x) => x.mesa)) {
      if (!porMesa.has(b.mesa)) porMesa.set(b.mesa, { area: b.area || "", asientos: [] });
      if (b.asiento) porMesa.get(b.mesa).asientos.push(b.asiento);
    }
    const mesasTexto = [...porMesa].map(([mesa, i]) =>
      `${i.area ? i.area + " · " : ""}Mesa ${mesa}` +
      (i.asientos.length ? `, asiento${i.asientos.length > 1 ? "s" : ""} ${i.asientos.sort((a, b) => a - b).join(", ")} (mesa compartida)` : ""));
    const lineaMesas = mesasTexto.length
      ? `<p><strong>${escaparHtml(mesasTexto.join(" · "))}</strong></p>`
      : "";
    // Resend no lanza un error cuando falla el envío: lo devuelve en "error".
    const respuesta = await resend.emails.send({
      from: EMAIL_FROM,
      to: contacto,
      subject: `Tus boleto${cantidad > 1 ? "s" : ""} para ${evento?.nombre || "tu evento"}`,
      html: `
        <p>Hola ${escaparHtml(nombre)},</p>
        <p>Aquí tienes tu${cantidad > 1 ? "s" : ""} boleto${cantidad > 1 ? "s" : ""} para
        <strong>${escaparHtml(evento?.nombre || "el evento")}</strong>
        (${escaparHtml(fechaLegibleServidor(evento?.fecha))}, ${escaparHtml(evento?.lugar || "lugar por confirmar")}).</p>
        ${lineaMesas}
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
    if (respuesta?.error) throw new Error(respuesta.error.message || JSON.stringify(respuesta.error));
  } catch (err) {
    console.error("Error enviando boletos por correo a", contacto, err);
    error = String(err?.message || err).slice(0, 300);
  }

  const ventaId = boletos[0].ventaId;
  if (!ventaId) return;
  try {
    await conCandado(async () => {
      const db = await leerDB();
      const venta = db.ventas.find((v) => v.id === ventaId);
      if (!venta) return;
      venta.correo = { estado: error ? "fallo" : "enviado", a: contacto, en: new Date().toISOString(), ...(error ? { error } : {}) };
      await escribirDB(db);
    });
  } catch (err) {
    console.error("No se pudo guardar el resultado del correo de la venta", ventaId, err);
  }
}

/* ---------------- App ---------------- */

// Express 4 no atrapa los errores de las rutas async: sin esto, un error
// inesperado (por ejemplo, el disco lleno al guardar) tumbaba todo el
// servidor y se cortaban las compras que estaban en curso. Con esto, el
// error llega al manejador del final, que lo registra y contesta 500.
const seguro = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
// Railway pasa las peticiones por su proxy: con esto, req.ip es la IP del
// último salto antes del proxy (en producción, el CDN). Para la IP real del
// visitante se usa ipVisitante().
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "12mb" })); // 12mb: alcanza para el cartel del evento en base64
app.use(express.static(path.join(__dirname, "..", "public")));

// Con db.json dañado no se atiende ninguna petición de la API, para que nadie
// escriba encima. Al webhook también se le contesta 503: así Mercado Pago
// vuelve a mandar el aviso más tarde, cuando ya se restauró el respaldo.
app.use("/api", (req, res, next) => {
  if (dbDañada) {
    return res.status(503).json({ error: "El sitio está en mantenimiento. Intenta de nuevo en unos minutos." });
  }
  next();
});

// -------- Eventos: listar (público, para la página de inicio) --------
app.get("/api/eventos", seguro(async (req, res) => {
  const db = await leerDB();
  // Por defecto (la página pública) solo se muestran eventos de hoy en
  // adelante; al día siguiente del evento deja de aparecer solo, sin que
  // nadie tenga que borrarlo. El panel de organizador pide ?todos=1 para
  // seguir viendo TODOS los eventos (incluidos los ya pasados), porque ahí
  // se siguen administrando boletos y borrando eventos a mano.
  const hoy = hoyMX(); // "AAAA-MM-DD"
  // Con ?todos=1 se ven también los eventos pasados y los ocultos, pero solo
  // si la petición trae la clave de organizador (el panel la manda siempre).
  const esAdmin = claveCorrecta(req.get("x-admin-key"));
  const mostrarTodos = req.query.todos === "1" && esAdmin;
  const lista = db.eventos
    .filter((e) => mostrarTodos || (!e.oculto && (!e.fecha || e.fecha >= hoy)))
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
}));

// -------- Un evento (público, para la página de compra de ese evento) --------
app.get("/api/eventos/:id", seguro(async (req, res) => {
  const db = await leerDB();
  const evento = db.eventos.find((e) => e.id === req.params.id);
  if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
  res.json(conOcupacion(db, evento));
}));

// -------- Mapas de mesas disponibles (para el formulario de eventos) --------
app.get("/api/mapas", seguro(async (req, res) => {
  try {
    const dir = path.join(__dirname, "..", "public", "mapas");
    const archivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const lista = [];
    for (const f of archivos) {
      const m = cargarMapa(f.replace(/\.json$/, ""));
      if (m) lista.push({ id: m.id, nombre: m.nombre, secciones: m.secciones.map((s) => ({ id: s.id, nombre: s.nombre })) });
    }
    res.json(lista);
  } catch {
    res.json([]);
  }
}));

// -------- Crear evento (admin) --------
app.post("/api/eventos", requiereAdmin, seguro(async (req, res) => {
  const { nombre, fecha, lugar, precio, cupo, imagen, zonas, mapaId, oculto, modoVenta } = req.body || {};
  if (typeof imagen === "string" && !imagenValida(imagen)) return res.status(400).json({ error: "La imagen del cartel no es válida." });
  await conCandado(async () => {
    const db = await leerDB();
    const mapa = mapaId ? cargarMapa(mapaId) : null;
    if (mapaId && !mapa) return res.status(400).json({ error: "Ese mapa no existe." });
    const zs = limpiarZonas(zonas);
    const nuevo = {
      id: uuid(),
      nombre: (nombre || "Evento sin nombre").trim(),
      fecha: fecha || "",
      lugar: (lugar || "").trim(),
      precio: Math.max(0, Number(precio) || 0),
      cupo: Math.max(1, Number(cupo) || 1),
      imagen: typeof imagen === "string" ? imagen : "",
      // Oculto: no aparece en la página de inicio; se compra solo con el enlace directo.
      oculto: oculto === true,
      creado: new Date().toISOString(),
    };
    if (mapa) {
      aplicarMapaAEvento(nuevo, mapa, zonasDeMapa(mapa, zonas, []));
      // Modo de venta inicial: todas las mesas completas (normal) o todas por asiento.
      nuevo.porAsiento = modoVenta === "asiento" ? mapa.mesas.map((m) => String(m.id)) : [];
    } else if (zs.length) {
      // Con zonas, el cupo total y el precio "desde" salen de las zonas.
      nuevo.zonas = zs;
      nuevo.cupo = Math.max(1, zs.reduce((t, z) => t + z.cupo, 0));
      nuevo.precio = Math.min(...zs.map(precioPorBoleto));
    }
    db.eventos.push(nuevo);
    await escribirDB(db);
    res.json(nuevo);
  });
}));

// -------- Editar evento (admin) --------
app.put("/api/eventos/:id", requiereAdmin, seguro(async (req, res) => {
  const { nombre, fecha, lugar, precio, cupo, imagen, zonas, mapaId, oculto } = req.body || {};
  if (typeof imagen === "string" && !imagenValida(imagen)) return res.status(400).json({ error: "La imagen del cartel no es válida." });
  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === req.params.id);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    if (typeof oculto === "boolean") evento.oculto = oculto;

    // Eventos con mapa de mesas: solo se editan datos y precios por persona.
    const quiereMapa = typeof mapaId === "string" ? mapaId : evento.mapaId || "";
    const tieneBoletos = db.boletos.some((b) => b.eventoId === evento.id);
    if ((evento.mapaId || "") !== quiereMapa && tieneBoletos) {
      return res.status(409).json({ error: "No puedes cambiar el mapa de un evento que ya vendió boletos." });
    }
    if ((evento.mapaId || "") !== quiereMapa && apartadosVigentes(db, evento.id).length) {
      return res.status(409).json({ error: "No puedes cambiar el mapa de un evento con apartados vigentes." });
    }
    if (quiereMapa) {
      const mapa = cargarMapa(quiereMapa);
      if (!mapa) return res.status(400).json({ error: "Ese mapa no existe." });
      evento.nombre = (nombre || evento.nombre || "Evento sin nombre").trim();
      evento.fecha = fecha ?? evento.fecha;
      evento.lugar = (lugar ?? evento.lugar ?? "").trim();
      aplicarMapaAEvento(evento, mapa, zonasDeMapa(mapa, zonas, zonasDe(evento)));
      // Si cambió el mapa, solo se quedan "por asiento" las mesas que existen en el nuevo.
      const idsMapa = new Set(mapa.mesas.map((m) => String(m.id)));
      evento.porAsiento = [...mesasPorAsiento(evento)].filter((id) => idsMapa.has(id));
      if (typeof imagen === "string" && imagen) evento.imagen = imagen;
      await escribirDB(db);
      return res.json(evento);
    }
    if (evento.mapaId) {
      // Se le quitó el mapa a un evento sin boletos: vuelve a precio único.
      delete evento.mapaId;
      delete evento.zonas;
      delete evento.porAsiento;
    }

    // Zonas: se revisa antes de cambiar nada para no dejar el evento a medias.
    let zs = null;
    if (Array.isArray(zonas)) {
      zs = limpiarZonas(zonas);
      const boletosEv = db.boletos.filter((b) => b.eventoId === evento.id);
      if (zs.length && boletosEv.some((b) => !b.zonaId)) {
        return res.status(409).json({ error: "Este evento ya vendió boletos sin zona; no se le pueden agregar zonas." });
      }
      const usadas = new Set(boletosEv.filter((b) => b.zonaId).map((b) => b.zonaId));
      for (const v of apartadosVigentes(db, evento.id)) for (const l of v.lineas || []) if (l.zonaId) usadas.add(l.zonaId);
      for (const id of usadas) {
        if (!zs.some((z) => z.id === id)) {
          return res.status(409).json({ error: "No puedes quitar una zona que ya tiene boletos vendidos o apartados." });
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
}));

// -------- Mesas por asiento / completas (admin) --------
// Cambia cómo se venden unas mesas de un evento con mapa. Reglas:
//  - Una mesa vendida o apartada COMPLETA no puede pasar a "por asiento".
//  - Una mesa con algún asiento vendido o apartado no puede volver a "completa".
// Las mesas que no se pueden cambiar se reportan en "omitidas" y las demás sí cambian.
app.put("/api/eventos/:id/por-asiento", requiereAdmin, seguro(async (req, res) => {
  const pedidas = Array.isArray(req.body?.mesas) ? [...new Set(req.body.mesas.map(String))] : [];
  const aAsiento = req.body?.porAsiento === true;
  if (!pedidas.length) return res.status(400).json({ error: "Elige al menos una mesa." });
  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === req.params.id);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    const mapa = mapaDe(evento);
    if (!mapa) return res.status(400).json({ error: "Este evento no tiene mapa de mesas." });
    const actuales = mesasPorAsiento(evento);
    const ahora = Date.now();
    const vigente = (v) => v.eventoId === evento.id && retieneLugar(v, ahora);
    const completas = new Set(), sueltas = new Set();
    for (const b of db.boletos) {
      if (b.eventoId !== evento.id || !b.mesaId) continue;
      (b.asiento ? sueltas : completas).add(String(b.mesaId));
    }
    for (const v of db.ventas) {
      if (!vigente(v)) continue;
      for (const m of Array.isArray(v.mesas) ? v.mesas : []) completas.add(String(m.mesaId));
      for (const a of Array.isArray(v.asientos) ? v.asientos : []) sueltas.add(String(a.mesaId));
    }
    const omitidas = [];
    for (const id of pedidas) {
      if (!mapa.mesas.some((m) => String(m.id) === id)) { omitidas.push({ mesa: id, motivo: "no existe" }); continue; }
      if (aAsiento && !actuales.has(id)) {
        if (completas.has(id)) omitidas.push({ mesa: id, motivo: "ya se vendió o apartó completa" });
        else actuales.add(id);
      } else if (!aAsiento && actuales.has(id)) {
        if (sueltas.has(id)) omitidas.push({ mesa: id, motivo: "ya tiene asientos vendidos o apartados" });
        else actuales.delete(id);
      }
    }
    const orden = new Map(mapa.mesas.map((m, i) => [String(m.id), i]));
    evento.porAsiento = [...actuales].sort((a, b) => orden.get(a) - orden.get(b));
    await escribirDB(db);
    res.json({ porAsiento: evento.porAsiento, omitidas });
  });
}));

// -------- Borrar evento (admin) --------
app.delete("/api/eventos/:id", requiereAdmin, seguro(async (req, res) => {
  await conCandado(async () => {
    const db = await leerDB();
    const tieneBoletos = db.boletos.some((b) => b.eventoId === req.params.id);
    if (tieneBoletos) {
      return res.status(409).json({ error: "Este evento ya tiene boletos emitidos; no se puede borrar." });
    }
    if (apartadosVigentes(db, req.params.id).length) {
      return res.status(409).json({ error: "Este evento tiene apartados vigentes; cancélalos antes de borrarlo." });
    }
    db.eventos = db.eventos.filter((e) => e.id !== req.params.id);
    await escribirDB(db);
    res.json({ ok: true });
  });
}));

// Cada compra iniciada aparta lugares 20 minutos aunque no se pague; sin
// límite, un programa podía apartar todo el cupo una y otra vez y hacer que
// el evento pareciera agotado. Se permiten MAX_COMPRAS_POR_IP compras
// iniciadas por IP cada VENTANA_COMPRAS_MS: alcanza para quien reintenta
// varias veces o para varias personas que comparten la red del celular.
const MAX_COMPRAS_POR_IP = 15;
const VENTANA_COMPRAS_MS = 15 * 60 * 1000;
const comprasPorIp = new Map(); // ip -> { n, desde }
function limitarCompras(req, res, next) {
  const ahora = Date.now();
  const ip = ipVisitante(req);
  if (comprasPorIp.size > 10000) {
    for (const [k, v] of comprasPorIp) if (ahora - v.desde > VENTANA_COMPRAS_MS) comprasPorIp.delete(k);
  }
  let c = comprasPorIp.get(ip);
  if (!c || ahora - c.desde > VENTANA_COMPRAS_MS) { c = { n: 0, desde: ahora }; comprasPorIp.set(ip, c); }
  if (c.n >= MAX_COMPRAS_POR_IP) {
    if (c.n === MAX_COMPRAS_POR_IP) console.warn(`Demasiadas compras iniciadas desde ${ip}: se pausan ${VENTANA_COMPRAS_MS / 60000} minutos.`);
    c.n++;
    return res.status(429).json({ error: "Hiciste muchos intentos de compra seguidos. Espera unos minutos e intenta de nuevo." });
  }
  c.n++;
  next();
}

// Además, una misma IP puede tener apartados a la vez como máximo
// MAX_LUGARES_APARTADOS_POR_IP lugares (durante VENTANA_RESERVA_MS). Su primera
// compra siempre pasa, aunque sea más grande (por ejemplo, varias mesas),
// así que nadie se queda sin poder comprar; lo que se evita es que una sola
// persona aparte el lugar completo con muchas compras seguidas.
const MAX_LUGARES_APARTADOS_POR_IP = 40;
const apartadosPorIp = new Map(); // ip -> [{ ventaId, lugares, hasta }]
function lugaresApartadosDe(ip, ahora = Date.now()) {
  if (apartadosPorIp.size > 10000) {
    for (const [k, v] of apartadosPorIp) if (!v.some((a) => a.hasta > ahora)) apartadosPorIp.delete(k);
  }
  const vigentes = (apartadosPorIp.get(ip) || []).filter((a) => a.hasta > ahora);
  if (vigentes.length) apartadosPorIp.set(ip, vigentes);
  else apartadosPorIp.delete(ip);
  return vigentes;
}

// -------- Comprar (público): crea la preferencia y devuelve el link de pago --------
app.post("/api/comprar", limitarCompras, seguro(async (req, res) => {
  const ventaId = uuid();
  const ip = ipVisitante(req);
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
      const mapa = mapaDe(evento);
      let lineas = null;
      let mesasVenta = null;
      let asientosVenta = null;
      let totalBoletos = 0;
      if (mapa) {
        // Evento con mapa de mesas: mesas completas y/o asientos sueltos de las
        // mesas que el organizador puso "por asiento" (mesa compartida).
        const pedidas = Array.isArray(req.body?.mesas) ? [...new Set(req.body.mesas.map(String))] : [];
        const revision = revisarAsientosPedidos(db, evento, mapa, req.body?.asientos);
        if (revision.error) { falla = { status: revision.status, error: revision.error }; return; }
        if (!pedidas.length && !revision.asientos.length) { falla = { status: 400, error: "Elige al menos una mesa o un asiento." }; return; }
        if (pedidas.length > 8) { falla = { status: 400, error: "Máximo 8 mesas por compra." }; return; }
        const estado = estadoMesas(db, evento);
        const porAsiento = mesasPorAsiento(evento);
        mesasVenta = [];
        for (const id of pedidas) {
          const mesa = mapa.mesas.find((m) => m.id === id);
          if (!mesa) { falla = { status: 400, error: `La mesa ${id} no existe.` }; return; }
          if (porAsiento.has(id)) {
            falla = { status: 409, error: `La mesa ${id} se vende por asiento: elige tus asientos.` };
            return;
          }
          if (estado.has(id)) {
            falla = { status: 409, error: `La mesa ${id} ya no está disponible. Elige otra.` };
            return;
          }
          const z = zonas.find((x) => x.id === mesa.seccion);
          const pp = z ? precioPorBoleto(z) : 0;
          mesasVenta.push({ mesaId: id, zonaId: mesa.seccion, zonaNombre: z?.nombre || mesa.seccion, ...(mesa.area ? { area: mesa.area } : {}), asientos: mesa.asientos, precioPersona: pp });
          totalBoletos += mesa.asientos;
          items.push({
            id: `mesa-${id}`,
            title: `${evento.nombre} — Mesa ${id} (${mesa.area || z?.nombre || mesa.seccion}, ${mesa.asientos} personas)`.slice(0, 250),
            quantity: 1,
            unit_price: Math.round(pp * mesa.asientos * 100) / 100,
            currency_id: "MXN",
          });
        }
        // Asientos sueltos: una línea de Mercado Pago por mesa, con sus números.
        asientosVenta = revision.asientos;
        totalBoletos += asientosVenta.length;
        const porMesa = new Map();
        for (const a of asientosVenta) {
          if (!porMesa.has(a.mesaId)) porMesa.set(a.mesaId, []);
          porMesa.get(a.mesaId).push(a);
        }
        for (const [mesaId, lista] of porMesa) {
          const a0 = lista[0];
          items.push({
            id: `asientos-${mesaId}`,
            title: `${evento.nombre} — Mesa ${mesaId} (${a0.area || a0.zonaNombre}), asiento${lista.length > 1 ? "s" : ""} ${lista.map((a) => a.asiento).join(", ")} · mesa compartida`.slice(0, 250),
            quantity: lista.length,
            unit_price: a0.precioPersona,
            currency_id: "MXN",
          });
        }
        if (!mesasVenta.length) mesasVenta = null;
        if (!asientosVenta.length) asientosVenta = null;
      } else if (zonas.length) {
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

      const apartados = lugaresApartadosDe(ip);
      const yaApartados = apartados.reduce((t, a) => t + a.lugares, 0);
      if (yaApartados > 0 && yaApartados + totalBoletos > MAX_LUGARES_APARTADOS_POR_IP) {
        console.warn(`Compra rechazada: ${ip} ya tiene ${yaApartados} lugares apartados.`);
        falla = { status: 429, error: "Ya tienes varias compras sin terminar. Termina de pagar esas o espera 20 minutos e intenta de nuevo. Si quieres comprar muchos lugares, escríbenos por WhatsApp." };
        return;
      }

      db.ventas.push({
        id: ventaId,
        eventoId,
        nombre,
        contacto,
        telefono,
        cantidad: totalBoletos,
        ...(mesasVenta || asientosVenta
          ? { ...(mesasVenta ? { mesas: mesasVenta } : {}), ...(asientosVenta ? { asientos: asientosVenta } : {}) }
          : lineas ? { lineas } : { precioUnit: Number(evento.precio) || 0 }),
        preferenceId: null,
        estado: "pendiente",
        creado: new Date().toISOString(),
      });
      await escribirDB(db);
      ventaCreada = true;
      if (!apartadosPorIp.has(ip)) apartadosPorIp.set(ip, apartados);
      apartados.push({ ventaId, lugares: totalBoletos, hasta: Date.now() + VENTANA_RESERVA_MS });
    });
    if (falla) return res.status(falla.status).json({ error: falla.error });

    const preference = new Preference(mpClient);
    const cuerpoPreferencia = {
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
    };
    // El link de pago vence antes de que se libere el apartado (VENTANA_RESERVA_MS)
    // y no ofrece pagos que se aprueban horas o días después (OXXO, SPEI):
    // así nadie paga un lugar que ya se liberó y se le vendió a otra persona.
    // Si Mercado Pago rechazara alguna de esas opciones, se reintenta sin
    // ella para no dejar de vender, y queda el aviso en el log.
    const intentos = [
      { ...cuerpoPreferencia, ...sinPagosDiferidos(), ...expiracionMP(19) },
      { ...cuerpoPreferencia, ...sinPagosDiferidos() },
      cuerpoPreferencia,
    ];
    let resultado;
    for (let i = 0; i < intentos.length; i++) {
      try {
        resultado = await preference.create({ body: intentos[i] });
        break;
      } catch (e) {
        if (i === intentos.length - 1) throw e;
        console.warn(
          i === 0
            ? "Mercado Pago no aceptó el vencimiento del link; se reintenta sin él:"
            : "⚠️ Mercado Pago no aceptó excluir OXXO/SPEI; se reintenta sin excluirlos:",
          e?.message || e
        );
      }
    }

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
      const apartados = apartadosPorIp.get(ip);
      if (apartados) apartadosPorIp.set(ip, apartados.filter((a) => a.ventaId !== ventaId));
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
}));

// -------- Estado de una venta (para la página de gracias) --------
app.get("/api/venta/:id", seguro(async (req, res) => {
  const db = await leerDB();
  const venta = db.ventas.find((v) => v.id === req.params.id);
  if (!venta) return res.status(404).json({ error: "Venta no encontrada" });
  const boletos = db.boletos.filter((b) => b.ventaId === venta.id);
  const evento = db.eventos.find((e) => e.id === venta.eventoId) || null;
  res.json({ estado: venta.estado, evento, boletos });
}));

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
    if (!venta) { resultado = { ventaNoEncontrada: true }; return; }
    if (venta.estado === "pagado") return; // idempotencia: ya se procesó este pago

    venta.estado = "pagado";
    venta.pagoId = pago.id;
    venta.pagadoEn = new Date().toISOString();

    const nuevos = [];
    // Compra con zonas: cada línea trae su zona y cuántos boletos incluye cada
    // compra (palco de 2 o de 4 = 2 o 4 boletos, cada uno con su QR).
    const conMesas = Array.isArray(venta.mesas) && venta.mesas.length;
    const conAsientos = Array.isArray(venta.asientos) && venta.asientos.length;
    const lineas = conMesas || conAsientos
      ? []
      : Array.isArray(venta.lineas) && venta.lineas.length
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
    if (conMesas) {
      // Una mesa son todos sus asientos: un boleto por persona, con su mesa.
      // Si por una demora larga la mesa ya se le dio a otra persona, se emiten
      // igual los boletos (el pago ya está hecho) pero se deja el aviso en
      // el Panel para resolverlo a mano.
      const tomadas = new Set(
        db.boletos.filter((b) => b.eventoId === venta.eventoId && b.mesaId && b.ventaId !== venta.id).map((b) => String(b.mesaId))
      );
      for (const m of venta.mesas) {
        if (tomadas.has(String(m.mesaId))) {
          venta.conflictoMesas = [...(venta.conflictoMesas || []), String(m.mesaId)];
        }
        for (let i = 0; i < m.asientos; i++) {
          const b = {
            folio: folioNuevo(db.boletos.length + 1),
            eventoId: venta.eventoId,
            ventaId: venta.id,
            nombre: venta.nombre,
            contacto: venta.contacto,
            telefono: venta.telefono || "",
            metodo: "Mercado Pago",
            precio: m.precioPersona,
            zonaId: m.zonaId,
            zona: m.zonaNombre,
            ...(m.area ? { area: m.area } : {}),
            mesa: m.mesaId,
            mesaId: m.mesaId,
            estado: "valido",
            creado: new Date().toISOString(),
            usadoEn: null,
          };
          db.boletos.push(b);
          nuevos.push(b);
        }
      }
    }
    if (conAsientos) {
      // Asientos sueltos (mesa compartida): un boleto por asiento, con su número.
      // Igual que con las mesas: si el asiento ya se le dio a otra persona por
      // una demora larga, se emite el boleto (el pago ya está hecho) y queda el
      // aviso en el Panel para resolverlo a mano.
      const otros = db.boletos.filter((b) => b.eventoId === venta.eventoId && b.mesaId && b.ventaId !== venta.id);
      for (const a of venta.asientos) {
        const choca = otros.some((b) => String(b.mesaId) === String(a.mesaId) && (!b.asiento || Number(b.asiento) === Number(a.asiento)));
        if (choca) venta.conflictoMesas = [...(venta.conflictoMesas || []), `${a.mesaId} (asiento ${a.asiento})`];
        const b = {
          folio: folioNuevo(db.boletos.length + 1),
          eventoId: venta.eventoId,
          ventaId: venta.id,
          nombre: venta.nombre,
          contacto: venta.contacto,
          telefono: venta.telefono || "",
          metodo: "Mercado Pago",
          precio: a.precioPersona,
          zonaId: a.zonaId,
          zona: a.zonaNombre,
          ...(a.area ? { area: a.area } : {}),
          mesa: a.mesaId,
          mesaId: a.mesaId,
          asiento: a.asiento,
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
// Se le contesta "OK" a Mercado Pago solo DESPUÉS de guardar los boletos. Si
// algo falla (Mercado Pago no responde, no se pudo guardar), se contesta con
// error y Mercado Pago vuelve a mandar el aviso más tarde; antes se contestaba
// "OK" de entrada y, si fallaba, el pago se quedaba sin boletos hasta que
// alguien usara "Revisar con Mercado Pago". Repetir el aviso no duplica
// boletos: aplicarPagoAprobado() no hace nada si la venta ya está pagada.
app.post("/api/webhook/mercadopago", seguro(async (req, res) => {
  const tipo = req.query.type || req.body?.type;
  if (tipo !== "payment") return res.sendStatus(200);

  // Sin MP_WEBHOOK_SECRET no se puede saber si el aviso es de Mercado Pago,
  // así que se rechaza (antes se aceptaba). Los pagos se pueden confirmar
  // igual con "Revisar con Mercado Pago" mientras se configura.
  if (!verificarFirma(req)) {
    console.warn(MP_WEBHOOK_SECRET ? "Webhook con firma inválida, se ignora." : "Webhook rechazado: falta MP_WEBHOOK_SECRET.");
    return res.sendStatus(401);
  }

  const paymentId = req.query["data.id"] || req.body?.data?.id;
  if (!paymentId) return res.sendStatus(200);

  let resultado;
  let pago;
  try {
    const paymentApi = new Payment(mpClient);
    pago = await paymentApi.get({ id: paymentId });
    if (pago.status !== "approved") return res.sendStatus(200);
    resultado = await aplicarPagoAprobado(pago.external_reference, pago);
  } catch (err) {
    console.error("Error procesando webhook (Mercado Pago lo reintentará):", err);
    return res.sendStatus(500);
  }
  res.sendStatus(200);

  // Lo que sigue va después de contestar, para no hacer esperar a Mercado Pago.
  if (resultado?.ventaNoEncontrada) {
    // Pago aprobado que no corresponde a ninguna venta: no se emitieron
    // boletos. Sin external_reference no es de este sitio (por ejemplo, un
    // cobro hecho con la misma cuenta por otro medio); con uno, hay que revisarlo.
    console.error("Pago aprobado sin venta:", pago.id, pago.external_reference);
    if (pago.external_reference) {
      avisarPorCorreo(
        "⚠️ massticket: pago aprobado sin venta",
        `<p>Mercado Pago aprobó el pago <strong>${escaparHtml(pago.id)}</strong>
          (${escaparHtml(pago.transaction_amount)} ${escaparHtml(pago.currency_id)}) con la referencia
          <code>${escaparHtml(pago.external_reference)}</code>, pero no existe ninguna venta con esa referencia,
          así que <strong>no se emitieron boletos</strong>.</p>
          <p>Búscalo en Mercado Pago para saber quién pagó y, si corresponde, hazle una venta manual o devuélvele el dinero.</p>`
      );
    }
  } else if (resultado?.evento && resultado.boletos?.length) {
    enviarBoletosPorEmail({
      evento: resultado.evento,
      nombre: resultado.nombre,
      contacto: resultado.contacto,
      boletos: resultado.boletos,
    });
  }
}));

// Las compras pendientes de más de DIAS_PENDIENTES_VIGENTES días son compras
// abandonadas (con tarjeta el pago se aprueba en minutos y ya no se ofrece
// OXXO/SPEI): no se vuelven a revisar ni se cuentan en el Panel. Se quedan
// guardadas como estaban, y si de verdad llegara su pago, el webhook lo aplica igual.
const DIAS_PENDIENTES_VIGENTES = 7;
function pendienteVigente(v, ahora = Date.now()) {
  if (v.estado !== "pendiente") return false;
  const creado = v.creado ? new Date(v.creado).getTime() : 0;
  return ahora - creado < DIAS_PENDIENTES_VIGENTES * 24 * 3600 * 1000;
}

// -------- Admin: revisar con Mercado Pago las ventas "pendientes" --------
// Por si el aviso automático (webhook) nunca llegó -por ejemplo si el sitio
// estaba caído justo en ese momento-, esto le pregunta a Mercado Pago,
// venta por venta, si en realidad ya está aprobada. Las que sí lo están se
// confirman aquí también: se emiten sus boletos y se manda el correo con el
// PDF, exactamente igual que si el webhook hubiera funcionado a tiempo.
app.post("/api/admin/reconciliar-pagos", requiereAdmin, seguro(async (req, res) => {
  try {
    const db = await leerDB();
    const pendientes = db.ventas.filter((v) => pendienteVigente(v));
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
}));

// -------- Admin: venta manual (efectivo/cortesía/promoción en puerta) --------
// Revisa los lugares pedidos de una venta manual o de un apartado y arma el
// "plan": un elemento por boleto que se va a emitir. Devuelve { plan, asientos }
// o { status, error } si algo ya no está disponible.
function armarPlanManual(db, evento, { mesas, asientos, cantidad, zonaId }) {
  const plan = [];
  const mapa = mapaDe(evento);
  let asientosManual = [];
  const mesasPedidas = Array.isArray(mesas) ? [...new Set(mesas.map(String))] : [];
  if (mapa) {
    // Evento con mesas: mesas completas (un boleto por asiento) y/o asientos
    // sueltos de las mesas que se venden por asiento.
    const revision = revisarAsientosPedidos(db, evento, mapa, asientos, { max: 100 });
    if (revision.error) return revision;
    asientosManual = revision.asientos;
    if (!mesasPedidas.length && !asientosManual.length) return { status: 400, error: "Elige al menos una mesa o un asiento." };
    const estado = estadoMesas(db, evento);
    const porAsiento = mesasPorAsiento(evento);
    for (const id of mesasPedidas) {
      const mesa = mapa.mesas.find((m) => m.id === id);
      if (!mesa) return { status: 400, error: `La mesa ${id} no existe.` };
      if (porAsiento.has(id)) return { status: 409, error: `La mesa ${id} se vende por asiento: elige los asientos.` };
      if (estado.has(id)) return { status: 409, error: `La mesa ${id} ya no está disponible (${estado.get(id)}).` };
      const z = zonasDe(evento).find((x) => x.id === mesa.seccion);
      const pp = z ? precioPorBoleto(z) : 0;
      for (let i = 0; i < mesa.asientos; i++) {
        plan.push({ zonaId: mesa.seccion, zona: z?.nombre || mesa.seccion, area: mesa.area, mesa: id, base: pp });
      }
    }
    for (const a of asientosManual) {
      plan.push({ zonaId: a.zonaId, zona: a.zonaNombre, area: a.area, mesa: a.mesaId, asiento: a.asiento, base: a.precioPersona });
    }
  } else {
    // Si el evento tiene zonas, hay que elegir una; "cantidad" son boletos
    // (personas) y el precio normal es el de un boleto individual de la zona.
    const zonasEv = zonasDe(evento);
    let zona = null;
    if (zonasEv.length) {
      zona = zonasEv.find((z) => z.id === zonaId);
      if (!zona) return { status: 400, error: "Elige la zona." };
      if (ocupadosZona(db, evento.id, zona.id) + cantidad > zona.cupo) {
        return { status: 409, error: `Ya no hay lugares suficientes en ${zona.nombre}.` };
      }
    }
    const base = zona ? precioPorBoleto(zona) : Number(evento.precio) || 0;
    for (let i = 0; i < cantidad; i++) {
      plan.push({ zonaId: zona?.id, zona: zona?.nombre, mesa: null, base });
    }
  }
  if (ocupadosDe(db, evento.id) + plan.length > evento.cupo) return { status: 409, error: "Ya no hay cupo" };
  return { plan, asientos: asientosManual };
}

// Emite un boleto por cada elemento del plan (cada uno ya trae su precio).
function emitirBoletosManuales(db, { eventoId, ventaId, nombre, contacto, telefono, metodo, plan }) {
  const nuevos = [];
  for (const p of plan) {
    const b = {
      folio: folioNuevo(db.boletos.length + 1),
      eventoId,
      ventaId,
      nombre,
      contacto,
      telefono,
      metodo,
      precio: p.precio,
      ...(p.zonaId ? { zonaId: p.zonaId, zona: p.zona } : {}),
      ...(p.area ? { area: p.area } : {}),
      ...(p.mesa ? { mesa: p.mesa, mesaId: p.mesa } : {}),
      ...(p.asiento ? { asiento: p.asiento } : {}),
      estado: "valido",
      creado: new Date().toISOString(),
      usadoEn: null,
    };
    db.boletos.push(b);
    nuevos.push(b);
  }
  return nuevos;
}

app.post("/api/ventas-manuales", requiereAdmin, seguro(async (req, res) => {
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
  // que se haya escrito aquí. Es precio por boleto (por persona).
  const precioManualTexto = String(req.body?.precioManual ?? "").trim();
  const precioManual = precioManualTexto === "" ? null : Math.max(0, Number(precioManualTexto) || 0);

  let eventoParaCorreo, boletosParaCorreo, ventaIdManual = null;
  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === eventoId);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });

    const armado = armarPlanManual(db, evento, { mesas: req.body?.mesas, asientos: req.body?.asientos, cantidad, zonaId });
    if (armado.error) return res.status(armado.status).json({ error: armado.error });
    const mapa = mapaDe(evento);
    const precioDe = (p) => (metodo === "Cortesía" ? 0 : precioManual !== null ? precioManual : p.base);
    const plan = armado.plan.map((p) => ({ ...p, precio: precioDe(p) }));
    const asientosManual = armado.asientos;

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
      cantidad: plan.length,
      precioUnit: plan[0].precio,
      ...(mapa ? { mesas: [...new Set(plan.filter((p) => !p.asiento).map((p) => p.mesa))].map((m) => ({ mesaId: m })) } : {}),
      ...(asientosManual.length ? { asientos: asientosManual.map((a) => ({ mesaId: a.mesaId, asiento: a.asiento })) } : {}),
      estado: "pagado",
      manual: true,
      metodo,
      creado: new Date().toISOString(),
    });
    const nuevos = emitirBoletosManuales(db, { eventoId, ventaId: ventaIdManual, nombre, contacto, telefono, metodo, plan });
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
}));

// -------- Admin: apartados con anticipo (arreglados por WhatsApp) --------
// El organizador registra el apartado cuando ya recibió el anticipo. Los
// lugares quedan tomados hasta la fecha límite; al liquidar se emiten los
// boletos. Si vence sin liquidar, los lugares se liberan solos y el
// anticipo no se devuelve (no pasa por Mercado Pago).
const redondear = (n) => Math.round(n * 100) / 100;
function textoLugares(plan) {
  const mesas = new Map(), sueltos = new Map(), zonas = new Map();
  for (const p of plan) {
    if (p.mesa && p.asiento) {
      if (!sueltos.has(p.mesa)) sueltos.set(p.mesa, { area: p.area || p.zona, nums: [] });
      sueltos.get(p.mesa).nums.push(p.asiento);
    } else if (p.mesa) {
      if (!mesas.has(p.mesa)) mesas.set(p.mesa, { area: p.area || p.zona, n: 0 });
      mesas.get(p.mesa).n++;
    } else {
      const k = p.zona || "";
      zonas.set(k, (zonas.get(k) || 0) + 1);
    }
  }
  return [
    ...[...mesas].map(([id, m]) => `Mesa ${id} (${m.area}, ${m.n} personas)`),
    ...[...sueltos].map(([id, m]) => `Mesa ${id} (${m.area}), asiento${m.nums.length > 1 ? "s" : ""} ${m.nums.join(", ")}`),
    ...[...zonas].map(([z, n]) => `${n} boleto${n > 1 ? "s" : ""}${z ? " de " + z : ""}`),
  ].join(" · ");
}
// ¿Siguen libres los lugares de un apartado ya vencido? (para liquidarlo o
// darle más tiempo). Como ya venció, sus propios lugares no cuentan.
function revisarApartadoVencido(db, evento, v) {
  const mapa = mapaDe(evento);
  if (mapa) {
    const estado = estadoMesas(db, evento);
    const porAsiento = mesasPorAsiento(evento);
    for (const m of v.mesas || []) {
      if (!mapa.mesas.some((x) => String(x.id) === String(m.mesaId))) return `La mesa ${m.mesaId} ya no existe en el mapa.`;
      if (porAsiento.has(String(m.mesaId))) return `La mesa ${m.mesaId} ahora se vende por asiento.`;
      if (estado.has(String(m.mesaId))) return `La mesa ${m.mesaId} ya se vendió o apartó a otra persona.`;
    }
    if ((v.asientos || []).length) {
      const ocupados = estadoAsientos(db, evento, mapa);
      for (const a of v.asientos) {
        if (!porAsiento.has(String(a.mesaId))) return `La mesa ${a.mesaId} ahora se vende completa.`;
        if (ocupados.get(String(a.mesaId))?.has(Number(a.asiento))) return `El asiento ${a.asiento} de la mesa ${a.mesaId} ya se vendió o apartó a otra persona.`;
      }
    }
  } else {
    for (const l of v.lineas || []) {
      const z = zonasDe(evento).find((x) => x.id === l.zonaId);
      if (!z) return "La zona de este apartado ya no existe.";
      if (ocupadosZona(db, evento.id, z.id) + l.cantidad * l.personas > z.cupo) return `Ya no hay lugares suficientes en ${z.nombre}.`;
    }
  }
  if (ocupadosDe(db, evento.id) + v.cantidad > evento.cupo) return "Ya no hay cupo.";
  return null;
}
function resumenApartado(v, ahora = Date.now()) {
  const estado = v.estado === "apartado" ? (retieneLugar(v, ahora) ? "vigente" : "vencido")
    : v.estado === "cancelado" ? "cancelado" : "liquidado";
  return {
    id: v.id, nombre: v.nombre, contacto: v.contacto || "", telefono: v.telefono || "",
    lugares: textoLugares(v.plan || []), boletos: v.cantidad,
    total: v.total, anticipo: v.anticipo, metodoAnticipo: v.metodoAnticipo, resto: redondear(v.total - v.anticipo),
    venceDia: v.venceDia, creado: v.creado, estado,
    ...(v.liquidado ? { liquidado: v.liquidado, metodo: v.metodo } : {}),
    ...(v.cancelado ? { cancelado: v.cancelado } : {}),
  };
}
function validarVence(texto, evento, hoy = hoyMX()) {
  if (!esFechaDia(texto)) return "La fecha límite no es válida.";
  if (texto < hoy) return "La fecha límite ya pasó.";
  if (esFechaDia(evento.fecha) && texto > evento.fecha) return "La fecha límite no puede ser después del evento.";
  return null;
}

app.get("/api/apartados", requiereAdmin, seguro(async (req, res) => {
  const db = await leerDB();
  const eventoId = String(req.query.eventoId || "");
  const evento = db.eventos.find((e) => e.id === eventoId);
  if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
  const orden = { vigente: 0, vencido: 1, liquidado: 2, cancelado: 3 };
  const apartados = db.ventas
    .filter((v) => v.eventoId === eventoId && v.apartado)
    .map((v) => resumenApartado(v))
    .sort((a, b) => orden[a.estado] - orden[b.estado] || String(a.venceDia).localeCompare(String(b.venceDia)));
  res.json({ apartados, info: infoApartado(evento), evento: { nombre: evento.nombre, fecha: evento.fecha } });
}));

app.post("/api/apartados", requiereAdmin, seguro(async (req, res) => {
  const eventoId = String(req.body?.eventoId || "");
  const nombre = String(req.body?.nombre || "").trim();
  const contacto = String(req.body?.contacto || "").trim();
  const telefono = String(req.body?.telefono || "").trim();
  const cantidad = Math.max(1, Math.min(100, parseInt(req.body?.cantidad) || 1));
  const zonaId = String(req.body?.zonaId || "");
  const metodoAnticipo = String(req.body?.metodoAnticipo || "Transferencia");
  if (!nombre) return res.status(400).json({ error: "Falta el nombre" });
  if (metodoAnticipo === "Cortesía") return res.status(400).json({ error: "Un apartado necesita un anticipo pagado; las cortesías se registran como venta." });
  const precioManualTexto = String(req.body?.precioManual ?? "").trim();
  const precioManual = precioManualTexto === "" ? null : Math.max(0, Number(precioManualTexto) || 0);
  const anticipoTexto = String(req.body?.anticipo ?? "").trim();

  await conCandado(async () => {
    const db = await leerDB();
    const evento = db.eventos.find((e) => e.id === eventoId);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    const hoy = hoyMX();
    if (esFechaDia(evento.fecha) && evento.fecha < hoy) return res.status(409).json({ error: "Ese evento ya pasó." });

    const armado = armarPlanManual(db, evento, { mesas: req.body?.mesas, asientos: req.body?.asientos, cantidad, zonaId });
    if (armado.error) return res.status(armado.status).json({ error: armado.error });
    const plan = armado.plan.map((p) => ({ ...p, precio: precioManual !== null ? precioManual : p.base }));
    const total = redondear(plan.reduce((t, p) => t + p.precio, 0));
    if (total <= 0) return res.status(400).json({ error: "El total es $0; regístralo como venta (cortesía)." });
    const anticipo = anticipoTexto === "" ? redondear(total / 2) : redondear(Number(anticipoTexto));
    if (!(anticipo > 0)) return res.status(400).json({ error: "Escribe el anticipo recibido." });
    if (anticipo >= total) return res.status(400).json({ error: "Si ya pagó todo, regístralo como venta y no como apartado." });

    const venceTexto = String(req.body?.vence || "").trim();
    const venceDia = venceTexto || infoApartado(evento, hoy).vence || sumarDias(hoy, DIAS_PARA_LIQUIDAR);
    const errVence = validarVence(venceDia, evento, hoy);
    if (errVence) return res.status(400).json({ error: errVence });

    // Forma de "retener lugares" igual que una compra pendiente, para que el
    // mapa, el cupo y las zonas los cuenten como tomados mientras esté vigente.
    const mesas = new Map();
    for (const p of plan) {
      if (!p.mesa || p.asiento) continue;
      if (!mesas.has(p.mesa)) mesas.set(p.mesa, { mesaId: p.mesa, zonaId: p.zonaId, asientos: 0 });
      mesas.get(p.mesa).asientos++;
    }
    const asientos = plan.filter((p) => p.asiento).map((p) => ({ mesaId: p.mesa, asiento: p.asiento, zonaId: p.zonaId }));
    const sinMesa = plan.filter((p) => !p.mesa);
    const lineas = sinMesa.length && sinMesa[0].zonaId ? [{ zonaId: sinMesa[0].zonaId, cantidad: sinMesa.length, personas: 1 }] : [];

    const v = {
      id: uuid(),
      eventoId,
      nombre,
      contacto,
      telefono,
      cantidad: plan.length,
      precioUnit: plan[0].precio,
      ...(mesas.size ? { mesas: [...mesas.values()] } : {}),
      ...(asientos.length ? { asientos } : {}),
      ...(lineas.length ? { lineas } : {}),
      plan,
      total,
      anticipo,
      metodoAnticipo,
      estado: "apartado",
      apartado: true,
      venceDia,
      vence: finDelDiaMX(venceDia),
      creado: new Date().toISOString(),
    };
    db.ventas.push(v);
    await escribirDB(db);
    res.json({ apartado: resumenApartado(v), evento: { nombre: evento.nombre, fecha: evento.fecha } });
  });
}));

app.post("/api/apartados/:id/liquidar", requiereAdmin, seguro(async (req, res) => {
  const metodo = String(req.body?.metodo || "Efectivo");
  let eventoParaCorreo, boletosParaCorreo, venta;
  await conCandado(async () => {
    const db = await leerDB();
    venta = db.ventas.find((v) => v.id === req.params.id && v.apartado);
    if (!venta) return res.status(404).json({ error: "Apartado no encontrado" });
    if (venta.estado !== "apartado") return res.status(409).json({ error: venta.estado === "cancelado" ? "Este apartado se canceló." : "Este apartado ya se liquidó." });
    const evento = db.eventos.find((e) => e.id === venta.eventoId);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });

    // Nunca emitir dos veces la misma mesa o asiento: si ya hay boletos de
    // otra venta en esos lugares (algo raro, como un pago muy tardío), se avisa.
    const ajenos = db.boletos.filter((b) => b.eventoId === evento.id && b.mesaId && b.ventaId !== venta.id);
    for (const p of venta.plan || []) {
      if (!p.mesa) continue;
      const choca = ajenos.find((b) => String(b.mesaId) === String(p.mesa) && (!p.asiento || !b.asiento || Number(b.asiento) === Number(p.asiento)));
      if (choca) return res.status(409).json({ error: `La mesa ${p.mesa} ya tiene boletos de otra venta. Revísalo antes de liquidar.` });
    }
    if (!retieneLugar(venta)) {
      const err = revisarApartadoVencido(db, evento, venta);
      if (err) return res.status(409).json({ error: `Este apartado ya venció y no se puede liquidar: ${err}` });
    }

    const nuevos = emitirBoletosManuales(db, {
      eventoId: evento.id, ventaId: venta.id, nombre: venta.nombre, contacto: venta.contacto, telefono: venta.telefono,
      metodo: `Apartado · ${metodo}`, plan: venta.plan,
    });
    venta.estado = "pagado";
    venta.manual = true;
    venta.metodo = metodo;
    venta.liquidado = new Date().toISOString();
    await escribirDB(db);
    eventoParaCorreo = evento;
    boletosParaCorreo = nuevos;
    res.json({ boletos: nuevos, ventaId: venta.id, evento: { nombre: evento.nombre, fecha: evento.fecha }, urlBoletos: `${PUBLIC_URL}/gracias.html?venta=${venta.id}` });
  });
  if (eventoParaCorreo && boletosParaCorreo) {
    enviarBoletosPorEmail({ evento: eventoParaCorreo, nombre: venta.nombre, contacto: venta.contacto, boletos: boletosParaCorreo });
  }
}));

app.put("/api/apartados/:id/plazo", requiereAdmin, seguro(async (req, res) => {
  await conCandado(async () => {
    const db = await leerDB();
    const venta = db.ventas.find((v) => v.id === req.params.id && v.apartado);
    if (!venta) return res.status(404).json({ error: "Apartado no encontrado" });
    if (venta.estado !== "apartado") return res.status(409).json({ error: "Solo se puede cambiar el plazo de un apartado sin liquidar." });
    const evento = db.eventos.find((e) => e.id === venta.eventoId);
    if (!evento) return res.status(404).json({ error: "Evento no encontrado" });
    const venceDia = String(req.body?.vence || "").trim();
    const errVence = validarVence(venceDia, evento);
    if (errVence) return res.status(400).json({ error: errVence });
    if (!retieneLugar(venta)) {
      const err = revisarApartadoVencido(db, evento, venta);
      if (err) return res.status(409).json({ error: `No se puede reactivar: ${err}` });
    }
    venta.venceDia = venceDia;
    venta.vence = finDelDiaMX(venceDia);
    await escribirDB(db);
    res.json({ apartado: resumenApartado(venta) });
  });
}));

app.post("/api/apartados/:id/cancelar", requiereAdmin, seguro(async (req, res) => {
  await conCandado(async () => {
    const db = await leerDB();
    const venta = db.ventas.find((v) => v.id === req.params.id && v.apartado);
    if (!venta) return res.status(404).json({ error: "Apartado no encontrado" });
    if (venta.estado !== "apartado") return res.status(409).json({ error: "Este apartado ya no se puede cancelar." });
    venta.estado = "cancelado";
    venta.cancelado = new Date().toISOString();
    await escribirDB(db);
    res.json({ apartado: resumenApartado(venta) });
  });
}));

// -------- Admin: clientes (junta todos los boletos por comprador) --------
// Agrupa por correo si hay uno; si no, por teléfono; si tampoco hay eso,
// por nombre (mejor esfuerzo -dos personas con el mismo nombre y sin
// correo ni teléfono se verían como una sola, pero es un caso raro).
app.get("/api/clientes", requiereAdmin, seguro(async (req, res) => {
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
}));

// -------- Admin: listar boletos (opcionalmente filtrados por evento) --------
app.get("/api/boletos", requiereAdmin, seguro(async (req, res) => {
  const db = await leerDB();
  const { eventoId } = req.query;
  const lista = eventoId ? db.boletos.filter((b) => b.eventoId === eventoId) : db.boletos;
  // Cada boleto lleva el resultado del correo de su venta (no se guarda en el boleto).
  const correoDe = new Map(db.ventas.filter((v) => v.correo).map((v) => [v.id, v.correo]));
  res.json(lista.map((b) => (correoDe.has(b.ventaId) ? { ...b, correo: correoDe.get(b.ventaId) } : b)));
}));

// -------- Admin: reenviar por correo los boletos de una venta --------
// Por si el correo no llegó (falló el envío, o el cliente escribió mal su
// correo). Se puede mandar a un correo corregido: en ese caso también se
// actualiza el contacto de la venta y de sus boletos.
app.post("/api/admin/reenviar-correo", requiereAdmin, seguro(async (req, res) => {
  if (!resend) return res.status(400).json({ error: "El envío de correos no está configurado (falta RESEND_API_KEY)." });
  const ventaId = String(req.body?.ventaId || "");
  const nuevoCorreo = String(req.body?.correo || "").trim();
  if (nuevoCorreo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nuevoCorreo)) {
    return res.status(400).json({ error: "Ese correo no parece válido." });
  }
  let datos = null;
  let falla = null;
  await conCandado(async () => {
    const db = await leerDB();
    const venta = db.ventas.find((v) => v.id === ventaId);
    if (!venta) { falla = { status: 404, error: "Venta no encontrada." }; return; }
    const boletos = db.boletos.filter((b) => b.ventaId === venta.id);
    if (!boletos.length) { falla = { status: 409, error: "Esta venta todavía no tiene boletos." }; return; }
    if (nuevoCorreo && nuevoCorreo !== venta.contacto) {
      venta.contacto = nuevoCorreo;
      for (const b of boletos) b.contacto = nuevoCorreo;
      await escribirDB(db);
    }
    if (!String(venta.contacto || "").includes("@")) { falla = { status: 400, error: "Esta venta no tiene correo. Escribe uno." }; return; }
    datos = { evento: db.eventos.find((e) => e.id === venta.eventoId) || null, nombre: venta.nombre, contacto: venta.contacto, boletos };
  });
  if (falla) return res.status(falla.status).json({ error: falla.error });
  await enviarBoletosPorEmail(datos);
  const db = await leerDB();
  const correo = db.ventas.find((v) => v.id === ventaId)?.correo || null;
  if (correo?.estado !== "enviado") return res.status(502).json({ error: "No se pudo enviar: " + (correo?.error || "error desconocido"), correo });
  res.json({ ok: true, correo });
}));

// -------- Puerta: validar folio (admin) --------
app.post("/api/validar", requiereAdmin, seguro(async (req, res) => {
  const folio = String(req.body?.folio || "").trim().toUpperCase();
  // Evento que se está revisando en la puerta. Un boleto de otro evento (por
  // ejemplo, uno más barato o uno que ya pasó) no deja entrar ni se marca
  // como usado. Si no viene (una pestaña del panel abierta desde antes de
  // este cambio), se valida como antes, sin revisar el evento.
  const eventoId = String(req.body?.eventoId || "");
  await conCandado(async () => {
    const db = await leerDB();
    const b = db.boletos.find((x) => x.folio === folio);
    if (!b) return res.status(404).json({ resultado: "no_existe" });
    if (eventoId && b.eventoId !== eventoId) {
      const suEvento = db.eventos.find((e) => e.id === b.eventoId);
      return res.status(409).json({
        resultado: "otro_evento",
        nombre: b.nombre,
        evento: suEvento?.nombre || "un evento que ya no existe",
        fecha: suEvento?.fecha || "",
      });
    }
    if (b.estado === "usado") {
      return res.json({ resultado: "repetido", nombre: b.nombre, usadoEn: b.usadoEn, zona: b.area || b.zona || "", mesa: b.mesa || "", asiento: b.asiento || "" });
    }
    b.estado = "usado";
    b.usadoEn = new Date().toISOString();
    await escribirDB(db);
    res.json({ resultado: "ok", nombre: b.nombre, folio: b.folio, zona: b.area || b.zona || "", mesa: b.mesa || "", asiento: b.asiento || "" });
  });
}));

// -------- Panel (admin), opcionalmente filtrado por evento --------
app.get("/api/panel", requiereAdmin, seguro(async (req, res) => {
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

  // Mesas vendidas (eventos con mapa) y avisos de mesas repetidas.
  let mesasInfo;
  if (eventoId) {
    const ev = db.eventos.find((e) => e.id === eventoId);
    const mp = mapaDe(ev);
    if (mp) {
      mesasInfo = {
        vendidas: new Set(boletos.filter((b) => b.mesaId && !b.asiento).map((b) => String(b.mesaId))).size,
        total: mp.mesas.length,
        asientosSueltos: boletos.filter((b) => b.mesaId && b.asiento).length,
        porAsiento: mesasPorAsiento(ev).size,
      };
    }
  }
  const conflictos = ventas
    .filter((v) => Array.isArray(v.conflictoMesas) && v.conflictoMesas.length)
    .map((v) => ({ nombre: v.nombre, mesas: v.conflictoMesas }));

  res.json({
    vendidos: boletos.length,
    usados,
    ingresos,
    cupo,
    porMetodo,
    ...(mesasInfo ? { mesas: mesasInfo } : {}),
    ...(conflictos.length ? { conflictos } : {}),
    correosFallidos: ventas.filter((v) => v.correo?.estado === "fallo").length,
    ...(porZona ? { porZona } : {}),
    pendientesDePago: ventas.filter((v) => pendienteVigente(v)).length,
  });
}));

// -------- Admin: descargar respaldo completo de db.json --------
app.get("/api/admin/respaldo", requiereAdmin, seguro(async (req, res) => {
  try {
    const texto = await textoDB();
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="massticket-respaldo-${hoyMX()}.json"`);
    res.set("Cache-Control", "no-store");
    res.send(texto);
  } catch (err) {
    console.error("Error descargando respaldo:", err);
    res.status(500).json({ error: "No se pudo generar el respaldo." });
  }
}));

// Manejador de errores: va al final, después de todas las rutas. Los errores
// de la petición (JSON mal formado, cuerpo demasiado grande) conservan su
// código 4xx; cualquier otro se registra y se contesta 500.
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(`Error en ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status === 500 ? "Ocurrió un error en el servidor. Intenta de nuevo." : "Petición no válida." });
});

// Último recurso: un error que se escape de todo lo anterior se registra en
// lugar de apagar el servidor.
process.on("unhandledRejection", (err) => {
  console.error("Error no atrapado (el servidor sigue funcionando):", err);
});

// Antes de abrir el sitio se revisa que db.json se pueda leer; si está
// dañado, queda en mantenimiento desde el principio (ver marcarDBDañada).
await leerDB().catch(() => {});

app.listen(PORT, () => {
  console.log(`massticket backend escuchando en el puerto ${PORT}`);
  console.log(`URL pública configurada: ${PUBLIC_URL}`);
});

// El respaldo extra va después del diario para no mandar dos correos juntos a las 6:00 am.
const respaldos = async () => { await respaldoDiario(); await respaldoDiaDeEvento(); };
setTimeout(respaldos, 60 * 1000);
setInterval(respaldos, 15 * 60 * 1000);
