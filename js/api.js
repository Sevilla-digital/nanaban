// Cliente de la API de Gold Corp. La web es estatica (GitHub Pages) y la API vive
// en Render, asi que todas las llamadas salen a este dominio.
export const API = 'https://goldcorp-api.onrender.com';

const TOKEN_KEY = 'goldcorp_token';
const CLIENTE_KEY = 'goldcorp_cliente';

export const sesion = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  get cliente() {
    try {
      return JSON.parse(localStorage.getItem(CLIENTE_KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  get esAdmin() {
    return this.cliente?.esAdmin === true || this.cliente?.es_admin === true;
  },
  guardar(token, cliente) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(CLIENTE_KEY, JSON.stringify(cliente));
  },
  cerrar() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CLIENTE_KEY);
  },
};

/** Llama a la API. Lanza un Error con el mensaje del servidor si la respuesta no es 2xx. */
export async function api(ruta, { method = 'GET', body, auth = false } = {}) {
  const cabeceras = {};
  if (body !== undefined) cabeceras['content-type'] = 'application/json';
  if (auth) {
    const t = sesion.token;
    if (!t) throw new Error('No has iniciado sesion');
    cabeceras.authorization = `Bearer ${t}`;
  }

  let resp;
  try {
    resp = await fetch(API + ruta, {
      method: method,
      headers: cabeceras,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // El servicio gratuito de Render se duerme tras 15 min; la primera llamada
    // puede tardar ~30s o fallar. Damos un mensaje entendible, no un stack.
    throw new Error('No se pudo contactar con el servidor. Intentalo de nuevo en un momento.');
  }

  let datos = null;
  try {
    datos = await resp.json();
  } catch {
    /* respuesta sin cuerpo */
  }

  if (resp.status === 401 && auth) {
    // Token caducado o invalido: limpiamos la sesion para no quedar en un limbo.
    sesion.cerrar();
  }
  if (!resp.ok) {
    const err = new Error(datos?.error ?? `Error ${resp.statusText}`);
    // Cuenta baneada: se adjuntan los datos para que la web muestre la pantalla
    // de "Cuenta baneada" con la razon que escribio el admin.
    if (datos?.baneado) {
      err.baneado = true;
      err.razon = datos.razon || '';
    }
    throw err;
  }
  return datos;
}

/**
 * Descarga binaria autenticada (p. ej. el comprobante de una recarga). Devuelve un
 * Blob; el llamante crea la object URL. Necesario porque una <img src> normal no
 * puede mandar la cabecera Authorization.
 */
export async function apiBlob(ruta) {
  const t = sesion.token;
  const resp = await fetch(API + ruta, {
    headers: t ? { authorization: `Bearer ${t}` } : {},
  });
  if (resp.status === 401) sesion.cerrar();
  if (!resp.ok) throw new Error(`Error ${resp.status}`);
  return resp.blob();
}

/**
 * Formatea un importe (que viaja como string "1500.50") a "$1,500.50".
 * La moneda de la plataforma es el dolar estadounidense (USD).
 */
export function dinero(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function fecha(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
