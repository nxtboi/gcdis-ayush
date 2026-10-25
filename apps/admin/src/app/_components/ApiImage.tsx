'use client';

import React, { useEffect, useState } from 'react';
import { resolveApiAssetUrl } from '../../lib/api-client';

type ApiImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string };

/**
 * Image served by the API. When the browser refuses to embed it directly (for example because the API
 * sends Cross-Origin-Resource-Policy: same-origin and the console runs on another origin), the file is
 * fetched with CORS and shown from a local object URL instead.
 */
export default function ApiImage({ src, alt = '', onError, ...rest }: ApiImageProps) {
  const resolved = resolveApiAssetUrl(src);
  const [fallback, setFallback] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFallback(null);
    setFailed(false);
  }, [resolved]);

  useEffect(
    () => () => {
      if (fallback) URL.revokeObjectURL(fallback);
    },
    [fallback]
  );

  const handleError = async (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
    if (fallback || failed || /^(blob:|data:)/.test(resolved)) {
      onError?.(event);
      return;
    }
    setFailed(true);
    try {
      const res = await fetch(resolved, { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      setFallback(URL.createObjectURL(await res.blob()));
    } catch {
      onError?.(event);
    }
  };

  return <img {...rest} alt={alt} src={fallback ?? resolved} onError={handleError} />;
}

/**
 * Displayable address for an API asset used outside an <img> element (CSS backgrounds, <video>).
 * Starts with the direct URL; when an image probe shows the browser refuses to embed it, the file is
 * fetched with CORS and an object URL is returned instead.
 */
export function useApiAssetSrc(url: string | null | undefined, kind: 'image' | 'video' = 'image'): string {
  const resolved = url ? resolveApiAssetUrl(url) : '';
  const [src, setSrc] = useState(resolved);

  useEffect(() => {
    setSrc(resolved);
    if (!resolved || /^(blob:|data:)/.test(resolved)) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const loadBlob = async () => {
      try {
        const res = await fetch(resolved, { credentials: 'omit' });
        if (!res.ok || cancelled) return;
        objectUrl = URL.createObjectURL(await res.blob());
        if (!cancelled) setSrc(objectUrl);
      } catch {
        // Keep the direct URL; the preview shows the overlay only
      }
    };
    if (kind === 'video') {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onerror = () => void loadBlob();
      probe.src = resolved;
    } else {
      const probe = new Image();
      probe.onerror = () => void loadBlob();
      probe.src = resolved;
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resolved, kind]);

  return src;
}
