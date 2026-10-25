'use client';

import React, { useId, useRef, useState } from 'react';
import { Clapperboard, Trash2, Upload } from 'lucide-react';
import { isSessionExpiredError, uploadAdminFile } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { useApiAssetSrc } from './ApiImage';
import ImageUploadField from './ImageUploadField';
import { DEFAULT_VIDEO_MAX_BYTES, VIDEO_ACCEPT, VIDEO_TYPES_LABEL, formatBytes, validateVideoFile } from './contentTypes';

/** Media of a home page section or entry: an uploaded image and / or an uploaded video (and the image description). */
export interface MediaValue {
  imageUrl?: string | null;
  videoUrl?: string | null;
  imageAlt?: string;
}

/** Upload purposes used by the media field (the API checks them again when the content is saved). */
export const MEDIA_IMAGE_PURPOSE = 'SITE_IMAGE';
export const MEDIA_VIDEO_PURPOSE = 'EVENT_VIDEO';
export const MEDIA_ALT_MAX = 200;

interface MediaUploadFieldProps {
  label: string;
  value: MediaValue;
  onChange: (next: MediaValue) => void;
  disabled?: boolean;
  hint?: string;
  /** Label of the image half (for example "Poster image"). */
  imageLabel?: string;
  videoLabel?: string;
  /** Show the image description input (default true). */
  showAlt?: boolean;
  videoMaxBytes?: number;
  onUploadingChange?: (uploading: boolean) => void;
}

/**
 * Image + video control shared by the home page editors. The image half is `ImageUploadField` (SITE_IMAGE: magic
 * bytes, malware scan, re-encode). The video half uploads an MP4 / WebM file as EVENT_VIDEO (sent with
 * `?purpose=EVENT_VIDEO`, so the API applies the video size limit before reading the body; magic bytes and malware
 * scan as for every upload), with type and size checks before upload, a progress bar, a muted preview and Replace /
 * Remove. Nothing is published until the section is saved; replacing or removing a video that is already live asks
 * for the authenticator code (step-up) when saving, and the API deletes the old file once nothing uses it.
 */
export default function MediaUploadField({
  label,
  value,
  onChange,
  disabled = false,
  hint,
  imageLabel = 'Image',
  videoLabel = 'Video',
  showAlt = true,
  videoMaxBytes = DEFAULT_VIDEO_MAX_BYTES,
  onUploadingChange
}: MediaUploadFieldProps) {
  const videoInputId = useId();
  const videoHintId = useId();
  const altId = useId();
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [videoProgress, setVideoProgress] = useState<number | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoUploading = videoProgress !== null;
  const imageUrl = value.imageUrl || null;
  const videoUrl = value.videoUrl || null;
  const videoSrc = useApiAssetSrc(videoUrl, 'video');
  const posterSrc = useApiAssetSrc(imageUrl, 'image');

  const set = (patch: Partial<MediaValue>) => onChange({ ...value, ...patch });

  const uploadVideo = async (file: File | undefined) => {
    if (!file) return;
    const problem = validateVideoFile(file, videoMaxBytes);
    if (problem) {
      setVideoError(problem);
      return;
    }
    setVideoError(null);
    setVideoProgress(0);
    onUploadingChange?.(true);
    try {
      const result = await uploadAdminFile(file, MEDIA_VIDEO_PURPOSE, setVideoProgress);
      set({ videoUrl: result.fileUrl });
    } catch (err) {
      if (!isSessionExpiredError(err)) setVideoError(`The video could not be uploaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setVideoProgress(null);
      onUploadingChange?.(false);
      if (videoInputRef.current) videoInputRef.current.value = '';
    }
  };

  return (
    <fieldset className="md:col-span-2 rounded-2xl border border-slate-800 p-4 space-y-3" data-media-field="">
      <legend className="px-1 text-xs font-bold text-slate-200">{label}</legend>
      {hint && <p className="text-[10px] text-slate-400 -mt-1">{hint}</p>}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Image (also the video's poster) */}
        <ImageUploadField
          label={imageLabel}
          purpose={MEDIA_IMAGE_PURPOSE}
          allowRemove
          disabled={disabled}
          value={imageUrl}
          previewAlt={value.imageAlt || ''}
          onChange={(url) => set({ imageUrl: url })}
          onUploadingChange={onUploadingChange}
        />

        {/* Video */}
        <div className="space-y-2">
          <label htmlFor={videoInputId} className="block text-xs font-bold text-slate-300">
            {videoLabel}
          </label>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 p-3 rounded-xl border border-dashed border-slate-700 bg-[#0B0F19]/40">
            <div className="relative shrink-0 w-full sm:w-36 h-24 rounded-lg overflow-hidden bg-black flex items-center justify-center">
              {videoUrl ? (
                <video
                  key={videoSrc}
                  src={videoSrc}
                  poster={posterSrc || undefined}
                  muted
                  loop
                  playsInline
                  controls
                  preload="metadata"
                  className="w-full h-full object-cover"
                  aria-label={`Preview of the ${videoLabel.toLowerCase()}`}
                />
              ) : (
                <span className="flex flex-col items-center gap-1 text-[10px] text-slate-400">
                  <Clapperboard className="w-5 h-5" aria-hidden="true" />
                  No video
                </span>
              )}
              {videoUploading && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[11px] font-mono font-bold text-white">{videoProgress}%</div>
              )}
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              <input
                id={videoInputId}
                ref={videoInputRef}
                type="file"
                accept={VIDEO_ACCEPT}
                className="sr-only"
                aria-describedby={videoHintId}
                disabled={disabled || videoUploading}
                onChange={(e) => void uploadVideo(e.target.files?.[0])}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={disabled || videoUploading}
                  onClick={() => videoInputRef.current?.click()}
                  className="px-3 py-2 bg-[#182035] hover:bg-slate-800 border border-slate-700 rounded-lg text-[11px] font-bold text-slate-200 flex items-center gap-2 transition-colors disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5 text-[#22C55E]" aria-hidden="true" />
                  {videoUploading ? 'Uploading…' : videoUrl ? 'Replace Video' : 'Choose Video'}
                </button>
                {videoUrl && (
                  <button
                    type="button"
                    disabled={disabled || videoUploading}
                    onClick={() => set({ videoUrl: null })}
                    className="px-3 py-2 rounded-lg text-[11px] font-bold text-rose-300 hover:bg-rose-500/10 flex items-center gap-2 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    Remove Video
                  </button>
                )}
              </div>
              <p id={videoHintId} className="text-[10px] text-slate-400">
                {VIDEO_TYPES_LABEL}, up to {formatBytes(videoMaxBytes)}; 10 to 30 seconds, landscape, no audio needed (it always plays
                muted and loops, only while on screen). The image is shown first and instead of the video for visitors who prefer
                reduced motion. Files are scanned on upload. Replacing or removing a saved video asks for your authenticator code.
              </p>
              {videoUploading && (
                <div
                  role="progressbar"
                  aria-label={`Uploading ${videoLabel.toLowerCase()}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={videoProgress ?? 0}
                  className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden"
                >
                  <div className="h-full bg-[#22C55E] transition-[width] duration-200" style={{ width: `${videoProgress}%` }} />
                </div>
              )}
              <p role="alert" className="text-[11px] text-rose-300">
                {videoError}
              </p>
            </div>
          </div>
        </div>
      </div>

      {showAlt && (
        <div>
          <label htmlFor={altId} className="block text-xs font-bold text-slate-300 mb-1">
            Image description <span className="font-normal text-slate-400">(for screen readers; leave empty if decorative)</span>
          </label>
          <input
            id={altId}
            type="text"
            maxLength={MEDIA_ALT_MAX}
            disabled={disabled}
            value={value.imageAlt ?? ''}
            onChange={(e) => set({ imageAlt: e.target.value })}
            className="w-full bg-[#182035] border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-[#22C55E] transition-colors"
          />
        </div>
      )}
    </fieldset>
  );
}
