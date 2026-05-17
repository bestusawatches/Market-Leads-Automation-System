// src/utils/proxy-rotator.ts
// ─────────────────────────────────────────────────────────────────────────────
// Manages proxy rotation across all scrapers
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from './logger';

export class ProxyRotator {
  private proxyUrls: string[];
  private currentIndex: number = 0;

  constructor(proxyUrls: string[]) {
    this.proxyUrls = proxyUrls.filter((url) => url && url.trim());
    if (this.proxyUrls.length === 0) {
      logger.warn('[proxy-rotator] No proxies configured — scrapers will run without proxies');
    } else {
      logger.info(`[proxy-rotator] Initialized with ${this.proxyUrls.length} proxy(ies)`);
      this.proxyUrls.forEach((url, i) => {
        const masked = this.maskProxyUrl(url);
        logger.debug(`[proxy-rotator] Proxy ${i + 1}: ${masked}`);
      });
    }
  }

  /**
   * Get the next proxy in rotation
   */
  getNextProxy(): string | null {
    if (this.proxyUrls.length === 0) {
      return null;
    }

    const proxy = this.proxyUrls[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxyUrls.length;
    logger.debug(
      `[proxy-rotator] Returning proxy ${this.currentIndex} (next index: ${this.currentIndex})`,
    );
    return proxy;
  }

  /**
   * Get current proxy without rotating
   */
  getCurrentProxy(): string | null {
    if (this.proxyUrls.length === 0) {
      return null;
    }
    return this.proxyUrls[this.currentIndex];
  }

  /**
   * Get all available proxies
   */
  getAllProxies(): string[] {
    return [...this.proxyUrls];
  }

  /**
   * Get number of available proxies
   */
  getProxyCount(): number {
    return this.proxyUrls.length;
  }

  /**
   * Reset rotation counter
   */
  reset(): void {
    this.currentIndex = 0;
    logger.debug('[proxy-rotator] Rotation counter reset');
  }

  /**
   * Mask proxy URL for logging (hide credentials)
   */
  private maskProxyUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const user = parsed.username ? `${parsed.username}:***` : '';
      const auth = user ? `${user}@` : '';
      return `http://${auth}${parsed.host}`;
    } catch {
      return url.replace(/:[^:/@]+@/g, ':***@');
    }
  }
}

// ── Singleton instance ─────────────────────────────────────────────────────────
let proxyRotatorInstance: ProxyRotator | null = null;

export function initializeProxyRotator(proxyUrls: string[]): ProxyRotator {
  proxyRotatorInstance = new ProxyRotator(proxyUrls);
  return proxyRotatorInstance;
}

export function getProxyRotator(): ProxyRotator {
  if (!proxyRotatorInstance) {
    throw new Error(
      '[proxy-rotator] ProxyRotator not initialized. Call initializeProxyRotator() first.',
    );
  }
  return proxyRotatorInstance;
}
