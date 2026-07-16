import { api, getAuthToken, dinero } from './api.js';

document.addEventListener('DOMContentLoaded', () => {
  const token = getAuthToken();
  if (!token) {
    window.location.href = '/';
    return;
  }

  const modal = document.getElementById('modal-inversion');
  const modalExito = document.getElementById('modal-exito');
  const btnCerrarModal = document.getElementById('btn-cerrar-modal');
  const formInversion = document.getElementById('form-inversion');
  const modalPlanNombre = document.getElementById('modal-plan-nombre');
  const modalSaldoDisponible = document.getElementById('modal-saldo-disponible');
  const inputImporte = document.getElementById('importe');
  const errorModal = document.getElementById('error-modal');
  const btnConfirmar = document.getElementById('btn-confirmar-inversion');

  let saldoCliente = 0;
  let planSeleccionado = '';

  // Cargar saldo del cliente
  api('/clientes/me')
    .then((cliente) => {
      saldoCliente = parseFloat(cliente.saldo);
      modalSaldoDisponible.textContent = dinero(saldoCliente);
    })
    .catch((err) => {
      console.error(err);
      modalSaldoDisponible.textContent = 'Error al cargar';
    });

  // Abrir modal al hacer clic en "Invertir Ahora"
  document.querySelectorAll('.btn-invertir').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const card = e.target.closest('.card-inversion');
      planSeleccionado = card.dataset.plan;
      modalPlanNombre.textContent = planSeleccionado;
      modal.classList.remove('hidden');
    });
  });

  // Cerrar modal
  btnCerrarModal.addEventListener('click', () => {
    modal.classList.add('hidden');
    formInversion.reset();
    errorModal.classList.add('hidden');
  });

  // Enviar formulario de inversión
  formInversion.addEventListener('submit', async (e) => {
    e.preventDefault();
    const importe = parseFloat(inputImporte.value);

    // Validaciones
    if (isNaN(importe) || importe <= 0) {
      mostrarError('El importe debe ser un número mayor a cero.');
      return;
    }
    if (importe > saldoCliente) {
      mostrarError('No tienes saldo suficiente para esta inversión.');
      return;
    }

    mostrarError(null); // Limpiar errores
    setLoading(true);

    try {
      await api('/inversiones', {
        method: 'POST',
        body: {
          plan: planSeleccionado,
          importe: String(importe.toFixed(2)),
        },
      });

      // Éxito
      modal.classList.add('hidden');
      modalExito.classList.remove('hidden');

      setTimeout(() => {
        window.location.href = 'cuenta.html';
      }, 2500);
    } catch (err) {
      console.error(err);
      mostrarError(err.error || 'Ocurrió un error inesperado. Inténtalo de nuevo.');
      setLoading(false);
    }
  });

  function mostrarError(mensaje) {
    if (mensaje) {
      errorModal.textContent = mensaje;
      errorModal.classList.remove('hidden');
    } else {
      errorModal.classList.add('hidden');
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