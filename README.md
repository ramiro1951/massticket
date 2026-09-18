# massticket.mx

Boletera con cobro real por Mercado Pago (Checkout Pro), confirmación de pago
por webhook, generación de boletos con QR, control de acceso en puerta y
panel del organizador.

Ahora soporta **varios eventos a la vez**: la página de inicio los lista con
su imagen, y cada uno tiene su propia página de compra, su propio cupo y sus
propios boletos.

```
massticket/
  server/     ← backend en Node.js + Express (lo que hay que desplegar)
  public/
    index.html    ← inicio: lista todos los eventos (con imagen)
    comprar.html  ← compra de UN evento (se abre como comprar.html?evento=ID)
    gracias.html  ← a donde regresa el comprador; muestra el boleto con QR
    admin.html    ← tu panel: pestaña Eventos (crear/editar) + Puerta,
                     Boletos, Venta manual y Panel, cada una con un
                     selector para elegir de qué evento
```

El `server` sirve también los archivos de `public`, así que **solo se
despliega una cosa**: la carpeta `server` (con `public` al lado, como ya
está en este proyecto).

**Sobre las claves (`ADMIN_KEY`, `MP_ACCESS_TOKEN`, etc.):** dentro de
`server/` viene `env-ejemplo.txt` con la lista completa y una explicación
de cada una. Ese archivo es solo de referencia — ábrelo, copia su
contenido y pégalo en las "Environment Variables" del hosting que uses
(Render, Railway, o el panel de la VPS), reemplazando cada valor de
ejemplo por el tuyo. Si además quieres probar el proyecto en tu propia
computadora antes de subirlo, copia ese texto a un archivo nuevo llamado
exactamente `.env` (con el punto al inicio) dentro de `server/` — ese
nombre lo lee automáticamente el servidor. Ojo: los archivos que empiezan
con punto suelen quedar ocultos en Mac/Windows; si no lo ves después de
crearlo, es normal, ahí sigue.

---

## 1. Consigue tus credenciales de Mercado Pago

1. Entra a **mercadopago.com.mx/developers/panel** con la cuenta de vendedor
   que ya tienes.
2. Crea una aplicación (o usa una existente) → pestaña **Credenciales de
   producción** → copia el **Access Token**. Empieza con `APP_USR-...`.
   Esa es tu `MP_ACCESS_TOKEN`.
3. En la misma aplicación, ve a **Webhooks** → **Configurar notificaciones**.
   Ahí vas a pegar la URL del webhook *después* del paso 3 (cuando ya tengas
   tu backend desplegado, la URL es `https://massticket.mx/api/webhook/mercadopago`).
   Al guardar, Mercado Pago te da una **Clave secreta** — esa es tu
   `MP_WEBHOOK_SECRET`. Selecciona el evento **Pagos**.

No compartas el Access Token con nadie ni lo pegues en el chat de Claude:
va directo como variable de entorno en tu hosting, nunca en el código.

## 2. Elige dónde correr el backend

Necesitas un hosting que corra Node.js todo el tiempo (no solo archivos
estáticos, porque el webhook tiene que estar escuchando). Opciones sencillas
y con plan gratuito o barato: **Railway**, **Render** o un VPS pequeño.
Los pasos de abajo son con Railway; en Render es prácticamente igual.

1. Sube esta carpeta (`massticket/`) a un repositorio de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** → selecciona el
   repo. Cuando pregunte el **Root Directory**, pon `server`.
3. En la pestaña **Variables** del proyecto, agrega:
   - `MP_ACCESS_TOKEN` → el Access Token del paso 1
   - `MP_WEBHOOK_SECRET` → la clave secreta del paso 1
   - `ADMIN_KEY` → una clave larga que inventes tú para entrar a `/admin.html`
   - `PUBLIC_URL` → `https://massticket.mx` (sin diagonal al final)
4. Railway detecta el `package.json` y corre `npm install && npm start`
   solo. Espera a que el deploy termine y te dé una URL temporal tipo
   `algo.up.railway.app` — pruébala antes de conectar el dominio.

## 3. Conecta massticket.mx (comprado en Bluehost, plan Básico)

El plan Básico de Bluehost es hosting compartido: perfecto para tu sitio
normal, correo, etc., pero no corre una app de Node.js que se quede
escuchando todo el tiempo — y eso es justo lo que necesita el webhook de
Mercado Pago. Por eso el backend vive en Railway/Render y Bluehost solo
presta el dominio. No hace falta cambiar de plan.

1. En Railway (o Render): **Settings → Domains → Custom Domain** → escribe
   `massticket.mx` (agrega también `www.massticket.mx` si quieres). Te va a
   dar uno o dos registros DNS — normalmente un **CNAME** para `www` y un
   registro **A** (con una IP) para el dominio raíz `massticket.mx`.
2. Entra a **bluehost.com/my-account** → inicia sesión → busca tu dominio
   `massticket.mx` y entra a su sección de **DNS** (en Bluehost suele
   llamarse "DNS" o "Zone Editor", dentro del panel del dominio o del
   cPanel).
3. Ahí reemplaza cualquier registro que ya exista para ese nombre por los
   que te dio Railway/Render en el paso 1:
   - Tipo **A**, nombre `@` (o vacío = `massticket.mx`), valor: la IP que
     te dieron.
   - Tipo **CNAME**, nombre `www`, valor: el dominio tipo
     `algo.up.railway.app` que te dieron.
4. Guarda. El cambio puede tardar de minutos a un par de horas en
   propagarse — Bluehost suele mostrar el tiempo estimado en esa misma
   pantalla.
5. Cuando `https://massticket.mx` cargue la tienda (no una página de
   Bluehost ni un error), sigue con el paso 4 de abajo.

Si no encuentras la sección de DNS en tu cuenta, pídele al chat de soporte
de Bluehost que te lleve a "editar los registros DNS de massticket.mx" —
es una pantalla estándar, solo cambia un poco de lugar según el tema del
panel.

## 4. Termina de configurar el webhook

Regresa a Mercado Pago → tu aplicación → Webhooks, y confirma que la URL
registrada sea exactamente:

```
https://massticket.mx/api/webhook/mercadopago
```

Mercado Pago tiene un botón de **Simular notificación** en esa misma
pantalla — úsalo para probar que tu servidor responde antes de vender de
verdad.

## 5. Prueba de punta a punta

1. Ve a `https://massticket.mx` → compra un boleto con un pago real
   pequeño (o con las tarjetas de prueba de Mercado Pago si tu app todavía
   está en modo sandbox).
2. Deberías caer en `gracias.html` y, en unos segundos, ver tu boleto con
   QR — eso confirma que el webhook llegó y disparó la generación del
   boleto.
3. Entra a `https://massticket.mx/admin.html`, mete tu `ADMIN_KEY`, y en
   **Puerta** valida el folio que acabas de generar.

## Crear y administrar tus eventos

Desde `admin.html` → pestaña **Eventos** puedes crear todos los eventos
que quieras — cada uno con su nombre, fecha, lugar, precio, cupo y cartel.
Cada evento creado aparece automáticamente en la página de inicio
(`massticket.mx`) con su imagen, y tiene su propia página de compra
(el botón "Ver página" en esa pestaña te da el link exacto,
`comprar.html?evento=...`, que es el que compartes para ese evento en
particular).

En **Puerta**, **Boletos**, **Venta manual** y **Panel** hay un selector
arriba para elegir sobre cuál evento estás trabajando — así puedes tener
varios eventos corriendo al mismo tiempo sin mezclar sus boletos ni su
cupo.

## Notas importantes

- **Los boletos y ventas se guardan en un archivo** (`server/data/db.json`)
  en el propio servidor. Sirve perfecto para eventos de tamaño chico o
  mediano. Si Railway/Render reinicia el contenedor sin un volumen
  persistente configurado, ese archivo se puede perder — actívales un
  **volumen persistente** apuntando a `server/data`, o pide que se
  migre a una base de datos real (Postgres) si vas a vender boletos todo
  el año.
- **La verdad de un pago es siempre el webhook**, nunca la pantalla de
  regreso del navegador — así está armado el servidor. Eso evita que
  alguien "invente" boletos cerrando el navegador antes de que Mercado
  Pago confirme.
- **`/admin.html` solo tiene la contraseña `ADMIN_KEY`** como protección.
  Es suficiente para un equipo chico que confía entre sí, pero no es un
  sistema de usuarios con roles — cualquiera con esa clave puede validar
  boletos y cambiar el evento.
