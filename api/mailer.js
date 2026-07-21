import nodemailer from 'nodemailer';

// Correo saliente de la empresa (support@goldcorp.online). Las credenciales SMTP
// viven SOLO en variables de entorno (Render > Environment); nunca en el repo.
// Sin ellas, el mailer queda desactivado y los flujos que lo usan caen al camino
// manual (aprobacion del supervisor), sin romper nada.

function config() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 465,
    secure: (Number(SMTP_PORT) || 465) === 465, // 465 = TLS implicito; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  };
}

export const mailerConfigurado = () => config() !== null;

/** Envia un correo en texto plano desde la direccion de la empresa. */
export async function enviarEmail({ para, asunto, texto }) {
  const c = config();
  if (!c) throw new Error('SMTP no configurado');
  const transporte = nodemailer.createTransport(c);
  const desde = process.env.SMTP_FROM || `Gold Corp Financial <${process.env.SMTP_USER}>`;
  await transporte.sendMail({ from: desde, to: para, subject: asunto, text: texto });
}
