// Puerta (validación de boletos), clave de organizador y límites de compra por IP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancarServidor } from "./ayudantes.js";

let s;
before(async () => { s = await arrancarServidor(); });
after(async () => { await s.detener(); });

test("puerta: un boleto entra una sola vez", async () => {
  const ev = await s.crearEvento();
  const { boletos } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 1 }, "10.2.0.1");
  const folio = boletos[0].folio;
  const primera = await s.validar(folio, ev.id);
  assert.equal(primera.datos.resultado, "ok");
  const segunda = await s.validar(folio, ev.id);
  assert.equal(segunda.datos.resultado, "repetido");
  assert.ok(segunda.datos.usadoEn);
});

test("puerta: un boleto de otro evento no entra ni se marca como usado", async () => {
  const evA = await s.crearEvento({ nombre: "Evento A" });
  const evB = await s.crearEvento({ nombre: "Evento B" });
  const { boletos } = await s.comprarYPagar({ eventoId: evA.id, cantidad: 1 }, "10.2.0.2");
  const r = await s.validar(boletos[0].folio, evB.id);
  assert.equal(r.status, 409);
  assert.equal(r.datos.resultado, "otro_evento");
  assert.equal(r.datos.evento, "Evento A");
  assert.equal((await s.validar(boletos[0].folio, evA.id)).datos.resultado, "ok", "en su evento sí entra");
});

test("puerta: folio inexistente, y minúsculas o espacios no importan", async () => {
  const ev = await s.crearEvento();
  assert.equal((await s.validar("MT-XXXX-9999", ev.id)).datos.resultado, "no_existe");
  const { boletos } = await s.comprarYPagar({ eventoId: ev.id, cantidad: 1 }, "10.2.0.3");
  assert.equal((await s.validar("  " + boletos[0].folio.toLowerCase() + " ", ev.id)).datos.resultado, "ok");
});

test("puerta: los folios viejos (4 letras) siguen entrando", async () => {
  const ev = await s.crearEvento();
  s.cambiarDB((db) => {
    db.boletos.push({ folio: "MT-3F9K-0142", eventoId: ev.id, ventaId: "vieja", nombre: "Cliente anterior", metodo: "Efectivo", precio: 100, estado: "valido", usadoEn: null });
  });
  assert.equal((await s.validar("MT-3F9K-0142", ev.id)).datos.resultado, "ok");
});

test("folios: cada uno tiene 8 letras al azar y no se repiten", async () => {
  const ev = await s.crearEvento({ cupo: 100 });
  const r = await s.pedir("/api/ventas-manuales", { metodo: "POST", admin: true, cuerpo: { eventoId: ev.id, nombre: "Grupo", cantidad: 60 } });
  const folios = r.datos.boletos.map((b) => b.folio);
  assert.equal(new Set(folios).size, 60);
  assert.equal(new Set(folios.map((f) => f.slice(3, 12))).size, 60, "la parte al azar no se repite");
});

test("puerta y panel piden la clave de organizador", async () => {
  assert.equal((await s.pedir("/api/validar", { metodo: "POST", cuerpo: { folio: "X" } })).status, 401);
  assert.equal((await s.pedir("/api/boletos")).status, 401);
  assert.equal((await s.pedir("/api/panel", { admin: "otra-clave", ip: "10.2.1.1" })).status, 401);
  assert.equal((await s.pedir("/api/boletos", { admin: true })).status, 200);
});

test("clave: tras 20 intentos fallidos se bloquea esa IP, pero no las demás", async () => {
  const atacante = "10.3.0.1";
  for (let i = 0; i < 20; i++) {
    assert.equal((await s.pedir("/api/boletos", { admin: "adivinanza-" + i, ip: atacante })).status, 401);
  }
  assert.equal((await s.pedir("/api/boletos", { admin: "otra", ip: atacante })).status, 429);
  assert.equal((await s.pedir("/api/boletos", { admin: true, ip: atacante })).status, 429, "bloqueada aunque ahora use la clave buena");
  assert.equal((await s.pedir("/api/boletos", { admin: true, ip: "10.3.0.2" })).status, 200, "la puerta (otra IP) sigue funcionando");
});

test("clave: la clave vacía no cuenta como intento fallido", async () => {
  const ip = "10.3.0.3";
  for (let i = 0; i < 25; i++) await s.pedir("/api/boletos", { ip });
  assert.equal((await s.pedir("/api/boletos", { admin: true, ip })).status, 200);
});

test("compras: máximo 15 compras iniciadas por IP cada 15 minutos", async () => {
  const ev = await s.crearEvento({ cupo: 1000 });
  const ip = "10.4.0.1";
  for (let i = 0; i < 15; i++) assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip)).status, 200);
  const r = await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip);
  assert.equal(r.status, 429);
  assert.match(r.datos.error, /intentos de compra/);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 1 }, "10.4.0.2")).status, 200, "otra persona sí puede comprar");
});

test("compras: máximo 40 lugares apartados por IP, pero la primera compra siempre pasa", async () => {
  const ev = await s.crearEvento({ cupo: 1000 });
  const ip = "10.4.1.1";
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 20 }, ip)).status, 200);
  assert.equal((await s.comprar({ eventoId: ev.id, cantidad: 20 }, ip)).status, 200, "20 + 20 = 40, justo en el límite");
  const r = await s.comprar({ eventoId: ev.id, cantidad: 1 }, ip);
  assert.equal(r.status, 429);
  assert.match(r.datos.error, /compras sin terminar/);
});

test("compras: si Mercado Pago falla al crear el link, el apartado se libera", async () => {
  const s2 = await arrancarServidor({ SIM_RECHAZA: "todo" });
  try {
    const ev = await s2.crearEvento({ cupo: 1 });
    assert.equal((await s2.comprar({ eventoId: ev.id, cantidad: 1 }, "10.5.0.1")).status, 500);
    assert.equal(s2.leerDB().ventas.length, 0, "no queda ninguna venta apartando el lugar");
  } finally {
    await s2.detener();
  }
});

test("compras: si Mercado Pago no acepta el vencimiento o la exclusión, se vende igual", async () => {
  const s2 = await arrancarServidor({ SIM_RECHAZA: "vence,excluir" });
  try {
    const ev = await s2.crearEvento();
    assert.equal((await s2.comprar({ eventoId: ev.id, cantidad: 1 }, "10.5.0.2")).status, 200);
    const creadas = s2.registro("preferencia");
    assert.equal(creadas.length, 1);
    assert.equal(creadas[0].cuerpo.payment_methods, undefined);
  } finally {
    await s2.detener();
  }
});

test("errores: un cuerpo mal formado contesta 400 y el servidor sigue funcionando", async () => {
  const r = await s.pedir("/api/comprar", { metodo: "POST", cuerpo: "{esto no es json" });
  assert.equal(r.status, 400);
  assert.equal((await s.pedir("/api/eventos")).status, 200);
});

test("carteles: solo se aceptan imágenes de verdad", async () => {
  const mala = await s.pedir("/api/eventos", { metodo: "POST", admin: true, cuerpo: { nombre: "X", imagen: 'javascript:alert(1)' } });
  assert.equal(mala.status, 400);
  const buena = await s.pedir("/api/eventos", { metodo: "POST", admin: true, cuerpo: { nombre: "X", imagen: "data:image/jpeg;base64,/9j/4AAQ" } });
  assert.equal(buena.status, 200);
});

test("encabezados de seguridad en páginas y API", async () => {
  for (const ruta of ["/", "/admin.html", "/api/eventos"]) {
    const r = await fetch(s.url + ruta);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /frame-ancestors 'none'/, ruta);
    assert.match(csp, /connect-src 'self'/, ruta);
    assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/, ruta);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("permissions-policy"), /camera=\(self\)/);
    assert.equal(r.headers.get("x-powered-by"), null);
  }
});

test("otros sitios no pueden llamar a la API desde el navegador (sin CORS)", async () => {
  const r = await fetch(s.url + "/api/eventos", { headers: { origin: "https://sitio-ajeno.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(s.url + "/api/comprar", { method: "OPTIONS", headers: { origin: "https://sitio-ajeno.example", "access-control-request-method": "POST" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
});

test("peticiones enormes: se rechazan en la API pública, pero el cartel de un evento sí cabe", async () => {
  const grande = await s.pedir("/api/comprar", { metodo: "POST", ip: "10.8.0.1", cuerpo: { nombre: "x".repeat(300 * 1024) } });
  assert.equal(grande.status, 413);
  const cartel = "data:image/jpeg;base64," + "A".repeat(2 * 1024 * 1024);
  assert.equal((await s.pedir("/api/eventos", { metodo: "POST", admin: true, cuerpo: { nombre: "Con cartel", imagen: cartel } })).status, 200);
});
