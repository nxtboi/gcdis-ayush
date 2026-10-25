'use client';

import React from 'react';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import type { GalleryImage, Sponsor } from '@/lib/site-content';
import type { HomeContent } from '@/lib/home-content';
import { linksToHiddenSection, type HomeBodyKey } from '@/lib/home-sections';
import { AboutSection } from './AboutSection';
import { AwardsSection, buildMosaicTiles } from './AwardsSection';
import { CentresSection } from './CentresSection';
import { LimeMarquee } from './LimeMarquee';
import { MissionSection } from './MissionSection';
import { MouStrip } from './MouStrip';
import { NewsSection, type HomeAnnouncement } from './NewsSection';
import { PartnersStrip } from './PartnersStrip';
import { ProgrammesSection } from './ProgrammesSection';
import { ServicesSection } from './ServicesSection';
import { TestimonialsSection } from './TestimonialsSection';

export interface HomeBentoProps {
  /** Home content with placeholders already resolved for the environment (see lib/home-content.ts). */
  content: HomeContent;
  /** Enabled body sections in the order set in the staff console (lib/home-sections.ts). */
  order: readonly HomeBodyKey[];
  /** Anchors of hidden sections: in-page links to them are not shown. */
  hiddenAnchors?: readonly string[];
  /** HOME-placement sponsors (empty when none or when the sponsors section is disabled). */
  sponsors: Sponsor[];
  /** Published gallery images (empty when none or when the gallery is disabled). */
  gallery: GalleryImage[];
  galleryTitle: string;
  /** Bulletin from the published hero CMS section, shown among the news cards. */
  announcement?: HomeAnnouncement | null;
}

/**
 * Body of the home page below the hero ticker, in the "bold bento" design. Sections render in the order
 * set in the staff console (disabled sections are absent from `order`), and only when they have content:
 * the MoU strip, the awards / gallery mosaic and the testimonials disappear in production until the
 * Centre supplies their facts.
 */
export function HomeBento({ content, order, hiddenAnchors = [], sponsors, gallery, galleryTitle, announcement }: HomeBentoProps) {
  const siteInfo = useSiteInfo();
  const mosaic = buildMosaicTiles(content.awards.items, gallery);
  // The About call to action points at another section (#mission by default): hide it with that section.
  const about = content.about.cta && linksToHiddenSection(content.about.cta.href, hiddenAnchors) ? { ...content.about, cta: null } : content.about;

  const render = (key: HomeBodyKey): React.ReactNode => {
    switch (key) {
      case 'partners':
        return <PartnersStrip sponsors={sponsors} content={content.partners} email={siteInfo.email} />;
      case 'about':
        return <AboutSection content={about} />;
      case 'mission':
        return <MissionSection content={content.mission} />;
      case 'centres':
        return content.centres.items.length > 0 && <CentresSection content={content.centres} />;
      case 'programmes':
        return <ProgrammesSection content={content.programmes} />;
      case 'marquee':
        return <LimeMarquee items={content.marquee.items} />;
      case 'mous':
        return <MouStrip content={content.mous} />;
      case 'services':
        return <ServicesSection content={content.services} />;
      case 'news':
        return <NewsSection content={content.news} announcement={announcement} />;
      case 'awards':
        return <AwardsSection content={content.awards} kind={mosaic.kind} tiles={mosaic.tiles} galleryTitle={galleryTitle} />;
      case 'testimonials':
        return <TestimonialsSection content={content.testimonials} />;
      default:
        return null;
    }
  };

  return (
    <>
      {/* Vertical motion-blur filter used by the counters (CountUp) */}
      <svg aria-hidden="true" focusable="false" width="0" height="0" className="absolute">
        <filter id="bento-vblur" x="0" y="-50%" width="100%" height="200%">
          <feGaussianBlur stdDeviation="0 1.8" />
        </filter>
      </svg>

      {order.map((key) => (
        <React.Fragment key={key}>{render(key)}</React.Fragment>
      ))}
    </>
  );
}
