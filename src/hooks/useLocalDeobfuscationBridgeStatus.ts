import { useEffect, useState } from 'react';
import {
  getLocalDeobfuscationBridgeUrl,
  probeLocalDeobfuscationBridge,
  type LocalDeobfuscationBridgeHealth,
} from '../lib/local-deobfuscation-bridge';

export type LocalDeobfuscationBridgeStatus = 'checking' | 'online' | 'offline';

export function useLocalDeobfuscationBridgeStatus(enabled: boolean): {
  status: LocalDeobfuscationBridgeStatus;
  health: LocalDeobfuscationBridgeHealth | null;
  url: string;
} {
  const [status, setStatus] = useState<LocalDeobfuscationBridgeStatus>('offline');
  const [health, setHealth] = useState<LocalDeobfuscationBridgeHealth | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus('offline');
      setHealth(null);
      return;
    }

    let cancelled = false;
    let consecutiveFailures = 0;
    let hasConnectedOnce = false;

    const refresh = async (force = false) => {
      if (!cancelled) {
        setStatus((current) => (current === 'online' && !force ? current : 'checking'));
      }

      const nextHealth = await probeLocalDeobfuscationBridge({ force });

      if (cancelled) {
        return;
      }

      if (nextHealth) {
        hasConnectedOnce = true;
        consecutiveFailures = 0;
        setHealth(nextHealth);
        setStatus('online');
        return;
      }

      consecutiveFailures += 1;
      setHealth(null);
      setStatus(!hasConnectedOnce || consecutiveFailures >= 2 ? 'offline' : 'online');
    };

    void refresh(true);
    const intervalId = window.setInterval(() => {
      void refresh(true);
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  return {
    status,
    health,
    url: getLocalDeobfuscationBridgeUrl(),
  };
}
