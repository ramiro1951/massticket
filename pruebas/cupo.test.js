// Cupo: nunca vender más lugares de los que hay (precio único, zonas,
// mesas completas y asientos sueltos), y liberar los apartados vencidos.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancarServidor, mesasDelMapa } from "./ayudantes.js";

let s;
before(async () => { s = await arrancarServidor(); });
after(async () => { await s.detener(); });

// Cada compra desde una IP distinta, para que no cuenten los límites por IP.
let ipN = 0;
const ip = () => `10.1.0.${++ipN}`;

// "Envejece" una venta pendiente para que su apartado de 20 minutos ya haya vencido.
function envejecer(ventaId, minutos = 21) {
  s.cambiarDB((db) => {
    db.ventas.find((v) => v.id === ventaId).creado = new Date(Date.now() - minutos * 60000).toISOString();
  });
}

test("precio único: no se vende más del cupo, contando compras pendientes", async () => {
  const ev = await s.crearEvento({ cupo: 5 });
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 3 }, ip())).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 3 }, ip())).status, 409, "3 + 3 rebasa el cupo de 5");
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 2 }, ip())).status, 200, "3 + 2 cabe justo");
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip())).status, 409, "ya está lleno");
});

test("una compra pendiente de más de 20 minutos libera su lugar", async () => {
  const ev = await s.crearEvento({ cupo: 2 });
  const a = await s.comprar({ eventoId: ev.id, cantidad: 2 }, ip());
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip())).status, 409);
  envejecer(a.datos.ventaId);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 2 }, ip())).status, 200);
});

test("los boletos emitidos ocupan cupo para siempre", async () => {
  const ev = await s.crearEvento({ cupo: 2 });
  const { ventaId } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 2 }, ip());
  envejecer(ventaId, 60);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip())).status, 409);
  const publico = await s.pedir("/api/eventos/" + ev.id);
  assert.equal(publico.datos.vendidos, 2);
});

test("zonas: cada zona tiene su propio cupo y los palcos cuentan por persona", async () => {
  const ev = await s.crearEvento({
    zonas: [
      { id: "luneta", nombre: "Luneta", precio: 300, personas: 1, cupo: 3 },
      { id: "palco", nombre: "Palco", precio: 1000, personas: 4, cupo: 8 },
    ],
  });
  assert.equal(ev.cupo, 11);
  assert.equal((await s.comprar({ eventoId: ev.id, zonas: [{ zonaId: "palco", cantidad: 2 }] }, ip())).status, 200, "2 palcos de 4 = 8");
  assert.equal((await s.comprar({ eventoId: ev.id, zonas: [{ zonaId: "palco", cantidad: 1 }] }, ip())).status, 409);
  assert.equal((await s.comprar({ eventoId: ev.id, zonas: [{ zonaId: "luneta", cantidad: 3 }] }, ip())).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, zonas: [{ zonaId: "luneta", cantidad: 1 }] }, ip())).status, 409);
});

test("zonas: un palco pagado emite un boleto por persona al precio por persona", async () => {
  const ev = await s.crearEvento({ zonas: [{ id: "palco", nombre: "Palco", precio: 1000, personas: 4, cupo: 8 }] });
  const { boletos } = await s.comprarYPagar({ eventoId: ev.id, zonas: [{ zonaId: "palco", cantidad: 1 }] }, ip());
  assert.equal(boletos.length, 4);
  assert.ok(boletos.every((b) => b.precio === 250 && b.zona === "Palco"));
});

// Mapa de mesas: precios por sección y mesas de 4 para las pruebas.
const MAPA = "la-comedia-show-live";
const mesas = mesasDelMapa(MAPA);
const deCuatro = mesas.filter((m) => m.asientos === 4).map((m) => m.id);
const precios = [...new Set(mesas.map((m) => m.seccion))].map((id) => ({ id, precio: 200 }));

test("mesas completas: una mesa no se vende dos veces", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const [m1, m2] = deCuatro;
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [m1] }, ip())).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [m1] }, ip())).status, 409, "la mesa está apartada");
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [m2, m1] }, ip())).status, 409, "si una de las mesas no está libre, no se compra ninguna");
  const publico = await s.pedir("/api/eventos/" + ev.id);
  assert.equal(publico.datos.mesas.find((m) => m.id === m1).estado, "apartada");
  assert.equal(publico.datos.mesas.find((m) => m.id === m2).estado, "libre");
});

test("mesas completas: una mesa pagada emite un boleto por asiento con su número de mesa", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const { boletos } = await s.comprarYPagar({ eventoId: ev.id, mesas: [deCuatro[0]] }, ip());
  assert.equal(boletos.length, 4);
  assert.ok(boletos.every((b) => b.mesa === deCuatro[0] && b.precio === 200));
  const publico = await s.pedir("/api/eventos/" + ev.id);
  assert.equal(publico.datos.mesas.find((m) => m.id === deCuatro[0]).estado, "vendida");
});

test("mesas completas: máximo 8 mesas por compra", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: deCuatro.slice(0, 9) }, ip())).status, 400);
});

test("mesa compartida: cada asiento se vende una sola vez", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios, modoVenta: "asiento" });
  const mesa = deCuatro[0];
  assert.equal((await s.comprar({ eventoId: ev.id, asientos: [{ mesa, asiento: 1 }, { mesa, asiento: 2 }] }, ip())).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, asientos: [{ mesa, asiento: 2 }] }, ip())).status, 409, "el asiento 2 está apartado");
  assert.equal((await s.comprar({ eventoId: ev.id, asientos: [{ mesa, asiento: 3 }] }, ip())).status, 200, "el asiento 3 sigue libre");
  assert.equal((await s.comprar({ eventoId: ev.id, asientos: [{ mesa, asiento: 5 }] }, ip())).status, 400, "la mesa solo tiene 4 asientos");
  assert.equal((await s.comprar({ eventoId: ev.id, mesas: [mesa] }, ip())).status, 409, "una mesa por asiento no se vende completa");
  const publico = await s.pedir("/api/eventos/" + ev.id);
  const m = publico.datos.mesas.find((x) => x.id === mesa);
  assert.deepEqual(m.asientosOcupados, [1, 2, 3]);
  assert.equal(m.libres, 1);
});

test("mesa compartida: los boletos pagados llevan su número de asiento", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios, modoVenta: "asiento" });
  const mesa = deCuatro[1];
  const { boletos } = await s.comprarYPagar({ eventoId: ev.id, asientos: [{ mesa, asiento: 4 }, { mesa, asiento: 1 }] }, ip());
  assert.deepEqual(boletos.map((b) => b.asiento).sort(), [1, 4]);
  assert.ok(boletos.every((b) => b.mesa === mesa && b.precio === 200));
});

test("pago tardío de una mesa que ya se vendió: se emite (ya pagó) pero queda el aviso en el Panel", async () => {
  const ev = await s.crearEvento({ mapaId: MAPA, zonas: precios });
  const mesa = deCuatro[2];
  const tarde = await s.comprar({ eventoId: ev.id, mesas: [mesa] }, ip());
  envejecer(tarde.datos.ventaId);
  await s.comprarYPagar({ eventoId: ev.id, mesas: [mesa], nombre: "Beto" }, ip());
  s.ponerPagos([{ id: 7001, status: "approved", external_reference: tarde.datos.ventaId }]);
  assert.equal((await s.avisarPago(7001)).status, 200);
  const panel = await s.pedir("/api/panel?eventoId=" + ev.id, { admin: true });
  assert.equal(panel.datos.conflictos.length, 1);
  assert.deepEqual(panel.datos.conflictos[0].mesas, [mesa]);
});
