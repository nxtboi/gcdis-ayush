'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Clapperboard, Film, Image as ImageIcon, Images, Info, LayoutPanelTop, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import {
  adminFetch,
  isSessionExpiredError,
  isStepUpCancelledError,
  resolveApiAssetUrl,
  uploadAdminFile
} from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, ConfirmDialog, Modal } from './Modal';
import { EASE_OUT, LoadingAnnouncement, Notice, Skeleton } from './motion';
import { CARD_CLASS, Field, INPUT_CLASS, ReorderButtons, SectionHeading, Toggle } from './ContentUi';
import ImageUploadField from './ImageUploadField';
import ApiImage from './ApiImage';
import {
  CHAMPIONSHIP_CAPTION_MAX,
  CHAMPIONSHIP_GALLERY_MAX,
  CHAMPIONSHIP_MEDIA_KINDS,
  CHAMPIONSHIP_MEDIA_KIND_LABELS,
  DEFAULT_VIDEO_MAX_BYTES,
  IMAGE_ACCEPT,
  VIDEO_ACCEPT,
  VIDEO_TYPES_LABEL,
  canDeleteSiteContent,
  canManageSiteContent,
  championshipMediaFrom,
  formatBytes,
  moveItem,
  uploadHint,
  validateChampionshipCaption,
  validateImageFile,
  validateVideoFile,
  type ChampionshipGalleryItem,
  type ChampionshipMedia,
  type ChampionshipMediaKind
} from './contentTypes';

const ENDPOINT = '/cms/admin/championship-media';
const EMPTY: ChampionshipMedia = { heroVideoUrl: null, heroPosterUrl: null, gallery: [] };

type PendingRemoval = { kind: 'video' } | { kind: 'poster' } | { kind: 'photo'; item: ChampionshipGalleryItem };

/**
 * Championship page media: the hero background video (with its poster image) and the photo gallery of the
 * team's drones and the arena. Replacing or removing the video or poster and deleting a photo ask for an
 * authenticator code (step-up); the API deletes the old file once nothing else uses it.
 */
export default function ChampionshipMediaTab({ role }: { role?: string }) {
  const canEdit = canManageSiteContent(role);
  const canDelete = canDeleteSiteContent(role);
  const [media, setMedia] = useState<ChampionshipMedia>(EMPTY);
  const [sections, setSections] = useState<SectionsValue>({});
  const [isLoading, setIsLoading] = useState(true);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isSavingHero, setIsSavingHero] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [editing, setEditing] = useState<ChampionshipGalleryItem | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const videoMaxBytes = media.limits?.videoMaxBytes || DEFAULT_VIDEO_MAX_BYTES;
  const galleryMax = media.limits?.galleryMax || CHAMPIONSHIP_GALLERY_MAX;
  const captionMax = media.limits?.captionMax || CHAMPIONSHIP_CAPTION_MAX;

  // Every API answer carries the whole value: the hero and gallery (contentTypes) and the section media (here)
  const apply = useCallback((data: unknown) => {
    setMedia(championshipMediaFrom(data));
    setSections(sectionsFrom(data));
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      apply(await adminFetch(ENDPOINT));
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The championship page media could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = (err: unknown, prefix: string) => {
    if (isSessionExpiredError(err)) return;
    setSuccess(null);
    setError(isStepUpCancelledError(err) ? err.message : `${prefix} ${errorMessage(err, 'Please try again.')}`);
  };

  const done = (data: unknown, message: string) => {
    apply(data);
    setSuccess(message);
    setError(null);
  };

  // ------------------------------------------------------------- Hero video and poster

  const saveHero = async (body: { heroVideoUrl?: string | null; heroPosterUrl?: string | null }, message: string, failure: string) => {
    setIsSavingHero(true);
    try {
      done(await adminFetch(`${ENDPOINT}/hero`, { method: 'PUT', body: JSON.stringify(body) }), message);
    } catch (err) {
      report(err, failure);
    } finally {
      setIsSavingHero(false);
    }
  };

  const uploadVideo = async (file: File | undefined) => {
    if (!file) return;
    const problem = validateVideoFile(file, videoMaxBytes);
    if (problem) {
      setVideoError(problem);
      return;
    }
    setVideoError(null);
    setVideoProgress(0);
    try {
      const result = await uploadAdminFile(file, 'EVENT_VIDEO', setVideoProgress);
      setVideoProgress(null);
      await saveHero(
        { heroVideoUrl: result.fileUrl },
        media.heroVideoUrl ? 'The hero video has been replaced.' : 'The hero video has been added to the championship page.',
        'The video was uploaded but could not be set as the hero video.'
      );
    } catch (err) {
      if (!isSessionExpiredError(err)) setVideoError(`The video could not be uploaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setVideoProgress(null);
      if (videoInputRef.current) videoInputRef.current.value = '';
    }
  };

  const handlePosterChange = (url: string | null) => {
    if (url === null) {
      setPendingRemoval({ kind: 'poster' });
      return;
    }
    void saveHero(
      { heroPosterUrl: url },
      media.heroPosterUrl ? 'The poster image has been replaced.' : 'The poster image has been added.',
      'The poster image could not be saved.'
    );
  };

  // ------------------------------------------------------------- Gallery

  const handleTogglePublished = async (item: ChampionshipGalleryItem, published: boolean) => {
    setMedia((prev) => ({ ...prev, gallery: prev.gallery.map((g) => (g.id === item.id ? { ...g, published } : g)) }));
    try {
      done(
        await adminFetch(`${ENDPOINT}/gallery/${item.id}`, { method: 'PATCH', body: JSON.stringify({ published }) }),
        `The photo has been ${published ? 'published' : 'unpublished'}.`
      );
    } catch (err) {
      setMedia((prev) => ({ ...prev, gallery: prev.gallery.map((g) => (g.id === item.id ? { ...g, published: !published } : g)) }));
      report(err, `The photo could not be ${published ? 'published' : 'unpublished'}.`);
    }
  };

  const handleMove = async (item: ChampionshipGalleryItem, direction: -1 | 1) => {
    const next = moveItem(media.gallery, item.id, direction);
    if (!next) return;
    const previous = media.gallery;
    setMedia((prev) => ({ ...prev, gallery: next }));
    setIsReordering(true);
    try {
      done(await adminFetch(`${ENDPOINT}/gallery/order`, { method: 'PUT', body: JSON.stringify({ ids: next.map((g) => g.id) }) }), 'The photo order has been saved.');
    } catch (err) {
      setMedia((prev) => ({ ...prev, gallery: previous }));
      report(err, 'The new order could not be saved.');
    } finally {
      setIsReordering(false);
    }
  };

  // ------------------------------------------------------------- Removals (step-up)

  const handleConfirmRemoval = async () => {
    if (!pendingRemoval) return;
    setIsRemoving(true);
    try {
      if (pendingRemoval.kind === 'photo') {
        done(await adminFetch(`${ENDPOINT}/gallery/${pendingRemoval.item.id}`, { method: 'DELETE' }), 'The photo has been deleted.');
      } else {
        done(
          await adminFetch(`${ENDPOINT}/hero/${pendingRemoval.kind}`, { method: 'DELETE' }),
          pendingRemoval.kind === 'video' ? 'The hero video has been removed.' : 'The poster image has been removed.'
        );
      }
    } catch (err) {
      report(err, pendingRemoval.kind === 'photo' ? 'The photo could not be deleted.' : `The ${pendingRemoval.kind === 'video' ? 'video' : 'poster image'} could not be removed.`);
    } finally {
      setIsRemoving(false);
      setPendingRemoval(null);
    }
  };

  const publishedCount = media.gallery.filter((g) => g.published).length;
  const videoUploading = videoProgress !== null;
  const removalCopy =
    pendingRemoval?.kind === 'video'
      ? { title: 'Remove Hero Video', label: 'Remove Video', message: 'Remove the hero video from the championship page? The poster image is shown instead. The stored video file is deleted when nothing else uses it. You will be asked for your authenticator code.' }
      : pendingRemoval?.kind === 'poster'
      ? { title: 'Remove Poster Image', label: 'Remove Poster', message: 'Remove the poster image? It is shown while the video loads and on devices that do not play it. The stored file is deleted when nothing else uses it. You will be asked for your authenticator code.' }
      : { title: 'Delete Photo', label: 'Delete Photo', message: 'Delete this photo from the championship gallery? It disappears from the public page immediately and the stored file is deleted when nothing else uses it. This cannot be undone. To hide a photo temporarily, unpublish it instead. You will be asked for your authenticator code.' };

  return (
    <div className="space-y-6">
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      {isLoading && <LoadingAnnouncement label="Loading championship page media." />}

      {/* Hero video */}
      <section className={CARD_CLASS} aria-labelledby="champ-video-heading" aria-busy={isLoading}>
        <SectionHeading
          id="champ-video-heading"
          title="Hero Background Video"
          icon={Film}
          description="Plays silently behind the title at the top of the championship page. The poster image below is shown while it loads."
        />
        <div className="flex gap-3 p-3 rounded-xl border border-sky-500/30 bg-sky-500/5 text-[11px] text-sky-100" role="note">
          <Info className="w-4 h-4 shrink-0 text-sky-300 mt-0.5" aria-hidden="true" />
          <ul className="space-y-0.5 list-disc pl-4">
            <li>{VIDEO_TYPES_LABEL}, under {formatBytes(videoMaxBytes)}.</li>
            <li>10 to 30 seconds; it loops.</li>
            <li>Landscape, 1920 × 1080 pixels.</li>
            <li>No audio is needed: the video always plays muted.</li>
          </ul>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 items-start">
          <div className="relative rounded-xl overflow-hidden bg-black aspect-video flex items-center justify-center">
            {isLoading ? (
              <Skeleton className="absolute inset-0 rounded-none" />
            ) : media.heroVideoUrl ? (
              <video
                key={media.heroVideoUrl}
                src={resolveApiAssetUrl(media.heroVideoUrl)}
                poster={media.heroPosterUrl ? resolveApiAssetUrl(media.heroPosterUrl) : undefined}
                controls
                muted
                loop
                playsInline
                preload="metadata"
                className="w-full h-full object-cover"
                aria-label="Preview of the hero background video"
              />
            ) : (
              <span className="flex flex-col items-center gap-2 text-[11px] text-slate-400">
                <Clapperboard className="w-6 h-6" aria-hidden="true" />
                No hero video has been added.
              </span>
            )}
            {videoUploading && (
              <div className="absolute inset-0 bg-black/70 flex items-center justify-center text-sm font-mono font-bold text-white">{videoProgress}%</div>
            )}
          </div>
          <div className="space-y-3">
            <input
              ref={videoInputRef}
              id="champ-video-file"
              type="file"
              accept={VIDEO_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose a hero video"
              disabled={!canEdit || videoUploading || isSavingHero}
              onChange={(e) => void uploadVideo(e.target.files?.[0])}
            />
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`${BUTTON_PRIMARY} flex items-center gap-2`}
                  disabled={videoUploading || isSavingHero || isLoading}
                  onClick={() => videoInputRef.current?.click()}
                >
                  <Upload className="w-4 h-4" aria-hidden="true" />
                  {videoUploading ? 'Uploading…' : media.heroVideoUrl ? 'Replace Video' : 'Upload Video'}
                </button>
                {canDelete && media.heroVideoUrl && (
                  <button
                    type="button"
                    className="px-3 py-2 rounded-xl text-xs font-bold text-rose-300 hover:bg-rose-500/10 flex items-center gap-2 transition-colors disabled:opacity-50"
                    disabled={videoUploading || isSavingHero}
                    onClick={() => setPendingRemoval({ kind: 'video' })}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    Remove Video
                  </button>
                )}
              </div>
            )}
            {videoUploading && (
              <div
                role="progressbar"
                aria-label="Uploading the hero video"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={videoProgress ?? 0}
                className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden"
              >
                <div className="h-full bg-[#22C55E] transition-[width] duration-200" style={{ width: `${videoProgress}%` }} />
              </div>
            )}
            <p className="text-[10px] text-slate-400">
              Files are scanned for malware on upload. Replacing or removing the video asks for your authenticator code.
            </p>
            <p role="alert" className="text-[11px] text-rose-300">
              {videoError}
            </p>
          </div>
        </div>

        <div className="pt-2 border-t border-slate-800">
          <ImageUploadField
            label="Poster Image"
            purpose="SITE_IMAGE"
            value={media.heroPosterUrl}
            onChange={handlePosterChange}
            disabled={!canEdit || isSavingHero || isLoading}
            allowRemove={canDelete}
            previewAlt="Poster image of the championship hero video"
          />
          <p className="mt-1 text-[10px] text-slate-400">A still frame from the video works best, also landscape 1920 × 1080.</p>
        </div>
      </section>

      {/* Gallery */}
      <section className={CARD_CLASS} aria-labelledby="champ-gallery-heading" aria-busy={isLoading}>
        <SectionHeading
          id="champ-gallery-heading"
          title="Drone and Arena Photos"
          icon={Images}
          description={`${media.gallery.length} of ${galleryMax} photos, ${publishedCount} published. Only published photos appear on the championship page, in the order shown here.`}
          actions={
            canEdit ? (
              <button
                type="button"
                className={`${BUTTON_PRIMARY} flex items-center gap-2`}
                disabled={isLoading || media.gallery.length >= galleryMax}
                onClick={() => setIsUploadOpen(true)}
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                Add Photos
              </button>
            ) : undefined
          }
        />
        {isLoading && media.gallery.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 w-full rounded-xl" />
            ))}
          </div>
        ) : media.gallery.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
            No photos have been added.{canEdit ? ' Select Add Photos to upload photos of the drones and the arena.' : ''}
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-label="Championship photos in display order">
            <AnimatePresence initial={false}>
              {media.gallery.map((item, index) => (
                <motion.li
                  key={item.id}
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT, delay: Math.min(index, 12) * 0.03 } }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                  className="rounded-xl border border-slate-800 bg-[#182035]/60 overflow-hidden flex flex-col"
                >
                  <div className="relative aspect-[4/3] bg-[#0B0F19] overflow-hidden">
                    <ApiImage
                      src={item.imageUrl}
                      alt={item.caption || `${CHAMPIONSHIP_MEDIA_KIND_LABELS[item.kind]} photo ${index + 1}`}
                      loading="lazy"
                      className={`w-full h-full object-cover ${item.published ? '' : 'opacity-60'}`}
                    />
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold bg-black/70 text-white">{index + 1}</span>
                    <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold bg-black/70 text-white">
                      {CHAMPIONSHIP_MEDIA_KIND_LABELS[item.kind]}
                    </span>
                    <span
                      className={`absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-bold ${
                        item.published ? 'bg-emerald-500 text-slate-950' : 'bg-slate-900/90 text-slate-200 border border-slate-600'
                      }`}
                    >
                      {item.published ? 'Published' : 'Not Published'}
                    </span>
                  </div>
                  <div className="p-3 space-y-2 flex-1 flex flex-col">
                    <p className="text-[11px] text-slate-300 line-clamp-2 min-h-[2.5em]">{item.caption || <span className="text-slate-400">No caption.</span>}</p>
                    <div className="mt-auto pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
                      <Toggle
                        compact
                        label={`Publish photo ${index + 1}`}
                        checked={item.published}
                        disabled={!canEdit}
                        onChange={(value) => void handleTogglePublished(item, value)}
                      />
                      <div className="flex items-center gap-1">
                        {canEdit && (
                          <ReorderButtons
                            orientation="horizontal"
                            label={`photo ${index + 1}`}
                            canMoveUp={index > 0}
                            canMoveDown={index < media.gallery.length - 1}
                            disabled={isReordering}
                            onMove={(direction) => void handleMove(item, direction)}
                          />
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => setEditing(item)}
                            aria-label={`Edit photo ${index + 1}`}
                            title="Edit caption and type"
                            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                          >
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setPendingRemoval({ kind: 'photo', item })}
                            aria-label={`Delete photo ${index + 1}`}
                            title="Delete"
                            className="p-1.5 rounded-lg text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      {/* Section media: an image and / or video for each page section and item */}
      <SectionMediaPanel
        sections={sections}
        canEdit={canEdit}
        canDelete={canDelete}
        isLoading={isLoading}
        videoMaxBytes={videoMaxBytes}
        onSaved={done}
        onFailed={report}
      />

      {isUploadOpen && (
        <PhotoUploadDialog
          room={Math.max(galleryMax - media.gallery.length, 0)}
          captionMax={captionMax}
          onAdded={(data) => apply(data)}
          onClose={(added) => {
            setIsUploadOpen(false);
            if (added > 0) {
              setSuccess(`${added} ${added === 1 ? 'photo has' : 'photos have'} been added to the championship gallery.`);
              setError(null);
            }
          }}
        />
      )}

      {editing && (
        <EditPhotoDialog
          item={editing}
          captionMax={captionMax}
          onClose={() => setEditing(null)}
          onSaved={(data) => {
            done(data, 'The photo has been updated.');
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={removalCopy.title}
        message={removalCopy.message}
        confirmLabel={removalCopy.label}
        tone="danger"
        busy={isRemoving}
        onConfirm={handleConfirmRemoval}
        onCancel={() => setPendingRemoval(null)}
      />
    </div>
  );
}

// -------------------------------------------------------------
// KIND SELECT
// -------------------------------------------------------------
function KindSelect({ value, onChange, disabled, ...props }: { value: ChampionshipMediaKind; onChange: (kind: ChampionshipMediaKind) => void; disabled?: boolean } & Record<string, unknown>) {
  return (
    <select {...props} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ChampionshipMediaKind)} className={INPUT_CLASS}>
      {CHAMPIONSHIP_MEDIA_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {CHAMPIONSHIP_MEDIA_KIND_LABELS[kind]}
        </option>
      ))}
    </select>
  );
}

// -------------------------------------------------------------
// MULTI-PHOTO UPLOAD
// -------------------------------------------------------------
interface PhotoItem {
  key: string;
  fileName: string;
  previewUrl: string;
  status: 'invalid' | 'queued' | 'uploading' | 'uploaded' | 'failed' | 'saved';
  progress: number;
  message: string | null;
  imageUrl: string | null;
  caption: string;
  kind: ChampionshipMediaKind;
  captionError: string | null;
}

function PhotoUploadDialog({
  room,
  captionMax,
  onAdded,
  onClose
}: {
  room: number;
  captionMax: number;
  onAdded: (data: unknown) => void;
  onClose: (added: number) => void;
}) {
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(new Map<string, File>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    },
    []
  );

  const patch = (key: string, update: Partial<PhotoItem>) => setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...update } : item)));

  const uploadOne = async (key: string) => {
    const file = filesRef.current.get(key);
    if (!file) return;
    patch(key, { status: 'uploading', progress: 0, message: null });
    try {
      const result = await uploadAdminFile(file, 'GALLERY_IMAGE', (progress) => patch(key, { progress }));
      patch(key, { status: 'uploaded', progress: 100, imageUrl: result.fileUrl });
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      patch(key, { status: 'failed', message: `The upload failed. ${errorMessage(err, 'Please try again.')}` });
    }
  };

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setNotice(null);
    const files = Array.from(fileList);
    const free = room - added - items.filter((i) => i.status !== 'saved' && i.status !== 'invalid').length;
    if (files.length > free) setNotice(`The gallery holds at most ${CHAMPIONSHIP_GALLERY_MAX} photos. Only the first ${Math.max(free, 0)} were accepted.`);
    const created: PhotoItem[] = files.slice(0, Math.max(free, 0)).map((file, i) => {
      const key = `${Date.now()}-${i}-${file.name}`;
      const problem = validateImageFile(file, 'GALLERY_IMAGE');
      filesRef.current.set(key, file);
      return {
        key,
        fileName: file.name,
        previewUrl: URL.createObjectURL(file),
        status: problem ? 'invalid' : 'queued',
        progress: 0,
        message: problem,
        imageUrl: null,
        caption: '',
        kind: 'drone',
        captionError: null
      };
    });
    setItems((prev) => [...prev, ...created]);
    if (inputRef.current) inputRef.current.value = '';
    const queue = created.filter((item) => item.status === 'queued').map((item) => item.key);
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) await uploadOne(key);
    };
    await Promise.all([worker(), worker()]);
  };

  const removeItem = (key: string) => {
    const item = items.find((i) => i.key === key);
    if (item) URL.revokeObjectURL(item.previewUrl);
    filesRef.current.delete(key);
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const ready = items.filter((i) => i.status === 'uploaded');
  const busyUploading = items.some((i) => i.status === 'uploading' || i.status === 'queued');

  const handleSave = async () => {
    setNotice(null);
    let hasErrors = false;
    const checked = items.map((item) => {
      if (item.status !== 'uploaded') return item;
      const captionError = validateChampionshipCaption(item.caption, captionMax);
      if (captionError) hasErrors = true;
      return { ...item, captionError };
    });
    setItems(checked);
    if (hasErrors) {
      setNotice('Please shorten the highlighted captions.');
      return;
    }
    setIsSaving(true);
    let count = added;
    let failed = 0;
    for (const item of checked.filter((i) => i.status === 'uploaded')) {
      try {
        const data = await adminFetch(`${ENDPOINT}/gallery`, {
          method: 'POST',
          body: JSON.stringify({ imageUrl: item.imageUrl, caption: item.caption.trim(), kind: item.kind })
        });
        onAdded(data);
        count += 1;
        patch(item.key, { status: 'saved', message: null });
      } catch (err) {
        if (isSessionExpiredError(err)) return;
        failed += 1;
        patch(item.key, { message: `The photo could not be added. ${errorMessage(err, 'Please try again.')}` });
      }
    }
    setAdded(count);
    setIsSaving(false);
    if (failed === 0) onClose(count);
    else setNotice(`${failed} ${failed === 1 ? 'photo was' : 'photos were'} not added. Please review the messages below.`);
  };

  return (
    <Modal
      open
      title="Add Championship Photos"
      description={`${uploadHint('GALLERY_IMAGE')} each. Choose several photos at once, then set a caption and type for each.`}
      onClose={() => onClose(added)}
      busy={isSaving}
      size="lg"
    >
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
        className="p-6 rounded-xl border-2 border-dashed border-slate-700 text-center space-y-2"
      >
        <Upload className="w-6 h-6 mx-auto text-[#22C55E]" aria-hidden="true" />
        <p className="text-xs text-slate-300">Drag photos here, or choose them from this device.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={IMAGE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose championship photos"
          onChange={(e) => void addFiles(e.target.files)}
        />
        <button type="button" onClick={() => inputRef.current?.click()} className={BUTTON_SECONDARY} disabled={isSaving}>
          Choose Photos
        </button>
      </div>

      <Notice tone="warning" message={notice} onDismiss={() => setNotice(null)} />

      {items.length > 0 && (
        <ul className="space-y-3" aria-label="Selected photos">
          {items.map((item) => (
            <li key={item.key} className="rounded-xl border border-slate-800 bg-[#182035]/60 p-3 space-y-3">
              <div className="flex items-start gap-3">
                <img src={item.previewUrl} alt="" className="w-20 h-16 object-cover rounded-lg bg-black shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-[11px] font-mono text-slate-300 truncate" title={item.fileName}>
                    {item.fileName}
                  </div>
                  {item.status === 'uploading' && (
                    <div
                      role="progressbar"
                      aria-label={`Uploading ${item.fileName}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={item.progress}
                      className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden"
                    >
                      <div className="h-full bg-[#22C55E] transition-[width] duration-200" style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                  <p className={`text-[11px] ${item.message ? 'text-rose-300' : 'text-slate-400'}`}>
                    {item.message ??
                      (item.status === 'queued'
                        ? 'Waiting to upload…'
                        : item.status === 'uploading'
                        ? `Uploading… ${item.progress}%`
                        : item.status === 'uploaded'
                        ? 'Uploaded. Set the caption and type, then select Add to Gallery.'
                        : item.status === 'saved'
                        ? 'Added to the gallery.'
                        : '')}
                  </p>
                </div>
                {item.status !== 'saved' && item.status !== 'uploading' && (
                  <button
                    type="button"
                    onClick={() => removeItem(item.key)}
                    disabled={isSaving}
                    aria-label={`Remove ${item.fileName} from this upload`}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
                {item.status === 'failed' && (
                  <button type="button" onClick={() => void uploadOne(item.key)} className="text-[11px] font-bold text-sky-300 underline">
                    Retry
                  </button>
                )}
              </div>
              {(item.status === 'uploaded' || item.status === 'uploading' || item.status === 'queued') && (
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
                  <Field label="Caption" error={item.captionError ?? undefined} hint={`Optional, up to ${captionMax} characters.`}>
                    {(props) => (
                      <input
                        {...props}
                        type="text"
                        maxLength={captionMax}
                        value={item.caption}
                        onChange={(e) => patch(item.key, { caption: e.target.value })}
                        className={INPUT_CLASS}
                      />
                    )}
                  </Field>
                  <Field label="Type" required>
                    {(props) => <KindSelect {...props} value={item.kind} onChange={(kind) => patch(item.key, { kind })} />}
                  </Field>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" onClick={() => onClose(added)} disabled={isSaving} className={BUTTON_SECONDARY}>
          {added > 0 ? 'Close' : 'Cancel'}
        </button>
        <button type="button" onClick={() => void handleSave()} disabled={isSaving || busyUploading || ready.length === 0} className={BUTTON_PRIMARY}>
          {isSaving ? 'Adding…' : `Add to Gallery${ready.length ? ` (${ready.length})` : ''}`}
        </button>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------
// EDIT CAPTION AND KIND
// -------------------------------------------------------------
function EditPhotoDialog({
  item,
  captionMax,
  onClose,
  onSaved
}: {
  item: ChampionshipGalleryItem;
  captionMax: number;
  onClose: () => void;
  onSaved: (data: unknown) => void;
}) {
  const [caption, setCaption] = useState(item.caption);
  const [kind, setKind] = useState<ChampionshipMediaKind>(item.kind);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateChampionshipCaption(caption, captionMax);
    if (problem) {
      setError(problem);
      return;
    }
    setIsSaving(true);
    try {
      onSaved(await adminFetch(`${ENDPOINT}/gallery/${item.id}`, { method: 'PATCH', body: JSON.stringify({ caption: caption.trim(), kind }) }));
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The photo could not be updated. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open title="Edit Photo" description="Change the caption and the type shown on the championship page." onClose={onClose} busy={isSaving}>
      <form className="space-y-4" onSubmit={handleSubmit} noValidate>
        <div className="rounded-xl overflow-hidden bg-black aspect-[4/3] max-h-56 flex items-center justify-center">
          <ApiImage src={item.imageUrl} alt={item.caption || 'Photo being edited'} className="max-h-56 w-auto object-contain" />
        </div>
        <Field label="Caption" error={error ?? undefined} hint={`Optional, up to ${captionMax} characters.`}>
          {(props) => <input {...props} type="text" maxLength={captionMax} value={caption} onChange={(e) => setCaption(e.target.value)} className={INPUT_CLASS} />}
        </Field>
        <Field label="Type" required>
          {(props) => <KindSelect {...props} value={kind} onChange={setKind} />}
        </Field>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={isSaving} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={isSaving} className={BUTTON_PRIMARY}>
            {isSaving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------
// SECTION MEDIA
// -------------------------------------------------------------

/** One media slot as returned by the API (`sections` of GET /cms/admin/championship-media). */
interface SlotValue {
  imageUrl: string | null;
  videoUrl: string | null;
  imageAlt: string;
}
type SectionsValue = Record<string, SlotValue & { items: Record<string, SlotValue> }>;
type SlotField = 'image' | 'video';

const IMAGE_ALT_MAX = 200;
const SECTION_IMAGE_PURPOSE = 'SITE_IMAGE';
const UPLOAD_PATH = /^\/api\/uploads\/files\/[A-Za-z0-9_.-]{1,200}$/;

/**
 * Every section and item of the championship page that can carry its own media, in page order. `where`
 * tells staff where the media appears; keys match the API whitelist (dto/championship-media.schema.ts).
 */
export const SECTION_MEDIA_SLOTS: ReadonlyArray<{
  section: string;
  title: string;
  where: string;
  items: ReadonlyArray<{ item: string; title: string; where: string }>;
}> = [
  { section: 'facts', title: 'Key Facts', where: 'Wide banner below the "championship in numbers" heading.', items: [] },
  { section: 'takePart', title: 'How to Take Part', where: 'Wide banner below the heading, above the registration steps.', items: [] },
  {
    section: 'categories',
    title: 'Categories',
    where: 'Wide banner below the heading, above the two class cards.',
    items: [
      { item: 'd20', title: 'Class 20 (D20) card', where: 'At the top of the D20 card, e.g. a photo or clip of the D20 drone.' },
      { item: 'd40', title: 'Class 40 (D40) card', where: 'At the top of the D40 card, e.g. a photo or clip of the D40 drone.' }
    ]
  },
  {
    section: 'programme',
    title: 'Programme',
    where: 'Wide banner below the heading, above the two days.',
    items: [
      { item: 'day1', title: 'Day 1 card', where: 'At the top of the Day 1 card.' },
      { item: 'day2', title: 'Day 2 card', where: 'At the top of the Day 2 card.' }
    ]
  },
  {
    section: 'prizes',
    title: 'Prizes',
    where: 'Wide banner below the heading, above the prize cards.',
    items: [
      { item: 'd20', title: 'Class 20 (D20) prizes', where: 'At the top of the D20 prize card, e.g. the trophy.' },
      { item: 'd40', title: 'Class 40 (D40) prizes', where: 'At the top of the D40 prize card, e.g. the trophy.' }
    ]
  },
  { section: 'rules', title: 'Rules', where: 'Wide banner at the end of the rules section.', items: [] },
  { section: 'teams', title: 'Teams', where: 'Wide banner below the heading, above the team list.', items: [] },
  { section: 'scores', title: 'Live Scores', where: 'Wide banner below the heading, above the live scoreboard.', items: [] },
  { section: 'venue', title: 'Venue and Contact', where: 'Wide banner below the heading, above the contact cards.', items: [] },
  { section: 'finalCta', title: 'Final Call to Action', where: 'Full background behind the closing "Register your team" panel, under a dark overlay.', items: [] }
];

function slotFrom(raw: unknown): SlotValue {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const url = (v: unknown) => (typeof v === 'string' && UPLOAD_PATH.test(v) ? v : null);
  return { imageUrl: url(r.imageUrl), videoUrl: url(r.videoUrl), imageAlt: typeof r.imageAlt === 'string' ? r.imageAlt : '' };
}

/** Section media from an API answer (whitelisted sections and items only). */
export function sectionsFrom(data: unknown): SectionsValue {
  const raw = data && typeof data === 'object' ? (data as { sections?: unknown }).sections : undefined;
  const all = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: SectionsValue = {};
  for (const spec of SECTION_MEDIA_SLOTS) {
    const entry = all[spec.section] && typeof all[spec.section] === 'object' ? (all[spec.section] as Record<string, unknown>) : {};
    const rawItems = entry.items && typeof entry.items === 'object' ? (entry.items as Record<string, unknown>) : {};
    const items: Record<string, SlotValue> = {};
    for (const { item } of spec.items) items[item] = slotFrom(rawItems[item]);
    out[spec.section] = { ...slotFrom(entry), items };
  }
  return out;
}

function slotPath(section: string, item: string | null): string {
  return `${ENDPOINT}/sections/${encodeURIComponent(section)}${item ? `/items/${encodeURIComponent(item)}` : ''}`;
}

type PendingSlotRemoval = { section: string; item: string | null; field: SlotField; title: string };

function SectionMediaPanel({
  sections,
  canEdit,
  canDelete,
  isLoading,
  videoMaxBytes,
  onSaved,
  onFailed
}: {
  sections: SectionsValue;
  canEdit: boolean;
  canDelete: boolean;
  isLoading: boolean;
  videoMaxBytes: number;
  onSaved: (data: unknown, message: string) => void;
  onFailed: (err: unknown, prefix: string) => void;
}) {
  const [pending, setPending] = useState<PendingSlotRemoval | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const configured = SECTION_MEDIA_SLOTS.reduce((n, spec) => {
    const s = sections[spec.section];
    const has = (slot?: SlotValue) => (slot?.imageUrl || slot?.videoUrl ? 1 : 0);
    return n + has(s) + spec.items.reduce((m, { item }) => m + has(s?.items[item]), 0);
  }, 0);
  const total = SECTION_MEDIA_SLOTS.reduce((n, spec) => n + 1 + spec.items.length, 0);

  const confirmRemoval = async () => {
    if (!pending) return;
    setIsRemoving(true);
    try {
      onSaved(
        await adminFetch(`${slotPath(pending.section, pending.item)}/${pending.field}`, { method: 'DELETE' }),
        `The ${pending.field} of ${pending.title} has been removed.`
      );
    } catch (err) {
      onFailed(err, `The ${pending.field} could not be removed.`);
    } finally {
      setIsRemoving(false);
      setPending(null);
    }
  };

  return (
    <section className={CARD_CLASS} aria-labelledby="champ-sections-heading" aria-busy={isLoading}>
      <SectionHeading
        id="champ-sections-heading"
        title="Section Media"
        icon={LayoutPanelTop}
        description={`${configured} of ${total} places have media. Each section and item takes an image, a video, or both; with nothing set the page keeps its current design.`}
      />
      <div className="flex gap-3 p-3 rounded-xl border border-sky-500/30 bg-sky-500/5 text-[11px] text-sky-100" role="note">
        <Info className="w-4 h-4 shrink-0 text-sky-300 mt-0.5" aria-hidden="true" />
        <ul className="space-y-0.5 list-disc pl-4">
          <li>
            Image: {uploadHint(SECTION_IMAGE_PURPOSE)}. Landscape, at least 1600 pixels wide (banners are shown wide, cards at 16:9).
          </li>
          <li>
            Video: {VIDEO_TYPES_LABEL}, under {formatBytes(videoMaxBytes)}, 5 to 20 seconds; it loops silently and plays only while visible.
          </li>
          <li>With a video, the image is its poster and is shown instead to visitors who prefer reduced motion or save data.</li>
          <li>Add a short description of the image for screen readers. Replacing or removing media asks for your authenticator code.</li>
        </ul>
      </div>
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : (
        <ul className="space-y-3" aria-label="Page sections">
          {SECTION_MEDIA_SLOTS.map((spec) => {
            const value = sections[spec.section];
            const count = (value?.imageUrl || value?.videoUrl ? 1 : 0) + spec.items.filter(({ item }) => value?.items[item]?.imageUrl || value?.items[item]?.videoUrl).length;
            return (
              <li key={spec.section}>
                <details className="group rounded-xl border border-slate-800 bg-[#182035]/60">
                  <summary className="flex cursor-pointer items-center justify-between gap-3 p-3 text-xs font-bold text-white">
                    <span>{spec.title}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${count > 0 ? 'bg-emerald-500 text-slate-950' : 'bg-slate-900 text-slate-300 border border-slate-700'}`}>
                      {count > 0 ? `${count} with media` : 'No media'}
                    </span>
                  </summary>
                  <div className="space-y-4 border-t border-slate-800 p-3">
                    <SlotEditor
                      section={spec.section}
                      item={null}
                      title={`${spec.title} section`}
                      where={spec.where}
                      value={value ?? { imageUrl: null, videoUrl: null, imageAlt: '' }}
                      canEdit={canEdit}
                      canDelete={canDelete}
                      videoMaxBytes={videoMaxBytes}
                      onSaved={onSaved}
                      onFailed={onFailed}
                      onRemove={(field) => setPending({ section: spec.section, item: null, field, title: `the ${spec.title} section` })}
                    />
                    {spec.items.map(({ item, title, where }) => (
                      <SlotEditor
                        key={item}
                        section={spec.section}
                        item={item}
                        title={title}
                        where={where}
                        value={value?.items[item] ?? { imageUrl: null, videoUrl: null, imageAlt: '' }}
                        canEdit={canEdit}
                        canDelete={canDelete}
                        videoMaxBytes={videoMaxBytes}
                        onSaved={onSaved}
                        onFailed={onFailed}
                        onRemove={(field) => setPending({ section: spec.section, item, field, title: `the ${title}` })}
                      />
                    ))}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.field === 'video' ? 'Remove Section Video' : 'Remove Section Image'}
        message={`Remove the ${pending?.field ?? 'media'} of ${pending?.title ?? 'this section'}? It disappears from the public page immediately and the stored file is deleted when nothing else uses it. You will be asked for your authenticator code.`}
        confirmLabel={pending?.field === 'video' ? 'Remove Video' : 'Remove Image'}
        tone="danger"
        busy={isRemoving}
        onConfirm={confirmRemoval}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

/** Independent image and video controls (upload, preview, replace, remove) plus the image description. */
function SlotEditor({
  section,
  item,
  title,
  where,
  value,
  canEdit,
  canDelete,
  videoMaxBytes,
  onSaved,
  onFailed,
  onRemove
}: {
  section: string;
  item: string | null;
  title: string;
  where: string;
  value: SlotValue;
  canEdit: boolean;
  canDelete: boolean;
  videoMaxBytes: number;
  onSaved: (data: unknown, message: string) => void;
  onFailed: (err: unknown, prefix: string) => void;
  onRemove: (field: SlotField) => void;
}) {
  const [progress, setProgress] = useState<Record<SlotField, number | null>>({ image: null, video: null });
  const [problem, setProblem] = useState<Record<SlotField, string | null>>({ image: null, video: null });
  const [alt, setAlt] = useState(value.imageAlt);
  const [isSaving, setIsSaving] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const idBase = `slot-${section}-${item ?? 'section'}`;

  useEffect(() => setAlt(value.imageAlt), [value.imageAlt]);

  const put = async (body: Record<string, unknown>, message: string, failure: string) => {
    setIsSaving(true);
    try {
      onSaved(await adminFetch(slotPath(section, item), { method: 'PUT', body: JSON.stringify(body) }), message);
    } catch (err) {
      onFailed(err, failure);
    } finally {
      setIsSaving(false);
    }
  };

  const upload = async (field: SlotField, file: File | undefined) => {
    if (!file) return;
    const issue = field === 'image' ? validateImageFile(file, SECTION_IMAGE_PURPOSE) : validateVideoFile(file, videoMaxBytes);
    setProblem((p) => ({ ...p, [field]: issue }));
    if (issue) return;
    setProgress((p) => ({ ...p, [field]: 0 }));
    try {
      const result = await uploadAdminFile(file, field === 'image' ? SECTION_IMAGE_PURPOSE : 'EVENT_VIDEO', (pct) => setProgress((p) => ({ ...p, [field]: pct })));
      setProgress((p) => ({ ...p, [field]: null }));
      const replacing = field === 'image' ? !!value.imageUrl : !!value.videoUrl;
      await put(
        field === 'image' ? { imageUrl: result.fileUrl } : { videoUrl: result.fileUrl },
        `The ${field} of ${title} has been ${replacing ? 'replaced' : 'added'}.`,
        `The ${field} was uploaded but could not be saved for ${title}.`
      );
    } catch (err) {
      if (!isSessionExpiredError(err)) setProblem((p) => ({ ...p, [field]: `The ${field} could not be uploaded. ${errorMessage(err, 'Please try again.')}` }));
    } finally {
      setProgress((p) => ({ ...p, [field]: null }));
      const input = field === 'image' ? imageInput.current : videoInput.current;
      if (input) input.value = '';
    }
  };

  const saveAlt = () => {
    const trimmed = alt.trim();
    if (trimmed.length > IMAGE_ALT_MAX) {
      setProblem((p) => ({ ...p, image: `The description must be at most ${IMAGE_ALT_MAX} characters.` }));
      return;
    }
    void put({ imageAlt: trimmed }, `The image description of ${title} has been saved.`, 'The image description could not be saved.');
  };

  const busy = isSaving || progress.image !== null || progress.video !== null;

  const control = (field: SlotField) => {
    const url = field === 'image' ? value.imageUrl : value.videoUrl;
    const pct = progress[field];
    const label = field === 'image' ? 'Image' : 'Video';
    return (
      <div className="space-y-2">
        <div className="relative rounded-lg overflow-hidden bg-black aspect-video flex items-center justify-center">
          {url && field === 'image' ? (
            <ApiImage src={url} alt={value.imageAlt || `Image for ${title}`} loading="lazy" className="w-full h-full object-cover" />
          ) : url ? (
            <video
              key={url}
              src={resolveApiAssetUrl(url)}
              poster={value.imageUrl ? resolveApiAssetUrl(value.imageUrl) : undefined}
              controls
              muted
              loop
              playsInline
              preload="metadata"
              className="w-full h-full object-cover"
              aria-label={`Preview of the video for ${title}`}
            />
          ) : (
            <span className="flex flex-col items-center gap-1 text-[10px] text-slate-400">
              {field === 'image' ? <ImageIcon className="w-5 h-5" aria-hidden="true" /> : <Film className="w-5 h-5" aria-hidden="true" />}
              No {field}
            </span>
          )}
          {pct !== null && <div className="absolute inset-0 bg-black/70 flex items-center justify-center text-xs font-mono font-bold text-white">{pct}%</div>}
        </div>
        <input
          ref={field === 'image' ? imageInput : videoInput}
          type="file"
          accept={field === 'image' ? IMAGE_ACCEPT : VIDEO_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label={`Choose the ${field} for ${title}`}
          disabled={!canEdit || busy}
          onChange={(e) => void upload(field, e.target.files?.[0])}
        />
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${BUTTON_SECONDARY} flex items-center gap-2 !py-1.5 !text-[11px]`}
              disabled={busy}
              onClick={() => (field === 'image' ? imageInput : videoInput).current?.click()}
              aria-label={`${url ? 'Replace' : 'Upload'} the ${field} for ${title}`}
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              {pct !== null ? 'Uploading…' : url ? `Replace ${label}` : `Upload ${label}`}
            </button>
            {canDelete && url && (
              <button
                type="button"
                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-rose-300 hover:bg-rose-500/10 flex items-center gap-1.5 transition-colors disabled:opacity-50"
                disabled={busy}
                onClick={() => onRemove(field)}
                aria-label={`Remove the ${field} of ${title}`}
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                Remove
              </button>
            )}
          </div>
        )}
        {pct !== null && (
          <div
            role="progressbar"
            aria-label={`Uploading the ${field} for ${title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden"
          >
            <div className="h-full bg-[#22C55E] transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        )}
        <p role="alert" className="text-[11px] text-rose-300">
          {problem[field]}
        </p>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-slate-800 p-3 space-y-3" role="group" aria-labelledby={`${idBase}-title`}>
      <div>
        <h3 id={`${idBase}-title`} className="text-xs font-bold text-white">
          {title}
        </h3>
        <p className="text-[10px] text-slate-400">{where}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {control('image')}
        {control('video')}
      </div>
      {canEdit && (
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <label htmlFor={`${idBase}-alt`} className="flex-1 space-y-1">
            <span className="block text-[11px] font-bold text-slate-300">Image description (alt text)</span>
            <input
              id={`${idBase}-alt`}
              type="text"
              maxLength={IMAGE_ALT_MAX}
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="e.g. Class 40 drone ball hovering in the arena"
              className={INPUT_CLASS}
              disabled={busy}
            />
          </label>
          <button type="button" className={BUTTON_SECONDARY} disabled={busy || alt.trim() === value.imageAlt} onClick={saveAlt}>
            Save Description
          </button>
        </div>
      )}
    </div>
  );
}
