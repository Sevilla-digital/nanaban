import { api, sesion, dinero } from './api.js?v=4';

const $ = (id) => document.getElementById(id);
const mostrar = (id, si) => $(id)?.classList.toggle('oculto', !si);

const PLANES = [
  {
    plan: '10 Kilates', subtitulo: 'Nivel Inicial', rendimiento: '1.2%', icono: 'diamond',
    beneficios: ['Contrato mínimo: 30 días', 'Liquidez estándar']
  },
  {
    plan: '14 Kilates', subtitulo: 'Crecimiento Constante', rendimiento: '1.4%', icono: 'diamond',
    beneficios: ['Contrato mínimo: 60 días', 'Re-inversión automática']
  },
  {
    plan: '18 Kilates', subtitulo: 'Óptimo Rendimiento', rendimiento: '1.8%', icono: 'workspace_premium', popular: true,
    beneficios: ['Contrato mínimo: 90 días', 'Asesor financiero dedicado']
  },
  {
    plan: '22 Kilates', subtitulo: 'Alta Pureza', rendimiento: '2.0%', icono: 'star',
    beneficios: ['Contrato mínimo: 180 días', 'Acceso a reportes institucionales']
  },
  {
    plan: '24 Kilates', subtitulo: 'Exclusividad Institucional', rendimiento: '2.4%', icono: 'military_tech',
    beneficios: ['Garantía Soberana', 'Liquidez Preferencial', 'Mesa de Dinero 24/7']
  }
];

function el(tag, className, textContent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent) element.textContent = textContent;
  return element;
}

function crearTarjetaPlan(planInfo) {
  const tarjeta = el('div', 'tarjeta-inversion-plan');
  tarjeta.dataset.plan = planInfo.plan;

  if (planInfo.popular) {
    tarjeta.appendChild(el('div', 'etiqueta-popular', 'Popular'));
  }

  const cima = el('div', 'cima');
  const titulos = el('div');
  titulos.appendChild(el('p', 'sub', planInfo.subtitulo));
  titulos.appendChild(el('h4', '', planInfo.plan));
  const icono = el('span', 'material-symbols-outlined icono-inversion', planInfo.icono);
  cima.append(titulos, icono);
  tarjeta.appendChild(cima);

  const cuerpo = el('div');
  cuerpo.style.flexGrow = '1';
  const rendimiento = el('div', 'saldo', planInfo.rendimiento);
  rendimiento.style.fontSize = '2.2em';
  cuerpo.appendChild(rendimiento);
  cuerpo.appendChild(el('p', 'muted', 'de retorno diario'));

  const lista = el('ul', 'muted');
  lista.style.marginTop = '16px';
  lista.style.paddingTop = '16px';
  lista.style.borderTop = '1px solid var(--borde)';
  planInfo.beneficios.forEach(b => {
    const li = el('li');
    li.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle; color:var(--primario)">check</span> ${b}`;
    lista.appendChild(li);
  });
  cuerpo.appendChild(lista);
  tarjeta.appendChild(cuerpo);

  const btn = el('button', 'btn ancho', 'Invertir ahora');
  btn.style.marginTop = 'auto';
  tarjeta.appendChild(btn);

  return tarjeta;
}

document.addEventListener('DOMContentLoaded', () => {
  const token = sesion.token;
  if (!token) {
    window.location.href = 'cuenta.html';
    return;
  }
  mostrar('vista-cliente', true);

  const rejilla = document.querySelector('.rejilla-inversiones');
  PLANES.forEach(plan => {
    rejilla.appendChild(crearTarjetaPlan(plan));
  });

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

  api('/api/clientes/me', { auth: true })
    .then((cliente) => {
      saldoCliente = parseFloat(cliente.saldo);
      modalSaldoDisponible.textContent = dinero(saldoCliente);
    })
    .catch((err) => {
      console.error(err);
      modalSaldoDisponible.textContent = 'Error al cargar';
    });

  rejilla.addEventListener('click', (e) => {
    const tarjeta = e.target.closest('.tarjeta-inversion-plan');
    if (tarjeta) {
      e.preventDefault();
      planSeleccionado = tarjeta.dataset.plan;
      modalPlanNombre.textContent = planSeleccionado;
      mostrar('modal-inversion', true);
    }
  });

  btnCerrarModal.addEventListener('click', () => {
    mostrar('modal-inversion', false);
    formInversion.reset();
    errorModal.textContent = '';
  });

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

    mostrarError(null); // Limpiar errores
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

      setTimeout(() => {
        window.location.href = 'cuenta.html';
      }, 2500);
    } catch (err) {
      console.error(err);
      mostrarError(err.error || 'Ocurrió un error inesperado.');
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
      textoBtn.classList.add('oculto');
      spinner.classList.remove('oculto');
    } else {
      btnConfirmar.disabled = false;
      textoBtn.classList.remove('oculto');
      spinner.classList.add('oculto');
    }
  }
});