# Conexión con Google (Gratis — 1 sola vez)

Para que tu hermana solo tenga que tocar **"Entrar con Google"** y el sistema cree automáticamente su carpeta, su hoja de Google Sheets y suba sus fotos a Google Drive, Google pide 2 cosas (ambas **100% gratis**, sin tarjeta de crédito):

1. **Un enlace `https://` público** (Google Sign-In no funciona abriendo un archivo `file://` directo).
   - La forma más rápida: arrastra esta carpeta a **Netlify Drop** (`app.netlify.com/drop`) o súbela a **GitHub Pages**. Te dará un enlace `https://...` gratis.

2. **Un "Google OAuth Client ID"** (se crea 1 sola vez en Google Cloud Console):
   1. Entra a [Google Cloud Console](https://console.cloud.google.com/) con tu cuenta Gmail.
   2. Crea un proyecto nuevo (ej. `Amway RD`).
   3. En **APIs & Services > Library**, activa estas dos APIs:
      - **Google Drive API**
      - **Google Sheets API**
   4. En **APIs & Services > OAuth consent screen**:
      - Elige **External**, pon el nombre de la app (`Mi Negocio Amway RD`) y tu correo.
      - En **Test users**, agrega el correo Gmail de tu hermana (y el tuyo) mientras esté en modo prueba.
   5. En **APIs & Services > Credentials > Create Credentials > OAuth client ID**:
      - Tipo: **Web application**.
      - En **Authorized JavaScript origins**, pega tu enlace `https://...` (ej. `https://tu-sitio.netlify.app`).
   6. Copia el **Client ID** (`xxxx.apps.googleusercontent.com`).
      - Puedes pegarlo en la app dentro de **⚙️ Opciones > ID de Cliente Google**, o pegarlo en `DEFAULT_GOOGLE_CLIENT_ID` dentro de `app.js` para que ella ni siquiera tenga que escribirlo.

## Qué pasa cuando tu hermana toca "Entrar con Google"
1. Elige su cuenta de Google y toca **Permitir**.
2. La app crea automáticamente en su Drive la carpeta **`Amway RD - Mi Negocio`** y la hoja **`Inventario Amway RD`** (con pestañas `Inventario` y `Catalogo`).
3. Cada producto y cada foto que agregue se guarda en el teléfono (para funcionar rápido) y se sincroniza con su Google Sheet y Google Drive.
4. Si quiere que tú le ayudes desde Hazleton con sus 3 productos principales, solo comparte esa hoja de Google Sheets con tu Gmail.
