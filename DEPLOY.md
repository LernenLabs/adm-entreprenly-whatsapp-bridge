# Despliegue del puente (Docker + túnel)

El backend de Entreprenly corre en Render y necesita alcanzar este puente por una URL pública.
La forma más simple y gratis es correr el puente en cualquier PC y exponerlo con un túnel.

## 1. Requisitos

- Git y Docker (Docker Desktop en Windows/macOS, Docker Engine en Linux). Alternativa sin Docker:
  Node.js 20 o superior.
- `cloudflared` (Cloudflare Tunnel) o `ngrok`.
- Unos 1 GB de RAM libres (Chromium).
- Un número de WhatsApp **solo para pruebas**: es una integración no oficial y el número puede ser baneado.

## 2. Levantar el puente

```bash
git clone https://github.com/LernenLabs/adm-entreprenly-whatsapp-bridge.git
cd adm-entreprenly-whatsapp-bridge
cp .env.example .env     # edita BRIDGE_TOKEN, SWITCH_TOKEN, OWNER_EMAIL, etc.
docker compose up -d --build
```

Sin Docker: `npm install` y `npm start` (con el mismo `.env`).

Comprueba `http://localhost:3001/health`.

## 3. Exponerlo con un túnel

```bash
cloudflared tunnel --url http://localhost:3001
```

Copia la URL `https://…` que imprime y comprueba `https://<url>/health`. Con ngrok:
`ngrok http 3001`.

## 4. Configurar el backend (Render)

En el servicio `adm-entreprenly-backend` → Environment:

| Variable | Valor |
|---|---|
| `WHATSAPP_BRIDGE_BASE_URL` | URL pública del túnel, sin `/` al final |
| `WHATSAPP_BRIDGE_TOKEN` | el mismo `BRIDGE_TOKEN` del `.env` |
| `WHATSAPP_ENABLED` | `true` |

Al guardar, Render redespliega solo.

## 5. Notas

- Con el túnel rápido de Cloudflare la URL cambia en cada reinicio: hay que actualizarla en Render.
  ngrok gratis ofrece un dominio fijo.
- La sesión de WhatsApp se guarda en el volumen `wwebjs_auth`; no lo borres si no quieres volver a
  escanear el QR.
- La página `/` es una vista de estado sin contraseña: no compartas la URL del túnel.
- Nunca subas el `.env` ni los tokens al repositorio.
