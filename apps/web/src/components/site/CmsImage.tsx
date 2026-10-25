'use client';

import React from 'react';
import Image from 'next/image';
import { isApiHostedImage } from '@/lib/site-content';

interface CmsImageProps {
  src: string;
  alt: string;
  /** Responsive `sizes` hint for the optimiser. */
  sizes: string;
  className?: string;
  priority?: boolean;
}

/**
 * Image uploaded through the staff console. Rendered with `fill` inside a fixed-aspect parent (no layout
 * shift). Files on the API host go through the Next.js image optimiser, which serves them from this
 * origin; any other http(s) URL is shown as-is (still subject to the img-src CSP).
 */
export function CmsImage({ src, alt, sizes, className, priority }: CmsImageProps) {
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={!isApiHostedImage(src)}
      className={className}
    />
  );
}
