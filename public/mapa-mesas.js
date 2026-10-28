/* Mapa de mesas de massticket.mx
 *
 * Dibuja el plano de un lugar (archivo en /mapas/<id>.json) y deja elegir
 * mesas completas o, en las mesas que el organizador puso "por asiento"
 * (mesa compartida), asientos sueltos. Lo usan la página de compra, la venta
 * manual y la pestaña Eventos del panel (para cambiar cómo se vende cada mesa).
 *
 *   const m = MapaMesas.crear(contenedor, {
 *     mapa,             // el JSON del plano
 *     mesas,            // estado de cada mesa que manda el servidor:
 *                       // [{id, seccion, area, asientos, precioPersona, precioMesa, ocupada,
 *                       //   porAsiento, asientosOcupados, libres}]
 *     max: 8,           // máximo de mesas completas por compra
 *     maxAsientos: 10,  // máximo de asientos sueltos por compra
 *     onCambio(){},     // se llama cada vez que cambia la selección
 *     onLimite(n, tipo){}, // se pasó del máximo ("mesas" o "asientos")
 *     modo: "config",   // opcional (panel): tocar una mesa llama onConfig(id) en vez de elegirla
 *     onConfig(id){}
 *   });
 *   m.seleccion()          -> ids de mesas completas elegidas
 *   m.seleccionAsientos()  -> [{mesa, asiento}] asientos sueltos elegidos
 *   m.info(id)             -> datos de una mesa (precio, asientos, libres...)
 *   m.limpiar()            -> quita la selección
 *   m.actualizar(mesasNuevas) -> refresca ocupadas/libres
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
  .mm-mesa.suelta .mm-fondo{stroke:#F5EFE1;stroke-width:3;stroke-dasharray:7 5}
  .mm-mesa.suelta.sel .mm-fondo{stroke:#fff;stroke-width:5;stroke-dasharray:none}
  .mm-mesa .mm-asiento.tomado{fill:#1c2740!important}
  .mm-mesa .mm-asiento.mio{fill:#ffffff!important;stroke:#101A2E;stroke-width:2}
  .mm-mesa.ocupada{cursor:not-allowed}
  .mm-mesa.ocupada .mm-fondo{fill:#334058!important;stroke:#4a5876;stroke-dasharray:6 5;filter:none}
  .mm-mesa.ocupada text{fill:#7f8ca6!important}
  .mm-mesa.ocupada .mm-asiento{fill:#4a5876!important}
  .mm-config .mm-mesa.ocupada{cursor:pointer}
  .mm-tip{position:absolute;z-index:5;pointer-events:none;background:#0b1424;color:#F5EFE1;border:1px solid #F2A71B;border-radius:10px;padding:9px 12px;font-size:13.5px;line-height:1.45;box-shadow:0 6px 18px rgba(0,0,0,.45);width:max-content;max-width:230px;display:none}
  .mm-tip b{font-size:15px}
  .mm-tip .mm-aviso{color:#F2A71B;font-size:12.5px;margin-top:3px;display:block}
  .mm-panel{display:none;margin-top:10px;padding:12px 14px;background:#0b1424;border:1px solid #F2A71B;border-radius:12px;color:#F5EFE1}
  .mm-panel.ver{display:block}
  .mm-panel h4{margin:0 0 2px;font-size:16px}
  .mm-panel .mm-sub{font-size:13px;color:#8FA0B8;margin:0 0 10px}
  .mm-panel .mm-sillas{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
  .mm-panel .mm-silla{min-width:52px;padding:10px 8px;border-radius:10px;border:2px solid #3D4B68;background:#18253D;color:#F5EFE1;font:600 15px Archivo,sans-serif;cursor:pointer}
  .mm-panel .mm-silla.mio{background:#F2A71B;border-color:#F2A71B;color:#101A2E}
  .mm-panel .mm-silla:disabled{opacity:.45;cursor:not-allowed;text-decoration:line-through}
  .mm-panel .mm-cerrar{background:none;border:1px solid #3D4B68;color:#F5EFE1;border-radius:8px;padding:6px 12px;font:500 14px Archivo,sans-serif;cursor:pointer}
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

  // Posición de cada asiento dentro de la mesa. El asiento N es el elemento N-1.
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
        : [[x+dx, y+dy],[x+w-dx, y+dy],[x+dx, cy],[x+w-dx, cy],[x+dx, y+h-dy],[x+w-dx, y+h-dy]];
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
    const maxAsientos = opc.maxAsientos || 10;
    const config = opc.modo === "config";
    let datos = {};          // id -> estado que manda el servidor
    const sel = new Set();   // mesas completas elegidas
    const selA = new Map();  // mesaId -> Set(números de asiento elegidos)
    let abierta = null;      // mesa por asiento abierta en el panel
    const secciones = {};
    mapa.secciones.forEach(s => secciones[s.id] = s);

    contenedor.innerHTML = "";
    const caja = document.createElement("div");
    caja.className = "mm-caja" + (config ? " mm-config" : "");
    contenedor.appendChild(caja);

    const leyenda = document.createElement("div");
    leyenda.className = "mm-leyenda";
    caja.appendChild(leyenda);
    const nota = document.createElement("p");
    nota.className = "mm-nota";
    caja.appendChild(nota);

    const [vx,vy,vw,vh] = mapa.viewBox;
    const svg = el("svg", {viewBox:`${vx} ${vy} ${vw} ${vh}`, class:"mm-svg", role:"group", "aria-label":"Plano de mesas de "+mapa.nombre});
    caja.appendChild(svg);

    const tip = document.createElement("div");
    tip.className = "mm-tip";
    caja.appendChild(tip);

    const panel = document.createElement("div");
    panel.className = "mm-panel";
    panel.setAttribute("role", "dialog");
    caja.appendChild(panel);

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
    const circulos = {}; // id -> [circle] en orden de asiento
    mapa.mesas.forEach(m=>{
      const s = secciones[m.seccion] || {color:"#888",texto:"#fff",asiento:"rgba(0,0,0,.3)",nombre:m.seccion};
      const g = el("g", {class:"mm-mesa", tabindex:0, role:"button", "data-id":m.id}, svg);
      // Una mesa puede tener varias partes (por ejemplo, dos sofás que se
      // venden juntos como una sola mesa): todas se eligen a la vez.
      const partes = m.partes || [m];
      circulos[m.id] = [];
      partes.forEach(pt=>{
        el("rect", {class:"mm-fondo", x:pt.x, y:pt.y, width:pt.w, height:pt.h, rx:10, fill:s.color}, g);
        asientosDe({x:pt.x, y:pt.y, w:pt.w, h:pt.h, asientos:pt.asientos}).forEach(([cx,cy])=> circulos[m.id].push(el("circle", {class:"mm-asiento", cx, cy, r:8, fill:s.asiento}, g)));
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
      g.addEventListener("click", ()=>{ tocar(m.id); mostrarTip(m.id, g); });
      g.addEventListener("keydown", e=>{ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); tocar(m.id); } });
    });

    function info(id){
      const m = mapa.mesas.find(x=>x.id===id);
      const d = datos[id] || {};
      const s = secciones[m.seccion] || {nombre:m.seccion};
      const asientos = d.asientos || m.asientos;
      const pp = d.precioPersona;
      const porAsiento = !!d.porAsiento;
      const tomados = new Set((d.asientosOcupados||[]).map(Number));
      return {m, d, s, asientos, pp, area: d.area || m.area || "", porAsiento, tomados,
        libres: porAsiento ? asientos - tomados.size : (d.ocupada ? 0 : asientos),
        mesa: d.precioMesa !== undefined ? d.precioMesa : (pp||0)*asientos, ocupada: !!d.ocupada};
    }
    function nombreMesa(i, id){ return `Mesa ${esc(id)}` + (i.area ? ` · ${esc(i.area)}` : ""); }
    function mostrarTip(id, g){
      const i = info(id);
      let h = `<b>${nombreMesa(i, id)}</b><br>${esc(i.s.nombre)} · ${i.asientos} personas`;
      if(config){
        h += `<span class="mm-aviso">${i.porAsiento ? "Se vende por asiento" : "Se vende completa"} · toca para cambiar</span>`;
      }else if(i.ocupada){
        h += `<span class="mm-aviso">No disponible</span>`;
      }else if(i.porAsiento){
        h += `<br>${i.libres} de ${i.asientos} asientos libres`;
        if(i.pp !== undefined) h += `<br><b>${pesos(i.pp)} por persona</b>`;
        h += `<span class="mm-aviso">Mesa compartida: toca para elegir tus asientos</span>`;
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

    function totalAsientosElegidos(){ let n = 0; selA.forEach(s=> n += s.size); return n; }

    function tocar(id){
      if(config){ if(opc.onConfig) opc.onConfig(id); return; }
      const i = info(id);
      if(i.porAsiento){ abrirPanel(id); return; }
      if(i.ocupada) return;
      if(sel.has(id)) sel.delete(id);
      else{
        if(sel.size >= max){ if(opc.onLimite) opc.onLimite(max, "mesas"); return; }
        sel.add(id);
      }
      pintarEstado();
      if(opc.onCambio) opc.onCambio([...sel]);
    }

    // ----- panel para elegir asientos de una mesa compartida -----
    function abrirPanel(id){
      abierta = id;
      pintarPanel();
      panel.classList.add("ver");
      try{ panel.scrollIntoView({block:"nearest", behavior:"smooth"}); }catch(e){}
    }
    function cerrarPanel(){ abierta = null; panel.classList.remove("ver"); panel.innerHTML = ""; }
    function pintarPanel(){
      if(!abierta) return;
      const id = abierta, i = info(id);
      const mios = selA.get(id) || new Set();
      let botones = "";
      for(let n = 1; n <= i.asientos; n++){
        const tomado = i.tomados.has(n);
        botones += `<button type="button" class="mm-silla${mios.has(n)?" mio":""}" data-n="${n}" ${tomado?"disabled":""} aria-pressed="${mios.has(n)}" aria-label="Asiento ${n}${tomado?", ocupado":""}">${n}</button>`;
      }
      panel.innerHTML = `<h4>${nombreMesa(i, id)} · mesa compartida</h4>
        <p class="mm-sub">${i.libres} de ${i.asientos} asientos libres${i.pp!==undefined?" · "+pesos(i.pp)+" por persona":""}. Toca los asientos que quieres.</p>
        <div class="mm-sillas">${botones}</div>
        <button type="button" class="mm-cerrar">Listo</button>`;
      panel.querySelectorAll(".mm-silla").forEach(b=> b.onclick = ()=> alternarAsiento(id, Number(b.dataset.n)));
      panel.querySelector(".mm-cerrar").onclick = cerrarPanel;
    }
    function alternarAsiento(id, n){
      const i = info(id);
      if(i.tomados.has(n)) return;
      const mios = selA.get(id) || new Set();
      if(mios.has(n)) mios.delete(n);
      else{
        if(totalAsientosElegidos() >= maxAsientos){ if(opc.onLimite) opc.onLimite(maxAsientos, "asientos"); return; }
        mios.add(n);
      }
      if(mios.size) selA.set(id, mios); else selA.delete(id);
      pintarEstado(); pintarPanel();
      if(opc.onCambio) opc.onCambio([...sel]);
    }

    function pintarEstado(){
      let hayPorAsiento = false;
      mapa.mesas.forEach(m=>{
        const g = grupos[m.id];
        const i = info(m.id);
        if(i.porAsiento) hayPorAsiento = true;
        g.classList.toggle("ocupada", i.ocupada && !config);
        g.classList.toggle("suelta", i.porAsiento);
        const mios = selA.get(m.id);
        g.classList.toggle("sel", sel.has(m.id) || !!(mios && mios.size));
        g.setAttribute("aria-pressed", (sel.has(m.id) || !!(mios && mios.size)) ? "true" : "false");
        (circulos[m.id]||[]).forEach((c, k)=>{
          c.classList.toggle("tomado", i.porAsiento && i.tomados.has(k+1));
          c.classList.toggle("mio", !!(mios && mios.has(k+1)));
        });
        let etiqueta = `Mesa ${m.id}${i.area?", "+i.area:""}, ${i.s.nombre}, ${i.asientos} personas`;
        if(config) etiqueta += i.porAsiento ? ", se vende por asiento" : ", se vende completa";
        else if(i.ocupada) etiqueta += ", no disponible";
        else if(i.porAsiento) etiqueta += `, mesa compartida, ${i.libres} asientos libres`;
        else if(i.pp!==undefined) etiqueta += `, ${pesos(i.mesa)}`;
        g.setAttribute("aria-label", etiqueta);
      });
      // leyenda con el precio por persona de cada sección
      leyenda.innerHTML = mapa.secciones.map(s=>{
        const ej = Object.values(datos).find(d=>d.seccion===s.id && d.precioPersona!==undefined);
        return `<span><i style="background:${s.color}"></i>${esc(s.nombre)}${ej && !config ? " · " + pesos(ej.precioPersona) + " por persona" : ""}</span>`;
      }).join("")
        + (hayPorAsiento ? `<span><i style="border:2px dashed #F5EFE1"></i>${config?"Por asiento":"Mesa compartida (por asiento)"}</span>` : "")
        + (config ? "" : `<span><i style="background:#334058;border:1px dashed #4a5876"></i>No disponible</span>`);
      nota.textContent = config
        ? "Toca una mesa para cambiarla entre \"completa\" y \"por asiento\". Las de borde punteado se venden por asiento."
        : hayPorAsiento
          ? "Las mesas con borde punteado son mesa compartida: tócalas y elige cuántos asientos quieres (un boleto por asiento). Las demás se compran completas (un boleto por cada persona que cabe). Pasa el cursor (o toca) una mesa para ver su precio."
          : "Cada mesa se compra completa: compras un boleto por cada persona que cabe en la mesa (6, 4, 3 o 2 según la mesa). Pasa el cursor (o toca) una mesa para ver su precio.";
    }

    function actualizar(mesasNuevas){
      datos = {};
      (mesasNuevas||[]).forEach(d=> datos[d.id] = d);
      // si algo elegido ya no está libre (o la mesa cambió de modo), se quita
      let cambio = false;
      [...sel].forEach(id=>{ const i = info(id); if(i.ocupada || i.porAsiento){ sel.delete(id); cambio = true; } });
      [...selA].forEach(([id, mios])=>{
        const i = info(id);
        [...mios].forEach(n=>{ if(!i.porAsiento || i.tomados.has(n)){ mios.delete(n); cambio = true; } });
        if(!mios.size) selA.delete(id);
      });
      if(abierta && !info(abierta).porAsiento) cerrarPanel();
      pintarEstado(); pintarPanel();
      if(cambio && opc.onCambio) opc.onCambio([...sel]);
    }

    actualizar(opc.mesas);
    return {
      seleccion: ()=>[...sel],
      seleccionAsientos: ()=>{
        const out = [];
        mapa.mesas.forEach(m=>{ const s = selA.get(m.id); if(s) [...s].sort((a,b)=>a-b).forEach(n=> out.push({mesa:m.id, asiento:n})); });
        return out;
      },
      info: id => info(id),
      limpiar: ()=>{ sel.clear(); selA.clear(); cerrarPanel(); pintarEstado(); if(opc.onCambio) opc.onCambio([]); },
      actualizar
    };
  }

  window.MapaMesas = { crear };
})();
