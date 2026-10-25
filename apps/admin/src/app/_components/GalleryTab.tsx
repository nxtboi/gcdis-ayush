'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Expand, Images, Pencil, Plus, Settings2, Trash2, Upload, X } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError, uploadAdminFile } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, ConfirmDialog, Modal } from './Modal';
import { EASE_OUT, LoadingAnnouncement, Notice, Skeleton } from './motion';
import { CARD_CLASS, Field, INPUT_CLASS, ReorderButtons, SectionHeading, Toggle } from './ContentUi';
import ImageUploadField from './ImageUploadField';
import ApiImage from './ApiImage';
import {
  DEFAULT_GALLERY_SECTION,
  IMAGE_ACCEPT,
  canDeleteSiteContent,
  canManageSiteContent,
  moveItem,
  sortGallery,
  uploadHint,
  validateGalleryDetails,
  validateImageFile,
  type GalleryImage,
  type GallerySection
} from './contentTypes';

/** Largest number of files accepted in one selection. */
const MAX_FILES_PER_BATCH = 20;

function sectionFrom(data: unknown): GallerySection {
  const record = data && typeof data === 'object' ? (data as Partial<GallerySection>) : {};
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_GALLERY_SECTION.enabled,
    title: typeof record.title === 'string' ? record.title : DEFAULT_GALLERY_SECTION.title,
    subtitle: typeof record.subtitle === 'string' ? record.subtitle : DEFAULT_GALLERY_SECTION.subtitle
  };
}

/** "qa-arena_day-2.jpg" becomes "Qa Arena Day 2" as a starting title. */
function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}

export default function GalleryTab({ role }: { role?: string }) {
  const canEdit = canManageSiteContent(role);
  const canDelete = canDeleteSiteContent(role);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [section, setSection] = useState<GallerySection>(DEFAULT_GALLERY_SECTION);
  const [isLoading, setIsLoading] = useState(true);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSavingSection, setIsSavingSection] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [editing, setEditing] = useState<GalleryImage | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GalleryImage | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [list, settings] = await Promise.all([
        adminFetch<GalleryImage[] | { items?: GalleryImage[] }>('/cms/admin/gallery'),
        adminFetch<GallerySection>('/cms/admin/settings/gallery-section').catch((err: unknown) => {
          if (isSessionExpiredError(err)) throw err;
          return null;
        })
      ]);
      setImages(sortGallery(Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : []));
      setSection(sectionFrom(settings));
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The gallery could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const report = (err: unknown, prefix: string) => {
    if (isSessionExpiredError(err)) return;
    setSuccess(null);
    setError(isStepUpCancelledError(err) ? err.message : `${prefix} ${errorMessage(err, 'Please try again.')}`);
  };

  const handleTogglePublished = async (image: GalleryImage, isPublished: boolean) => {
    setImages((prev) => prev.map((i) => (i.id === image.id ? { ...i, isPublished } : i)));
    try {
      await adminFetch(`/cms/admin/gallery/${image.id}`, { method: 'PATCH', body: JSON.stringify({ isPublished }) });
      setSuccess(`${image.title} has been ${isPublished ? 'published' : 'unpublished'}.`);
      setError(null);
    } catch (err) {
      setImages((prev) => prev.map((i) => (i.id === image.id ? { ...i, isPublished: !isPublished } : i)));
      report(err, `${image.title} could not be ${isPublished ? 'published' : 'unpublished'}.`);
    }
  };

  const handleMove = async (image: GalleryImage, direction: -1 | 1) => {
    const next = moveItem(images, image.id, direction);
    if (!next) return;
    const previous = images;
    setImages(next.map((item, index) => ({ ...item, displayOrder: index })));
    setIsReordering(true);
    try {
      await adminFetch('/cms/admin/gallery/order', { method: 'PUT', body: JSON.stringify({ ids: next.map((i) => i.id) }) });
      setSuccess('The gallery order has been saved.');
      setError(null);
    } catch (err) {
      setImages(previous);
      report(err, 'The new order could not be saved.');
    } finally {
      setIsReordering(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await adminFetch(`/cms/admin/gallery/${pendingDelete.id}`, { method: 'DELETE' });
      setImages((prev) => prev.filter((i) => i.id !== pendingDelete.id));
      setSuccess(`${pendingDelete.title} has been deleted.`);
      setError(null);
    } catch (err) {
      report(err, `${pendingDelete.title} could not be deleted.`);
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  };

  const handleSaveSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!section.title.trim()) {
      setError('Please enter a section title.');
      return;
    }
    setIsSavingSection(true);
    try {
      const saved = await adminFetch<GallerySection>('/cms/admin/settings/gallery-section', {
        method: 'PUT',
        body: JSON.stringify({ ...section, title: section.title.trim(), subtitle: section.subtitle.trim() })
      });
      if (saved) setSection(sectionFrom(saved));
      setSuccess('The gallery section settings have been saved.');
      setError(null);
    } catch (err) {
      report(err, 'The section settings could not be saved.');
    } finally {
      setIsSavingSection(false);
    }
  };

  const publishedCount = images.filter((i) => i.isPublished).length;

  return (
    <div className="space-y-6">
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />

      <section className={CARD_CLASS} aria-labelledby="gallery-heading" aria-busy={isLoading}>
        <SectionHeading
          id="gallery-heading"
          title="Gallery Images"
          icon={Images}
          description={`${images.length} ${images.length === 1 ? 'image' : 'images'}, ${publishedCount} published. Only published images appear on the public site, in the order shown here.`}
          actions={
            canEdit ? (
              <button type="button" className={`${BUTTON_PRIMARY} flex items-center gap-2`} onClick={() => setIsUploadOpen(true)}>
                <Plus className="w-4 h-4" aria-hidden="true" />
                Add Images
              </button>
            ) : undefined
          }
        />
        {isLoading && <LoadingAnnouncement label="Loading gallery images." />}
        {isLoading && images.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 w-full rounded-xl" />
            ))}
          </div>
        ) : images.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
            No gallery images have been added.{canEdit ? ' Select Add Images to upload the first images.' : ''}
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-label="Gallery images in display order">
            <AnimatePresence initial={false}>
              {images.map((image, index) => (
                <motion.li
                  key={image.id}
                  layout="position"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT, delay: Math.min(index, 12) * 0.03 } }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                  className="rounded-xl border border-slate-800 bg-[#182035]/60 overflow-hidden flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(index)}
                    className="group relative block aspect-[4/3] bg-[#0B0F19] overflow-hidden"
                    aria-label={`View ${image.title} at full size`}
                  >
                    <ApiImage
                      src={image.imageUrl}
                      alt={image.altText}
                      loading="lazy"
                      className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03] ${image.isPublished ? '' : 'opacity-60'}`}
                    />
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold bg-black/70 text-white">
                      {index + 1}
                    </span>
                    <span
                      className={`absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-bold ${
                        image.isPublished ? 'bg-emerald-500 text-slate-950' : 'bg-slate-900/90 text-slate-200 border border-slate-600'
                      }`}
                    >
                      {image.isPublished ? 'Published' : 'Not Published'}
                    </span>
                    <span className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-black/60 text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">
                      <Expand className="w-3.5 h-3.5" aria-hidden="true" />
                    </span>
                  </button>
                  <div className="p-3 space-y-2 flex-1 flex flex-col">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate" title={image.title}>
                        {image.title}
                      </div>
                      {image.caption && <div className="text-[11px] text-slate-400 line-clamp-2">{image.caption}</div>}
                      {image.category && (
                        <span className="inline-block mt-1 px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">{image.category}</span>
                      )}
                    </div>
                    <div className="mt-auto pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
                      <Toggle
                        compact
                        label={`Publish ${image.title}`}
                        checked={image.isPublished}
                        disabled={!canEdit}
                        onChange={(value) => void handleTogglePublished(image, value)}
                      />
                      <div className="flex items-center gap-1">
                        {canEdit && (
                          <ReorderButtons
                            orientation="horizontal"
                            label={image.title}
                            canMoveUp={index > 0}
                            canMoveDown={index < images.length - 1}
                            disabled={isReordering}
                            onMove={(direction) => void handleMove(image, direction)}
                          />
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => setEditing(image)}
                            aria-label={`Edit ${image.title}`}
                            title="Edit"
                            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                          >
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => setPendingDelete(image)}
                            aria-label={`Delete ${image.title}`}
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

      <form className={`${CARD_CLASS} max-w-2xl`} aria-labelledby="gallery-settings-heading" onSubmit={handleSaveSection} noValidate>
        <SectionHeading id="gallery-settings-heading" title="Section Settings" icon={Settings2} description="Controls the gallery section on the public site." />
        <Toggle
          label="Show the Gallery Section"
          description="When disabled, the gallery is hidden from the public site."
          checked={section.enabled}
          disabled={!canEdit}
          onChange={(enabled) => setSection((prev) => ({ ...prev, enabled }))}
        />
        <Field label="Section Title" required>
          {(props) => (
            <input
              {...props}
              type="text"
              maxLength={120}
              disabled={!canEdit}
              value={section.title}
              onChange={(e) => setSection((prev) => ({ ...prev, title: e.target.value }))}
              className={INPUT_CLASS}
            />
          )}
        </Field>
        <Field label="Subtitle" hint="Optional. Shown below the title.">
          {(props) => (
            <input
              {...props}
              type="text"
              maxLength={300}
              disabled={!canEdit}
              value={section.subtitle}
              onChange={(e) => setSection((prev) => ({ ...prev, subtitle: e.target.value }))}
              className={INPUT_CLASS}
            />
          )}
        </Field>
        {canEdit && (
          <div className="flex justify-end">
            <button type="submit" className={BUTTON_PRIMARY} disabled={isSavingSection || isLoading}>
              {isSavingSection ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        )}
      </form>

      {isUploadOpen && (
        <UploadDialog
          onClose={(created) => {
            setIsUploadOpen(false);
            if (created > 0) {
              setSuccess(`${created} ${created === 1 ? 'image has' : 'images have'} been added to the gallery.`);
              setError(null);
              void load();
            }
          }}
        />
      )}

      {editing && (
        <EditDialog
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setImages((prev) => prev.map((i) => (i.id === saved.id ? saved : i)));
            setSuccess(`${saved.title} has been updated.`);
            setError(null);
            setEditing(null);
          }}
        />
      )}

      <Lightbox images={images} index={lightboxIndex} onIndexChange={setLightboxIndex} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete Gallery Image"
        message={`Delete ${pendingDelete?.title ?? 'this image'}? It will be removed from the public gallery immediately and the stored file will be deleted when nothing else uses it. This cannot be undone. To hide an image temporarily, unpublish it instead.`}
        confirmLabel="Delete Image"
        tone="danger"
        busy={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// -------------------------------------------------------------
// LIGHTBOX
// -------------------------------------------------------------
function Lightbox({ images, index, onIndexChange }: { images: GalleryImage[]; index: number | null; onIndexChange: (index: number | null) => void }) {
  const image = index !== null ? images[index] : undefined;
  const count = images.length;

  useEffect(() => {
    if (index === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') onIndexChange((index + 1) % count);
      if (event.key === 'ArrowLeft') onIndexChange((index - 1 + count) % count);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, count, onIndexChange]);

  return (
    <Modal
      open={!!image}
      title={image?.title ?? 'Image Preview'}
      description={image ? `Image ${(index ?? 0) + 1} of ${count}. Use the left and right arrow keys to move between images.` : undefined}
      onClose={() => onIndexChange(null)}
      size="xl"
    >
      {image && (
        <div className="space-y-3">
          <div className="relative bg-black rounded-xl overflow-hidden flex items-center justify-center min-h-[200px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={image.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.2 } }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                className="flex items-center justify-center"
              >
                <ApiImage src={image.imageUrl} alt={image.altText} className="max-h-[65vh] w-auto max-w-full object-contain" />
              </motion.div>
            </AnimatePresence>
            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => onIndexChange(((index ?? 0) - 1 + count) % count)}
                  aria-label="Previous image"
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onIndexChange(((index ?? 0) + 1) % count)}
                  aria-label="Next image"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
                >
                  <ChevronRight className="w-5 h-5" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
            <div className="sm:col-span-2">
              <dt className="sr-only">Caption</dt>
              <dd className="text-slate-200">{image.caption || 'No caption.'}</dd>
            </div>
            <div>
              <dt className="inline text-slate-400">Alternative text: </dt>
              <dd className="inline text-slate-300">{image.altText}</dd>
            </div>
            <div>
              <dt className="inline text-slate-400">Status: </dt>
              <dd className="inline text-slate-300">
                {image.isPublished ? 'Published' : 'Not Published'}
                {image.category ? `, ${image.category}` : ''}
                {image.width && image.height ? `, ${image.width} × ${image.height} px` : ''}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </Modal>
  );
}

// -------------------------------------------------------------
// MULTI-FILE UPLOAD
// -------------------------------------------------------------
interface UploadItem {
  key: string;
  fileName: string;
  previewUrl: string;
  status: 'invalid' | 'queued' | 'uploading' | 'uploaded' | 'failed' | 'saved';
  progress: number;
  message: string | null;
  imageUrl: string | null;
  title: string;
  altText: string;
  caption: string;
  category: string;
  isPublished: boolean;
  errors: Record<string, string>;
}

function UploadDialog({ onClose }: { onClose: (created: number) => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [createdCount, setCreatedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(new Map<string, File>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Release preview object URLs when the dialog closes
  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    },
    []
  );

  const patch = (key: string, update: Partial<UploadItem>) => setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...update } : item)));

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
    const room = MAX_FILES_PER_BATCH - items.filter((i) => i.status !== 'saved').length;
    if (files.length > room) setNotice(`Up to ${MAX_FILES_PER_BATCH} images can be added at a time. Only the first ${Math.max(room, 0)} were accepted.`);
    const accepted = files.slice(0, Math.max(room, 0));
    const created: UploadItem[] = accepted.map((file, i) => {
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
        title: titleFromFileName(file.name),
        altText: '',
        caption: '',
        category: '',
        isPublished: true,
        errors: {}
      };
    });
    setItems((prev) => [...prev, ...created]);
    if (inputRef.current) inputRef.current.value = '';
    // Two uploads at a time keeps progress readable without overloading the scanner
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
      const errors = validateGalleryDetails(item);
      if (Object.keys(errors).length > 0) hasErrors = true;
      return { ...item, errors };
    });
    setItems(checked);
    if (hasErrors) {
      setNotice('Please complete the highlighted fields. A title and alternative text are required for every image.');
      return;
    }
    setIsSaving(true);
    let created = createdCount;
    let failed = 0;
    for (const item of checked.filter((i) => i.status === 'uploaded')) {
      try {
        await adminFetch('/cms/admin/gallery', {
          method: 'POST',
          body: JSON.stringify({
            imageUrl: item.imageUrl,
            title: item.title.trim(),
            altText: item.altText.trim(),
            caption: item.caption.trim() || undefined,
            category: item.category.trim() || undefined,
            isPublished: item.isPublished
          })
        });
        created += 1;
        patch(item.key, { status: 'saved', message: null });
      } catch (err) {
        if (isSessionExpiredError(err)) return;
        failed += 1;
        patch(item.key, { message: `The image could not be saved. ${errorMessage(err, 'Please try again.')}` });
      }
    }
    setCreatedCount(created);
    setIsSaving(false);
    // Close automatically when everything that was uploaded has been saved
    if (failed === 0) onClose(created);
    else setNotice(`${failed} ${failed === 1 ? 'image was' : 'images were'} not saved. Please review the messages below and try again.`);
  };

  return (
    <Modal
      open
      title="Add Gallery Images"
      description={`${uploadHint('GALLERY_IMAGE')} each; up to ${MAX_FILES_PER_BATCH} images at a time. A title and alternative text are required for every image.`}
      onClose={() => onClose(createdCount)}
      busy={isSaving}
      size="lg"
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
        className={`p-6 rounded-xl border-2 border-dashed text-center space-y-2 transition-colors ${
          dragging ? 'border-[#22C55E] bg-[#22C55E]/5' : 'border-slate-700'
        }`}
      >
        <Upload className="w-6 h-6 mx-auto text-[#22C55E]" aria-hidden="true" />
        <p className="text-xs text-slate-300">Drag images here, or choose them from this device.</p>
        <input
          ref={inputRef}
          id="gallery-files"
          type="file"
          multiple
          accept={IMAGE_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose gallery images"
          onChange={(e) => void addFiles(e.target.files)}
        />
        <button type="button" onClick={() => inputRef.current?.click()} className={BUTTON_SECONDARY}>
          Choose Images
        </button>
      </div>

      <Notice tone="warning" message={notice} onDismiss={() => setNotice(null)} />

      {items.length > 0 && (
        <ul className="space-y-3" aria-label="Selected images">
          {items.map((item) => (
            <li key={item.key} className="rounded-xl border border-slate-800 bg-[#182035]/60 p-3 space-y-3">
              <div className="flex items-start gap-3">
                <img src={item.previewUrl} alt="" className="w-20 h-16 object-cover rounded-lg bg-black shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-[11px] font-mono text-slate-300 truncate" title={item.fileName}>
                    {item.fileName}
                  </div>
                  <UploadStatus item={item} />
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field label="Title" required error={item.errors.title}>
                    {(props) => (
                      <input {...props} type="text" maxLength={150} value={item.title} onChange={(e) => patch(item.key, { title: e.target.value })} className={INPUT_CLASS} />
                    )}
                  </Field>
                  <Field label="Alternative Text" required error={item.errors.altText} hint="Describe what the image shows.">
                    {(props) => (
                      <input {...props} type="text" maxLength={300} value={item.altText} onChange={(e) => patch(item.key, { altText: e.target.value })} className={INPUT_CLASS} />
                    )}
                  </Field>
                  <Field label="Caption" error={item.errors.caption}>
                    {(props) => (
                      <input {...props} type="text" maxLength={1000} value={item.caption} onChange={(e) => patch(item.key, { caption: e.target.value })} className={INPUT_CLASS} />
                    )}
                  </Field>
                  <Field label="Category" error={item.errors.category} hint="Optional, for example Arena or Workshops.">
                    {(props) => (
                      <input {...props} type="text" maxLength={60} value={item.category} onChange={(e) => patch(item.key, { category: e.target.value })} className={INPUT_CLASS} />
                    )}
                  </Field>
                  <div className="md:col-span-2">
                    <Toggle label="Publish Immediately" checked={item.isPublished} onChange={(value) => patch(item.key, { isPublished: value })} />
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-[11px] text-slate-400 mr-auto" role="status" aria-live="polite">
          {busyUploading ? 'Uploading images…' : ready.length > 0 ? `${ready.length} ${ready.length === 1 ? 'image is' : 'images are'} ready to save.` : ''}
        </span>
        <button type="button" onClick={() => onClose(createdCount)} disabled={isSaving} className={BUTTON_SECONDARY}>
          {createdCount > 0 ? 'Close' : 'Cancel'}
        </button>
        <button type="button" onClick={() => void handleSave()} disabled={isSaving || busyUploading || ready.length === 0} className={BUTTON_PRIMARY}>
          {isSaving ? 'Saving…' : ready.length > 1 ? `Save ${ready.length} Images` : 'Save Image'}
        </button>
      </div>
    </Modal>
  );
}

function UploadStatus({ item }: { item: UploadItem }) {
  if (item.status === 'uploading' || item.status === 'queued') {
    return (
      <div className="space-y-1">
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
        <div className="text-[10px] text-slate-400">{item.status === 'queued' ? 'Waiting to upload.' : `Uploading, ${item.progress}% complete.`}</div>
      </div>
    );
  }
  if (item.status === 'uploaded') {
    return item.message ? (
      <div className="text-[10px] text-rose-300">{item.message}</div>
    ) : (
      <div className="text-[10px] text-emerald-300">Uploaded. Complete the details below, then save.</div>
    );
  }
  if (item.status === 'saved') return <div className="text-[10px] text-emerald-300">Saved to the gallery.</div>;
  return <div className="text-[10px] text-rose-300">{item.message}</div>;
}

// -------------------------------------------------------------
// EDIT
// -------------------------------------------------------------
function EditDialog({ image, onClose, onSaved }: { image: GalleryImage; onClose: () => void; onSaved: (saved: GalleryImage) => void }) {
  const [form, setForm] = useState({
    imageUrl: image.imageUrl,
    title: image.title,
    altText: image.altText,
    caption: image.caption ?? '',
    category: image.category ?? '',
    isPublished: image.isPublished
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateGalleryDetails(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setIsSaving(true);
    setSaveError(null);
    const body = {
      ...(form.imageUrl !== image.imageUrl ? { imageUrl: form.imageUrl } : {}),
      title: form.title.trim(),
      altText: form.altText.trim(),
      caption: form.caption.trim() || null,
      category: form.category.trim() || null,
      isPublished: form.isPublished
    };
    try {
      const saved = await adminFetch<GalleryImage>(`/cms/admin/gallery/${image.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved(saved ?? { ...image, ...body, imageUrl: form.imageUrl });
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setSaveError(isStepUpCancelledError(err) ? err.message : `The image could not be saved. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open title="Edit Gallery Image" description="Fields marked with an asterisk are required." onClose={onClose} busy={isSaving} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <ImageUploadField
          label="Image"
          purpose="GALLERY_IMAGE"
          value={form.imageUrl}
          previewAlt={form.altText}
          onChange={(url) => url && set('imageUrl', url)}
          onUploadingChange={setIsUploading}
        />
        {form.imageUrl !== image.imageUrl && (
          <p className="text-[11px] text-amber-300" role="status">
            The replacement image is used once you save the changes.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Title" required error={errors.title}>
            {(props) => <input {...props} data-autofocus type="text" maxLength={150} value={form.title} onChange={(e) => set('title', e.target.value)} className={INPUT_CLASS} />}
          </Field>
          <Field label="Alternative Text" required error={errors.altText} hint="Describe what the image shows.">
            {(props) => <input {...props} type="text" maxLength={300} value={form.altText} onChange={(e) => set('altText', e.target.value)} className={INPUT_CLASS} />}
          </Field>
          <Field label="Caption" error={errors.caption} className="md:col-span-2">
            {(props) => (
              <textarea {...props} rows={2} maxLength={1000} value={form.caption} onChange={(e) => set('caption', e.target.value)} className={`${INPUT_CLASS} resize-y`} />
            )}
          </Field>
          <Field label="Category" error={errors.category}>
            {(props) => <input {...props} type="text" maxLength={60} value={form.category} onChange={(e) => set('category', e.target.value)} className={INPUT_CLASS} />}
          </Field>
          <div className="flex items-end pb-1">
            <div className="w-full">
              <Toggle label="Published" checked={form.isPublished} onChange={(value) => set('isPublished', value)} />
            </div>
          </div>
        </div>
        <Notice tone="error" message={saveError} />
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={isSaving} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={isSaving || isUploading} className={BUTTON_PRIMARY}>
            {isSaving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
