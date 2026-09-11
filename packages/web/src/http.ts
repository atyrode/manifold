import { HttpErrorSchema } from "@manifold/protocol";
import { instanceOrigin, instanceUrl } from "@manifold/plugin/hooks";

interface IdentityRejectionListener {
  readonly origin: string;
  readonly authorization: string;
  readonly invalidate: () => void;
}

const identityRejectionListeners = new Set<IdentityRejectionListener>();

/** The gate, not an individual plugin, owns recovery for its exact instance credential. */
export function onIdentityRejected(token: string, invalidate: () => void): () => void {
  const listener = { origin: instanceOrigin(), authorization: `Bearer ${token}`, invalidate };
  identityRejectionListeners.add(listener);
  return () => {
    identityRejectionListeners.delete(listener);
  };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (${response.status})`);
  }
}

function errorFromBody(
  status: number,
  body: unknown,
  origin: string,
  authorization: string | null,
): Error {
  const parsed = HttpErrorSchema.safeParse(body);
  if (!parsed.success) return new Error(`Request failed (${status})`);
  const { code, message } = parsed.data.error;
  // A permission denial is not a dead credential. Only the server's authentication
  // expiry/revocation refusal can return the browser to admission.
  if (
    ((status === 403 && code === "forbidden") || (status === 401 && code === "unauthorized")) &&
    (message === "revoked" || message === "expired")
  ) {
    for (const listener of identityRejectionListeners) {
      if (listener.origin === origin && listener.authorization === authorization) {
        listener.invalidate();
      }
    }
  }
  return new Error(message);
}

/**
 * Every door this layer knocks on is addressed at the INSTANCE, not at the origin that served
 * the page. The two are the same thing for an ordinary self-hosted deployment and deliberately
 * not the same assumption: a lens may be pointed elsewhere (`@manifold/plugin/hooks`
 * `instanceOrigin`, AXIOMS §The portable lens), and a relative path would quietly follow the
 * bundle's birthplace instead.
 */
export async function requestResponse(path: string, init: RequestInit): Promise<Response> {
  const url = instanceUrl(path);
  const authorization = new Headers(init.headers).get("authorization");
  const response = await fetch(url, init);
  if (!response.ok) {
    throw errorFromBody(
      response.status,
      await readBody(response),
      new URL(url).origin,
      authorization,
    );
  }
  return response;
}

export async function requestJson(path: string, init: RequestInit): Promise<unknown> {
  return readBody(await requestResponse(path, init));
}
