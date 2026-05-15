import type { ActiveLibrary } from "./types.js";

const LOCAL_PORT = 23119;
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const BRIDGE = `${LOCAL}/mcp-bridge`;
const TIMEOUT = 15_000;

export type BridgeObjectResult = {
  id: number;
  key: string;
  libraryID: number;
  version: number;
};

export type BridgePing = {
  version: string;
  zoteroVersion: string;
  userLibraryID: number;
};

type BridgeEnvelope<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

function fetchT(url: string | URL, init?: RequestInit, ms = TIMEOUT): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}

function libraryPayload(activeLib: ActiveLibrary): Record<string, string> {
  return {
    libraryID: activeLib.libraryId,
    libraryType: activeLib.libraryType,
  };
}

export async function bridgePost<T>(
  path: string,
  body: Record<string, unknown> = {},
  activeLib: ActiveLibrary = { libraryId: "0", libraryType: "user" }
): Promise<T> {
  const res = await fetchT(`${BRIDGE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Zotero-Allowed-Request": "1",
    },
    body: JSON.stringify({ ...libraryPayload(activeLib), ...body }),
  });
  const text = await res.text();
  let payload: BridgeEnvelope<T>;
  try {
    payload = text ? JSON.parse(text) as BridgeEnvelope<T> : { ok: false, error: "Empty bridge response" };
  } catch {
    throw new Error(`Zotero local bridge returned non-JSON HTTP ${res.status}: ${text || res.statusText}`);
  }
  if (!res.ok || !payload.ok) {
    throw new Error(payload.error || `Zotero local bridge HTTP ${res.status}`);
  }
  return payload.result as T;
}

export async function pingBridge(): Promise<BridgePing> {
  const res = await fetchT(`${BRIDGE}/ping`, {
    headers: { Accept: "application/json", "Zotero-Allowed-Request": "1" },
  }, 2_000);
  if (!res.ok) {
    throw new Error(`Zotero local bridge ping failed: HTTP ${res.status}`);
  }
  const payload = await res.json() as BridgeEnvelope<BridgePing>;
  if (!payload.ok || !payload.result) {
    throw new Error(payload.error || "Zotero local bridge ping failed");
  }
  return payload.result;
}

export async function hasBridge(): Promise<boolean> {
  try {
    await pingBridge();
    return true;
  } catch {
    return false;
  }
}
