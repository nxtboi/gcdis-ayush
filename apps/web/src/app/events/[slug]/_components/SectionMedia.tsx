'use client';

/**
 * Console-managed media for the championship page's sections and items (`sections` of
 * GET /cms/public/championship-media, re-validated in lib/championship-media.ts: site uploads only).
 *
 * - `MediaVisual` fills its parent (which fixes the size, so there is no layout shift) with the image, and the
 *   video over it when there is one. The video is muted, looped, inline and silent, uses the image as its
 *   poster, is mounted only once the visual first scrolls near the viewport, plays only while it is in view
 *   and pauses outside it. With `prefers-reduced-motion` or `navigator.connection.saveData` only the image is
 *   shown (or, without an image, the video's first frame, never playing).
 * - `MediaBanner` is a bento tile with a fixed aspect ratio for a section's own media.
 * - `MediaBackdrop` puts a section's media behind its content, under a navy overlay.
 * Nothing is rendered when a slot has no media, so the page looks exactly as before.
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useReduce } from '@/components/home-bento/hooks';
import { CmsImage } from '@/components/site/CmsImage';
import { safeUploadUrl, type ChampionshipSectionMedia, type SectionMedia, type SectionMediaKey, type SlotMedia } from '@/lib/championship-media';
import { Card, cx } from './EventPrimitives';

const SectionMediaContext = createContext<ChampionshipSectionMedia>({});

export function SectionMediaProvider({ value, children }: { value: ChampionshipSectionMedia; children: React.ReactNode }) {
  return <SectionMediaContext.Provider value={value}>{children}</SectionMediaContext.Provider>;
}

const NO_MEDIA: SectionMedia = { own: null, items: {} };

/** The media of one section (own slot and items); empty when nothing is set. */
export function useSectionMedia(key: SectionMediaKey): SectionMedia {
  return useContext(SectionMediaContext)[key] ?? NO_MEDIA;
}

interface NavigatorConnection {
  saveData?: boolean;
}

/** Whether section videos may play: no reduced-motion request and no data-saving mode (false until mounted). */
function useMotionVideoAllowed(): boolean {
  const reduce = useReduce();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: NavigatorConnection }).connection;
    setAllowed(!reduce && !connection?.saveData);
  }, [reduce]);
  return allowed;
}

/** Defensive second check before rendering: only absolute URLs of site uploads (as produced by safeUploadUrl). */
function checkedUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return safeUploadUrl(parsed.pathname) ? url : null;
  } catch {
    return null;
  }
}

/** True when the slot has something to show. */
export function hasMedia(slot: SlotMedia | null | undefined): slot is SlotMedia {
  return Boolean(slot && (checkedUrl(slot.imageUrl) || checkedUrl(slot.videoUrl)));
}

export function MediaVisual({
  media,
  fallbackAlt,
  sizes,
  className
}: {
  media: SlotMedia;
  /** Alternative text when staff left it empty (describes the section or item). */
  fallbackAlt: string;
  sizes: string;
  className?: string;
}) {
  const imageUrl = checkedUrl(media.imageUrl);
  const videoUrl = checkedUrl(media.videoUrl);
  const allowed = useMotionVideoAllowed();
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [playing, setPlaying] = useState(false);
  const alt = media.imageAlt || fallbackAlt;
  const animate = Boolean(videoUrl && allowed);

  // Mount the video only once the tile first comes near the viewport.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !animate || near) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setNear(true);
      },
      { rootMargin: '200px 0px' }
    );
    io.observe(box);
    return () => io.disconnect();
  }, [animate, near]);

  // Play only while in view; pause outside it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !animate || !near) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) video.play().catch(() => undefined);
        else video.pause();
      },
      { threshold: 0.15 }
    );
    io.observe(video);
    return () => {
      io.disconnect();
      video.pause();
    };
  }, [animate, near]);

  return (
    <div ref={boxRef} className={cx('absolute inset-0 overflow-hidden bg-slate-900', className)} data-section-media="">
      {imageUrl && <CmsImage src={imageUrl} alt={videoUrl && animate ? '' : alt} sizes={sizes} className="object-cover" />}
      {videoUrl && !imageUrl && !animate && (
        // Reduced motion / data saving without an image: the first frame only, never playing
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          aria-label={alt}
          tabIndex={-1}
        />
      )}
      {videoUrl && animate && near && (
        <video
          ref={videoRef}
          className={cx('absolute inset-0 h-full w-full object-cover transition-opacity duration-700', playing || !imageUrl ? 'opacity-100' : 'opacity-0')}
          src={videoUrl}
          poster={imageUrl ?? undefined}
          muted
          loop
          playsInline
          preload="metadata"
          disablePictureInPicture
          disableRemotePlayback
          aria-label={alt}
          tabIndex={-1}
          onPlaying={() => setPlaying(true)}
        />
      )}
    </div>
  );
}

/** A section's own media as a bento tile with a fixed aspect ratio (no layout shift). */
export function MediaBanner({
  media,
  fallbackAlt,
  dark = false,
  className
}: {
  media: SlotMedia | null | undefined;
  fallbackAlt: string;
  dark?: boolean;
  className?: string;
}) {
  if (!hasMedia(media)) return null;
  return (
    <Card dark={dark} wrapperClassName={cx('mt-10', className)} className="relative aspect-[16/9] overflow-hidden sm:aspect-[21/9]">
      <MediaVisual media={media} fallbackAlt={fallbackAlt} sizes="(min-width: 1280px) 1216px, 100vw" />
    </Card>
  );
}

/** Media at the top of a card (an item such as the D20 card or a programme day), 16:9. */
export function CardMedia({
  media,
  fallbackAlt,
  dark = false,
  className
}: {
  media: SlotMedia | null | undefined;
  fallbackAlt: string;
  dark?: boolean;
  className?: string;
}) {
  if (!hasMedia(media)) return null;
  return (
    <div className={cx('relative aspect-[16/9] overflow-hidden rounded-xl border-2', dark ? 'border-white/20' : 'border-bento-ink', className)}>
      <MediaVisual media={media} fallbackAlt={fallbackAlt} sizes="(min-width: 1024px) 600px, 100vw" />
    </div>
  );
}

/** A section's media behind its content, under a navy overlay that keeps the text legible. */
export function MediaBackdrop({ media, fallbackAlt }: { media: SlotMedia | null | undefined; fallbackAlt: string }) {
  if (!hasMedia(media)) return null;
  return (
    <div className="pointer-events-none absolute inset-0 -z-20">
      <MediaVisual media={media} fallbackAlt={fallbackAlt} sizes="100vw" />
      <div aria-hidden="true" className="absolute inset-0 bg-[#0F172A]/80" />
    </div>
  );
}
