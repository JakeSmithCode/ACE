// Social sign-in (Google / Discord / any OAuth2 code-flow provider) — zero-dep,
// like the rest of the slice. The authorization-code flow is plain HTTP: redirect
// the browser to the provider, receive a one-time code on our callback, exchange
// it server-side for an access token, fetch the user's identity, and mint OUR OWN
// session (DESIGN §16 still holds: the provider proves who you are once; the
// account, tokens and data stay in our tables — no vendor session, no SDK).
//
// Providers are injected as plain configs (client id/secret from env), which is
// also what makes the whole flow provably testable: the verification suite points
// a provider at an in-process mock and drives every leg end-to-end.

export interface OAuthProvider {
  id: string;             // 'google' | 'discord' | a test id
  label: string;          // button text
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Map the provider's userinfo JSON to a stable identity. `subject` is the
   *  provider's permanent user id (never the email — emails change); `email`
   *  is the provider-VERIFIED address used once for account linking. */
  identity: (info: Record<string, unknown>) => { subject: string; email: string | null };
}

export const googleProvider = (clientId: string, clientSecret: string): OAuthProvider => ({
  id: 'google', label: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  clientId, clientSecret, scope: 'openid email',
  identity: info => ({ subject: String(info.sub ?? ''), email: info.email_verified ? (info.email as string) ?? null : null }),
});

export const discordProvider = (clientId: string, clientSecret: string): OAuthProvider => ({
  id: 'discord', label: 'Discord',
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  userinfoUrl: 'https://discord.com/api/users/@me',
  clientId, clientSecret, scope: 'identify email',
  identity: info => ({ subject: String(info.id ?? ''), email: info.verified ? (info.email as string) ?? null : null }),
});

/** The provider's authorize URL for a login attempt (the browser is sent here). */
export function authorizeUrl(p: OAuthProvider, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: p.clientId, redirect_uri: redirectUri, response_type: 'code', scope: p.scope, state });
  return `${p.authorizeUrl}?${q}`;
}

/** Exchange the callback code for the provider access token (server-side). */
export async function exchangeCode(p: OAuthProvider, code: string, redirectUri: string): Promise<string | null> {
  const body = new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  try {
    const r = await fetch(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string };
    return j.access_token ?? null;
  } catch { return null; }
}

/** Fetch the provider's userinfo with the exchanged token. */
export async function fetchIdentity(p: OAuthProvider, accessToken: string): Promise<{ subject: string; email: string | null } | null> {
  try {
    const r = await fetch(p.userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    const id = p.identity((await r.json()) as Record<string, unknown>);
    return id.subject ? id : null;
  } catch { return null; }
}
