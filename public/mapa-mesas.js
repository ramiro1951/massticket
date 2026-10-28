/* Mapa de mesas de massticket.mx
 *
 * Dibuja el plano de un lugar (archivo en /mapas/<id>.json) y deja elegir
 * mesas. Lo usan la página de compra y la venta manual del panel.
 *
 *   const m = MapaMesas.crear(contenedor, {
 *     mapa,            // el JSON del plano
 *     mesas,           // estado de cada mesa que manda el servidor:
 *                      // [{id, seccion, asientos, precioPersona, precioMesa, ocupada}]
 *     max: 8,          // máximo de mesas por compra
 *     onCambio(ids){}  // se llama cada vez que cambia la selección
 *   });
 *   m.seleccion()  -> ids elegidos      m.limpiar()   -> quita la selección
 *   m.actualizar(mesasNuevas)           -> refresca ocupadas/libres
 */
(function(){
  const NS = "http://www.w3.org/2000/svg";
  const pesos = n => "$" + Number(n||0).toLocaleString("es-MX");
  const esc = t => String(t??"").replace(/[<>&"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));

  const CSS = `
  .mm-caja{position:relative;max-width:480px;margin:0 auto}
  .mm-leyenda{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 8px;font-size:13.5px}
  .mm-leyenda span{display:inline-flex;align-items:center;gap:6px}
  .mm-leyenda i{width:14px;height:14px;border-radius:4px;display:inline-block}
  .mm-nota{font-size:13px;color:var(--humo,#8FA0B8);margin:0 0 10px}
  .mm-svg{width:100%;height:auto;display:block;background:var(--noche-2,#18253D);border:1px solid var(--linea,#2a3a57);border-radius:12px}
  .mm-mesa{cursor:pointer;outline:none}
  .mm-mesa .mm-fondo{transition:filter .12s,stroke-width .12s;stroke:rgba(255,255,255,.35);stroke-width:2}
  .mm-mesa:hover .mm-fondo,.mm-mesa:focus .mm-fondo{filter:brightness(1.18);stroke:#fff;stroke-width:3}
  .mm-mesa.sel .mm-fondo{stroke:#fff;stroke-width:5;filter:brightness(1.1)}
  .mm-mesa.ocupada{cursor:not-allowed}
  .mm-mesa.ocupada .mm-fondo{fill:#334058!important;stroke:#4a5876;stroke-dasharray:6 5;filter:none}
  .mm-mesa.ocupada text{fill:#7f8ca6!important}
  .mm-mesa.ocupada .mm-asiento{fill:#4a5876!important}
  .mm-tip{position:absolute;z-index:5;pointer-events:none;background:#0b1424;color:#F5EFE1;border:1px solid #F2A71B;border-radius:10px;padding:9px 12px;font-size:13.5px;line-height:1.45;box-shadow:0 6px 18px rgba(0,0,0,.45);width:max-content;max-width:230px;display:none}
  .mm-tip b{font-size:15px}
  .mm-tip .mm-aviso{color:#F2A71B;font-size:12.5px;margin-top:3px;display:block}
  `;
  function inyectarCSS(){
    if(document.getElementById("mapa-mesas-css")) return;
    const s = document.createElement("style");
    s.id = "mapa-mesas-css"; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function el(tag, attrs, padre){
    const e = document.createElementNS(NS, tag);
    for(const k in (attrs||{})) e.setAttribute(k, attrs[k]);
    if(padre) padre.appendChild(e);
    return e;
  }

  function asientosDe(m){
    const {x,y,w,h,asientos} = m;
    const cx = x + w/2, cy = y + h/2;
    const dx = Math.min(14, w/2 - 8), dy = Math.min(14, h/2 - 8);
    if(asientos === 2){
      return w >= h ? [[x+w*0.28, cy],[x+w*0.72, cy]] : [[cx, y+h*0.28],[cx, y+h*0.72]];
    }
    if(asientos === 6){
      // dos filas de 3 sobre el lado largo; el número queda en el centro
      return w >= h
        ? [[x+dx, y+dy],[cx, y+dy],[x+w-dx, y+dy],[x+dx, y+h-dy],[cx, y+h-dy],[x+w-dx, y+h-dy]]
        : [[x+dx, y+dy],[x+dx, cy],[x+dx, y+h-dy],[x+w-dx, y+dy],[x+w-dx, cy],[x+w-dx, y+h-dy]];
    }
    if(asientos === 3){
      return [[cx, y+dy],[x+dx, y+h-dy],[x+w-dx, y+h-dy]]; // triángulo: deja libre el centro para el número
    }
    return [[cx, y+dy],[x+w-dx, cy],[cx, y+h-dy],[x+dx, cy]];
  }

  function crear(contenedor, opc){
    inyectarCSS();
    const mapa = opc.mapa;
    const max = opc.max || 8;
    let datos = {};      // id -> estado que manda el servidor
    const sel = new Set();
    const secciones = {};
    mapa.secciones.forEach(s => secciones[s.id] = s);

    contenedor.innerHTML = "";
    const caja = document.createElement("div");
    caja.className = "mm-caja";
    contenedor.appendChild(caja);

    const leyenda = document.createElement("div");
    leyenda.className = "mm-leyenda";
    caja.appendChild(leyenda);
    const nota = document.createElement("p");
    nota.className = "mm-nota";
    nota.textContent = "Cada mesa se compra completa: compras un boleto por cada persona que cabe en la mesa (6, 4, 3 o 2 según la mesa). Pasa el cursor (o toca) una mesa para ver su precio.";
    caja.appendChild(nota);

    const [vx,vy,vw,vh] = mapa.viewBox;
    const svg = el("svg", {viewBox:`${vx} ${vy} ${vw} ${vh}`, class:"mm-svg", role:"group", "aria-label":"Plano de mesas de "+mapa.nombre});
    caja.appendChild(svg);

    const tip = document.createElement("div");
    tip.className = "mm-tip";
    caja.appendChild(tip);

    // ----- decoración (escenario, muros, baños...) -----
    (mapa.decoracion||[]).forEach(d=>{
      if(d.tipo === "rect"){
        el("rect", {x:d.x,y:d.y,width:d.w,height:d.h,rx:d.rx||0,fill:d.fill}, svg);
        if(d.texto){
          const t = el("text", {x:d.x+d.w/2,y:d.y+d.h/2,"text-anchor":"middle","dominant-baseline":"central","font-size":d.ts||12,fill:d.tc||"#fff","font-weight":d.bold?700:500,"font-family":"Archivo,sans-serif"}, svg);
          t.textContent = d.texto;
        }
      }else if(d.tipo === "texto"){
        const a = {x:d.x,y:d.y,"text-anchor":d.anchor||"middle","font-size":d.size||12,fill:d.color||"#cfd8e6","font-weight":d.bold?700:500,"font-family":"Archivo,sans-serif"};
        if(d.ls) a["letter-spacing"] = d.ls;
        if(d.rot) a.transform = `rotate(${d.rot} ${d.x} ${d.y})`;
        const t = el("text", a, svg);
        t.textContent = d.texto;
      }
    });

    // ----- mesas -----
    const grupos = {};
    mapa.mesas.forEach(m=>{
      const s = secciones[m.seccion] || {color:"#888",texto:"#fff",asiento:"rgba(0,0,0,.3)",nombre:m.seccion};
      const g = el("g", {class:"mm-mesa", tabindex:0, role:"button", "data-id":m.id}, svg);
      // Una mesa puede tener varias partes (por ejemplo, dos sofás que se
      // venden juntos como una sola mesa): todas se eligen a la vez.
      const partes = m.partes || [m];
      partes.forEach(pt=>{
        el("rect", {class:"mm-fondo", x:pt.x, y:pt.y, width:pt.w, height:pt.h, rx:10, fill:s.color}, g);
        asientosDe({x:pt.x, y:pt.y, w:pt.w, h:pt.h, asientos:pt.asientos}).forEach(([cx,cy])=> el("circle", {class:"mm-asiento", cx, cy, r:8, fill:s.asiento}, g));
      });
      const r0 = partes[0];
      const tam = Math.max(20, Math.min(30, Math.min(r0.w, r0.h) * 0.3));
      const lx = m.lx !== undefined ? m.lx : r0.x + r0.w/2;
      const ly = m.ly !== undefined ? m.ly : r0.y + r0.h/2;
      const fuera = m.lx !== undefined;
      if(m.partes){
        // el número va en una etiqueta del color de la sección, entre las partes
        el("rect", {class:"mm-fondo", x:lx-22, y:ly-17, width:44, height:34, rx:8, fill:s.color}, g);
      }
      const t = el("text", {x:lx, y:ly, "text-anchor":"middle", "dominant-baseline":"central", "font-size":tam, "font-weight":700, "font-family":"Anton,Archivo,sans-serif", fill: (fuera && !m.partes) ? "#F5EFE1" : s.texto, "pointer-events":"none"}, g);
      t.textContent = m.id;
      if(fuera && !m.partes){ // etiqueta fuera de la mesa: se cubre también con un área tocable
        el("rect", {x:lx-16, y:ly-16, width:32, height:32, fill:"transparent"}, g);
      }
      grupos[m.id] = g;

      g.addEventListener("mouseenter", ()=> mostrarTip(m.id, g));
      g.addEventListener("mouseleave", ocultarTip);
      g.addEventListener("focus", ()=> mostrarTip(m.id, g));
      g.addEventListener("blur", ocultarTip);
      g.addEventListener("click", ()=>{ alternar(m.id); mostrarTip(m.id, g); });
      g.addEventListener("keydown", e=>{ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); alternar(m.id); } });
    });

    function info(id){
      const m = mapa.mesas.find(x=>x.id===id);
      const d = datos[id] || {};
      const s = secciones[m.seccion] || {nombre:m.seccion};
      const asientos = d.asientos || m.asientos;
      const pp = d.precioPersona;
      return {m, d, s, asientos, pp, mesa: d.precioMesa !== undefined ? d.precioMesa : (pp||0)*asientos, ocupada: !!d.ocupada};
    }
    function mostrarTip(id, g){
      const i = info(id);
      let h = `<b>Mesa ${esc(id)}</b><br>${esc(i.s.nombre)} · ${i.asientos} personas`;
      if(i.ocupada){
        h += `<span class="mm-aviso">No disponible</span>`;
      }else{
        if(i.pp !== undefined) h += `<br>${pesos(i.pp)} por persona<br><b>${pesos(i.mesa)} la mesa</b>`;
        h += `<span class="mm-aviso">Se compra completa: ${i.asientos} boletos</span>`;
      }
      tip.innerHTML = h;
      tip.style.display = "block";
      const rc = caja.getBoundingClientRect(), rg = g.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = rg.left - rc.left + rg.width/2 - tw/2;
      left = Math.max(4, Math.min(rc.width - tw - 4, left));
      let top = rg.top - rc.top - th - 8;
      if(top < 4) top = rg.bottom - rc.top + 8;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }
    function ocultarTip(){ tip.style.display = "none"; }

    function alternar(id){
      const i = info(id);
      if(i.ocupada) return;
      if(sel.has(id)) sel.delete(id);
      else{
        if(sel.size >= max){ if(opc.onLimite) opc.onLimite(max); return; }
        sel.add(id);
      }
      pintarEstado();
      if(opc.onCambio) opc.onCambio([...sel]);
    }

    function pintarEstado(){
      mapa.mesas.forEach(m=>{
        const g = grupos[m.id];
        const ocupada = !!(datos[m.id] && datos[m.id].ocupada);
        g.classList.toggle("ocupada", ocupada);
        g.classList.toggle("sel", sel.has(m.id));
        g.setAttribute("aria-pressed", sel.has(m.id) ? "true" : "false");
        const i = info(m.id);
        g.setAttribute("aria-label", `Mesa ${m.id}, ${i.s.nombre}, ${i.asientos} personas` + (ocupada ? ", no disponible" : (i.pp!==undefined ? `, ${pesos(i.mesa)}` : "")));
      });
      // leyenda con el precio por persona de cada sección
      leyenda.innerHTML = mapa.secciones.map(s=>{
        const ej = Object.values(datos).find(d=>d.seccion===s.id && d.precioPersona!==undefined);
        return `<span><i style="background:${s.color}"></i>${esc(s.nombre)}${ej ? " · " + pesos(ej.precioPersona) + " por persona" : ""}</span>`;
      }).join("") + `<span><i style="background:#334058;border:1px dashed #4a5876"></i>No disponible</span>`;
    }

    function actualizar(mesasNuevas){
      datos = {};
      (mesasNuevas||[]).forEach(d=> datos[d.id] = d);
      // si una mesa elegida ya no está libre, se quita
      let cambio = false;
      [...sel].forEach(id=>{ if(datos[id] && datos[id].ocupada){ sel.delete(id); cambio = true; } });
      pintarEstado();
      if(cambio && opc.onCambio) opc.onCambio([...sel]);
    }

    actualizar(opc.mesas);
    return {
      seleccion: ()=>[...sel],
      info: id => info(id),
      limpiar: ()=>{ sel.clear(); pintarEstado(); if(opc.onCambio) opc.onCambio([]); },
      actualizar
    };
  }

  window.MapaMesas = { crear };
})();
