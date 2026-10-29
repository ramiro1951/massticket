// Reembolsos, contracargos y cancelación de boletos a mano.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancarServidor, esperarQue, mesasDelMapa } from "./ayudantes.js";

let s;
before(async () => { s = await arrancarServidor(); });
after(async () => { await s.detener(); });

let ipN = 0;
const ip = () => `10.7.0.${++ipN}`;
const correosA = (texto) => s.registro("correo").filter((c) => c.para === "dueno@prueba.mx" && c.asunto.includes(texto));
const cancelar = (folios, motivo) => s.pedir("/api/admin/cancelar-boletos", { metodo: "POST", admin: true, cuerpo: { folios, motivo } });

test("reembolso completo: cancela los boletos, la puerta los rechaza y se avisa al organizador", async () => {
  const ev = await s.crearEvento({ cupo: 2 });
  const { ventaId, pagoId, boletos } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 2, nombre: "Rita" }, ip());
  s.actualizarPago(pagoId, { status: "refunded" });
  assert.equal((await s.avisarPago(pagoId)).status, 200);

  const venta = await s.pedir("/api/venta/" + ventaId);
  assert.equal(venta.datos.estado, "devuelto");
  assert.ok(venta.datos.boletos.every((b) => b.estado === "cancelado" && b.motivoCancelacion === "reembolso"));
  const puerta = await s.validar(boletos[0].folio, ev.id);
  assert.equal(puerta.status, 409);
  assert.equal(puerta.datos.resultado, "cancelado");
  assert.ok(await esperarQue(() => correosA("reembolso de Rita").length === 1));
});

test("reembolso completo: los lugares se liberan y se pueden volver a vender", async () => {
  const ev = await s.crearEvento({ cupo: 2 });
  const { pagoId } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 2 }, ip());
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip())).status, 409, "lleno antes del reembolso");
  s.actualizarPago(pagoId, { status: "refunded" });
  await s.avisarPago(pagoId);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 2 }, ip())).status, 200, "hay lugar otra vez");
  const panel = await s.pedir("/api/panel?eventoId=" + ev.id, { admin: true });
  assert.equal(panel.datos.vendidos, 0);
  assert.equal(panel.datos.ingresos, 0);
  assert.equal(panel.datos.cancelados, 2);
});

test("reembolso de una mesa: la mesa vuelve a estar libre", async () => {
  const MAPA = "la-comedia-show-live";
  const mesa = mesasDelMapa(MAPA).find((m) => m.asientos === 4).id;
  const precios = [...new Set(mesasDelMapa(MAPA).map((m) => m.seccion))].map((id) => ({ id, precio: 200 }));
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const { pagoId } = await s.comprarYPagar({ eventoId: ev.id, mesas: [mesa] }, ip());
  s.actualizarPago(pagoId, { status: "refunded" });
  await s.avisarPago(pagoId);
  const publico = await s.pedir("/api/eventos/" + ev.id);
  assert.equal(publico.datos.mesas.find((m) => m.id === mesa).estado, "libre");
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [mesa] }, ip())).status, 200);
});

test("el mismo aviso de reembolso repetido no hace nada más (un solo correo)", async () => {
  const ev = await s.crearEvento();
  const { pagoId } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 1, nombre: "Toño" }, ip());
  s.actualizarPago(pagoId, { status: "refunded" });
  for (let i = 0; i < 3; i++) assert.equal((await s.avisarPago(pagoId)).status, 200);
  await esperarQue(() => correosA("reembolso de Toño").length >= 1);
  assert.equal(correosA("reembolso de Toño").length, 1);
});

test("una venta reembolsada nunca vuelve a emitir boletos, aunque llegue un aviso de aprobado", async () => {
  const ev = await s.crearEvento();
  const { ventaId, pagoId } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 2 }, ip());
  s.actualizarPago(pagoId, { status: "refunded" });
  await s.avisarPago(pagoId);
  s.actualizarPago(424242, { id: 424242, status: "approved", external_reference: ventaId });
  assert.equal((await s.avisarPago(424242)).status, 200);
  const venta = await s.pedir("/api/venta/" + ventaId);
  assert.equal(venta.datos.boletos.length, 2);
  assert.ok(venta.datos.boletos.every((b) => b.estado === "cancelado"));
});

test("contracargo: cancela los que no han entrado y deja como usados los que ya entraron", async () => {
  const ev = await s.crearEvento();
  const { ventaId, pagoId, boletos } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 3, nombre: "Memo" }, ip());
  await s.validar(boletos[0].folio, ev.id);
  s.actualizarPago(pagoId, { status: "charged_back" });
  await s.avisarPago(pagoId);
  const venta = await s.pedir("/api/venta/" + ventaId);
  const estados = venta.datos.boletos.map((b) => b.estado).sort();
  assert.deepEqual(estados, ["cancelado", "cancelado", "usado"]);
  assert.ok(await esperarQue(() => correosA("contracargo de Memo").length === 1));
  assert.match(correosA("contracargo de Memo")[0].html, /1 boleto\(s\) ya se habían usado/);
});

test("reembolso parcial o disputa: los boletos siguen válidos y se avisa una sola vez", async () => {
  const ev = await s.crearEvento();
  const { pagoId, boletos } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 2, nombre: "Lupe" }, ip());
  s.actualizarPago(pagoId, { status: "approved", status_detail: "partially_refunded", transaction_amount_refunded: 100 });
  await s.avisarPago(pagoId);
  await s.avisarPago(pagoId);
  assert.ok(await esperarQue(() => correosA("reembolso parcial de Lupe").length >= 1));
  assert.equal(correosA("reembolso parcial de Lupe").length, 1);
  assert.equal((await s.validar(boletos[0].folio, ev.id)).datos.resultado, "ok");

  s.actualizarPago(pagoId, { status: "in_mediation" });
  await s.avisarPago(pagoId);
  assert.ok(await esperarQue(() => correosA("disputa de Lupe").length === 1));
  assert.equal((await s.validar(boletos[1].folio, ev.id)).datos.resultado, "ok");
});

test("cancelar a mano: el boleto ya no entra, libera su lugar y no cuenta en ingresos", async () => {
  const ev = await s.crearEvento({ precio: 100, cupo: 2 });
  const venta = await s.pedir("/api/ventas-manuales", { metodo: "POST", admin: true, cuerpo: { eventoId: ev.id, nombre: "Paco", cantidad: 2 } });
  const [b1, b2] = venta.datos.boletos;
  const r = await cancelar([b1.folio.toLowerCase()], "devolución en efectivo");
  assert.deepEqual(r.datos.cancelados, [b1.folio]);
  assert.equal((await s.validar(b1.folio, ev.id)).datos.resultado, "cancelado");
  assert.equal((await s.validar(b2.folio, ev.id)).datos.resultado, "ok");
  const panel = await s.pedir("/api/panel?eventoId=" + ev.id, { admin: true });
  assert.equal(panel.datos.vendidos, 1);
  assert.equal(panel.datos.ingresos, 100);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip())).status, 200, "el lugar se liberó");
});

test("cancelar a mano: no se cancela un boleto que ya entró ni uno inexistente", async () => {
  const ev = await s.crearEvento();
  const venta = await s.pedir("/api/ventas-manuales", { metodo: "POST", admin: true, cuerpo: { eventoId: ev.id, nombre: "Sol", cantidad: 1 } });
  const folio = venta.datos.boletos[0].folio;
  await s.validar(folio, ev.id);
  const r = await cancelar([folio, "MT-NO-EXISTE"]);
  assert.deepEqual(r.datos.cancelados, []);
  assert.deepEqual(r.datos.omitidos.map((o) => o.motivo).sort(), ["no existe", "ya entró"]);
  assert.equal((await s.pedir("/api/admin/cancelar-boletos", { metodo: "POST", cuerpo: { folios: [folio] } })).status, 401, "pide la clave");
});

test("reenviar correo: solo manda los boletos vigentes y avisa si todos están cancelados", async () => {
  const ev = await s.crearEvento();
  const venta = await s.pedir("/api/ventas-manuales", { metodo: "POST", admin: true, cuerpo: { eventoId: ev.id, nombre: "Ivo", contacto: "ivo@prueba.mx", cantidad: 2 } });
  const folios = venta.datos.boletos.map((b) => b.folio);
  await cancelar(folios);
  const r = await s.pedir("/api/admin/reenviar-correo", { metodo: "POST", admin: true, cuerpo: { ventaId: venta.datos.ventaId } });
  assert.equal(r.status, 409);
  assert.match(r.datos.error, /cancelados/);
});
