import { api, dinero, fecha, sesion } from './api.js';

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
    
    $('tab-config').onclick = () => {
        ['tab-clientes', 'tab-config', 'tab-metodos', 'tab-recargas'].forEach(t => $(t)?.classList.remove('activa'));
        $('tab-config').classList.add('activa');
        ['panel-clientes', 'panel-config', 'panel-metodos', 'panel-recargas'].forEach(p => mostrar(p, false));
        mostrar('panel-config', true);
        cargarConfig();
    };

    if ($('tab-metodos')) {
        $('tab-metodos').onclick = () => {
            ['tab-clientes', 'tab-config', 'tab-metodos', 'tab-recargas'].forEach(t => $(t)?.classList.remove('activa'));
            $('tab-metodos').classList.add('activa');
            ['panel-clientes', 'panel-config', 'panel-metodos', 'panel-recargas'].forEach(p => mostrar(p, false));
            mostrar('panel-metodos', true);
            listarMetodos();
        };
    }

    if ($('tab-recargas')) {
        $('tab-recargas').onclick = () => {
            ['tab-clientes', 'tab-config', 'tab-metodos', 'tab-recargas'].forEach(t => $(t)?.classList.remove('activa'));
            $('tab-recargas').classList.add('activa');
            ['panel-clientes', 'panel-config', 'panel-metodos', 'panel-recargas'].forEach(p => mostrar(p, false));
            mostrar('panel-recargas', true);
            listarRecargas();
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
                    cuerpo: { clienteId: clienteAbierto, tipo, importeEur, descripcion: f.descripcion.value },
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
            };
            const btn = f.querySelector('button');
            btn.disabled = true;
            try {
                const c = await api('/api/sitio', { method: 'PUT', auth: true, cuerpo });
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
                };
            }

            const btn = f.querySelector('button[type=submit]');
            btn.disabled = true;
            try {
                await api('/api/pagos/metodos', { method: 'POST', auth: true, cuerpo });
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
            const nombre = `${c.nombre} ${c.apellido || ''}`.trim() + (c.es_admin ? ' ⭐' : '');
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
            tr.appendChild(el('td', '', r.metodo_desc));
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
        : { tipo: 'cripto', etiqueta: m.etiqueta, red: m.red, direccion: m.direccion };
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
            method: 'PUT', auth: true, cuerpo: cuerpoMetodo(m, { activo: !m.activo }),
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
