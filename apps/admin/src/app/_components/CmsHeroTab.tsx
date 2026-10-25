'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle, Clapperboard, Upload, RotateCcw, Sliders, Smartphone, Monitor, Eye, Type, X } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { useApiAssetSrc } from './ApiImage';
import MediaUploadField, { type MediaValue } from './MediaUploadField';
import { EASE_OUT, MotionLi, Skeleton, staggerProps } from './motion';
import { HERO_TEXT_LIMITS, formatDateTime, type ContentVersion, type HeroConfig, type HeroText } from './types';

const TEXT_FIELDS: { key: keyof HeroText; label: string; multiline?: boolean; rows?: number; hint?: string }[] = [
  { key: 'headline', label: 'Headline' },
  { key: 'tagline', label: 'Tagline' },
  { key: 'description', label: 'Description', multiline: true, rows: 4 },
  { key: 'announcementTitle', label: 'Announcement Title' },
  { key: 'announcementDate', label: 'Announcement Date', hint: 'Shown exactly as entered, for example 1 December 2026.' },
  { key: 'announcementBody', label: 'Announcement Text', multiline: true, rows: 5 }
];

const TEXT_INPUT_CLASS =
  'w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#22C55E] transition-colors';

const SLIDERS: { key: keyof HeroConfig; id: string; label: string; min: number; max: number; unit: string; scale?: number }[] = [
  { key: 'focusX', id: 'hero-focus-x', label: 'Horizontal Focus', min: 0, max: 100, unit: '%' },
  { key: 'focusY', id: 'hero-focus-y', label: 'Vertical Focus', min: 0, max: 100, unit: '%' },
  { key: 'mobileCropFocusY', id: 'hero-mobile-focus-y', label: 'Vertical Focus on Mobile', min: 0, max: 100, unit: '%' },
  { key: 'zoom', id: 'hero-zoom', label: 'Zoom', min: 100, max: 200, unit: '%' },
  { key: 'overlayOpacity', id: 'hero-overlay-opacity', label: 'Overlay Opacity', min: 0, max: 100, unit: '%', scale: 100 },
  { key: 'blurPx', id: 'hero-blur', label: 'Blur (maximum 20 px)', min: 0, max: 20, unit: ' px' },
  { key: 'brightnessPct', id: 'hero-brightness', label: 'Brightness (maximum 200%)', min: 0, max: 200, unit: '%' }
];

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

interface CmsHeroTabProps {
  heroConfig: HeroConfig;
  setHeroConfig: React.Dispatch<React.SetStateAction<HeroConfig>>;
  heroText: HeroText;
  setHeroText: React.Dispatch<React.SetStateAction<HeroText>>;
  previewDevice: 'desktop' | 'mobile';
  setPreviewDevice: (device: 'desktop' | 'mobile') => void;
  isLoading: boolean;
  isSavingHero: boolean;
  isUploading: boolean;
  versionHistory: ContentVersion[];
  cmsSuccessMessage: string | null;
  cmsErrorMessage: string | null;
  onDismissMessages: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleUploadHeroBackground: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSaveHeroDraft: () => void;
  handlePublishHero: () => void;
  handleRollbackHero: (versionNum: number) => void;
  /** Opens the Site Information tab, where the About section image is managed. */
  onOpenSiteInfo?: () => void;
}

/** Message box that fades in and out inside an always-mounted live region. */
function AnimatedMessage({ message, tone, onDismiss }: { message: string | null; tone: 'success' | 'error'; onDismiss: () => void }) {
  const Icon = tone === 'success' ? CheckCircle : AlertTriangle;
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          key={message}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          className={`p-4 text-xs rounded-xl flex items-start justify-between gap-3 border ${
            tone === 'success' ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-rose-500/10 border-rose-500/40 text-rose-300'
          }`}
        >
          <span className="flex items-start gap-2">
            <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{message}</span>
          </span>
          <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="opacity-80 hover:opacity-100 transition-opacity">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Hero background video (and its poster image). Stored with the hero section of Home Page Sections
 * (`home_sections`, key `hero`: `videoUrl`, `imageUrl`), so it is validated, audited and cleaned up exactly like
 * every other home page media field: the video must be a public EVENT_VIDEO upload (MP4 / WebM), and replacing or
 * removing a saved video asks for the authenticator code. It is live as soon as it is saved (no draft / publish).
 */
function HeroVideoPanel() {
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [media, setMedia] = useState<MediaValue>({ imageUrl: null, videoUrl: null });
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (view: unknown) => {
    const c = view && typeof view === 'object' && (view as { content?: unknown }).content;
    const record = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
    setContent(record);
    setMedia({
      imageUrl: typeof record.imageUrl === 'string' ? record.imageUrl : null,
      videoUrl: typeof record.videoUrl === 'string' ? record.videoUrl : null,
      imageAlt: typeof record.imageAlt === 'string' ? record.imageAlt : ''
    });
  };

  const load = useCallback(async () => {
    try {
      apply(await adminFetch('/cms/admin/home/sections/hero'));
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The hero video settings could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const savedVideo = content && typeof content.videoUrl === 'string' ? content.videoUrl : null;
  const savedPoster = content && typeof content.imageUrl === 'string' ? content.imageUrl : null;
  const dirty = !!content && ((media.videoUrl || null) !== savedVideo || (media.imageUrl || null) !== savedPoster);

  const save = async () => {
    if (!content) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const next: Record<string, unknown> = { ...content, imageUrl: media.imageUrl || null, videoUrl: media.videoUrl || null };
      apply(await adminFetch('/cms/admin/home/sections/hero', { method: 'PATCH', body: JSON.stringify({ content: next }) }));
      setMessage('The hero background video has been saved. The public site updates within about 30 seconds.');
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setError(isStepUpCancelledError(err) ? err.message : `The hero video could not be saved. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-labelledby="hero-video-heading">
      <div>
        <h2 id="hero-video-heading" className="text-sm font-black text-white tracking-tight flex items-center gap-2">
          <Clapperboard className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
          <span>Hero Background Video</span>
        </h2>
        <p className="text-[11px] text-slate-400">
          Optional. Plays muted and looped behind the hero, under its dark overlay so the text stays legible. The poster image is shown first and
          instead of the video for visitors who prefer reduced motion or save data; without a poster, the background image below is
          used. Saved directly (not part of the draft and publish steps below).
        </p>
      </div>
      <div role="status" aria-live="polite">
        <AnimatedMessage message={message} tone="success" onDismiss={() => setMessage(null)} />
      </div>
      <div role="alert">
        <AnimatedMessage message={error} tone="error" onDismiss={() => setError(null)} />
      </div>
      <MediaUploadField
        label="Background video and poster"
        imageLabel="Poster image"
        videoLabel="Background video"
        showAlt={false}
        disabled={!content || busy}
        value={media}
        onChange={setMedia}
        onUploadingChange={(uploading) => setUploads((n) => Math.max(0, n + (uploading ? 1 : -1)))}
      />
      <div className="flex justify-end gap-3">
        <button
          type="button"
          disabled={!dirty || busy || uploads > 0}
          onClick={() => {
            if (content) apply({ content });
          }}
          className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Discard
        </button>
        <button
          type="button"
          disabled={!dirty || busy || uploads > 0}
          onClick={() => void save()}
          className="px-4 py-2.5 bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 font-black text-xs rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Saving…' : 'Save Hero Video'}
        </button>
      </div>
    </section>
  );
}

export default function CmsHeroTab({
  heroConfig,
  setHeroConfig,
  heroText,
  setHeroText,
  previewDevice,
  setPreviewDevice,
  isLoading,
  isSavingHero,
  isUploading,
  versionHistory,
  cmsSuccessMessage,
  cmsErrorMessage,
  onDismissMessages,
  fileInputRef,
  handleUploadHeroBackground,
  handleSaveHeroDraft,
  handlePublishHero,
  handleRollbackHero,
  onOpenSiteInfo
}: CmsHeroTabProps) {
  const update = <K extends keyof HeroConfig>(key: K, value: HeroConfig[K]) => setHeroConfig((prev) => ({ ...prev, [key]: value }));
  // Resolved through the API image helper so the preview also works when the API forbids cross-origin embedding
  const mediaSrc = useApiAssetSrc(heroConfig.mediaUrl, heroConfig.mediaType === 'video' ? 'video' : 'image');
  const backgroundPosition = `${heroConfig.focusX}% ${previewDevice === 'mobile' ? heroConfig.mobileCropFocusY : heroConfig.focusY}%`;
  const mediaStyle: React.CSSProperties = {
    transform: `scale(${heroConfig.zoom / 100})`,
    filter: `blur(${heroConfig.blurPx}px) brightness(${heroConfig.brightnessPct}%)`
  };

  return (
    <div className="space-y-6">
      {/* Live regions stay mounted so screen readers announce each new message */}
      <div role="status" aria-live="polite">
        <AnimatedMessage message={cmsSuccessMessage} tone="success" onDismiss={onDismissMessages} />
      </div>
      <div role="alert">
        <AnimatedMessage message={cmsErrorMessage} tone="error" onDismiss={onDismissMessages} />
      </div>

      {/* Hero Text */}
      <section className="bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-4" aria-labelledby="hero-text-heading" aria-busy={isLoading}>
        <div>
          <h2 id="hero-text-heading" className="text-sm font-black text-white tracking-tight flex items-center gap-2">
            <Type className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
            <span>Hero Text and Announcement</span>
          </h2>
          <p className="text-[11px] text-slate-400">
            Plain text only. Empty fields display the default wording on the public site. Changes are saved with the draft and take effect
            when published.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {TEXT_FIELDS.map(({ key, label, multiline, rows, hint }) => {
            const max = HERO_TEXT_LIMITS[key];
            const value = heroText[key];
            const id = `hero-text-${key}`;
            const counterId = `${id}-count`;
            const onChange = (next: string) => setHeroText((prev) => ({ ...prev, [key]: next.slice(0, max) }));
            return (
              <div key={key} className={multiline ? 'md:col-span-2' : undefined}>
                <div className="flex justify-between items-baseline mb-1">
                  <label htmlFor={id} className="text-xs font-bold text-slate-300">
                    {label}
                  </label>
                  <span
                    id={counterId}
                    className={`text-[10px] font-mono ${value.length >= max ? 'text-amber-400' : 'text-slate-400'}`}
                  >
                    {value.length} / {max} characters
                  </span>
                </div>
                {isLoading && !value ? (
                  <Skeleton className={multiline ? 'h-20 w-full rounded-xl' : 'h-9 w-full rounded-xl'} />
                ) : multiline ? (
                  <textarea
                    id={id}
                    rows={rows}
                    maxLength={max}
                    value={value}
                    aria-describedby={counterId}
                    onChange={(e) => onChange(e.target.value)}
                    className={TEXT_INPUT_CLASS}
                  />
                ) : (
                  <input
                    id={id}
                    type="text"
                    maxLength={max}
                    value={value}
                    aria-describedby={counterId}
                    onChange={(e) => onChange(e.target.value)}
                    className={TEXT_INPUT_CLASS}
                  />
                )}
                {hint && <p className="text-[10px] text-slate-400 mt-1">{hint}</p>}
              </div>
            );
          })}
        </div>
      </section>

      <HeroVideoPanel />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Visual Controls Panel */}
        <section className="lg:col-span-5 bg-[#111625] border border-slate-800 rounded-2xl p-6 space-y-6" aria-labelledby="hero-background-heading">
          <div>
            <h2 id="hero-background-heading" className="text-sm font-black text-white tracking-tight flex items-center gap-2">
              <Sliders className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
              <span>Hero Background Settings</span>
            </h2>
            <p className="text-[11px] text-slate-400">The server validates every value (blur up to 20 px; brightness up to 200%).</p>
          </div>

          {/* Background type and upload (files are scanned for malware and re-encoded by the API) */}
          <div className="space-y-3">
            <div>
              <label htmlFor="hero-media-type" className="block text-xs font-bold text-slate-300 mb-1.5">
                Background Type
              </label>
              <select
                id="hero-media-type"
                value={heroConfig.mediaType}
                onChange={(e) => update('mediaType', e.target.value as HeroConfig['mediaType'])}
                className="w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white"
              >
                <option value="image">Image</option>
                {/* Background videos are set under Hero Background Video above (validated EVENT_VIDEO uploads) */}
                {heroConfig.mediaType === 'video' && <option value="video">Video (no longer used: set it under Hero Background Video)</option>}
                <option value="color">Solid Colour</option>
              </select>
            </div>
            {heroConfig.mediaType !== 'color' && (
              <div>
                <label htmlFor="hero-background-file" className="block text-xs font-bold text-slate-300 mb-1.5">
                  Background File (scanned for malware and re-encoded on upload)
                </label>
                <input
                  id="hero-background-file"
                  type="file"
                  ref={fileInputRef}
                  onChange={handleUploadHeroBackground}
                  accept={heroConfig.mediaType === 'video' ? 'video/mp4' : 'image/jpeg,image/png,image/webp'}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={isUploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2.5 bg-[#182035] hover:bg-slate-800 border border-slate-700 rounded-xl text-xs font-bold text-slate-200 flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
                >
                  <Upload className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
                  <span>
                    {isUploading
                      ? 'Uploading…'
                      : `${heroConfig.mediaUrl ? 'Replace' : 'Choose'} Background ${heroConfig.mediaType === 'video' ? 'Video' : 'Image'}`}
                  </span>
                </button>
                <p className="text-[10px] text-slate-400 mt-1">
                  {heroConfig.mediaType === 'video' ? 'MP4 video, up to 25 MB.' : 'JPEG, PNG or WebP, up to 25 MB. A landscape image of at least 1920 px width is recommended.'}{' '}
                  The new file is shown in the preview at once and on the public site after you save and publish.
                </p>
                {heroConfig.mediaUrl && (
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[10px] text-slate-400 font-mono truncate" title={heroConfig.mediaUrl}>
                      Current file: {heroConfig.mediaUrl}
                    </span>
                    <button
                      type="button"
                      onClick={() => update('mediaUrl', '')}
                      disabled={isUploading}
                      className="text-[10px] font-bold text-rose-300 hover:text-rose-200 underline shrink-0 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )}
            {onOpenSiteInfo && (
              <p className="text-[10px] text-slate-400">
                The About section image is managed under{' '}
                <button type="button" onClick={onOpenSiteInfo} className="text-sky-300 hover:text-sky-200 underline font-bold">
                  Site Information
                </button>
                .
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="hero-overlay-colour" className="text-xs font-bold text-slate-300">
                Overlay Colour
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-slate-400">{heroConfig.overlayColor}</span>
                <input
                  id="hero-overlay-colour"
                  type="color"
                  value={HEX_COLOUR.test(heroConfig.overlayColor) ? heroConfig.overlayColor : '#0b1120'}
                  onChange={(e) => update('overlayColor', e.target.value)}
                  className="h-8 w-10 bg-transparent border border-slate-700 rounded cursor-pointer"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="hero-parallax"
                type="checkbox"
                checked={heroConfig.parallaxEnabled}
                onChange={(e) => update('parallaxEnabled', e.target.checked)}
                className="w-4 h-4 accent-[#22C55E]"
              />
              <label htmlFor="hero-parallax" className="text-xs font-bold text-slate-300">
                Parallax scrolling effect
              </label>
            </div>
          </div>

          {/* Sliders */}
          <div className="space-y-4 text-xs font-mono">
            {SLIDERS.map(({ key, id, label, min, max, unit, scale }) => {
              const raw = heroConfig[key] as number;
              const shown = scale ? Math.round(raw * scale) : raw;
              return (
                <div key={key}>
                  <div className="flex justify-between mb-1">
                    <label htmlFor={id} className="text-slate-300">
                      {label}
                    </label>
                    <span className="text-[#22C55E] font-bold">
                      {shown}
                      {unit}
                    </span>
                  </div>
                  <input
                    id={id}
                    type="range"
                    min={min}
                    max={max}
                    value={shown}
                    onChange={(e) => update(key, (scale ? Number(e.target.value) / scale : Number(e.target.value)) as never)}
                    className="w-full accent-[#22C55E]"
                  />
                </div>
              );
            })}
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleSaveHeroDraft}
              disabled={isSavingHero || isLoading}
              className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSavingHero ? 'Saving…' : 'Save Draft'}
            </button>
            <button
              type="button"
              onClick={handlePublishHero}
              disabled={isSavingHero || isLoading}
              className="flex-1 py-3 bg-[#22C55E] hover:bg-[#16A34A] text-slate-950 font-black text-xs rounded-xl transition-colors shadow-md shadow-[#22C55E]/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Publish
            </button>
          </div>

          {/* Published versions and restore */}
          <div className="border-t border-slate-800 pt-3">
            <h3 className="text-[10px] font-mono text-slate-400 uppercase tracking-widest mb-2">Published Versions</h3>
            <ul className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {versionHistory.length === 0 && <li className="text-[11px] text-slate-400">No versions have been published.</li>}
              {versionHistory.map((v, index) => (
                <MotionLi
                  key={v.id || v.versionNumber}
                  {...staggerProps(index)}
                  className="flex items-center justify-between gap-2 bg-[#182035] p-2 rounded-lg text-[11px]"
                >
                  <div className="min-w-0">
                    <span className="font-bold text-white">Version {v.versionNumber}</span>
                    <span className="text-slate-400 ml-2">{v.changeNote || 'Published version'}</span>
                    {v.createdAt && <span className="block text-[10px] text-slate-400 font-mono">{formatDateTime(v.createdAt)}</span>}
                  </div>
                  {index > 0 && (
                    <button
                      type="button"
                      onClick={() => handleRollbackHero(v.versionNumber)}
                      aria-label={`Restore version ${v.versionNumber}`}
                      className="text-[#22C55E] hover:text-emerald-300 flex items-center gap-1 font-semibold shrink-0 transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" aria-hidden="true" />
                      <span>Restore</span>
                    </button>
                  )}
                  {index === 0 && <span className="text-[10px] text-emerald-300 font-mono shrink-0">Live</span>}
                </MotionLi>
              ))}
            </ul>
          </div>
        </section>

        {/* Live Preview Window */}
        <section className="lg:col-span-7 bg-[#111625] border border-slate-800 rounded-2xl p-6 flex flex-col justify-between" aria-label="Preview">
          <div>
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
              <div className="flex items-center gap-2 text-xs font-bold text-white">
                <Eye className="w-4 h-4 text-[#22C55E]" aria-hidden="true" />
                <span>Preview</span>
              </div>
              <div className="flex items-center gap-1 bg-[#182035] p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setPreviewDevice('desktop')}
                  aria-label="Desktop preview"
                  aria-pressed={previewDevice === 'desktop'}
                  className={`p-1.5 rounded transition-colors ${previewDevice === 'desktop' ? 'bg-[#22C55E] text-slate-950' : 'text-slate-400 hover:text-white'}`}
                  title="Desktop preview"
                >
                  <Monitor className="w-4 h-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewDevice('mobile')}
                  aria-label="Mobile preview"
                  aria-pressed={previewDevice === 'mobile'}
                  className={`p-1.5 rounded transition-colors ${previewDevice === 'mobile' ? 'bg-[#22C55E] text-slate-950' : 'text-slate-400 hover:text-white'}`}
                  title="Mobile preview"
                >
                  <Smartphone className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Simulated hero stage */}
            <div
              className={`relative overflow-hidden rounded-2xl border border-slate-700 mx-auto transition-[max-width,height] duration-300 ease-out motion-reduce:transition-none ${
                previewDevice === 'mobile' ? 'max-w-xs h-[480px]' : 'max-w-full w-full h-[400px]'
              }`}
              style={{ backgroundColor: heroConfig.overlayColor }}
            >
              {mediaSrc && heroConfig.mediaType === 'image' && (
                <div
                  className="absolute inset-0 bg-cover bg-no-repeat"
                  style={{ ...mediaStyle, backgroundImage: `url(${mediaSrc})`, backgroundPosition }}
                />
              )}
              {mediaSrc && heroConfig.mediaType === 'video' && (
                <video
                  key={mediaSrc}
                  src={mediaSrc}
                  muted
                  loop
                  autoPlay
                  playsInline
                  aria-hidden="true"
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ ...mediaStyle, objectPosition: backgroundPosition }}
                />
              )}

              <div
                className="absolute inset-0"
                style={{
                  backgroundColor: heroConfig.overlayColor,
                  opacity: heroConfig.mediaType === 'color' ? 1 : heroConfig.overlayOpacity
                }}
              />

              <div className="relative z-10 h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                <span className="text-[10px] font-mono font-bold text-[#4ADE80] uppercase tracking-wider bg-[#22C55E]/20 px-3 py-1 rounded-full">
                  Championship 2026
                </span>
                {heroText.headline ? (
                  <h3 className="text-xl sm:text-2xl font-black text-white uppercase tracking-tight leading-tight">{heroText.headline}</h3>
                ) : (
                  <h3 className="text-xl sm:text-2xl font-black text-white uppercase tracking-tight leading-tight">
                    Building India&apos;s Next Generation of <br />
                    <span className="bg-[#2563EB] text-white px-2 py-0.5 rounded">Drone Innovators</span>
                  </h3>
                )}
                {heroText.tagline && <p className="text-xs font-bold text-slate-200 max-w-sm">{heroText.tagline}</p>}
                <p className="text-[11px] text-slate-300 max-w-sm line-clamp-4">
                  {heroText.description || 'Preview of the home page hero before publication.'}
                </p>
                {(heroText.announcementTitle || heroText.announcementBody) && (
                  <div className="mt-2 max-w-sm rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-left">
                    {heroText.announcementDate && (
                      <span className="block text-[10px] font-mono text-[#4ADE80]">{heroText.announcementDate}</span>
                    )}
                    {heroText.announcementTitle && (
                      <span className="block text-[11px] font-bold text-white">{heroText.announcementTitle}</span>
                    )}
                    {heroText.announcementBody && (
                      <span className="block text-[10px] text-slate-300 line-clamp-3">{heroText.announcementBody}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="text-[11px] text-slate-400 font-mono text-center pt-3">
            Preview: {previewDevice === 'desktop' ? 'desktop, 1920 × 1080' : 'mobile, 390 × 844'}
          </div>
        </section>
      </div>
    </div>
  );
}
