// Panel del organizador: venta manual, correos (y reenvío) y apartados con anticipo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancarServidor, esperarQue, mesasDelMapa } from "./ayudantes.js";

let s;
before(async () => { s = await arrancarServidor(); });
after(async () => { await s.detener(); });

const ventaManual = (cuerpo) => s.pedir("/api/ventas-manuales", { metodo: "POST", admin: true, cuerpo: { nombre: "Caro", ...cuerpo } });
const apartar = (cuerpo) => s.pedir("/api/apartados", { metodo: "POST", admin: true, cuerpo: { nombre: "Dani", telefono: "8111111111", ...cuerpo } });
const correoDeVenta = (ventaId) => s.leerDB().ventas.find((v) => v.id === ventaId)?.correo;

test("venta manual: emite boletos al precio del evento y respeta el cupo", async () => {
  const ev = await s.crearEvento({ precio: 150, cupo: 3 });
  const r = await ventaManual({ eventoId: ev.id, cantidad: 2, metodo: "Efectivo" });
  assert.equal(r.status, 200);
  assert.equal(r.datos.boletos.length, 2);
  assert.ok(r.datos.boletos.every((b) => b.precio === 150 && b.metodo === "Efectivo"));
  assert.equal((await ventaManual({ eventoId: ev.id, cantidad: 2 })).status, 409);
});

test("venta manual: la cortesía siempre es gratis y el precio especial se respeta", async () => {
  const ev = await s.crearEvento({ precio: 150 });
  const cortesia = await ventaManual({ eventoId: ev.id, cantidad: 1, metodo: "Cortesía", precioManual: "99" });
  assert.equal(cortesia.datos.boletos[0].precio, 0);
  const promo = await ventaManual({ eventoId: ev.id, cantidad: 1, metodo: "Efectivo", precioManual: "120" });
  assert.equal(promo.datos.boletos[0].precio, 120);
});

test("correo: se registra si se envió, el Panel avisa si falló y se puede reenviar a un correo corregido", async () => {
  const ev = await s.crearEvento();
  const r = await ventaManual({ eventoId: ev.id, cantidad: 2, contacto: "falla@prueba.mx" });
  const ventaId = r.datos.ventaId;
  assert.ok(await esperarQue(() => correoDeVenta(ventaId)?.estado === "fallo"));
  const panel = await s.pedir("/api/panel?eventoId=" + ev.id, { admin: true });
  assert.equal(panel.datos.correosFallidos, 1);

  const mal = await s.pedir("/api/admin/reenviar-correo", { metodo: "POST", admin: true, cuerpo: { ventaId, correo: "no-es-correo" } });
  assert.equal(mal.status, 400);
  const bien = await s.pedir("/api/admin/reenviar-correo", { metodo: "POST", admin: true, cuerpo: { ventaId, correo: "caro@prueba.mx" } });
  assert.equal(bien.status, 200);
  assert.equal(correoDeVenta(ventaId).estado, "enviado");
  const boletos = await s.pedir("/api/boletos?eventoId=" + ev.id, { admin: true });
  assert.ok(boletos.datos.every((b) => b.contacto === "caro@prueba.mx" && b.correo.estado === "enviado"));
  assert.equal((await s.pedir("/api/panel?eventoId=" + ev.id, { admin: true })).datos.correosFallidos, 0);
});

test("correo: el nombre del cliente se escapa en el HTML del correo", async () => {
  const ev = await s.crearEvento();
  await ventaManual({ eventoId: ev.id, cantidad: 1, nombre: "<b>Pepe</b>", contacto: "pepe@prueba.mx" });
  assert.ok(await esperarQue(() => s.registro("correo").some((c) => c.para === "pepe@prueba.mx")));
  const html = s.registro("correo").find((c) => c.para === "pepe@prueba.mx").html;
  assert.ok(html.includes("&lt;b&gt;Pepe&lt;/b&gt;"));
  assert.ok(!html.includes("<b>Pepe</b>"));
});

// Apartados con anticipo (eventos con mapa de mesas).
const MAPA = "la-comedia-show-live";
const deCuatro = mesasDelMapa(MAPA).filter((m) => m.asientos === 4).map((m) => m.id);
const precios = [...new Set(mesasDelMapa(MAPA).map((m) => m.seccion))].map((id) => ({ id, precio: 200 }));

test("apartado: aparta la mesa (nadie más la puede comprar) y calcula anticipo y resto", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const r = await apartar({ eventoId: ev.id, mesas: [deCuatro[0]] });
  assert.equal(r.status, 200);
  assert.equal(r.datos.apartado.total, 800);
  assert.equal(r.datos.apartado.anticipo, 400, "sin anticipo escrito, se toma el 50%");
  assert.equal(r.datos.apartado.resto, 400);
  assert.equal(r.datos.apartado.estado, "vigente");
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [deCuatro[0]] }, "10.6.0.1")).status, 409);
  assert.equal((await ventaManual({ eventoId: ev.id, mesas: [deCuatro[0]] })).status, 409);
});

test("apartado: al liquidar se emiten sus boletos una sola vez", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const { datos } = await apartar({ eventoId: ev.id, mesas: [deCuatro[1]], anticipo: 300 });
  const id = datos.apartado.id;
  const liq = await s.pedir(`/api/apartados/${id}/liquidar`, { metodo: "POST", admin: true, cuerpo: { metodo: "Transferencia" } });
  assert.equal(liq.status, 200);
  assert.equal(liq.datos.boletos.length, 4);
  assert.ok(liq.datos.boletos.every((b) => b.mesa === deCuatro[1] && b.metodo === "Apartado · Transferencia"));
  const otraVez = await s.pedir(`/api/apartados/${id}/liquidar`, { metodo: "POST", admin: true, cuerpo: { metodo: "Efectivo" } });
  assert.equal(otraVez.status, 409);
  assert.equal(s.leerDB().boletos.filter((b) => b.ventaId === id).length, 4);
});

test("apartado: al cancelarlo la mesa se libera", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const { datos } = await apartar({ eventoId: ev.id, mesas: [deCuatro[2]] });
  assert.equal((await s.pedir(`/api/apartados/${datos.apartado.id}/cancelar`, { metodo: "POST", admin: true })).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [deCuatro[2]] }, "10.6.0.2")).status, 200);
});

test("apartado vencido: libera la mesa y ya no se puede liquidar si se vendió a otra persona", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const { datos } = await apartar({ eventoId: ev.id, mesas: [deCuatro[3]] });
  s.cambiarDB((db) => {
    db.ventas.find((v) => v.id === datos.apartado.id).vence = new Date(Date.now() - 60000).toISOString();
  });
  await s.comprarYPagar({ eventoId: ev.id, mesas: [deCuatro[3]], nombre: "Otra persona" }, "10.6.0.3");
  const liq = await s.pedir(`/api/apartados/${datos.apartado.id}/liquidar`, { metodo: "POST", admin: true, cuerpo: { metodo: "Efectivo" } });
  assert.equal(liq.status, 409);
  const lista = await s.pedir("/api/apartados?eventoId=" + ev.id, { admin: true });
  assert.equal(lista.datos.apartados[0].estado, "vencido");
});

test("apartado: el anticipo debe ser menor que el total y no se aceptan cortesías", async () => {
  const ev = await s.crearEvento({ precio: 100, cupo: 10 });
  assert.equal((await apartar({ eventoId: ev.id, cantidad: 2, anticipo: 200 })).status, 400);
  assert.equal((await apartar({ eventoId: ev.id, cantidad: 2, metodoAnticipo: "Cortesía" })).status, 400);
});

test("apartado: ocupa cupo en un evento de precio único", async () => {
  const ev = await s.crearEvento({ precio: 100, cupo: 3 });
  assert.equal((await apartar({ eventoId: ev.id, cantidad: 2 })).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 2 }, "10.6.0.4")).status, 409);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, "10.6.0.5")).status, 200);
});

test("un evento con boletos o apartados vigentes no se puede borrar", async () => {
  const conBoletos = await s.crearEvento();
  await ventaManual({ eventoId: conBoletos.id, cantidad: 1 });
  assert.equal((await s.pedir("/api/eventos/" + conBoletos.id, { metodo: "DELETE", admin: true })).status, 409);
  const conApartado = await s.crearEvento();
  await apartar({ eventoId: conApartado.id, cantidad: 1 });
  assert.equal((await s.pedir("/api/eventos/" + conApartado.id, { metodo: "DELETE", admin: true })).status, 409);
  const vacio = await s.crearEvento();
  assert.equal((await s.pedir("/api/eventos/" + vacio.id, { metodo: "DELETE", admin: true })).status, 200);
});
