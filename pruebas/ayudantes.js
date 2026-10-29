// Ayudantes de las pruebas: arrancan un servidor de prueba (con datos
// vacíos en una carpeta temporal y Mercado Pago/Resend simulados) y dan
// atajos para comprar, avisar pagos, validar boletos, etc.

import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLAVE = "clave-de-prueba";
export const SECRETO = "secreto-webhook-de-prueba";
export const FECHA_FUTURA = "2030-06-15";

async function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera hasta que "condicion()" sea verdadera (para lo que pasa después de
// contestar, como el correo con los boletos).
export async function esperarQue(condicion, ms = 5000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await condicion()) return true;
    await esperar(50);
  }
  return false;
}

export async function arrancarServidor(entorno = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "massticket-prueba-"));
  const datos = path.join(dir, "datos");
  const archivoPagos = path.join(dir, "pagos.json");
  const archivoRegistro = path.join(dir, "registro.jsonl");
  fs.mkdirSync(datos);
  fs.writeFileSync(archivoPagos, "{}");
  fs.writeFileSync(archivoRegistro, "");
  const puerto = await puertoLibre();
  const url = `http://127.0.0.1:${puerto}`;

  const proceso = spawn(process.execPath, ["--require", path.join(RAIZ, "pruebas", "simulador.cjs"), path.join(RAIZ, "server", "server.js")], {
    cwd: dir, // para que no lea ningún .env real
    env: {
      PATH: process.env.PATH,
      PORT: String(puerto),
      DATA_DIR: datos,
      PUBLIC_URL: url,
      ADMIN_KEY: CLAVE,
      MP_ACCESS_TOKEN: "TEST-simulado",
      MP_WEBHOOK_SECRET: SECRETO,
      RESEND_API_KEY: "re_simulado",
      BACKUP_EMAIL: "dueno@prueba.mx",
      SIM_PAGOS: archivoPagos,
      SIM_REGISTRO: archivoRegistro,
      ...entorno,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proceso.stdout.on("data", (d) => (log += d));
  proceso.stderr.on("data", (d) => (log += d));

  const listo = await esperarQue(async () => {
    try {
      return (await fetch(url + "/api/eventos")).ok;
    } catch {
      return false;
    }
  }, 10000);
  if (!listo) {
    proceso.kill();
    throw new Error("El servidor de prueba no arrancó:\n" + log);
  }

  async function pedir(ruta, { metodo = "GET", cuerpo, admin = false, ip, encabezados = {} } = {}) {
    const r = await fetch(url + ruta, {
      method: metodo,
      headers: {
        "content-type": "application/json",
        ...(admin ? { "x-admin-key": admin === true ? CLAVE : admin } : {}),
        ...(ip ? { "x-real-ip": ip } : {}),
        ...encabezados,
      },
      body: cuerpo === undefined ? undefined : typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
    });
    const texto = await r.text();
    let json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = texto;
    }
    return { status: r.status, datos: json };
  }

  const servidor = {
    url,
    pedir,
    log: () => log,
    rutaDB: path.join(datos, "db.json"),
    leerDB() {
      return JSON.parse(fs.readFileSync(this.rutaDB, "utf8"));
    },
    // Cambia db.json directamente (por ejemplo, para "envejecer" una venta).
    // Solo usarlo entre peticiones, nunca mientras el servidor escribe.
    cambiarDB(fn) {
      const db = this.leerDB();
      fn(db);
      fs.writeFileSync(this.rutaDB, JSON.stringify(db));
    },
    ponerPagos(lista) {
      fs.writeFileSync(archivoPagos, JSON.stringify(Object.fromEntries(lista.map((p) => [String(p.id), p]))));
    },
    registro(tipo) {
      return fs.readFileSync(archivoRegistro, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !tipo || e.tipo === tipo);
    },
    async crearEvento(datos = {}) {
      const r = await pedir("/api/eventos", { metodo: "POST", admin: true, cuerpo: { nombre: "Evento de prueba", fecha: FECHA_FUTURA, precio: 100, cupo: 10, ...datos } });
      if (r.status !== 200) throw new Error("No se pudo crear el evento: " + JSON.stringify(r.datos));
      return r.datos;
    },
    comprar(cuerpo, ip = "10.0.0.1") {
      return pedir("/api/comprar", { metodo: "POST", ip, cuerpo: { nombre: "Ana", contacto: "ana@prueba.mx", ...cuerpo } });
    },
    // Aviso de Mercado Pago firmado como lo firma Mercado Pago.
    avisarPago(paymentId, { firma = true } = {}) {
      const ts = String(Date.now());
      const requestId = crypto.randomUUID();
      const v1 = crypto.createHmac("sha256", SECRETO).update(`id:${String(paymentId).toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");
      return pedir(`/api/webhook/mercadopago?type=payment&data.id=${encodeURIComponent(paymentId)}`, {
        metodo: "POST",
        cuerpo: { type: "payment", data: { id: paymentId } },
        encabezados: { "x-request-id": requestId, ...(firma ? { "x-signature": `ts=${ts},v1=${v1}` } : {}) },
      });
    },
    // Compra completa: crea la venta, Mercado Pago la aprueba y llega el aviso.
    async comprarYPagar(cuerpo, ip) {
      const compra = await this.comprar(cuerpo, ip);
      if (compra.status !== 200) throw new Error("La compra falló: " + JSON.stringify(compra.datos));
      const id = String(Math.floor(Math.random() * 1e9));
      const actuales = JSON.parse(fs.readFileSync(archivoPagos, "utf8"));
      actuales[id] = { id: Number(id), status: "approved", external_reference: compra.datos.ventaId };
      fs.writeFileSync(archivoPagos, JSON.stringify(actuales));
      const aviso = await this.avisarPago(id);
      if (aviso.status !== 200) throw new Error("El aviso de pago falló: " + aviso.status);
      const venta = await pedir("/api/venta/" + compra.datos.ventaId);
      return { ventaId: compra.datos.ventaId, pagoId: id, boletos: venta.datos.boletos };
    },
    // Cambia un pago ya existente en "Mercado Pago" (por ejemplo, a reembolsado).
    actualizarPago(id, cambios) {
      const actuales = JSON.parse(fs.readFileSync(archivoPagos, "utf8"));
      actuales[String(id)] = { ...actuales[String(id)], ...cambios };
      fs.writeFileSync(archivoPagos, JSON.stringify(actuales));
    },
    validar(folio, eventoId) {
      return pedir("/api/validar", { metodo: "POST", admin: true, cuerpo: { folio, ...(eventoId ? { eventoId } : {}) } });
    },
    async detener() {
      proceso.kill();
      await new Promise((r) => (proceso.exitCode !== null ? r() : proceso.once("exit", r)));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return servidor;
}

// Mesas de un mapa, para elegir mesas de cierto tamaño en las pruebas.
export function mesasDelMapa(mapaId) {
  return JSON.parse(fs.readFileSync(path.join(RAIZ, "public", "mapas", mapaId + ".json"), "utf8")).mesas;
}
