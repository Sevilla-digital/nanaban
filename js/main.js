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
            const params = new URLSearchParams(window.location.search);
            const ref = params.get('ref') || undefined;
            const r = await api('/api/clientes/registro', {
                method: 'POST',
                body: {
                    nombre: form.nombre.value, apellido: form.apellido.value,
                    usuario: form.usuario.value,
                    telefono: form.pais.value + form.telefono.value.replace(/\D/g, ''),
                    password: form.password.value,
                    ref,
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
            sesion.guardar(r.token, { ...r.cliente, esAdmin: r.cliente.esAdmin === true || r.cliente.es_admin === true });
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
    
    const actualizarVista = (hash) => {
        if (!window.location.pathname.endsWith('cuenta.html')) return;
        
        const referidos = document.getElementById('sec-referidos');
        const resumen = document.getElementById('resumen');
        const inversiones = document.getElementById('sec-inversiones');
        const movimientos = document.getElementById('sec-movimientos');
        
        if (!referidos || !resumen) return;

        if (hash === '#sec-referidos') {
            resumen.style.display = 'none';
            inversiones.style.display = 'none';
            movimientos.style.display = 'none';
            referidos.style.display = 'block';
        } else {
            resumen.style.display = ''; // Se usa la clase original
            inversiones.style.display = '';
            movimientos.style.display = '';
            referidos.style.display = 'none';
        }
    };

    window.addEventListener('hashchange', () => {
        actualizarVista(window.location.hash);
        const hash = window.location.hash || enlaces[ruta];
        for (const enlace of document.querySelectorAll('.lateral-enlace')) {
            const href = enlace.getAttribute('href');
            if (href === hash || (href === 'cuenta.html' && hash === enlaces['cuenta.html'])) {
                enlace.classList.add('activo');
            } else {
                enlace.classList.remove('activo');
            }
        }
    });

    actualizarVista(window.location.hash);

    const currentHash = window.location.hash || enlaces[ruta];
    for (const enlace of document.querySelectorAll('.lateral-enlace')) {
        const href = enlace.getAttribute('href');
        if (href === currentHash || (href.includes('cuenta.html') && ruta === 'cuenta.html' && !window.location.hash)) {
            enlace.classList.add('activo');
        } else {
            enlace.classList.remove('activo');
        }
        enlace.addEventListener('click', () => {
            document.querySelectorAll('.lateral-enlace').forEach(e => e.classList.remove('activo'));
            enlace.classList.add('activo');
        });
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
    comision_referido: 'group',
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
        let textoEstado = 'Completado';
        let clasePunto = 'punto-ok';
        
        if (m.retiro_estado === 'pendiente') {
            textoEstado = 'Pendiente';
            clasePunto = 'punto-wait';
        } else if (m.retiro_estado === 'rechazado') {
            textoEstado = 'Rechazado';
            clasePunto = 'punto-err';
        }
        
        estado.append(el('span', clasePunto), textoEstado);
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

function referidosCliente(destino, referidos) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!referidos?.length) {
        const vacio = el('p', 'muted', 'Aún no has invitado a nadie.');
        vacio.style.padding = '24px';
        cont.appendChild(vacio);
        return;
    }
    const tabla = document.createElement('table');
    tabla.innerHTML = '<thead><tr><th>Fecha de registro</th><th>Nombre</th><th>Usuario</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const r of referidos) {
        const tr = document.createElement('tr');
        tr.appendChild(el('td', '', fecha(r.creado_en)));
        tr.appendChild(el('td', '', `${r.nombre} ${r.apellido || ''}`.trim()));
        tr.appendChild(el('td', '', '@' + (r.usuario || '')));
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
        
        const ref = await api('/api/clientes/referidos', { auth: true });
        if ($('link-referido')) {
            $('link-referido').value = `${window.location.origin}/cuenta.html?ref=${yo.usuario || ''}`;
            $('btn-copiar-link').onclick = async () => {
                try {
                    await navigator.clipboard.writeText($('link-referido').value);
                    $('btn-copiar-link').textContent = '¡Copiado!';
                    setTimeout(() => { $('btn-copiar-link').textContent = 'Copiar'; }, 1500);
                } catch { }
            };
        }
        referidosCliente('cliente-referidos', ref.referidos);
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

// ---------- Retiros ----------
let metodosRetiro = [];
let metodoRetiroSel = null;

async function cargarMetodosRetiro() {
    try {
        const { metodos } = await api('/api/retiros/metodos', { auth: true });
        metodosRetiro = metodos;
        renderizarMetodosRetiro();
    } catch (err) {
        $('retiro-metodos-lista').innerHTML = '<p class="error">Error al cargar métodos</p>';
    }
}

function renderizarMetodosRetiro() {
    const cont = $('retiro-metodos-lista');
    cont.innerHTML = '';
    if (metodosRetiro.length === 0) {
        cont.innerHTML = '<p class="muted" style="grid-column: span 2; font-size:13px;">No tienes cuentas añadidas. Añade una para retirar.</p>';
        metodoRetiroSel = null;
        return;
    }

    if (!metodoRetiroSel || !metodosRetiro.find(m => m.id === metodoRetiroSel)) {
        metodoRetiroSel = metodosRetiro[0].id;
    }

    for (const m of metodosRetiro) {
        const lbl = document.createElement('label');
        lbl.className = 'metodo-retiro-card';
        lbl.style.cssText = 'position:relative; display:flex; flex-direction:column; padding:16px; border:1px solid #333; background:var(--superficie); border-radius:8px; cursor:pointer; transition:all 0.2s;';
        
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'metodo_retiro';
        radio.className = 'sr-only metodo-retiro-radio';
        radio.style.display = 'none';
        radio.checked = m.id === metodoRetiroSel;
        radio.onchange = () => { metodoRetiroSel = m.id; };
        
        const div = document.createElement('div');
        div.style.cssText = 'height:100%; display:flex; flex-direction:column; padding:16px; margin:-16px; border-radius:8px; transition:all 0.2s; border:1px solid transparent;';
        
        const top = document.createElement('div');
        top.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;';
        
        let iconName = 'account_balance';
        if (m.tipo === 'movil') iconName = 'smartphone';
        if (m.tipo === 'cripto') iconName = 'currency_bitcoin';

        top.innerHTML = `
            <span class="material-symbols-outlined" style="color:var(--texto-suave);">${iconName}</span>
            <span class="material-symbols-outlined metodo-check" style="font-size:18px; color:transparent; transition:color 0.2s;">check_circle</span>
        `;
        
        let titulo = '';
        let subtitulo = '';
        if (m.tipo === 'banco') {
            titulo = m.banco_nombre;
            subtitulo = m.numero_cuenta;
        } else if (m.tipo === 'movil') {
            titulo = m.banco_nombre || 'Billetera Móvil';
            subtitulo = m.telefono_movil;
        } else if (m.tipo === 'cripto') {
            titulo = m.cripto_red;
            subtitulo = m.cripto_direccion;
        }

        const titleEl = document.createElement('span');
        titleEl.style.cssText = 'font-size:14px; font-weight:500; color:var(--texto-principal); margin-bottom:4px;';
        titleEl.textContent = titulo;
        
        const subEl = document.createElement('span');
        subEl.style.cssText = 'font-size:12px; color:var(--texto-suave); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        subEl.textContent = subtitulo;

        div.append(top, titleEl, subEl);
        lbl.append(radio, div);
        cont.appendChild(lbl);
    }
}

function inicializarRetiro() {
    const btnAbrir = $('abrir-retiro');
    const btnVolver = $('retiro-volver');
    
    if (btnAbrir) {
        btnAbrir.onclick = () => {
            mostrar('vista-cliente', false);
            mostrar('vista-retiro', true);
            $('retiro-monto').value = '';
            actualizarResumenRetiro();
            $('error-solicitud-retiro').textContent = '';
            $('ok-solicitud-retiro').textContent = '';
            
            // Actualizar balance
            const saldoEl = $('cliente-saldo');
            if (saldoEl) $('retiro-balance-disponible').textContent = saldoEl.textContent;
            
            cargarMetodosRetiro();
        };
    }
    
    if (btnVolver) {
        btnVolver.onclick = () => {
            mostrar('vista-retiro', false);
            mostrar('vista-cliente', true);
        };
    }

    const inputMonto = $('retiro-monto');
    if (inputMonto) {
        inputMonto.oninput = actualizarResumenRetiro;
        $('retiro-max').onclick = () => {
            const saldoEl = $('cliente-saldo');
            if (!saldoEl) return;
            const val = parseFloat(saldoEl.textContent.replace(/[^0-9.-]+/g, ''));
            if (!isNaN(val)) {
                inputMonto.value = val.toFixed(2);
                actualizarResumenRetiro();
            }
        };
    }

    // Modal Nuevo Método
    const btnNuevoMetodo = $('btn-nuevo-metodo');
    if (btnNuevoMetodo) {
        btnNuevoMetodo.onclick = () => {
            $('form-nuevo-metodo').reset();
            $('metodo-tipo').dispatchEvent(new Event('change'));
            $('error-nuevo-metodo').textContent = '';
            mostrar('modal-nuevo-metodo', true);
        };
    }
    
    const btnCerrarModal = $('cerrar-modal-metodo');
    if (btnCerrarModal) {
        btnCerrarModal.onclick = () => mostrar('modal-nuevo-metodo', false);
    }

    const selTipo = $('metodo-tipo');
    if (selTipo) {
        selTipo.onchange = () => {
            const tipo = selTipo.value;
            mostrar('campos-banco-retiro', tipo === 'banco');
            mostrar('campos-movil-retiro', tipo === 'movil');
            mostrar('campos-cripto-retiro', tipo === 'cripto');
        };
    }

    const formNuevoMetodo = $('form-nuevo-metodo');
    if (formNuevoMetodo) {
        formNuevoMetodo.onsubmit = async (e) => {
            e.preventDefault();
            const btn = $('btn-guardar-metodo');
            $('error-nuevo-metodo').textContent = '';
            btn.disabled = true;
            btn.textContent = 'Guardando...';

            try {
                const tipo = $('metodo-tipo').value;
                const body = { tipo };
                
                if (tipo === 'banco') {
                    body.banco_nombre = $('metodo-banco-nombre').value;
                    body.titular = $('metodo-banco-titular').value;
                    body.numero_cuenta = $('metodo-banco-cuenta').value;
                } else if (tipo === 'movil') {
                    body.banco_nombre = $('metodo-movil-nombre').value;
                    body.titular = $('metodo-movil-titular').value;
                    body.telefono_movil = $('metodo-movil-telefono').value;
                } else if (tipo === 'cripto') {
                    body.cripto_red = $('metodo-cripto-red').value;
                    body.cripto_direccion = $('metodo-cripto-direccion').value;
                }

                await api('/api/retiros/metodos', { method: 'POST', auth: true, body });
                mostrar('modal-nuevo-metodo', false);
                await cargarMetodosRetiro();
            } catch (err) {
                $('error-nuevo-metodo').textContent = err.message;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Guardar Cuenta';
            }
        };
    }

    const btnSolicitar = $('btn-solicitar-retiro');
    if (btnSolicitar) {
        btnSolicitar.onclick = async () => {
            const monto = parseFloat($('retiro-monto').value);
            $('error-solicitud-retiro').textContent = '';
            $('ok-solicitud-retiro').textContent = '';
            
            if (isNaN(monto) || monto < 30) {
                $('error-solicitud-retiro').textContent = 'El monto mínimo de retiro es $30.00';
                return;
            }
            if (!metodoRetiroSel) {
                $('error-solicitud-retiro').textContent = 'Selecciona una cuenta de destino';
                return;
            }

            btnSolicitar.disabled = true;
            btnSolicitar.textContent = 'Procesando...';
            try {
                const res = await api('/api/retiros', { 
                    method: 'POST', auth: true, 
                    body: { monto, metodo_retiro_id: metodoRetiroSel } 
                });
                $('ok-solicitud-retiro').textContent = res.mensaje;
                $('retiro-monto').value = '';
                actualizarResumenRetiro();
                
                // Actualizar saldo visual en el dashboard
                await cargarCliente(); 
                const saldoEl = $('cliente-saldo');
                if (saldoEl) $('retiro-balance-disponible').textContent = saldoEl.textContent;
                
            } catch (err) {
                $('error-solicitud-retiro').textContent = err.message;
            } finally {
                btnSolicitar.disabled = false;
                btnSolicitar.innerHTML = 'Solicitar Retiro <span class="material-symbols-outlined" style="font-size:20px;">arrow_forward</span>';
            }
        };
    }
}

function actualizarResumenRetiro() {
    const input = $('retiro-monto');
    if (!input) return;
    const monto = parseFloat(input.value) || 0;
    const comision = monto * 0.05;
    const total = monto - comision;

    $('retiro-resumen-monto').textContent = dinero(monto);
    $('retiro-resumen-comision').textContent = '-' + dinero(comision);
    $('retiro-resumen-total').textContent = dinero(total);
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
    inicializarRetiro();
    inicializarMenuLateral();
    arrancar();
});
