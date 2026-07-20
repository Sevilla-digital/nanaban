import { API, api, dinero, fecha, sesion } from './api.js?v=6';

// Utilidades locales para no depender de main.js
function el(etiqueta, clase = '', texto = '') {
    const e = document.createElement(etiqueta);
    if (clase) e.className = clase;
    if (texto) e.textContent = texto;
    return e;
}
function mostrar(id, visible) {
    const d = document.getElementById(id);
    if (d) {
        if (visible) d.classList.remove('oculto');
        else d.classList.add('oculto');
    }
}
const $ = id => document.getElementById(id);

function botonAccion(texto, clase = '', onClick) {
    const btn = el('button', clase, texto);
    btn.type = 'button';
    if (onClick) btn.onclick = onClick;
    return btn;
}

function fila(celdas, onClick) {
    const tr = document.createElement('tr');
    if (onClick) {
        tr.style.cursor = 'pointer';
        tr.onclick = onClick;
        tr.classList.add('fila-clic'); // asumiendo que esta clase existe o no importa
    }
    for (const text of celdas) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
    }
    return tr;
}

const ESTADO_RECARGA = {
    pendiente: 'Pendiente',
    confirmada: 'Confirmada',
    rechazada: 'Rechazada',
};

// Formatea una fecha (DATE de la BD, "2026-07-25...") como 25/07/2026, sin
// pasar por Date para evitar corrimientos de zona horaria.
function fechaCorta(v) {
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v ?? '');
}

// Necesitaremos regenerar las tablas
function tablaInversiones(destino, inversiones) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!inversiones || !inversiones.length) {
        cont.appendChild(el('p', 'muted', 'Sin inversiones.'));
        return;
    }
    const tabla = document.createElement('table');
    tabla.innerHTML = '<thead><tr><th>Plan</th><th>Gramos</th><th>Fecha</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const inv of inversiones) {
        tbody.appendChild(fila([inv.plan_nombre, inv.gramos, fecha(inv.creada_en)]));
    }
    tabla.appendChild(tbody);
    cont.appendChild(tabla);
}

function tablaMovimientos(destino, movimientos) {
    const cont = $(destino);
    if (!cont) return;
    cont.innerHTML = '';
    if (!movimientos || !movimientos.length) {
        cont.appendChild(el('p', 'muted', 'Sin movimientos.'));
        return;
    }
    const tabla = document.createElement('table');
    tabla.innerHTML = '<thead><tr><th>Fecha</th><th>Descripción</th><th>Importe</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const mov of movimientos) {
        const tr = document.createElement('tr');
        tr.appendChild(el('td', '', fecha(mov.creado_en)));
        tr.appendChild(el('td', '', mov.descripcion));
        const num = Number(mov.importe_eur);
        const css = num > 0 ? 'monto-pos' : num < 0 ? 'monto-neg' : '';
        tr.appendChild(el('td', css, dinero(mov.importe_eur)));
        tbody.appendChild(tr);
    }
    tabla.appendChild(tbody);
    cont.appendChild(tabla);
}


let clienteAbierto = null;
let adminInicializado = false;
let baneoSeleccionado = null; // cliente elegido en la pestaña Baneos

export function inicializarAdmin() {
    if (adminInicializado) {
        listarClientes();
        return;
    }
    adminInicializado = true;

    $('tab-clientes').onclick = () => {
        ['tab-clientes', 'tab-config', 'tab-metodos', 'tab-recargas'].forEach(t => $(t)?.classList.remove('activa'));
        $('tab-clientes').classList.add('activa');
        ['panel-clientes', 'panel-config', 'panel-metodos', 'panel-recargas'].forEach(p => mostrar(p, false));
        mostrar('panel-clientes', true);
        listarClientes();
    };
    
    // Manejo de pestañas
    const tabs = ['tab-clientes', 'tab-config', 'tab-metodos', 'tab-recargas', 'tab-retiros', 'tab-premium', 'tab-baneos'];
    const paneles = ['panel-clientes', 'panel-config', 'panel-metodos', 'panel-recargas', 'panel-retiros', 'panel-premium', 'panel-baneos'];

    if ($('tab-clientes')) {
        $('tab-clientes').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-clientes').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-clientes', true);
            listarClientes($('buscar').value);
        };
    }

    if ($('tab-config')) {
        $('tab-config').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-config').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-config', true);
            cargarConfig();
        };
    }

    if ($('tab-metodos')) {
        $('tab-metodos').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-metodos').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-metodos', true);
            listarMetodos();
        };
    }

    if ($('tab-recargas')) {
        $('tab-recargas').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-recargas').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-recargas', true);
            listarRecargas();
        };
    }

    if ($('tab-retiros')) {
        $('tab-retiros').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-retiros').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-retiros', true);
            listarRetiros();
        };
    }

    if ($('tab-premium')) {
        $('tab-premium').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-premium').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-premium', true);
            listarPremium($('buscar-premium')?.value || '');
        };
    }

    let debouncePremium;
    if ($('buscar-premium')) {
        $('buscar-premium').oninput = (e) => {
            clearTimeout(debouncePremium);
            debouncePremium = setTimeout(() => listarPremium(e.target.value), 300);
        };
    }

    if ($('tab-baneos')) {
        $('tab-baneos').onclick = () => {
            tabs.forEach(t => $(t)?.classList.remove('activa'));
            $('tab-baneos').classList.add('activa');
            paneles.forEach(p => mostrar(p, false));
            mostrar('panel-baneos', true);
            listarBaneos($('buscar-baneo')?.value || '');
        };
    }

    let debounceBaneo;
    if ($('buscar-baneo')) {
        $('buscar-baneo').oninput = (e) => {
            clearTimeout(debounceBaneo);
            debounceBaneo = setTimeout(() => listarBaneos(e.target.value), 300);
        };
    }

    if ($('btn-cancelar-baneo')) {
        $('btn-cancelar-baneo').onclick = () => {
            baneoSeleccionado = null;
            mostrar('form-baneo', false);
        };
    }

    if ($('btn-confirmar-baneo')) {
        $('btn-confirmar-baneo').onclick = async () => {
            if (!baneoSeleccionado) return;
            const razon = $('baneo-razon').value.trim();
            $('error-baneo').textContent = '';
            if (razon.length < 3) {
                $('error-baneo').textContent = 'Escribe la razón del baneo (mínimo 3 caracteres).';
                return;
            }
            const btn = $('btn-confirmar-baneo');
            btn.disabled = true; btn.textContent = 'Baneando…';
            try {
                await api(`/api/clientes/${baneoSeleccionado.id}/ban`, {
                    method: 'PATCH', auth: true, body: { baneado: true, razon },
                });
                baneoSeleccionado = null;
                mostrar('form-baneo', false);
                listarBaneos($('buscar-baneo')?.value || '');
            } catch (err) {
                $('error-baneo').textContent = err.message;
            } finally {
                btn.disabled = false; btn.textContent = 'Banear cuenta';
            }
        };
    }

    let debounce;
    if ($('buscar')) {
        $('buscar').oninput = (e) => { clearTimeout(debounce); debounce = setTimeout(() => listarClientes(e.target.value), 300); };
    }

    if ($('cerrar-detalle')) {
        $('cerrar-detalle').onclick = () => {
            mostrar('detalle-cliente', false);
            mostrar('lista-clientes', true);
            $('buscar').classList.remove('oculto');
            listarClientes($('buscar').value);
        };
    }

    if ($('form-movimiento')) {
        $('form-movimiento').onsubmit = async (e) => {
            e.preventDefault();
            $('error-movimiento').textContent = ''; $('ok-movimiento').textContent = '';
            const f = e.target;
            const tipo = f.tipo.value;
            const magnitud = f.importe.value.trim().replace(',', '.');
            if (!/^\d{1,15}(\.\d{1,2})?$/.test(magnitud) || Number(magnitud) === 0) {
                $('error-movimiento').textContent = 'Introduce un importe positivo, p. ej. 1500.50';
                return;
            }
            const resta = tipo === 'retiro' || tipo === 'compra_oro';
            const importeEur = (resta ? '-' : '') + magnitud;
            const btn = f.querySelector('button');
            btn.disabled = true;
            try {
                await api('/api/clientes/movimientos', {
                    method: 'POST', auth: true,
                    body: { clienteId: clienteAbierto, tipo, importeEur, descripcion: f.descripcion.value },
                });
                $('ok-movimiento').textContent = 'Movimiento registrado.';
                f.reset();
                abrirCliente(clienteAbierto);
            } catch (err) {
                $('error-movimiento').textContent = err.message;
            } finally {
                btn.disabled = false;
            }
        };
    }

    if ($('form-config')) {
        $('form-config').onsubmit = async (e) => {
            e.preventDefault();
            $('error-config').textContent = ''; $('ok-config').textContent = '';
            const f = e.target;
            const cuerpo = {
                nombre_sitio: f.nombre_sitio.value,
                eslogan: f.eslogan.value,
                texto_header: f.texto_header.value,
                texto_footer: f.texto_footer.value,
                logo_url: f.logo_url.value,
                color_primario: f.color_primario.value,
                color_fondo: f.color_fondo.value,
                legal_terminos: f.legal_terminos.value,
                legal_privacidad: f.legal_privacidad.value,
                legal_cumplimiento: f.legal_cumplimiento.value,
                tasa_cordoba: f.tasa_cordoba.value,
                link_grupo_whatsapp: f.link_grupo_whatsapp.value,
                mostrar_grupo_whatsapp: f.mostrar_grupo_whatsapp.checked,
            };
            const btn = f.querySelector('button');
            btn.disabled = true;
            try {
                const c = await api('/api/sitio', { method: 'PUT', auth: true, body: cuerpo });
                document.documentElement.style.setProperty('--primario', c.color_primario);
                document.documentElement.style.setProperty('--fondo', c.color_fondo);
                $('ok-config').textContent = 'Guardado. Se verá en la web pública.';
            } catch (err) {
                $('error-config').textContent = err.message;
            } finally {
                btn.disabled = false;
            }
        };
    }

    if ($('metodo-tipo')) {
        $('metodo-tipo').onchange = () => {
            const esBanco = $('metodo-tipo').value === 'banco';
            mostrar('campos-banco', esBanco);
            mostrar('campos-cripto', !esBanco);
        };
    }

    if ($('form-metodo')) {
        $('form-metodo').onsubmit = async (e) => {
            e.preventDefault();
            $('error-metodo').textContent = ''; $('ok-metodo').textContent = '';
            const f = e.target;
            const tipo = f.tipo.value;

            let cuerpo;
            if (tipo === 'banco') {
                if (!f.etiqueta_banco.value.trim() || !f.titular.value.trim()
                    || !f.numero_cuenta.value.trim() || !f.moneda.value.trim()) {
                    $('error-metodo').textContent = 'Completa banco, titular, número de cuenta y moneda.';
                    return;
                }
                cuerpo = {
                    tipo, etiqueta: f.etiqueta_banco.value, titular: f.titular.value,
                    numero_cuenta: f.numero_cuenta.value, moneda: f.moneda.value, notas: f.notas.value,
                };
            } else {
                if (!f.etiqueta_cripto.value.trim() || !f.red.value.trim() || !f.direccion.value.trim()) {
                    $('error-metodo').textContent = 'Completa moneda, red y dirección.';
                    return;
                }
                cuerpo = {
                    tipo, etiqueta: f.etiqueta_cripto.value, red: f.red.value,
                    direccion: f.direccion.value, notas: f.notas.value,
                    comision: f.comision ? f.comision.value : '0.50',
                };
            }

            const btn = f.querySelector('button[type=submit]');
            btn.disabled = true;
            try {
                await api('/api/pagos/metodos', { method: 'POST', auth: true, body: cuerpo });
                $('ok-metodo').textContent = 'Método añadido.';
                f.reset();
                $('metodo-tipo').dispatchEvent(new Event('change'));
                listarMetodos();
            } catch (err) {
                $('error-metodo').textContent = err.message;
            } finally {
                btn.disabled = false;
            }
        };
    }

    if ($('btn-eliminar-cuenta')) {
        $('btn-eliminar-cuenta').onclick = async () => {
            if (!clienteAbierto) return;
            if (!confirm('¿Estás seguro de que deseas ELIMINAR por completo a este cliente y todo su historial? Esta acción no se puede deshacer.')) return;
            try {
                const btn = $('btn-eliminar-cuenta');
                btn.disabled = true;
                btn.textContent = 'Eliminando...';
                await api('/api/clientes/' + clienteAbierto, { method: 'DELETE', auth: true });
                $('cerrar-detalle').click();
                listarClientes();
            } catch (err) {
                alert('Error al eliminar: ' + err.message);
            } finally {
                const btn = $('btn-eliminar-cuenta');
                btn.disabled = false;
                btn.textContent = 'Eliminar cuenta';
            }
        };
    }

    // Arrancar la primera pestaña (Clientes)
    listarClientes();
}

async function listarClientes(buscar = '') {
    const cont = $('lista-clientes');
    if (!cont) return;
    try {
        const q = buscar ? `?buscar=${encodeURIComponent(buscar)}` : '';
        const { clientes } = await api('/api/clientes' + q, { auth: true });
        cont.innerHTML = '';
        if (!clientes.length) { cont.innerHTML = '<p class="muted">No hay clientes.</p>'; return; }
        const tabla = document.createElement('table');
        tabla.innerHTML = '<thead><tr><th>Cliente</th><th>Teléfono</th><th>Saldo</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const c of clientes) {
            const nombre = `${c.nombre} ${c.apellido || ''}`.trim()
                + (c.es_admin ? ' ⭐' : '')
                + (c.premium ? ' 👑' : '')
                + (c.activo === false ? ' 🚫' : '');
            // Si el backend devuelve c.saldo en lugar de c.saldo_eur, usamos c.saldo
            const saldoUsar = c.saldo !== undefined ? c.saldo : c.saldo_eur;
            tbody.appendChild(fila([nombre, c.telefono, dinero(saldoUsar)], () => abrirCliente(c.id)));
        }
        tabla.appendChild(tbody);
        cont.appendChild(tabla);
    } catch (err) {
        cont.innerHTML = `<p class="error">${err.message}</p>`;
    }
}

// ---------- Cuentas premium ----------

// Sin búsqueda: muestra las cuentas premium actuales. Con búsqueda: muestra las
// coincidencias con un botón para hacer o quitar premium a cada una.
async function listarPremium(buscar = '') {
    const cont = $('lista-premium');
    if (!cont) return;
    try {
        const q = buscar ? `?buscar=${encodeURIComponent(buscar)}` : '';
        const { clientes } = await api('/api/clientes' + q, { auth: true });
        const lista = buscar ? clientes : clientes.filter(c => c.premium);
        cont.innerHTML = '';

        if (!lista.length) {
            cont.innerHTML = buscar
                ? '<p class="muted">Sin resultados para esa búsqueda.</p>'
                : '<p class="muted">Todavía no hay cuentas premium. Busca un cliente arriba para añadirlo.</p>';
            return;
        }

        const tabla = document.createElement('table');
        tabla.innerHTML = '<thead><tr><th>Cliente</th><th>Usuario</th><th>Estado</th><th></th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const c of lista) {
            const tr = document.createElement('tr');
            const nombre = `${c.nombre} ${c.apellido || ''}`.trim();

            const tdNombre = document.createElement('td');
            tdNombre.textContent = nombre + (c.premium ? ' 👑' : '');
            const tdUsuario = document.createElement('td');
            tdUsuario.textContent = c.usuario ? '@' + c.usuario : '—';
            const tdEstado = document.createElement('td');
            tdEstado.textContent = c.premium ? 'Premium' : 'Normal';
            if (c.premium) tdEstado.style.color = 'var(--primario)';

            const tdBoton = document.createElement('td');
            const btn = botonAccion(c.premium ? 'Quitar premium' : 'Hacer premium', 'btn' + (c.premium ? ' sec' : ''));
            btn.style.marginTop = '0';
            btn.onclick = () => cambiarPremium(c.id, !c.premium, buscar);
            tdBoton.appendChild(btn);

            tr.append(tdNombre, tdUsuario, tdEstado, tdBoton);
            tbody.appendChild(tr);
        }
        tabla.appendChild(tbody);
        cont.appendChild(tabla);
    } catch (err) {
        cont.innerHTML = `<p class="error">${err.message}</p>`;
    }
}

async function cambiarPremium(id, premium, buscar) {
    if ($('error-premium')) $('error-premium').textContent = '';
    try {
        await api(`/api/clientes/${id}/premium`, { method: 'PATCH', auth: true, body: { premium } });
        listarPremium(buscar);
    } catch (err) {
        if ($('error-premium')) $('error-premium').textContent = err.message;
    }
}

// ---------- Baneo de cuentas ----------

// Sin búsqueda: muestra las cuentas baneadas (con su razón). Con búsqueda: las
// coincidencias, con botón para banear o quitar el baneo.
async function listarBaneos(buscar = '') {
    const cont = $('lista-baneos');
    if (!cont) return;
    if ($('error-baneos-lista')) $('error-baneos-lista').textContent = '';
    try {
        const q = buscar ? `?buscar=${encodeURIComponent(buscar)}` : '';
        const { clientes } = await api('/api/clientes' + q, { auth: true });
        const lista = buscar ? clientes : clientes.filter(c => c.activo === false);
        cont.innerHTML = '';

        if (!lista.length) {
            cont.innerHTML = buscar
                ? '<p class="muted">Sin resultados para esa búsqueda.</p>'
                : '<p class="muted">No hay cuentas baneadas. Busca un cliente arriba para banearlo.</p>';
            return;
        }

        const tabla = document.createElement('table');
        tabla.innerHTML = '<thead><tr><th>Cliente</th><th>Usuario</th><th>Estado</th><th>Razón</th><th></th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const c of lista) {
            const tr = document.createElement('tr');
            const baneada = c.activo === false;
            const nombre = `${c.nombre} ${c.apellido || ''}`.trim();

            const tdNombre = document.createElement('td');
            tdNombre.textContent = nombre + (c.es_admin ? ' ⭐' : '') + (baneada ? ' 🚫' : '');
            const tdUsuario = document.createElement('td');
            tdUsuario.textContent = c.usuario ? '@' + c.usuario : '—';
            const tdEstado = document.createElement('td');
            tdEstado.textContent = baneada ? 'Baneada' : 'Activa';
            if (baneada) tdEstado.style.color = 'var(--error)';
            const tdRazon = document.createElement('td');
            tdRazon.textContent = baneada ? (c.ban_razon || '—') : '';
            tdRazon.style.maxWidth = '280px';

            const tdBoton = document.createElement('td');
            if (c.es_admin) {
                tdBoton.appendChild(el('span', 'muted', 'Admin'));
            } else if (baneada) {
                const btn = botonAccion('Quitar baneo', 'btn sec');
                btn.style.marginTop = '0';
                btn.onclick = () => quitarBaneo(c.id, buscar);
                tdBoton.appendChild(btn);
            } else {
                const btn = botonAccion('Banear', 'btn');
                btn.style.marginTop = '0';
                btn.style.background = '#dc3545';
                btn.style.borderColor = '#dc3545';
                btn.style.color = '#fff';
                btn.onclick = () => seleccionarBaneo(c);
                tdBoton.appendChild(btn);
            }

            tr.append(tdNombre, tdUsuario, tdEstado, tdRazon, tdBoton);
            tbody.appendChild(tr);
        }
        tabla.appendChild(tbody);
        cont.appendChild(tabla);
    } catch (err) {
        cont.innerHTML = `<p class="error">${err.message}</p>`;
    }
}

function seleccionarBaneo(c) {
    baneoSeleccionado = c;
    const nombre = `${c.nombre} ${c.apellido || ''}`.trim();
    $('baneo-nombre').textContent = `${nombre}${c.usuario ? ' (@' + c.usuario + ')' : ''}`;
    $('baneo-razon').value = '';
    $('error-baneo').textContent = '';
    mostrar('form-baneo', true);
    $('baneo-razon').focus();
}

async function quitarBaneo(id, buscar) {
    if (!confirm('¿Quitar el baneo a esta cuenta? El cliente podrá volver a entrar.')) return;
    if ($('error-baneos-lista')) $('error-baneos-lista').textContent = '';
    try {
        await api(`/api/clientes/${id}/ban`, { method: 'PATCH', auth: true, body: { baneado: false } });
        listarBaneos(buscar);
    } catch (err) {
        if ($('error-baneos-lista')) $('error-baneos-lista').textContent = err.message;
    }
}

async function abrirCliente(id) {
    clienteAbierto = id;
    const c = await api('/api/clientes/' + id, { auth: true });
    $('detalle-nombre').textContent = `${c.nombre} ${c.apellido || ''}`.trim();
    $('detalle-tel').textContent = c.telefono;
    const saldoUsar = c.saldo !== undefined ? c.saldo : c.saldo_eur;
    $('detalle-saldo').textContent = dinero(saldoUsar);
    tablaInversiones('detalle-inversiones', c.inversiones);
    tablaMovimientos('detalle-movimientos', c.movimientos);
    $('error-movimiento').textContent = ''; $('ok-movimiento').textContent = '';
    mostrar('detalle-cliente', true);
    mostrar('lista-clientes', false);
    $('buscar').classList.add('oculto');
}

async function cargarConfig() {
    try {
        const c = await api('/api/sitio');
        const f = $('form-config');
        if (!f) return;
        f.nombre_sitio.value = c.nombre_sitio || '';
        f.eslogan.value = c.eslogan || '';
        f.texto_header.value = c.texto_header || '';
        f.texto_footer.value = c.texto_footer || '';
        f.logo_url.value = c.logo_url || '';
        f.color_primario.value = c.color_primario || '#ffd700';
        f.color_fondo.value = c.color_fondo || '#1a1a1a';
        if (f.legal_terminos) f.legal_terminos.value = c.legal_terminos || '';
        f.legal_privacidad.value = c.legal_privacidad || '';
        f.legal_cumplimiento.value = c.legal_cumplimiento || '';
        f.tasa_cordoba.value = c.tasa_cordoba || '36.80';
        if (f.link_grupo_whatsapp) f.link_grupo_whatsapp.value = c.link_grupo_whatsapp || '';
        if (f.mostrar_grupo_whatsapp) f.mostrar_grupo_whatsapp.checked = c.mostrar_grupo_whatsapp !== false;
    } catch (err) {
        if ($('error-config')) $('error-config').textContent = err.message;
    }
}

async function listarRecargas() {
    const cont = $('lista-recargas');
    if (!cont) return;
    cont.innerHTML = '';
    cont.appendChild(el('p', 'muted', 'Cargando…'));
    try {
        const { recargas } = await api('/api/pagos/recargas', { auth: true });
        cont.innerHTML = '';
        if (!recargas.length) { cont.appendChild(el('p', 'muted', 'No hay recargas.')); return; }
        const tabla = document.createElement('table');
        tabla.innerHTML = '<thead><tr><th>Fecha</th><th>Cliente</th><th>Método</th><th>Monto</th><th>Estado</th><th>Acción</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const r of recargas) {
            const tr = document.createElement('tr');
            tr.appendChild(el('td', '', fecha(r.creada_en)));
            const quien = `${r.nombre} ${r.apellido || ''}`.trim() + (r.usuario ? ` (@${r.usuario})` : '');
            tr.appendChild(el('td', '', quien));
            const tdMetodo = el('td', '', r.metodo_desc);
            // Cripto con confirmación automática: el admin ve el monto exacto que
            // debe llegar a la exchange (identifica al pagador).
            if (r.monto_esperado) {
                tdMetodo.appendChild(document.createElement('br'));
                const esp = el('span', '', `Debe llegar exacto: ${dinero(r.monto_esperado)}`);
                esp.style.cssText = 'font-size:12px; color:var(--primario)';
                tdMetodo.appendChild(esp);
            }
            if (r.referencia) {
                tdMetodo.appendChild(document.createElement('br'));
                const ref = el('span', 'muted', r.referencia);
                ref.style.fontSize = '12px';
                tdMetodo.appendChild(ref);
            }
            if (r.tiene_comprobante) {
                tdMetodo.appendChild(document.createElement('br'));
                const btnVer = document.createElement('button');
                btnVer.className = 'btn sec';
                btnVer.style.padding = '2px 8px';
                btnVer.style.marginTop = '6px';
                btnVer.style.fontSize = '12px';
                btnVer.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; margin-right:4px;">search</span>Ver Comprobante';
                btnVer.onclick = () => verComprobante(r.id);
                tdMetodo.appendChild(btnVer);
            }
            tr.appendChild(tdMetodo);
            tr.appendChild(el('td', 'monto-pos', dinero(r.monto)));
            tr.appendChild(el('td', '', ESTADO_RECARGA[r.estado] ?? r.estado));
            const acc = document.createElement('td');
            acc.style.whiteSpace = 'nowrap';
            if (r.estado === 'pendiente') {
                acc.appendChild(botonAccion('Confirmar', '', (e) => accionRecarga(r.id, 'confirmar', e.target)));
                acc.appendChild(botonAccion('Rechazar', 'sec', (e) => accionRecarga(r.id, 'rechazar', e.target)));
            }
            tr.appendChild(acc);
            tbody.appendChild(tr);
        }
        tabla.appendChild(tbody);
        cont.appendChild(tabla);
    } catch (err) {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'error', err.message));
    }
}

async function accionRecarga(id, accion, btn) {
    if (accion === 'rechazar' && !confirm('¿Rechazar esta recarga? No se abonará nada.')) return;
    btn.disabled = true;
    try {
        await api(`/api/pagos/recargas/${id}/${accion}`, { method: 'POST', auth: true });
        listarRecargas();
        if (accion === 'confirmar' && clienteAbierto) abrirCliente(clienteAbierto);
    } catch (err) {
        alert(err.message);
        btn.disabled = false;
    }
}

function cuerpoMetodo(m, cambios = {}) {
    const base = m.tipo === 'banco'
        ? { tipo: 'banco', etiqueta: m.etiqueta, titular: m.titular,
            numero_cuenta: m.numero_cuenta, moneda: m.moneda }
        : { tipo: 'cripto', etiqueta: m.etiqueta, red: m.red, direccion: m.direccion, comision: m.comision };
    return { ...base, notas: m.notas || '', activo: m.activo, orden: m.orden || 0, ...cambios };
}

async function listarMetodos() {
    const cont = $('lista-metodos');
    if (!cont) return;
    cont.innerHTML = '';
    cont.appendChild(el('p', 'muted', 'Cargando…'));
    try {
        const { metodos } = await api('/api/pagos/metodos/gestion', { auth: true });
        cont.innerHTML = '';
        if (!metodos.length) { cont.appendChild(el('p', 'muted', 'Aún no has añadido métodos.')); return; }
        const tabla = document.createElement('table');
        tabla.innerHTML = '<thead><tr><th>Tipo</th><th>Detalle</th><th>Estado</th><th></th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const m of metodos) {
            const tr = document.createElement('tr');
            tr.appendChild(el('td', '', m.tipo === 'banco' ? 'Banco' : 'Cripto'));
            const detalle = m.tipo === 'banco'
                ? `${m.etiqueta} · ${m.numero_cuenta} (${m.moneda})`
                : `${m.etiqueta} · ${m.red} · ${m.direccion}`;
            tr.appendChild(el('td', '', detalle));
            tr.appendChild(el('td', m.activo ? 'pos' : 'muted', m.activo ? 'Activo' : 'Inactivo'));
            const acc = document.createElement('td');
            acc.style.whiteSpace = 'nowrap';
            acc.appendChild(botonAccion(m.activo ? 'Desactivar' : 'Activar', 'sec',
                (e) => cambiarActivo(m, e.target)));
            acc.appendChild(botonAccion('Borrar', 'sec', (e) => borrarMetodo(m.id, e.target)));
            tr.appendChild(acc);
            tbody.appendChild(tr);
        }
        tabla.appendChild(tbody);
        cont.appendChild(tabla);
    } catch (err) {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'error', err.message));
    }
}

async function cambiarActivo(m, btn) {
    btn.disabled = true;
    try {
        await api(`/api/pagos/metodos/${m.id}`, {
            method: 'PUT', auth: true, body: cuerpoMetodo(m, { activo: !m.activo }),
        });
        listarMetodos();
    } catch (err) { alert(err.message); btn.disabled = false; }
}

async function borrarMetodo(id, btn) {
    if (!confirm('¿Borrar este método? Las recargas ya registradas se conservan.')) return;
    btn.disabled = true;
    try {
        await api(`/api/pagos/metodos/${id}`, { method: 'DELETE', auth: true });
        listarMetodos();
    } catch (err) { alert(err.message); btn.disabled = false; }
}

// ---------- Retiros ----------
async function listarRetiros() {
    const cont = $('lista-retiros');
    if (!cont) return;
    cont.innerHTML = '<p class="muted">Cargando…</p>';
    try {
        const { retiros } = await api('/api/retiros/admin/lista', { auth: true });
        cont.innerHTML = '';
        if (!retiros.length) {
            cont.innerHTML = '<p class="muted">No hay solicitudes de retiro.</p>';
            return;
        }

        for (const r of retiros) {
            const row = document.createElement('div');
            row.className = 'recarga-item'; // Reusamos el CSS de recargas
            
            let htmlDetalles = '';
            if (r.metodo_tipo === 'banco') {
                htmlDetalles = `<b>Banco:</b> ${r.banco_nombre}<br><b>Titular:</b> ${r.titular}<br><b>Cuenta:</b> ${r.numero_cuenta}`;
            } else if (r.metodo_tipo === 'movil') {
                htmlDetalles = `<b>Billetera Móvil:</b> ${r.banco_nombre}<br><b>Titular:</b> ${r.titular}<br><b>Telf:</b> ${r.telefono_movil}`;
            } else if (r.metodo_tipo === 'cripto') {
                htmlDetalles = `<b>Red:</b> ${r.cripto_red}<br><b>Billetera:</b> <span style="font-size:11px;word-break:break-all;">${r.cripto_direccion}</span>`;
            }

            row.innerHTML = `
                <div class="info">
                    <strong>${r.nombre} ${r.apellido}</strong> <span class="muted">(${r.usuario})</span><br>
                    <small>Tel: ${r.telefono}</small><br>
                    <small class="muted">${fecha(r.creado_en)}</small>
                </div>
                <div class="info" style="min-width: 200px">
                    <div style="font-size:14px; margin-bottom:4px">${htmlDetalles}</div>
                </div>
                <div class="info der" style="min-width: 120px">
                    <div><b>Pide:</b> ${dinero(r.monto)}</div>
                    <div style="color:var(--error); font-size:12px;">Comisión: -${dinero(r.comision)}</div>
                    <div style="color:var(--primario);"><b>A Enviar:</b> ${dinero(r.total_recibir)}</div>
                    ${r.premium
                        ? '<div style="font-size:11px; color:var(--primario);">👑 Premium · pago en 24h</div>'
                        : (r.programado_para
                            ? `<div style="font-size:11px; color:#99907c;">Pago programado: ${fechaCorta(r.programado_para)}</div>`
                            : '')}
                </div>
            `;

            const acciones = document.createElement('div');
            acciones.className = 'acciones';
            
            if (r.estado === 'pendiente') {
                const btnOk = document.createElement('button');
                btnOk.className = 'btn';
                btnOk.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px">check</span> Completar';
                btnOk.onclick = () => procesarRetiro(r.id, 'completar', btnOk);
                
                const btnErr = document.createElement('button');
                btnErr.className = 'btn sec';
                btnErr.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px">close</span> Rechazar';
                btnErr.onclick = () => {
                    if (confirm('¿Estás seguro de RECHAZAR este retiro? El dinero se devolverá a su saldo.')) {
                        procesarRetiro(r.id, 'rechazar', btnErr);
                    }
                };
                
                acciones.append(btnOk, btnErr);
            } else {
                const label = document.createElement('span');
                label.style.fontWeight = 'bold';
                label.style.color = r.estado === 'completado' ? '#4ade80' : '#ef4444';
                label.textContent = r.estado.toUpperCase();
                acciones.appendChild(label);
            }

            row.appendChild(acciones);
            cont.appendChild(row);
        }
    } catch (err) {
        cont.innerHTML = `<p class="error">${err.message}</p>`;
    }
}

async function procesarRetiro(id, accion, btn) {
    if (btn) btn.disabled = true;
    try {
        await api('/api/retiros/admin/' + id + '/procesar', {
            method: 'POST',
            auth: true,
            body: { accion }
        });
        listarRetiros();
    } catch (err) {
        alert(err.message);
        if (btn) btn.disabled = false;
    }
}

// Global scope attachment since the button uses onclick="..." inside a constructed element?
// Wait, in my previous edit, I assigned btnVer.onclick = () => verComprobante(r.id); directly.
// So verComprobante can just be a function in this module scope.
async function verComprobante(id) {
    const btn = event.currentTarget;
    const txtOriginal = btn.innerHTML;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px;"></span>Cargando...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API}/api/pagos/recargas/${id}/comprobante`, {
            headers: { 'Authorization': `Bearer ${sesion.token}` }
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'No se pudo cargar el comprobante');
        }
        
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        
        const modal = document.createElement('div');
        modal.className = 'modal-fondo';
        modal.style.zIndex = '9999';
        modal.innerHTML = `
            <div class="modal" style="max-width: 90%; max-height: 90%; text-align: center; display: flex; flex-direction: column;">
                <h3 style="margin-top:0;">Comprobante #${id}</h3>
                <div style="flex: 1; overflow: auto; margin: 16px 0; background: #000; border-radius: 8px;">
                    ${blob.type === 'application/pdf' 
                        ? '<iframe src="' + url + '" style="width: 100%; height: 60vh; border: none;"></iframe>'
                        : '<img src="' + url + '" style="max-width: 100%; object-fit: contain; max-height: 60vh;">'
                    }
                </div>
                <div style="display: flex; justify-content: center; gap: 12px; margin-top: auto;">
                    <a href="${url}" download="comprobante_${id}" class="btn">
                        <span class="material-symbols-outlined" style="font-size:18px;vertical-align:middle;">download</span> Descargar
                    </a>
                    <button class="btn sec btn-cerrar-comp">Cerrar</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.btn-cerrar-comp').onclick = () => {
            modal.remove();
            URL.revokeObjectURL(url);
        };
    } catch (err) {
        alert(err.message);
    } finally {
        btn.innerHTML = txtOriginal;
        btn.disabled = false;
    }
}

