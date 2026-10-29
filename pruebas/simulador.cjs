// Simulador de Mercado Pago y Resend para las pruebas automáticas.
// Se carga con "node --require" antes de server.js (ver ayudantes.js), así
// las pruebas nunca tocan dinero ni correos reales.
//
// Variables de entorno que usa:
//   SIM_PAGOS     archivo JSON { idDePago: pago } que devuelve "Mercado Pago".
//   SIM_REGISTRO  archivo donde se anota, una línea JSON por evento, cada
//                 preferencia creada y cada correo enviado.
//   SIM_RECHAZA   "vence" y/o "excluir": Mercado Pago rechaza preferencias
//                 con vencimiento o con tipos de pago excluidos; "todo": todas.
// Un pago con id "999" simula que Mercado Pago no responde (error 500).
// Un correo a una dirección que empieza con "falla@" simula un envío fallido.

const fs = require("fs");
const Module = require("module");

function anotar(dato) {
  fs.appendFileSync(process.env.SIM_REGISTRO, JSON.stringify(dato) + "\n");
}
function pagos() {
  try {
    return JSON.parse(fs.readFileSync(process.env.SIM_PAGOS, "utf8"));
  } catch {
    return {};
  }
}

// Respuesta con la forma que espera el SDK de Mercado Pago (node-fetch).
function respuesta(status, cuerpo) {
  return {
    ok: status < 400,
    status,
    headers: { raw: () => ({ "content-type": ["application/json"] }), get: () => "application/json" },
    json: async () => cuerpo,
    text: async () => JSON.stringify(cuerpo),
  };
}

async function mercadoPago(url, opciones = {}) {
  const u = new URL(url);
  const ruta = u.pathname.replace(/\/$/, "");
  if (ruta === "/checkout/preferences") {
    const cuerpo = JSON.parse(opciones.body);
    const rechaza = process.env.SIM_RECHAZA || "";
    if (rechaza === "todo" || (rechaza.includes("vence") && cuerpo.expires) || (rechaza.includes("excluir") && cuerpo.payment_methods)) {
      anotar({ tipo: "preferencia-rechazada", cuerpo });
      return respuesta(400, { message: "rechazada por el simulador" });
    }
    anotar({ tipo: "preferencia", cuerpo });
    return respuesta(201, { id: "pref-" + Date.now(), init_point: "https://mercadopago.simulado/pagar" });
  }
  if (ruta === "/v1/payments/search") {
    const ref = u.searchParams.get("external_reference");
    return respuesta(200, { results: Object.values(pagos()).filter((p) => p.external_reference === ref) });
  }
  const m = ruta.match(/^\/v1\/payments\/(\w+)$/);
  if (m) {
    if (m[1] === "999") return respuesta(500, { message: "Mercado Pago no responde (simulado)" });
    const pago = pagos()[m[1]];
    return pago ? respuesta(200, pago) : respuesta(404, { message: "pago no encontrado" });
  }
  return respuesta(404, { message: "ruta no simulada: " + ruta });
}

// El SDK de Mercado Pago usa node-fetch: se reemplaza por el simulador.
const cargarOriginal = Module._load;
Module._load = function (pedido) {
  if (pedido === "node-fetch") {
    const f = mercadoPago;
    f.default = mercadoPago;
    return f;
  }
  return cargarOriginal.apply(this, arguments);
};

// Resend usa el fetch global: se interceptan solo sus llamadas.
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opciones) => {
  if (String(url).includes("resend.com")) {
    const cuerpo = JSON.parse(opciones.body);
    const para = [].concat(cuerpo.to).join(",");
    const falla = para.startsWith("falla@");
    anotar({ tipo: "correo", para, asunto: cuerpo.subject, html: cuerpo.html, adjuntos: (cuerpo.attachments || []).length, falla });
    if (falla) {
      return new Response(JSON.stringify({ name: "validation_error", message: "envío fallido (simulado)", statusCode: 422 }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "correo-simulado" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return fetchOriginal(url, opciones);
};
