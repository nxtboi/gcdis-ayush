'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, Star } from 'lucide-react';
import { CmsImage } from '@/components/site/CmsImage';
import { GalleryLightbox } from '@/components/site/GallerySection';
import type { GalleryImage } from '@/lib/site-content';
import type { HomeContent } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { LAB_PHOTO, LabPhoto, Parallax } from './Effects';
import { SectionMedia, VideoLayer } from './Media';
import { BentoSection, Shape, Stagger } from './Section';
import { Eyebrow, RevealHeading } from './Text';
import { CONTAINER, EASE, H2, cx } from './tokens';

/** One mosaic tile: an award (with a photo) or a gallery image. */
export interface MosaicTile {
  id: string;
  title: string;
  detail: string | null;
  badge: string | null;
  image: GalleryImage;
  /** Award video (muted, looping, plays while in view) over the image; set in the staff console. */
  videoUrl?: string | null;
}

const LAB_CROPS = ['40% 60%', '80% 30%', '15% 75%', '60% 45%'];

/** Lab photograph as a viewer-compatible image (used when the console has no gallery images). */
function labImage(i: number, title: string): GalleryImage {
  return {
    id: `lab-${i}`,
    imageUrl: LAB_PHOTO,
    title,
    caption: null,
    altText: 'The GCDIS drone laboratory',
    category: null,
    displayOrder: i,
    width: 1600,
    height: 604
  };
}

/** Photograph uploaded for an award in the staff console, as a viewer-compatible image. */
function uploadedImage(award: HomeContent['awards']['items'][number], i: number): GalleryImage {
  return {
    id: `award-image-${award.id}`,
    imageUrl: award.imageUrl as string,
    title: award.title,
    caption: award.detail || null,
    altText: award.imageAlt || award.title,
    category: null,
    displayOrder: i,
    width: null,
    height: null
  };
}

/**
 * Tiles of the mosaic: verified awards when there are any (photos from the gallery, or crops of the lab
 * photograph), otherwise the console-managed gallery. Empty when neither exists (the section is hidden).
 */
export function buildMosaicTiles(awards: HomeContent['awards']['items'], gallery: GalleryImage[]): { kind: 'awards' | 'gallery'; tiles: MosaicTile[] } {
  if (awards.length > 0) {
    return {
      kind: 'awards',
      tiles: awards.slice(0, 4).map((a, i) => ({
        id: a.id,
        title: a.title,
        detail: a.detail,
        badge: a.badge,
        image: a.imageUrl ? uploadedImage(a, i) : gallery[i] ? { ...gallery[i], title: a.title } : labImage(i, a.title),
        videoUrl: a.videoUrl ?? null
      }))
    };
  }
  return {
    kind: 'gallery',
    tiles: gallery.slice(0, 4).map((g) => ({ id: g.id, title: g.title || g.altText, detail: g.caption, badge: g.category, image: g }))
  };
}

/** Grid placement by tile count, so the mosaic always fills its rectangle. */
const SPANS: Record<number, string[]> = {
  1: ['md:col-span-4 md:row-span-2'],
  2: ['md:col-span-2 md:row-span-2', 'md:col-span-2 md:row-span-2'],
  3: ['md:col-span-2 md:row-span-2', 'md:col-span-2', 'md:col-span-2'],
  4: ['md:col-span-2 md:row-span-2', '', '', 'md:col-span-2']
};

export function AwardsSection({
  content,
  kind,
  tiles,
  galleryTitle
}: {
  content: HomeContent['awards'];
  kind: 'awards' | 'gallery';
  tiles: MosaicTile[];
  galleryTitle: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (tiles.length === 0) return null;
  const spans = SPANS[tiles.length] ?? SPANS[4];
  const images = tiles.map((t) => t.image);
  const heading = kind === 'awards' ? content.heading : galleryTitle;

  return (
    <BentoSection
      id={kind === 'awards' ? 'awards' : 'gallery'}
      labelledBy="awards-heading"
      decor={<Shape kind="orange-circle" depth={2} className="right-[6%] top-10 h-36 w-36" />}
    >
      <div className={cx(CONTAINER, 'py-20')}>
        <div className="text-center">
          <Eyebrow text={kind === 'awards' ? content.eyebrow : content.galleryEyebrow} />
          <RevealHeading id="awards-heading" text={heading} className={cx(H2, 'mt-3')} />
        </div>

        <SectionMedia media={content} className="mt-10" />

        <Stagger as="ul" className="mt-12 grid auto-rows-[220px] gap-5 md:grid-cols-4 md:grid-rows-[220px_220px]">
          {tiles.map((tile, i) => {
            const big = i === 0;
            return (
              <BentoCard key={tile.id} as="li" pressable wrapperClassName={spans[i]} className="group relative overflow-hidden bg-bento-ink">
                <Parallax depth={big ? 0.6 : 0.3} className="absolute -inset-y-8 inset-x-0">
                  <div className="absolute inset-0 transition-transform duration-700 ease-out group-hover:scale-[1.07] motion-reduce:transition-none motion-reduce:group-hover:scale-100">
                    {tile.image.imageUrl === LAB_PHOTO ? (
                      <LabPhoto position={LAB_CROPS[i % LAB_CROPS.length]} sizes={big ? '(min-width: 768px) 50vw, 100vw' : '(min-width: 768px) 25vw, 100vw'} />
                    ) : (
                      <CmsImage src={tile.image.imageUrl} alt="" sizes={big ? '(min-width: 768px) 50vw, 100vw' : '(min-width: 768px) 25vw, 100vw'} className="object-cover" />
                    )}
                    <VideoLayer videoUrl={tile.videoUrl} poster={tile.image.imageUrl === LAB_PHOTO ? null : tile.image.imageUrl} />
                  </div>
                </Parallax>
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bento-ink/90 via-bento-ink/20 to-transparent" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => setOpen(i)}
                  className="absolute inset-0 z-10 flex flex-col justify-end overflow-hidden p-5 text-left text-white focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[6px] focus-visible:outline-bento-lime sm:p-6"
                >
                  {tile.badge && (
                    <span className="mb-2 inline-flex w-fit items-center gap-1 rounded bg-bento-lime px-2 py-1 font-mono text-[10px] font-bold uppercase text-bento-ink">
                      {kind === 'awards' && <Star className="h-3 w-3 fill-current" aria-hidden="true" />}
                      {tile.badge}
                    </span>
                  )}
                  <span className={cx('font-extrabold', big ? 'text-xl' : 'text-sm')}>{tile.title}</span>
                  {tile.detail && (
                    <span className="block translate-y-3 text-xs text-zinc-300 opacity-0 transition-[opacity,transform] duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
                      {tile.detail}
                    </span>
                  )}
                  <span className="sr-only">, open in the image viewer</span>
                </button>
                <motion.span
                  aria-hidden="true"
                  className="pointer-events-none absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 border-bento-ink bg-white text-bento-ink"
                  whileHover={{ scale: 1.1 }}
                  transition={{ duration: 0.3, ease: EASE }}
                >
                  <Maximize2 className="h-4 w-4" />
                </motion.span>
              </BentoCard>
            );
          })}
        </Stagger>
      </div>

      <AnimatePresence>
        {open !== null && images[open] && <GalleryLightbox images={images} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </BentoSection>
  );
}
