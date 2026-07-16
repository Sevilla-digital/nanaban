import { api, sesion, dinero } from './api.js?v=4';

const $ = (id) => document.getElementById(id);
const mostrar = (id, si) => {
    const el = $(id);
    if (!el) return;
    if (si) {
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
};

const iniciales = (nombre, apellido) =>
    (((nombre || '')[0] || '') + ((apellido || '')[0] || '')).toUpperCase() || '·';

document.addEventListener('DOMContentLoaded', () => {
    const token = sesion.token;
    if (!token) {
        window.location.href = 'cuenta.html';
        return;
    }

    const modal = $('modal-inversion');
    const modalExito = $('modal-exito');
    const btnCerrarModal = $('btn-cerrar-modal');
    const formInversion = $('form-inversion');
    const modalPlanNombre = $('modal-plan-nombre');
    const modalSaldoDisponible = $('modal-saldo-disponible');
    const inputImporte = $('importe');
    const errorModal = $('error-modal');
    const btnConfirmar = $('btn-confirmar-inversion');

    let saldoCliente = 0;
    let planSeleccionado = '';

    // Cargar datos del cliente
    api('/api/clientes/me', { auth: true })
        .then((cliente) => {
            saldoCliente = parseFloat(cliente.saldo);
            modalSaldoDisponible.textContent = dinero(saldoCliente);

            // Actualizar aside profile
            if ($('aside-nombre')) $('aside-nombre').textContent = `${cliente.nombre} ${cliente.apellido || ''}`.trim();
            if ($('aside-usuario')) $('aside-usuario').textContent = '@' + (cliente.usuario ?? '');
            if ($('aside-avatar')) $('aside-avatar').textContent = iniciales(cliente.nombre, cliente.apellido);
        })
        .catch((err) => {
            console.error(err);
            modalSaldoDisponible.textContent = 'Error al cargar';
        });

    // Añadir eventos a los botones de inversión hardcodeados
    const botonesInvertir = document.querySelectorAll('.btn-invertir');
    botonesInvertir.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            planSeleccionado = btn.dataset.plan;
            modalPlanNombre.textContent = planSeleccionado;
            mostrar('modal-inversion', true);
        });
    });

    // Cerrar modal
    btnCerrarModal.addEventListener('click', () => {
        mostrar('modal-inversion', false);
        formInversion.reset();
        errorModal.textContent = '';
    });

    // Confirmar inversión
    formInversion.addEventListener('submit', async (e) => {
        e.preventDefault();
        const importe = parseFloat(inputImporte.value.replace(',', '.'));

        if (isNaN(importe) || importe <= 0) {
            mostrarError('El importe debe ser un número mayor a cero.');
            return;
        }
        if (importe > saldoCliente) {
            mostrarError('No tienes saldo suficiente para realizar esta inversión.');
            return;
        }

        mostrarError(null);
        setLoading(true);

        try {
            await api('/api/inversiones', {
                method: 'POST', auth: true,
                body: {
                    plan: planSeleccionado,
                    importe: String(importe.toFixed(2)),
                },
            });

            mostrar('modal-inversion', false);
            mostrar('modal-exito', true);

            // Redirigir al dashboard después de 2.5 segundos
            setTimeout(() => {
                window.location.href = 'cuenta.html#sec-inversiones';
            }, 2500);
        } catch (err) {
            console.error(err);
            mostrarError(err.message || 'Ocurrió un error inesperado.');
            setLoading(false);
        }
    });

    function mostrarError(mensaje) {
        if (mensaje) {
            errorModal.textContent = mensaje;
        } else {
            errorModal.textContent = '';
        }
    }

    function setLoading(isLoading) {
        const textoBtn = btnConfirmar.querySelector('.texto-btn');
        const spinner = btnConfirmar.querySelector('.spinner');
        if (isLoading) {
            btnConfirmar.disabled = true;
            textoBtn.classList.add('hidden');
            spinner.classList.remove('hidden');
        } else {
            btnConfirmar.disabled = false;
            textoBtn.classList.remove('hidden');
            spinner.classList.add('hidden');
        }
    }
});
