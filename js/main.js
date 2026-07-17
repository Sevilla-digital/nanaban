// La ?v= debe subir cada vez que cambie js/api.js: fuerza al navegador a
// pedir el modulo nuevo en vez de servir uno viejo de la cache. Sin esto,
// un HTML nuevo con un js/api.js cacheado viejo rompe todos los botones.
import { api, apiBlob, sesion, dinero, fecha } from './api.js?v=4';

const $ = (id) => document.getElementById(id);
const mostrar = (id, si) => $(id)?.classList.toggle('oculto', !si);

// Prefijos telefonicos. España primero por defecto; el resto alfabetico.
const PAISES = [
    ['🇪🇸 España', '+34'],
    ['🇩🇪 Alemania', '+49'], ['🇦🇩 Andorra', '+376'], ['🇦🇷 Argentina', '+54'],
    ['🇧🇴 Bolivia', '+591'], ['🇧🇷 Brasil', '+55'], ['🇨🇱 Chile', '+56'],
    ['🇨🇴 Colombia', '+57'], ['🇨🇷 Costa Rica', '+506'], ['🇨🇺 Cuba', '+53'],
    ['🇪🇨 Ecuador', '+593'], ['🇸🇻 El Salvador', '+503'], ['🇺🇸 EE. UU. / Canadá', '+1'],
    ['🇫🇷 Francia', '+33'], ['🇬🇹 Guatemala', '+502'], ['🇭🇳 Honduras', '+504'],
    ['🇮🇹 Italia', '+39'], ['🇲🇦 Marruecos', '+212'], ['🇲🇽 México', '+52'],
    ['🇳🇮 Nicaragua', '+505'], ['🇵🇦 Panamá', '+507'], ['🇵🇾 Paraguay', '+595'],
    ['🇵🇪 Perú', '+51'], ['🇵🇹 Portugal', '+351'], ['🇬🇧 Reino Unido', '+44'],
    ['🇺🇾 Uruguay', '+598'], ['🇻🇪 Venezuela', '+58'],
];

function popularPaises() {
    const selPais = $('sel-pais');
    if (!selPais) return;
    for (const [nombre, prefijo] of PAISES) {
        const op = document.createElement('option');
        op.value = prefijo;
        op.textContent = `${nombre} (${prefijo})`;
        selPais.appendChild(op);
    }
}

// Aplica la marca y colores guardados, para que combine con la web publica.
async function aplicarBranding() {
    try {
        const c = await api('/api/sitio');
        if (c.color_primario) document.documentElement.style.setProperty('--primario', c.color_primario);
        if (c.color_fondo) document.documentElement.style.setProperty('--fondo', c.color_fondo);
        if (c.nombre_sitio) {
            for (const id of ['marca', 'marca-panel', 'marca-movil', 'marca-lateral', 'marca-movil-cliente']) {
                if ($(id)) $(id).textContent = c.nombre_sitio;
            }
            document.title = document.title.includes('Nueva Inversión')
                ? 'Nueva Inversión - ' + c.nombre_sitio
                : 'Portal de Clientes - ' + c.nombre_sitio;
        }
    } catch (err) {
        console.warn('No se pudo cargar la configuración del sitio:', err);
    }
}

// Boton del ojo: alterna ver/ocultar la contraseña del campo que lo contiene.
function inicializarVerPass() {
    for (const btn of document.querySelectorAll('.ver-pass')) {
        btn.onclick = () => {
            const input = btn.parentElement.querySelector('input');
            const oculta = input.type === 'password';
            input.type = oculta ? 'text' : 'password';
            btn.querySelector('span').textContent = oculta ? 'visibility' : 'visibility_off';
        };
    }
}

// Crea una fila de tabla con celdas de texto (textContent = sin riesgo de HTML).
function fila(celdas, onClick) {
    const tr = document.createElement('tr');
    for (const c of celdas) {
        const td = document.createElement('td');
        if (c && typeof c === 'object') { td.textContent = c.texto; if (c.clase) td.className = c.clase; }
        else td.textContent = c ?? '';
        tr.appendChild(td);
    }
    if (onClick) { tr.classList.add('clic'); tr.onclick = onClick; }
    return tr;
}

function tablaMovimientos(destino, movimientos) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!movimientos?.length) { cont.innerHTML = '<p class="muted">Sin movimientos.</p>'; return; }
    const tabla = document.createElement('table');
    tabla.innerHTML = '<thead><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Importe</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const m of movimientos) {
        const neg = Number(m.importe) < 0;
        tbody.appendChild(fila([
            fecha(m.creado_en),
            m.tipo.replace('_', ' '),
            m.descripcion,
            { texto: dinero(m.importe), clase: neg ? 'neg' : 'pos' },
        ]));
    }
    tabla.appendChild(tbody);
    cont.appendChild(tabla);
}

function tablaInversiones(destino, inversiones) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!inversiones?.length) { cont.innerHTML = '<p class="muted">No hay inversiones.</p>'; return; }
    const tabla = document.createElement('table');
    tabla.innerHTML = '<thead><tr><th>Fecha</th><th>Plan</th><th>Oro (g)</th><th>Importe</th><th>Estado</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const i of inversiones) {
        tbody.appendChild(fila([fecha(i.abierta_en), i.plan, i.gramos_oro, dinero(i.importe), i.estado]));
    }
    tabla.appendChild(tbody);
    cont.appendChild(tabla);
}

// ---------- Alternar login / registro ----------
function inicializarAuthForms() {
    const irRegistro = $('ir-registro');
    const irLogin = $('ir-login');
    if (irRegistro) {
        irRegistro.onclick = (e) => {
            e.preventDefault();
            mostrar('panel-registro', true); mostrar('panel-login', false);
        };
    }
    if (irLogin) {
        irLogin.onclick = (e) => {
            e.preventDefault();
            mostrar('panel-login', true); mostrar('panel-registro', false);
        };
    }
}

// ---------- Registro ----------
function inicializarRegistro() {
    const form = $('form-registro');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        $('error-registro').textContent = '';
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Creando…';
        try {
            const r = await api('/api/clientes/registro', {
                method: 'POST',
                body: {
                    nombre: form.nombre.value, apellido: form.apellido.value,
                    usuario: form.usuario.value,
                    telefono: form.pais.value + form.telefono.value.replace(/\D/g, ''),
                    password: form.password.value,
                },
            });
            sesion.guardar(r.token, { ...r.cliente, esAdmin: r.cliente.es_admin === true });
            arrancar();
        } catch (err) {
            $('error-registro').textContent = err.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Registrarme';
        }
    };
}

// ---------- Login ----------
function inicializarLogin() {
    const form = $('form-login');
    if (!form) return;
    form.onsubmit = async (e) => {
        e.preventDefault();
        $('error-login').textContent = '';
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Entrando…';
        try {
            const r = await api('/api/clientes/login', {
                method: 'POST',
                body: { usuario: form.usuario.value, password: form.password.value },
            });
            sesion.guardar(r.token, { ...r.cliente, esAdmin: r.cliente.es_admin === true });
            arrancar();
        } catch (err) {
            $('error-login').textContent = err.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Entrar';
        }
    };
}

// ---------- Cerrar sesión (barra de admin, lateral y móvil) ----------
function inicializarCerrarSesion() {
    for (const b of document.querySelectorAll('.cerrar-sesion')) {
        b.onclick = () => { sesion.cerrar(); location.href = 'cuenta.html'; };
    }
}

// Marca el enlace pulsado de la barra lateral como activo.
function inicializarMenuLateral() {
    const ruta = window.location.pathname.split('/').pop();
    const enlaces = {
        'cuenta.html': '#resumen',
        'nueva-inversion.html': 'nueva-inversion.html'
    };

    for (const enlace of document.querySelectorAll('.lateral-enlace')) {
        const href = enlace.getAttribute('href');
        if (href === enlaces[ruta] || (href.includes('cuenta.html') && ruta === 'cuenta.html')) {
            enlace.classList.add('activo');
        } else {
            enlace.classList.remove('activo');
        }
    }
}

// ---------- Vista de cliente (dashboard) ----------

// Crea un elemento con clase y texto.
function el(etiqueta, clase = '', texto = '') {
    const e = document.createElement(etiqueta);
    if (clase) e.className = clase;
    if (texto) e.textContent = texto;
    return e;
}

const iniciales = (nombre, apellido) =>
    (((nombre || '')[0] || '') + ((apellido || '')[0] || '')).toUpperCase() || '·';

// Saldo grande con los decimales en pequeño
function pintarSaldo(destino, valor) {
    const elDestino = $(destino);
    if (!elDestino) return;
    const texto = dinero(valor);
    const punto = texto.lastIndexOf('.');
    elDestino.textContent = '';
    if (punto === -1) { elDestino.textContent = texto; return; }
    elDestino.append(texto.slice(0, punto));
    elDestino.append(el('span', 'decimales', texto.slice(punto)));
}

const ESTADO_INVERSION = { abierta: 'Abierta', cerrada: 'Cerrada', cancelada: 'Cancelada' };

function tarjetasInversiones(destino, inversiones) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!inversiones?.length) {
        cont.appendChild(el('p', 'muted',
            'No tienes inversiones todavía. Haz click en "Nueva Inversión" para empezar.'));
        return;
    }
    for (const i of inversiones) {
        const tarjeta = el('div', 'tarjeta-inversion');

        const cima = el('div', 'cima');
        const titulos = el('div');
        titulos.appendChild(el('h4', '', i.plan));
        titulos.appendChild(el('p', 'sub', 'Abierta el ' + fecha(i.abierta_en)));
        const icono = el('span', 'material-symbols-outlined icono-inversion', 'workspace_premium');
        cima.append(titulos, icono);
        tarjeta.appendChild(cima);

        const datos = [
            ['Invertido', dinero(i.importe)],
            ['Oro', `${i.gramos_oro} g`],
            ['Estado', ESTADO_INVERSION[i.estado] ?? i.estado],
        ];
        for (const [etiqueta, valor] of datos) {
            const fila = el('div', 'dato');
            fila.appendChild(el('span', 'etiqueta', etiqueta));
            fila.appendChild(el('span', '', valor));
            tarjeta.appendChild(fila);
        }
        cont.appendChild(tarjeta);
    }
}

const ICONO_TIPO = {
    deposito: 'arrow_downward',
    retiro: 'arrow_upward',
    compra_oro: 'shopping_cart',
    venta_oro: 'sell',
    ajuste: 'tune',
};

function movimientosCliente(destino, movimientos) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!movimientos?.length) {
        const vacio = el('p', 'muted', 'Sin movimientos todavía.');
        vacio.style.padding = '24px';
        cont.appendChild(vacio);
        return;
    }
    const tabla = document.createElement('table');
    tabla.innerHTML =
        '<thead><tr><th>Fecha</th><th>Concepto</th><th>Estado</th><th class="der">Monto</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const m of movimientos) {
        const positivo = Number(m.importe) > 0;
        const tr = document.createElement('tr');

        tr.appendChild(el('td', '', fecha(m.creado_en)));

        const concepto = el('div', 'concepto');
        const icono = el('span', 'icono-mov' + (positivo ? '' : ' neutro'));
        icono.appendChild(el('span', 'material-symbols-outlined', ICONO_TIPO[m.tipo] ?? 'receipt'));
        concepto.append(icono, el('span', '', m.descripcion));
        const tdConcepto = document.createElement('td');
        tdConcepto.appendChild(concepto);
        tr.appendChild(tdConcepto);

        const estado = el('div', 'estado-mov');
        estado.append(el('span', 'punto-ok'), 'Completado');
        const tdEstado = document.createElement('td');
        tdEstado.appendChild(estado);
        tr.appendChild(tdEstado);

        tr.appendChild(el('td', 'der' + (positivo ? ' monto-pos' : ''),
            (positivo ? '+' : '') + dinero(m.importe)));

        tbody.appendChild(tr);
    }
    tabla.appendChild(tbody);
    cont.appendChild(tabla);
}

async function cargarCliente() {
    try {
        const yo = await api('/api/clientes/me', { auth: true });
        if ($('cliente-nombre')) $('cliente-nombre').textContent = `${yo.nombre} ${yo.apellido || ''}`.trim();
        if ($('cliente-usuario')) $('cliente-usuario').textContent = '@' + (yo.usuario ?? '');
        if ($('cliente-avatar')) $('cliente-avatar').textContent = iniciales(yo.nombre, yo.apellido);
        pintarSaldo('cliente-saldo', yo.saldo);
        tarjetasInversiones('cliente-inversiones', yo.inversiones);
        const mov = await api('/api/clientes/me/movimientos', { auth: true });
        movimientosCliente('cliente-movimientos', mov.movimientos);
    } catch (err) {
        // Token caducado u otro fallo: api() ya limpia la sesion en un 401.
        if (!sesion.token) { arrancar(); return; }
        alert(err.message);
    }
}

// ---------- Recargar saldo (cliente) ----------
const DURACION_RECARGA = 5 * 60; // segundos que da el temporizador para pagar
let cronoInterval = null;
let recargaEnCurso = null; // { metodo, monto }
let comprobanteDataUrl = null; // data URL del comprobante (solo banco)

// Suma dos importes en dolares sin errores de coma flotante (trabaja en centavos).
const sumarDolares = (a, b) =>
    ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);

function inicializarRecarga() {
    const btnAbrir = $('abrir-recarga');
    const btnVolver = $('recarga-volver');
    if (btnAbrir) {
        btnAbrir.onclick = () => {
            mostrar('vista-cliente', false);
            mostrar('vista-recarga', true);
            $('error-recarga').textContent = '';
            cargarMetodosRecarga();
        };
    }
    if (btnVolver) {
        btnVolver.onclick = () => {
            mostrar('vista-recarga', false);
            mostrar('vista-cliente', true);
        };
    }

    const comprobanteInput = $('comprobante-file');
    if (comprobanteInput) {
        comprobanteInput.onchange = () => {
            const archivo = comprobanteInput.files[0];
            comprobanteDataUrl = null;
            $('ya-pague').disabled = true;
            $('error-modal').textContent = '';
            if (!archivo) return;
            if (archivo.size > 5 * 1024 * 1024) {
                $('error-modal').textContent = 'El comprobante supera los 5 MB.';
                comprobanteInput.value = '';
                return;
            }
            const lector = new FileReader();
            lector.onload = () => { comprobanteDataUrl = lector.result; $('ya-pague').disabled = false; };
            lector.onerror = () => { $('error-modal').textContent = 'No se pudo leer el archivo.'; };
            lector.readAsDataURL(archivo);
        };
    }

    const btnYaPague = $('ya-pague');
    if (btnYaPague) {
        btnYaPague.onclick = async () => {
            if (!recargaEnCurso) return;
            $('error-modal').textContent = ''; $('ok-modal').textContent = '';
            const cuerpo = { metodoId: recargaEnCurso.metodo.id, monto: recargaEnCurso.monto };
            if (recargaEnCurso.metodo.tipo === 'banco') {
                if (!comprobanteDataUrl) {
                    $('error-modal').textContent = 'Sube tu comprobante de pago antes de continuar.';
                    return;
                }
                cuerpo.comprobante = comprobanteDataUrl;
            }
            btnYaPague.disabled = true; btnYaPague.textContent = 'Registrando…';
            try {
                await api('/api/pagos/recargas', { method: 'POST', auth: true, body: cuerpo });
                clearInterval(cronoInterval);
                $('ok-modal').textContent = 'Recarga registrada. Se abonará en cuanto verifiquemos el pago.';
                btnYaPague.textContent = 'Registrado ✓';
                setTimeout(() => {
                    cerrarModal();
                    mostrar('vista-recarga', false);
                    mostrar('vista-cliente', true);
                    cargarCliente();
                }, 1800);
            } catch (err) {
                $('error-modal').textContent = err.message;
                btnYaPague.disabled = false; btnYaPague.textContent = 'Ya realicé el pago';
            }
        };
    }

    const modalPago = $('modal-pago');
    if (modalPago) {
        $('cerrar-modal').onclick = cerrarModal;
        modalPago.onclick = (e) => { if (e.target === modalPago) cerrarModal(); };
    }
}

async function cargarMetodosRecarga() {
    const cont = $('recarga-metodos');
    if (!cont) return;
    cont.innerHTML = '';
    cont.appendChild(el('p', 'muted', 'Cargando métodos…'));
    try {
        const { metodos } = await api('/api/pagos/metodos', { auth: true });
        cont.innerHTML = '';
        const bancos = metodos.filter((m) => m.tipo === 'banco');
        const criptos = metodos.filter((m) => m.tipo === 'cripto');
        if (!bancos.length && !criptos.length) {
            cont.appendChild(el('p', 'muted',
                'Aún no hay métodos de pago disponibles. Escríbenos y te ayudamos.'));
            return;
        }
        if (bancos.length) {
            cont.appendChild(tarjetaMetodos('Cuentas bancarias',
                'Transferencia directa desde bancos locales. Acreditación en 24-48 h hábiles.',
                'account_balance', bancos));
        }
        if (criptos.length) {
            cont.appendChild(tarjetaMetodos('Criptomonedas',
                'Depósito a través de redes blockchain.', 'currency_bitcoin', criptos));
        }
    } catch (err) {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'error', err.message));
    }
}

function tarjetaMetodos(titulo, desc, icono, metodos) {
    const tarjeta = el('div', 'tarjeta-metodo');
    const cabezal = el('div', 'cabezal');
    const cuadro = el('div', 'cuadro-icono');
    cuadro.appendChild(el('span', 'material-symbols-outlined', icono));
    cabezal.append(cuadro, el('h2', '', titulo));
    tarjeta.appendChild(cabezal);
    tarjeta.appendChild(el('p', 'descripcion', desc));
    const lista = el('div', 'lista-opciones');
    for (const m of metodos) {
        const btn = el('button', 'opcion-metodo');
        btn.type = 'button';
        const izq = el('div', 'izq');
        izq.append(
            el('div', 'redondo', (m.etiqueta || '?').slice(0, 2).toUpperCase()),
            el('span', 'nombre', m.etiqueta + (m.red ? ' · ' + m.red : ''))
        );
        btn.append(izq, el('span', 'material-symbols-outlined', 'chevron_right'));
        btn.onclick = () => abrirModalPago(m);
        lista.appendChild(btn);
    }
    tarjeta.appendChild(lista);
    return tarjeta;
}

function abrirModalPago(metodo) {
    const montoInput = $('recarga-monto');
    const monto = (montoInput.value || '').trim().replace(',', '.');
    if (!/^\d{1,15}(\.\d{1,2})?$/.test(monto) || Number(monto) < 10) {
        $('error-recarga').textContent = 'Introduce un monto de al menos $10 antes de elegir un método.';
        montoInput.focus();
        return;
    }
    $('error-recarga').textContent = '';
    recargaEnCurso = { metodo, monto };

    const esBanco = metodo.tipo === 'banco';
    $('modal-titulo').textContent = esBanco ? 'Transferencia bancaria' : 'Depósito en cripto';

    const comision = esBanco ? '0' : (metodo.comision ?? '0');
    const total = sumarDolares(monto, comision);
    $('modal-sub').textContent = `Envía exactamente ${dinero(esBanco ? monto : total)} a estos datos:`;

    const datos = $('modal-datos');
    datos.innerHTML = '';
    const filas = esBanco
        ? [['Banco', metodo.etiqueta, false], ['Titular', metodo.titular, false],
           ['Cuenta', metodo.numero_cuenta, true], ['Moneda', metodo.moneda, false],
           ...(metodo.notas ? [['Nota', metodo.notas, false]] : []),
           ['Monto', dinero(monto), true]]
        : [['Moneda', metodo.etiqueta, false], ['Red', metodo.red, false],
           ['Dirección', metodo.direccion, true],
           ...(metodo.notas ? [['Nota', metodo.notas, false]] : []),
           ['Monto a acreditar', dinero(monto), false],
           ['Comisión de red', dinero(comision), false],
           ['Total a enviar', dinero(total), true]];

    for (const [k, v, copiable] of filas) {
        const fila = el('div', 'dato-pago');
        fila.appendChild(el('span', 'k', k));
        if (copiable) {
            const caja = el('div');
            caja.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';
            caja.appendChild(el('span', 'v', v));
            const b = el('button', 'copiar');
            b.type = 'button';
            b.appendChild(el('span', 'material-symbols-outlined', 'content_copy'));
            b.append('Copiar');
            b.onclick = () => copiar(v, b);
            caja.appendChild(b);
            fila.appendChild(caja);
        } else {
            fila.appendChild(el('span', 'v', v));
        }
        datos.appendChild(fila);
    }

    comprobanteDataUrl = null;
    $('comprobante-file').value = '';
    mostrar('modal-comprobante', esBanco);

    $('error-modal').textContent = ''; $('ok-modal').textContent = '';
    const yaPague = $('ya-pague');
    yaPague.disabled = esBanco; yaPague.textContent = 'Ya realicé el pago';
    $('cronometro').classList.remove('agotado');
    mostrar('modal-pago', true);
    iniciarCrono();
}

function iniciarCrono() {
    clearInterval(cronoInterval);
    let restante = DURACION_RECARGA;
    const pinta = () => {
        const mm = String(Math.floor(restante / 60)).padStart(2, '0');
        const ss = String(restante % 60).padStart(2, '0');
        $('cronometro-tiempo').textContent = `${mm}:${ss}`;
    };
    pinta();
    cronoInterval = setInterval(() => {
        restante -= 1;
        pinta();
        if (restante <= 0) {
            clearInterval(cronoInterval);
            $('cronometro').classList.add('agotado');
            $('error-modal').textContent =
                'Se agotó el tiempo. Si ya pagaste puedes registrarlo igualmente; si no, cierra y vuelve a empezar.';
        }
    }, 1000);
}

function cerrarModal() {
    clearInterval(cronoInterval);
    mostrar('modal-pago', false);
    recargaEnCurso = null;
}

async function copiar(texto, btn) {
    try {
        await navigator.clipboard.writeText(texto);
        const span = btn.querySelector('span');
        span.textContent = 'check';
        setTimeout(() => { span.textContent = 'content_copy'; }, 1500);
    } catch { /* el navegador puede bloquear el portapapeles; se copia a mano */ }
}

// ---------- Lógica de arranque ----------
async function arrancar() {
    const autenticado = !!sesion.token;
    mostrar('vista-auth', !autenticado);
    mostrar('barra-top', autenticado && sesion.esAdmin);
    mostrar('vista-cliente', false);
    mostrar('vista-recarga', false);
    mostrar('modal-pago', false);
    mostrar('vista-admin', false);

    if (!autenticado) {
        // Si no está autenticado, solo mostramos el formulario de login/registro
        mostrar('vista-auth', true);
        return;
    }

    // Si está autenticado, mostramos el panel del cliente y cargamos sus datos
    try {
        if (sesion.esAdmin) {
            mostrar('vista-admin', true);
            const { inicializarAdmin } = await import('./admin.js');
            inicializarAdmin();
        } else {
            mostrar('vista-cliente', true);
            await cargarCliente();
        }
    } catch (err) {
        if (!sesion.token) { arrancar(); return; }
        alert(err.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    aplicarBranding();
    popularPaises();
    inicializarVerPass();
    inicializarAuthForms();
    inicializarRegistro();
    inicializarLogin();
    inicializarCerrarSesion();
    inicializarRecarga();
    inicializarMenuLateral();
    arrancar();
});
