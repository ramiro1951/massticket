// Compra en línea, aviso de Mercado Pago (webhook) y emisión de boletos.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancarServidor, esperarQue } from "./ayudantes.js";

let s;
before(async () => { s = await arrancarServidor(); });
after(async () => { await s.detener(); });

test("una compra aprobada emite un boleto por persona y manda el correo", async () => {
  const ev = await s.crearEvento({ nombre: "Show", precio: 250, cupo: 10 });
  const { ventaId, boletos } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 3, contacto: "luis@prueba.mx" });
  assert.equal(boletos.length, 3);
  assert.ok(boletos.every((b) => b.precio === 250 && b.estado === "valido" && /^MT-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-\d{4}$/.test(b.folio)));
  assert.equal(new Set(boletos.map((b) => b.folio)).size, 3, "los folios no se repiten");
  const venta = await s.pedir("/api/venta/" + ventaId);
  assert.equal(venta.datos.estado, "pagado");
  assert.ok(await esperarQue(() => s.registro("correo").some((c) => c.para === "luis@prueba.mx" && c.adjuntos === 1)));
});

test("el mismo aviso de pago repetido no duplica boletos", async () => {
  const ev = await s.crearEvento();
  const compra = await s.comprar({ eventoId: ev.id, cantidad: 2 });
  s.ponerPagos([{ id: 5001, status: "approved", external_reference: compra.datos.ventaId }]);
  for (let i = 0; i < 3; i++) assert.equal((await s.avisarPago(5001)).status, 200);
  const venta = await s.pedir("/api/venta/" + compra.datos.ventaId);
  assert.equal(venta.datos.boletos.length, 2);
});

test("un pago todavía pendiente no emite boletos", async () => {
  const ev = await s.crearEvento();
  const compra = await s.comprar({ eventoId: ev.id, cantidad: 1 });
  s.ponerPagos([{ id: 5002, status: "pending", external_reference: compra.datos.ventaId }]);
  assert.equal((await s.avisarPago(5002)).status, 200);
  const venta = await s.pedir("/api/venta/" + compra.datos.ventaId);
  assert.equal(venta.datos.estado, "pendiente");
  assert.equal(venta.datos.boletos.length, 0);
});

test("si Mercado Pago no responde, se contesta error para que reintente", async () => {
  assert.equal((await s.avisarPago(999)).status, 500);
});

test("un aviso sin firma o con firma falsa se rechaza", async () => {
  const ev = await s.crearEvento();
  const compra = await s.comprar({ eventoId: ev.id, cantidad: 1 });
  s.ponerPagos([{ id: 5003, status: "approved", external_reference: compra.datos.ventaId }]);
  assert.equal((await s.avisarPago(5003, { firma: false })).status, 401);
  const falsa = await s.pedir("/api/webhook/mercadopago?type=payment&data.id=5003", {
    metodo: "POST", encabezados: { "x-request-id": "x", "x-signature": "ts=1,v1=abc" },
  });
  assert.equal(falsa.status, 401);
  const venta = await s.pedir("/api/venta/" + compra.datos.ventaId);
  assert.equal(venta.datos.boletos.length, 0);
});

test("un pago aprobado que no corresponde a ninguna venta avisa al organizador", async () => {
  s.ponerPagos([{ id: 5004, status: "approved", external_reference: "no-existe", transaction_amount: 300, currency_id: "MXN" }]);
  assert.equal((await s.avisarPago(5004)).status, 200);
  assert.ok(await esperarQue(() => s.registro("correo").some((c) => c.para === "dueno@prueba.mx" && c.asunto.includes("pago aprobado sin venta"))));
});

test("el link de pago no ofrece OXXO/SPEI y vence a los 19 minutos", async () => {
  const ev = await s.crearEvento();
  const antes = s.registro("preferencia").length;
  await s.comprar({ eventoId: ev.id, cantidad: 1 });
  const pref = s.registro("preferencia").slice(antes)[0].cuerpo;
  assert.deepEqual(pref.payment_methods.excluded_payment_types.map((t) => t.id).sort(), ["atm", "bank_transfer", "ticket"]);
  assert.equal(pref.expires, true);
  const minutos = (new Date(pref.expiration_date_to) - new Date(pref.expiration_date_from)) / 60000;
  assert.equal(Math.round(minutos), 19);
  assert.equal(pref.external_reference.length > 0, true);
});

test("Revisar con Mercado Pago confirma pagos cuyo aviso se perdió", async () => {
  const ev = await s.crearEvento();
  const compra = await s.comprar({ eventoId: ev.id, cantidad: 2 });
  s.ponerPagos([{ id: 5005, status: "approved", external_reference: compra.datos.ventaId }]);
  const r = await s.pedir("/api/admin/reconciliar-pagos", { metodo: "POST", admin: true });
  assert.equal(r.status, 200);
  assert.ok(r.datos.confirmadas.some((c) => c.boletos === 2));
  const venta = await s.pedir("/api/venta/" + compra.datos.ventaId);
  assert.equal(venta.datos.boletos.length, 2);
});

test("Revisar con Mercado Pago ignora compras pendientes de hace más de 7 días", async () => {
  const ev = await s.crearEvento();
  const compra = await s.comprar({ eventoId: ev.id, cantidad: 1 });
  s.cambiarDB((db) => {
    db.ventas.find((v) => v.id === compra.datos.ventaId).creado = new Date(Date.now() - 8 * 86400000).toISOString();
  });
  s.ponerPagos([{ id: 5006, status: "approved", external_reference: compra.datos.ventaId }]);
  await s.pedir("/api/admin/reconciliar-pagos", { metodo: "POST", admin: true });
  const venta = await s.pedir("/api/venta/" + compra.datos.ventaId);
  assert.equal(venta.datos.estado, "pendiente");
});

test("un evento que ya pasó no se puede comprar", async () => {
  const ev = await s.crearEvento({ fecha: "2020-01-01" });
  const r = await s.comprar({ eventoId: ev.id, cantidad: 1 });
  assert.equal(r.status, 409);
});
