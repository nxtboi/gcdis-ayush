'use client';

import React, { useId, useRef, useState } from 'react';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { isSessionExpiredError, uploadAdminFile } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import ApiImage from './ApiImage';
import { IMAGE_ACCEPT, uploadHint, validateImageFile, type ImageUploadPurpose } from './contentTypes';

interface ImageUploadFieldProps {
  label: string;
  purpose: ImageUploadPurpose;
  value: string | null | undefined;
  onChange: (url: string | null) => void;
  disabled?: boolean;
  /** Offer a "Remove Image" control (for optional images such as sponsor logos). */
  allowRemove?: boolean;
  /** Alternative text for the preview. */
  previewAlt?: string;
  /** Preview shape: logos are shown on a light tile and contained; photographs are cropped to fill. */
  variant?: 'logo' | 'photo';
  onUploadingChange?: (uploading: boolean) => void;
}

/**
 * Single-image upload: drag and drop or file picker, client-side type and size checks, upload progress,
 * a preview of the current image and Replace / Remove controls.
 */
export default function ImageUploadField({
  label,
  purpose,
  value,
  onChange,
  disabled = false,
  allowRemove = false,
  previewAlt = '',
  variant = 'photo',
  onUploadingChange
}: ImageUploadFieldProps) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploading = progress !== null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const problem = validateImageFile(file, purpose);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setProgress(0);
    onUploadingChange?.(true);
    try {
      const result = await uploadAdminFile(file, purpose, setProgress);
      onChange(result.fileUrl);
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The image could not be uploaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setProgress(null);
      onUploadingChange?.(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const src = value || '';

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-xs font-bold text-slate-300">
        {label}
      </label>
      <div
        onDragOver={(e) => {
          if (disabled || uploading) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled && !uploading) void upload(e.dataTransfer.files?.[0]);
        }}
        className={`flex flex-col sm:flex-row items-stretch sm:items-center gap-4 p-3 rounded-xl border border-dashed transition-colors ${
          dragging ? 'border-[#22C55E] bg-[#22C55E]/5' : 'border-slate-700 bg-[#0B0F19]/40'
        }`}
      >
        <div
          className={`relative shrink-0 w-full sm:w-36 h-24 rounded-lg overflow-hidden flex items-center justify-center ${
            variant === 'logo' ? 'bg-white' : 'bg-[#182035]'
          }`}
        >
          {src ? (
            <ApiImage
              src={src}
              alt={previewAlt || 'Preview of the current image'}
              className={variant === 'logo' ? 'max-w-full max-h-full object-contain p-2' : 'w-full h-full object-cover'}
            />
          ) : (
            <span className="flex flex-col items-center gap-1 text-[10px] text-slate-400">
              <ImageIcon className="w-5 h-5" aria-hidden="true" />
              No image
            </span>
          )}
          {uploading && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[11px] font-mono font-bold text-white">
              {progress}%
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            className="sr-only"
            aria-describedby={hintId}
            disabled={disabled || uploading}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={disabled || uploading}
              onClick={() => inputRef.current?.click()}
              className="px-3 py-2 bg-[#182035] hover:bg-slate-800 border border-slate-700 rounded-lg text-[11px] font-bold text-slate-200 flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5 text-[#22C55E]" aria-hidden="true" />
              {uploading ? 'Uploading…' : value ? 'Replace Image' : 'Choose Image'}
            </button>
            {allowRemove && value && (
              <button
                type="button"
                disabled={disabled || uploading}
                onClick={() => onChange(null)}
                className="px-3 py-2 rounded-lg text-[11px] font-bold text-rose-300 hover:bg-rose-500/10 flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                Remove Image
              </button>
            )}
          </div>
          <p id={hintId} className="text-[10px] text-slate-400">
            {uploadHint(purpose)}. You may also drag a file here. Files are scanned and their metadata is removed on upload.
          </p>
          {uploading && (
            <div
              role="progressbar"
              aria-label={`Uploading ${label.toLowerCase()}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress ?? 0}
              className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden"
            >
              <div className="h-full bg-[#22C55E] transition-[width] duration-200" style={{ width: `${progress}%` }} />
            </div>
          )}
          <p role="alert" className="text-[11px] text-rose-300">
            {error}
          </p>
        </div>
      </div>
    </div>
  );
}
