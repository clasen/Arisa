const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function jsonRequest(fetchFn, url, init = {}) {
  const response = await fetchFn(url, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: response.ok, status: response.status, headers: response.headers, json, text };
}

function metadataCandidates(issuer, endpoint) {
  const issuerUrl = new URL(issuer);
  const path = issuerUrl.pathname.replace(/\/$/, "");
  return [
    new URL(`${path}/.well-known/openid-configuration`, issuerUrl.origin),
    new URL(`/.well-known/oauth-authorization-server${path}`, issuerUrl.origin),
    new URL("/.well-known/oauth-authorization-server", endpoint.origin)
  ];
}

export async function discoverOAuth(fetchFn, endpoint) {
  const resourceUrl = new URL("/.well-known/oauth-protected-resource", endpoint.origin);
  const resourceResult = await jsonRequest(fetchFn, resourceUrl, { headers: { Accept: "application/json" } });
  if (!resourceResult.ok || !resourceResult.json) throw new Error(`OAuth protected-resource discovery failed with HTTP ${resourceResult.status}`);
  const resource = resourceResult.json;
  const issuer = resource.authorization_servers?.[0];
  if (!issuer) throw new Error("OAuth resource metadata does not name an authorization server");
  let metadata = null;
  for (const candidate of metadataCandidates(issuer, endpoint)) {
    const result = await jsonRequest(fetchFn, candidate, { headers: { Accept: "application/json" } });
    if (result.ok && result.json?.token_endpoint) {
      metadata = result.json;
      break;
    }
  }
  if (!metadata) throw new Error("OAuth authorization-server discovery failed");
  return { resource, metadata };
}

async function registerPublicClient(fetchFn, metadata) {
  if (!metadata.registration_endpoint) throw new Error("The authorization server does not support dynamic client registration");
  const result = await jsonRequest(fetchFn, metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Arisa MCP Client",
      grant_types: [DEVICE_GRANT, "refresh_token"],
      response_types: [],
      token_endpoint_auth_method: "none"
    })
  });
  if (!result.ok || !result.json?.client_id) throw new Error(`OAuth client registration failed with HTTP ${result.status}`);
  return {
    clientId: result.json.client_id,
    clientSecret: result.json.client_secret || "",
    registrationAccessToken: result.json.registration_access_token || "",
    registeredAt: new Date().toISOString()
  };
}

function formBody(values) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") form.set(key, String(value));
  return form;
}

export async function startDeviceAuthorization(fetchFn, endpoint, credentials = {}) {
  const { resource, metadata } = await discoverOAuth(fetchFn, endpoint);
  if (!metadata.device_authorization_endpoint) throw new Error("The authorization server does not offer OAuth device authorization");
  const client = credentials.client?.clientId ? credentials.client : await registerPublicClient(fetchFn, metadata);
  const scope = (resource.scopes_supported || metadata.scopes_supported || []).filter((item) => item !== "offline_access").join(" ");
  const result = await jsonRequest(fetchFn, metadata.device_authorization_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formBody({ client_id: client.clientId, client_secret: client.clientSecret, scope, resource: resource.resource })
  });
  if (!result.ok || !result.json?.device_code) throw new Error(`OAuth device authorization failed with HTTP ${result.status}`);
  const now = Date.now();
  return {
    credentials: {
      ...credentials,
      client,
      oauth: {
        issuer: metadata.issuer || resource.authorization_servers?.[0],
        tokenEndpoint: metadata.token_endpoint,
        revocationEndpoint: metadata.revocation_endpoint || "",
        resource: resource.resource || endpoint.origin,
        scope
      },
      pending: {
        deviceCode: result.json.device_code,
        userCode: result.json.user_code,
        verificationUri: result.json.verification_uri,
        verificationUriComplete: result.json.verification_uri_complete || "",
        intervalSeconds: Number(result.json.interval || 5),
        expiresAt: new Date(now + Number(result.json.expires_in || 600) * 1000).toISOString(),
        startedAt: new Date(now).toISOString()
      }
    },
    public: {
      userCode: result.json.user_code,
      verificationUri: result.json.verification_uri,
      verificationUriComplete: result.json.verification_uri_complete || "",
      expiresAt: new Date(now + Number(result.json.expires_in || 600) * 1000).toISOString(),
      intervalSeconds: Number(result.json.interval || 5)
    }
  };
}

export async function pollDeviceAuthorization(fetchFn, credentials) {
  const pending = credentials.pending;
  if (!pending?.deviceCode) throw new Error("No OAuth device authorization is pending");
  if (Date.parse(pending.expiresAt) <= Date.now()) throw new Error("OAuth device authorization expired; start it again");
  const result = await jsonRequest(fetchFn, credentials.oauth.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formBody({
      grant_type: DEVICE_GRANT,
      device_code: pending.deviceCode,
      client_id: credentials.client.clientId,
      client_secret: credentials.client.clientSecret,
      resource: credentials.oauth.resource
    })
  });
  if (!result.ok) {
    const code = result.json?.error || "token_request_failed";
    if (code === "authorization_pending" || code === "slow_down") return { pending: true, code, credentials };
    throw new Error(`OAuth token request failed: ${code}`);
  }
  if (!result.json?.access_token) throw new Error("OAuth token response did not include an access token");
  const next = { ...credentials, pending: null, tokens: tokenRecord(result.json) };
  return { pending: false, credentials: next };
}

function tokenRecord(json) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || "",
    tokenType: json.token_type || "Bearer",
    scope: json.scope || "",
    expiresAt: new Date(Date.now() + Number(json.expires_in || 300) * 1000).toISOString()
  };
}

export async function validAccessToken(fetchFn, credentials) {
  const tokens = credentials.tokens;
  if (!tokens?.accessToken) return { credentials, accessToken: "" };
  if (Date.parse(tokens.expiresAt) > Date.now() + 30000) return { credentials, accessToken: tokens.accessToken };
  if (!tokens.refreshToken) return { credentials: { ...credentials, tokens: null }, accessToken: "" };
  const result = await jsonRequest(fetchFn, credentials.oauth.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: credentials.client.clientId,
      client_secret: credentials.client.clientSecret,
      resource: credentials.oauth.resource
    })
  });
  if (!result.ok || !result.json?.access_token) return { credentials: { ...credentials, tokens: null }, accessToken: "" };
  const next = { ...credentials, tokens: tokenRecord({ ...result.json, refresh_token: result.json.refresh_token || tokens.refreshToken }) };
  return { credentials: next, accessToken: next.tokens.accessToken };
}
