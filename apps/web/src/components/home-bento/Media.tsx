'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { MediaFields } from '../../lib/home-content';
import { LabPhoto } from './Effects';
import { cx } from './tokens';

/**
 * Media of home page sections and entries (set under Home Page Sections in the staff console).
 *
 * Contract:
 * - A video (uploaded EVENT_VIDEO file, URL already re-validated by `sanitiseHomeLinks`) plays muted, looped and
 *   inline, with the entry's image as its poster. It is mounted only on the client, only when the visitor has not
 *   asked for reduced motion or data saving, and it plays only while it is in view (IntersectionObserver) and
 *   pauses when it leaves the viewport.
 * - Until the video is actually playing it stays transparent, so the image (or the default laboratory photograph)
 *   underneath is what the visitor sees first; nothing changes size, so there is no layout shift.
 * - Without a video the image is shown; without either, the existing default.
 * - No external embeds: only `<video>` with an API-hosted source.
 */

/** True when the browser reports a data-saving preference (Save-Data / navigator.connection.saveData). */
export function prefersSaveData(nav: unknown = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  const connection = (nav as { connection?: { saveData?: unknown } } | undefined)?.connection;
  return Boolean(connection && connection.saveData === true);
}

/** Whether ambient video may be shown: false on the server, on the first render, with reduced motion or data saving. */
export function useAmbientVideoAllowed(): boolean {
  const reduce = useReducedMotion();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(!prefersSaveData());
  }, []);
  return allowed && !reduce;
}

/** True when the entry has an image or a video. */
export function hasMedia(media: MediaFields | null | undefined): boolean {
  return Boolean(media && (media.imageUrl || media.videoUrl));
}

/**
 * Muted, looping, inline video that plays only while in view. `eager` (the hero) starts loading at once and
 * autoplays; otherwise nothing is downloaded until the video scrolls into view.
 */
export function AmbientVideo({
  src,
  poster,
  className,
  style,
  eager = false
}: {
  src: string;
  poster?: string | null;
  className?: string;
  style?: React.CSSProperties;
  eager?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    const play = () => {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => undefined);
    };
    if (typeof IntersectionObserver === 'undefined') {
      play();
      return () => video.pause();
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) play();
        else video.pause();
      },
      { threshold: 0.15 }
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      video.pause();
    };
  }, [src]);

  return (
    <video
      ref={ref}
      src={src}
      poster={poster || undefined}
      muted
      loop
      playsInline
      autoPlay={eager}
      preload={eager ? 'auto' : 'none'}
      disablePictureInPicture
      disableRemotePlayback
      aria-hidden="true"
      tabIndex={-1}
      data-ambient-video=""
      onPlaying={() => setPlaying(true)}
      className={cx(
        'pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-700 motion-reduce:transition-none',
        playing ? 'opacity-100' : 'opacity-0',
        className
      )}
      style={style}
    />
  );
}

/** The entry's video over whatever image is already shown, when ambient video is allowed (else nothing). */
export function VideoLayer({
  videoUrl,
  poster,
  position,
  eager = false
}: {
  videoUrl?: string | null;
  poster?: string | null;
  position?: string;
  /** Load and autoplay at once (the hero, which is in view on load). */
  eager?: boolean;
}) {
  const allowed = useAmbientVideoAllowed();
  if (!allowed || !videoUrl) return null;
  return <AmbientVideo src={videoUrl} poster={poster} eager={eager} style={position ? { objectPosition: position } : undefined} />;
}

/**
 * Fills its (relative, overflow-hidden) parent: the entry's image or the laboratory photograph, with the entry's
 * video on top when allowed. Drop-in replacement for `LabPhoto`.
 */
export function MediaFill({
  media,
  position = '50% 50%',
  sizes,
  alt
}: {
  media: MediaFields | null | undefined;
  position?: string;
  sizes: string;
  /** Overrides the entry's `imageAlt` (empty = decorative). */
  alt?: string;
}) {
  const image = media?.imageUrl || null;
  return (
    <>
      <LabPhoto src={image} position={position} sizes={sizes} alt={alt ?? media?.imageAlt ?? ''} />
      <VideoLayer videoUrl={media?.videoUrl} poster={image} position={position} />
    </>
  );
}

/** Image / video box of a card that has no photograph of its own (services, MoUs): nothing when unset. */
export function ItemMedia({ media, className, sizes = '(min-width: 1024px) 400px, 100vw' }: { media: MediaFields | null | undefined; className?: string; sizes?: string }) {
  if (!hasMedia(media)) return null;
  return (
    <div data-item-media="" className={cx('relative aspect-video w-full overflow-hidden rounded-xl border-2 border-black/15', className)}>
      <MediaFill media={media} sizes={sizes} />
    </div>
  );
}

/**
 * Feature image / video of a whole section, in a fixed aspect box (no layout shift). Renders nothing when the
 * section has no media, so sections without media look exactly as before.
 */
export function SectionMedia({
  media,
  tone = 'paper',
  className,
  sizes = '(min-width: 1280px) 1200px, 100vw'
}: {
  media: MediaFields | null | undefined;
  tone?: 'paper' | 'dark';
  className?: string;
  sizes?: string;
}) {
  if (!hasMedia(media)) return null;
  return (
    <div
      data-section-media=""
      className={cx(
        'relative aspect-video w-full overflow-hidden rounded-[28px] border-[2.5px] sm:aspect-[21/9]',
        tone === 'dark' ? 'border-white/15 bg-white/5' : 'border-bento-ink bg-bento-ink/5',
        className
      )}
    >
      <MediaFill media={media} sizes={sizes} />
    </div>
  );
}
