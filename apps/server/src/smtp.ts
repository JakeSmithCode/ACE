// Zero-dep SMTP client — the last leg of self-owned outbound mail (DESIGN §16:
// our own stack, never a vendor SDK). ~120 lines of node:net/node:tls speaking
// the actual protocol: EHLO → STARTTLS upgrade (when the server advertises it)
// → AUTH LOGIN → MAIL/RCPT/DATA with dot-stuffing → QUIT. `smtpMailer(cfg)`
// returns the exact `(to, subject, text)` function `LiveServerOpts.mailer`
// expects, so a deployment points ACE_SMTP_* at any relay (SES, Mailgun,
// Postfix, a LAN smarthost) and verification/reset tokens are mailed without
// installing anything. The webhook mailer remains for HTTP-based senders.
//
// Deliberately mail-as-infrastructure: wall-clock (Date) is fine here — this is
// the transport layer, nothing the sim or the world streams ever see.
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpConfig {
  host: string;
  port?: number;          // default 587 (STARTTLS); use 465 with secure:true for implicit TLS
  secure?: boolean;       // implicit TLS from byte one (port 465 style)
  user?: string;          // AUTH LOGIN when user+pass present
  pass?: string;
  from: string;           // envelope sender + From: header, e.g. 'ACE <no-reply@ace.gg>'
  timeoutMs?: number;     // per-exchange guard (default 15s)
  /** Test seam: allow STARTTLS-less AUTH (the in-process fake is plaintext).
   *  Real deployments leave this unset — credentials never cross an open wire. */
  allowInsecureAuth?: boolean;
}

/** One SMTP reply — possibly multi-line (`250-…` continues, `250 …` ends). */
function readReply(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('smtp: reply timeout')); }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      // complete when the last full line is a final one: "NNN " (space, not dash)
      const lines = buf.split(/\r?\n/).filter(l => l.length);
      const last = lines[lines.length - 1];
      if (buf.endsWith('\n') && last && /^\d{3} /.test(last)) { cleanup(); resolve(buf); }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onErr); };
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

async function expect(socket: Socket, code: string, timeoutMs: number, sent: string): Promise<string> {
  const reply = await readReply(socket, timeoutMs);
  if (!reply.trimStart().startsWith(code)) throw new Error(`smtp: ${sent} → ${reply.trim().split('\n')[0]}`);
  return reply;
}

async function say(socket: Socket, line: string, code: string, timeoutMs: number): Promise<string> {
  socket.write(line + '\r\n');
  return expect(socket, code, timeoutMs, line.startsWith('AUTH') || /^[A-Za-z0-9+/=]+$/.test(line) ? line.split(' ')[0] : line);
}

/** Strip CR/LF so a hostile `to`/`subject` can't inject headers or commands. */
const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** The address inside `Name <addr>` (or the string itself). */
const addrOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim();

/** Build the mailer the server's `LiveServerOpts.mailer` seam expects. Each send
 *  is one full SMTP session (connect → deliver → QUIT) — trivially correct, and
 *  token mail is rare enough that connection reuse isn't worth the state. */
export function smtpMailer(cfg: SmtpConfig): (to: string, subject: string, text: string) => Promise<void> {
  const port = cfg.port ?? (cfg.secure ? 465 : 587);
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  return async (to, subject, text) => {
    let socket: Socket | TLSSocket = cfg.secure
      ? tlsConnect({ host: cfg.host, port, servername: cfg.host })
      : createConnection({ host: cfg.host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('smtp: socket timeout')));
    try {
      await expect(socket, '220', timeoutMs, 'connect');
      let ehlo = await say(socket, 'EHLO ace', '250', timeoutMs);
      // opportunistic STARTTLS: upgrade whenever the relay offers it
      if (!cfg.secure && /STARTTLS/i.test(ehlo)) {
        await say(socket, 'STARTTLS', '220', timeoutMs);
        socket = await new Promise<TLSSocket>((resolve, reject) => {
          const t = tlsConnect({ socket, servername: cfg.host }, () => resolve(t));
          t.once('error', reject);
        });
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('smtp: socket timeout')));
        ehlo = await say(socket, 'EHLO ace', '250', timeoutMs);
      }
      if (cfg.user && cfg.pass) {
        const isTls = 'encrypted' in socket;
        if (!isTls && !cfg.allowInsecureAuth) throw new Error('smtp: relay offers no STARTTLS — refusing to send credentials in the clear');
        await say(socket, 'AUTH LOGIN', '334', timeoutMs);
        await say(socket, Buffer.from(cfg.user, 'utf8').toString('base64'), '334', timeoutMs);
        await say(socket, Buffer.from(cfg.pass, 'utf8').toString('base64'), '235', timeoutMs);
      }
      await say(socket, `MAIL FROM:<${addrOf(cfg.from)}>`, '250', timeoutMs);
      await say(socket, `RCPT TO:<${addrOf(clean(to))}>`, '250', timeoutMs);
      await say(socket, 'DATA', '354', timeoutMs);
      const body = text.split(/\r?\n/).map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');   // dot-stuffing
      const msg = [
        `From: ${clean(cfg.from)}`,
        `To: ${clean(to)}`,
        `Subject: ${clean(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@ace>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '.',
      ].join('\r\n');
      socket.write(msg + '\r\n');
      await expect(socket, '250', timeoutMs, 'DATA body');
      await say(socket, 'QUIT', '221', timeoutMs).catch(() => { /* delivered — a rude relay's QUIT reply doesn't matter */ });
    } finally {
      socket.destroy();
    }
  };
}
