import type { SourceFile } from '../types/analysis';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4318';
const DEFAULT_HEALTH_TIMEOUT_MS = 1200;
const DEFAULT_DEOBFUSCATION_TIMEOUT_MS = 20000;
const HEALTH_CACHE_TTL_MS = 5000;

export interface LocalDeobfuscationBridgeHealth {
  ok: true;
  bridge: string;
  capabilities: string[];
}

export interface LocalDeobfuscationBridgeFileWarning {
  stage: string;
  message: string;
}

export interface LocalDeobfuscationBridgeFile extends SourceFile {
  changed: boolean;
  steps: string[];
  warnings: LocalDeobfuscationBridgeFileWarning[];
  moduleCount: number;
}

export interface LocalDeobfuscationBridgeResponse {
  ok: true;
  bridge: string;
  capabilities: string[];
  processedAt: string;
  fileCount: number;
  transformedCount: number;
  unpackedBundleCount: number;
  files: LocalDeobfuscationBridgeFile[];
}

let cachedHealth: LocalDeobfuscationBridgeHealth | null = null;
let lastHealthCheckAt = 0;
let activeHealthCheck: Promise<LocalDeobfuscationBridgeHealth | null> | null = null;

export function getLocalDeobfuscationBridgeUrl(): string {
  const configured = import.meta.env.VITE_LOCAL_DEOBFUSCATION_BRIDGE_URL?.trim();
  return configured || DEFAULT_BRIDGE_URL;
}

function createBridgeUrl(pathname: string): string {
  return `${getLocalDeobfuscationBridgeUrl().replace(/\/+$/u, '')}${pathname}`;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Bridge request failed with status ${response.status}.`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function probeLocalDeobfuscationBridge(options?: {
  timeoutMs?: number;
  force?: boolean;
}): Promise<LocalDeobfuscationBridgeHealth | null> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const force = options?.force ?? false;
  const now = Date.now();

  if (!force && activeHealthCheck) {
    return activeHealthCheck;
  }

  if (!force && cachedHealth && now - lastHealthCheckAt < HEALTH_CACHE_TTL_MS) {
    return cachedHealth;
  }

  activeHealthCheck = (async () => {
    try {
      const result = await fetchJson<LocalDeobfuscationBridgeHealth>(
        createBridgeUrl('/health'),
        {
          method: 'GET',
        },
        timeoutMs,
      );
      cachedHealth = result.ok ? result : null;
      return cachedHealth;
    } catch {
      cachedHealth = null;
      return null;
    } finally {
      lastHealthCheckAt = Date.now();
      activeHealthCheck = null;
    }
  })();

  return activeHealthCheck;
}

export async function requestLocalDeobfuscation(
  files: SourceFile[],
  options?: {
    timeoutMs?: number;
  },
): Promise<LocalDeobfuscationBridgeResponse> {
  return fetchJson<LocalDeobfuscationBridgeResponse>(
    createBridgeUrl('/api/deobfuscate'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files,
      }),
    },
    options?.timeoutMs ?? DEFAULT_DEOBFUSCATION_TIMEOUT_MS,
  );
}
