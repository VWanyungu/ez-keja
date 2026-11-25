import nodemailer, { type Transporter } from 'nodemailer';

const DEFAULT_USESENDY_API_URL = 'https://usesendy.com/api/v1/emails';

export type MailProvider = 'usesendy' | 'gmail';

export interface SendEmailPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  sent: boolean;
  skipped?: boolean;
  provider: MailProvider;
}

export interface MailerConfig {
  nodeEnv?: string;
  apiUrl?: string;
  apiKey?: string;
  from?: string;
  gmailUser?: string;
  gmailAppPassword?: string;
  fetchFn?: typeof fetch;
  createGmailTransport?: (opts: {
    user: string;
    pass: string;
  }) => Pick<Transporter, 'sendMail'>;
}

function defaultCreateGmailTransport(opts: {
  user: string;
  pass: string;
}): Pick<Transporter, 'sendMail'> {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: opts.user,
      pass: opts.pass,
    },
  });
}

async function sendViaUsesendy(
  payload: SendEmailPayload,
  config: MailerConfig,
): Promise<SendEmailResult> {
  const apiUrl = config.apiUrl?.trim() || process.env.USESENDY_API_URL?.trim() || DEFAULT_USESENDY_API_URL;
  const apiKey = config.apiKey?.trim() || process.env.USESENDY_API_KEY?.trim();
  const from = config.from?.trim() || process.env.MAIL_FROM?.trim();
  const fetchImpl = config.fetchFn ?? fetch;

  if (!apiKey || !from) {
    throw new Error('USESENDY_API_KEY and MAIL_FROM must be configured in production.');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };

  if (payload.idempotencyKey) {
    headers['Idempotency-Key'] = payload.idempotencyKey.slice(0, 128);
  }

  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      data: {
        type: 'emails',
        attributes: {
          from,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Sendy email delivery failed (${response.status}): ${errorBody || response.statusText}`,
    );
  }

  return { sent: true, provider: 'usesendy' };
}

async function sendViaGmail(
  payload: SendEmailPayload,
  env: string,
  config: MailerConfig,
): Promise<SendEmailResult> {
  const user = config.gmailUser?.trim() || process.env.GMAIL_USER?.trim();
  const pass = config.gmailAppPassword || process.env.GMAIL_APP_PASSWORD;
  const from = config.from?.trim() || process.env.MAIL_FROM?.trim() || user;

  if (!user || !pass) {
    if (env === 'staging') {
      throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be configured in staging.');
    }
    console.warn(
      `[mailer] Skipping Gmail delivery to ${payload.to} ("${payload.subject}") because GMAIL_USER or GMAIL_APP_PASSWORD is not set.`,
    );
    return { sent: false, skipped: true, provider: 'gmail' };
  }

  const createTransport = config.createGmailTransport ?? defaultCreateGmailTransport;
  const transporter = createTransport({ user, pass });

  await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });

  return { sent: true, provider: 'gmail' };
}

export async function sendEmail(
  payload: SendEmailPayload,
  config: MailerConfig = {},
): Promise<SendEmailResult> {
  const env = config.nodeEnv ?? process.env.NODE_ENV ?? 'development';

  if (env === 'production') {
    return sendViaUsesendy(payload, config);
  }

  return sendViaGmail(payload, env, config);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function sendPasswordResetEmail(
  params: { to: string; name: string; resetUrl: string; token: string },
  config: MailerConfig = {},
): Promise<SendEmailResult> {
  const safeName = escapeHtml(params.name || 'there');
  const safeUrl = escapeHtml(params.resetUrl);

  return sendEmail(
    {
      to: params.to,
      subject: 'Reset your password',
      text: `Hi ${params.name || 'there'},\n\nReset your password using the link below:\n${params.resetUrl}\n\nIf you did not request a password reset, you can safely ignore this email.`,
      html: `<p>Hi ${safeName},</p><p>Reset your password using the link below:</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request a password reset, you can safely ignore this email.</p>`,
      idempotencyKey: `password-reset-${params.token}`,
    },
    config,
  );
}

export async function sendAdminInviteEmail(
  params: {
    to: string;
    displayName: string;
    inviteUrl: string;
    expiresAt: Date;
    inviteId?: string;
  },
  config: MailerConfig = {},
): Promise<SendEmailResult> {
  const safeName = escapeHtml(params.displayName);
  const safeUrl = escapeHtml(params.inviteUrl);
  const expiresIso = params.expiresAt.toISOString();

  return sendEmail(
    {
      to: params.to,
      subject: 'You have been invited as an Admin',
      text: `Hi ${params.displayName},\n\nYou have been invited to join as an Admin. Set your password and accept the privacy notice here:\n${params.inviteUrl}\n\nThis invitation expires at ${expiresIso}.`,
      html: `<p>Hi ${safeName},</p><p>You have been invited to join as an Admin. Set your password and accept the privacy notice using the link below:</p><p><a href="${safeUrl}">Accept Admin invite</a></p><p>This invitation expires at ${escapeHtml(expiresIso)}.</p>`,
      idempotencyKey: params.inviteId ? `admin-invite-${params.inviteId}` : undefined,
    },
    config,
  );
}
