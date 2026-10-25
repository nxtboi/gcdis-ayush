'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronRight, EyeOff, LayoutList, Lock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, ConfirmDialog } from './Modal';
import { LoadingAnnouncement, Notice, Skeleton } from './motion';
import { CARD_CLASS, Field, INPUT_CLASS, ReorderButtons, SectionHeading, Toggle } from './ContentUi';
import ImageUploadField from './ImageUploadField';
import MediaUploadField, { type MediaValue } from './MediaUploadField';
import { canManageSiteContent } from './contentTypes';
import {
  HOME_SECTION_SPECS,
  SAMPLE_BADGE,
  countSamples,
  moveSection,
  type FieldSpec,
  type HomeSection,
  type HomeSectionKey
} from './homeSectionSpecs';

type Obj = Record<string, unknown>;

const ADD_BUTTON =
  'px-3 py-1.5 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed';
const REMOVE_BUTTON = 'p-2 rounded-lg text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-40 shrink-0';
const BADGE = 'px-2 py-0.5 rounded-full text-[10px] font-bold border';

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObj = (v: unknown): Obj => (isObj(v) ? v : {});

function sectionsFrom(data: unknown): HomeSection[] {
  return Array.isArray(data) ? (data.filter((s) => isObj(s) && typeof s.key === 'string') as unknown as HomeSection[]) : [];
}

function SampleBadge() {
  return <span className={`${BADGE} border-amber-400/40 bg-amber-400/10 text-amber-200`}>{SAMPLE_BADGE}</span>;
}

/** Placeholder flag of an entry: badge plus a switch. Sample entries are hidden on the live site. */
function SampleControl({ value, onChange, disabled }: { value: Obj; onChange: (next: Obj) => void; disabled: boolean }) {
  const isSample = value.placeholder === true;
  return (
    <div className={`rounded-xl border p-3 ${isSample ? 'border-amber-400/30 bg-amber-400/5' : 'border-slate-800'}`}>
      <Toggle
        checked={isSample}
        disabled={disabled}
        label="Sample content"
        description={
          isSample
            ? 'Example text awaiting facts: shown on test sites only, never on the live site. Replace the text, then turn this off to publish it.'
            : 'Published on the live site.'
        }
        onChange={(checked) => {
          const next = { ...value };
          if (checked) next.placeholder = true;
          else delete next.placeholder;
          onChange(next);
        }}
      />
    </div>
  );
}

interface EditorProps {
  root: Obj;
  disabled: boolean;
  onUploadingChange: (uploading: boolean) => void;
}

/** The media fields of an object (imageUrl / videoUrl / imageAlt) as edited by a `media` spec. */
function mediaOf(value: Obj): MediaValue {
  return {
    imageUrl: typeof value.imageUrl === 'string' ? value.imageUrl : null,
    videoUrl: typeof value.videoUrl === 'string' ? value.videoUrl : null,
    imageAlt: typeof value.imageAlt === 'string' ? value.imageAlt : ''
  };
}

/** Writes the media fields back: cleared ones become null (image / video) or are left out (description). */
function withMedia(value: Obj, media: MediaValue): Obj {
  const next: Obj = { ...value, imageUrl: media.imageUrl || null, videoUrl: media.videoUrl || null };
  if (media.imageAlt && media.imageAlt.trim()) next.imageAlt = media.imageAlt;
  else delete next.imageAlt;
  return next;
}

function FieldsEditor({ fields, value, onChange, ...rest }: EditorProps & { fields: FieldSpec[]; value: Obj; onChange: (next: Obj) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {fields.map((spec) =>
        spec.kind === 'media' ? (
          <MediaUploadField
            key={spec.key}
            label={spec.label}
            hint={spec.hint}
            imageLabel={spec.imageLabel}
            videoLabel={spec.videoLabel}
            disabled={rest.disabled}
            value={mediaOf(value)}
            onChange={(media) => onChange(withMedia(value, media))}
            onUploadingChange={rest.onUploadingChange}
          />
        ) : (
          <FieldEditor key={spec.key} spec={spec} value={value[spec.key]} onChange={(v) => onChange({ ...value, [spec.key]: v })} {...rest} />
        )
      )}
    </div>
  );
}

const WIDE = new Set(['group', 'list', 'textList', 'image']);

function FieldEditor({ spec, value, onChange, root, disabled, onUploadingChange }: EditorProps & { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const wide = WIDE.has(spec.kind) || (spec.kind === 'text' && spec.multiline) ? 'md:col-span-2' : '';
  switch (spec.kind) {
    case 'text':
      return (
        <Field label={spec.label} hint={spec.hint} required={spec.required} className={wide}>
          {(props) =>
            spec.multiline ? (
              <textarea {...props} rows={spec.rows ?? 3} maxLength={spec.max} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} />
            ) : (
              <input {...props} type="text" maxLength={spec.max} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} />
            )
          }
        </Field>
      );
    case 'link':
    case 'datetime':
      return (
        <Field label={spec.label} hint={spec.hint} required={spec.kind === 'link' && spec.required}>
          {(props) => (
            <input
              {...props}
              type="text"
              inputMode="url"
              maxLength={500}
              disabled={disabled}
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.target.value)}
              className={`${INPUT_CLASS} font-mono`}
            />
          )}
        </Field>
      );
    case 'slug':
      return (
        <Field label={spec.label} hint={spec.hint} required>
          {(props) => (
            <input
              {...props}
              type="text"
              maxLength={64}
              disabled={disabled}
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              className={`${INPUT_CLASS} font-mono`}
            />
          )}
        </Field>
      );
    case 'date':
      return (
        <Field label={spec.label} hint={spec.hint}>
          {(props) => (
            <input {...props} type="date" disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS} />
          )}
        </Field>
      );
    case 'number':
      return (
        <Field label={spec.label} hint={spec.hint}>
          {(props) => (
            <input
              {...props}
              type="number"
              min={spec.min}
              max={spec.max}
              disabled={disabled}
              value={typeof value === 'number' ? String(value) : ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') onChange(spec.nullable ? null : spec.min);
                else onChange(Number(raw));
              }}
              className={INPUT_CLASS}
            />
          )}
        </Field>
      );
    case 'select': {
      const options = spec.options ?? spec.optionsFrom?.(root) ?? [];
      const current = typeof value === 'string' ? value : '';
      const all = current && !options.some((o) => o.value === current) ? [{ value: current, label: `${current} (not in the list)` }, ...options] : options;
      return (
        <Field label={spec.label} hint={spec.hint ?? (options.length === 0 ? 'Add an entry to the list above first.' : undefined)}>
          {(props) => (
            <select {...props} disabled={disabled} value={current || all[0]?.value || ''} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
              {all.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      );
    }
    case 'checkbox':
      return (
        <div className="self-end pb-2">
          <Toggle checked={value === true} disabled={disabled} label={spec.label} description={spec.hint} onChange={(checked) => onChange(checked)} />
        </div>
      );
    case 'image':
      return (
        <div className={wide}>
          <ImageUploadField
            label={spec.label}
            purpose="SITE_IMAGE"
            allowRemove
            disabled={disabled}
            value={typeof value === 'string' ? value : null}
            onChange={(url) => onChange(url)}
            onUploadingChange={onUploadingChange}
          />
          {spec.hint && <p className="mt-1 text-[10px] text-slate-400">{spec.hint}</p>}
        </div>
      );
    case 'textList':
      return <TextListEditor spec={spec} value={asList(value).map((v) => (typeof v === 'string' ? v : ''))} onChange={onChange} disabled={disabled} className={wide} />;
    case 'group': {
      const present = isObj(value);
      return (
        <fieldset className={`${wide} rounded-2xl border border-slate-800 p-4 space-y-4`}>
          <legend className="px-1 text-xs font-bold text-slate-200 flex items-center gap-2">
            {spec.label}
            {present && spec.sample && value.placeholder === true && <SampleBadge />}
          </legend>
          {spec.hint && <p className="text-[10px] text-slate-400 -mt-2">{spec.hint}</p>}
          {!present ? (
            spec.optional ? (
              <button type="button" className={ADD_BUTTON} disabled={disabled} onClick={() => onChange(spec.optional!.create())}>
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                {spec.optional.addLabel}
              </button>
            ) : (
              <p className="text-[11px] text-slate-400">Not set.</p>
            )
          ) : (
            <>
              {spec.sample && <SampleControl value={value} onChange={onChange} disabled={disabled} />}
              <FieldsEditor fields={spec.fields} value={value} onChange={onChange} root={root} disabled={disabled} onUploadingChange={onUploadingChange} />
              {spec.optional && (
                <button type="button" className={`${ADD_BUTTON} text-rose-200`} disabled={disabled} onClick={() => onChange(null)}>
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Remove {spec.label.toLowerCase()}
                </button>
              )}
            </>
          )}
        </fieldset>
      );
    }
    case 'list':
      return (
        <ListEditor spec={spec} value={asList(value).map(asObj)} onChange={onChange} root={root} disabled={disabled} onUploadingChange={onUploadingChange} className={wide} />
      );
    default:
      return null;
  }
}

function move<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function TextListEditor({
  spec,
  value,
  onChange,
  disabled,
  className
}: {
  spec: Extract<FieldSpec, { kind: 'textList' }>;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
  className: string;
}) {
  const baseId = useId();
  return (
    <fieldset className={`${className} space-y-2`}>
      <legend className="text-xs font-bold text-slate-300 mb-1.5">
        {spec.label}{' '}
        <span className="font-normal text-slate-400">
          ({value.length} of up to {spec.maxItems})
        </span>
      </legend>
      {spec.hint && <p className="text-[10px] text-slate-400">{spec.hint}</p>}
      {value.map((line, index) => (
        <div key={index} className="flex items-center gap-2">
          <label htmlFor={`${baseId}-${index}`} className="sr-only">
            {spec.itemLabel} {index + 1}
          </label>
          <input
            id={`${baseId}-${index}`}
            type="text"
            maxLength={spec.max}
            disabled={disabled}
            value={line}
            onChange={(e) => onChange(value.map((l, i) => (i === index ? e.target.value : l)))}
            className={INPUT_CLASS}
          />
          <ReorderButtons
            label={`${spec.itemLabel.toLowerCase()} ${index + 1}`}
            orientation="horizontal"
            disabled={disabled}
            canMoveUp={index > 0}
            canMoveDown={index < value.length - 1}
            onMove={(d) => onChange(move(value, index, d))}
          />
          <button type="button" disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))} aria-label={`Remove ${spec.itemLabel.toLowerCase()} ${index + 1}`} className={REMOVE_BUTTON}>
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className={ADD_BUTTON} disabled={disabled || value.length >= spec.maxItems} onClick={() => onChange([...value, ''])}>
        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
        Add {spec.itemLabel.toLowerCase()}
      </button>
    </fieldset>
  );
}

function ListEditor({
  spec,
  value,
  onChange,
  root,
  disabled,
  onUploadingChange,
  className
}: EditorProps & { spec: Extract<FieldSpec, { kind: 'list' }>; value: Obj[]; onChange: (v: Obj[]) => void; className: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const baseId = useId();
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const reorder = (index: number, d: -1 | 1) => {
    const target = index + d;
    onChange(move(value, index, d));
    // Keep the expanded state with the entry that moved
    setOpen((prev) => {
      const next = new Set(prev);
      const a = prev.has(index);
      const b = prev.has(target);
      next.delete(index);
      next.delete(target);
      if (a) next.add(target);
      if (b) next.add(index);
      return next;
    });
  };

  return (
    <fieldset className={`${className} space-y-2`}>
      <legend className="text-xs font-bold text-slate-200 mb-1.5">
        {spec.label}{' '}
        <span className="font-normal text-slate-400">
          ({value.length} of up to {spec.maxItems})
        </span>
      </legend>
      {spec.hint && <p className="text-[10px] text-slate-400">{spec.hint}</p>}
      {value.length === 0 && <p className="text-[11px] text-slate-400">No entries.</p>}
      {value.map((item, index) => {
        const isOpen = open.has(index);
        const panelId = `${baseId}-panel-${index}`;
        const title = spec.titleOf(item, index);
        return (
          <div key={typeof item.id === 'string' ? item.id : index} className="rounded-xl border border-slate-800 bg-[#0B0F19]/40">
            <div className="flex items-center gap-2 p-2">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(index)}
                className="flex-1 min-w-0 flex items-center gap-2 text-left px-1 py-1 rounded-lg hover:bg-slate-800/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E]"
              >
                {isOpen ? <ChevronDown className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />}
                <span className="text-[10px] font-mono text-slate-400">{String(index + 1).padStart(2, '0')}</span>
                <span className="truncate text-xs font-bold text-white">{title}</span>
                {spec.sample && item.placeholder === true && <SampleBadge />}
              </button>
              <ReorderButtons
                label={`${spec.itemNoun} ${index + 1}`}
                orientation="horizontal"
                disabled={disabled}
                canMoveUp={index > 0}
                canMoveDown={index < value.length - 1}
                onMove={(d) => reorder(index, d)}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onChange(value.filter((_, i) => i !== index));
                  setOpen(new Set());
                }}
                aria-label={`Delete ${spec.itemNoun} ${index + 1}: ${title}`}
                className={REMOVE_BUTTON}
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            {isOpen && (
              <div id={panelId} className="border-t border-slate-800 p-4 space-y-4">
                {spec.sample && <SampleControl value={item} onChange={(next) => onChange(value.map((v, i) => (i === index ? next : v)))} disabled={disabled} />}
                <FieldsEditor
                  fields={spec.fields}
                  value={item}
                  onChange={(next) => onChange(value.map((v, i) => (i === index ? next : v)))}
                  root={root}
                  disabled={disabled}
                  onUploadingChange={onUploadingChange}
                />
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className={ADD_BUTTON}
        disabled={disabled || value.length >= spec.maxItems}
        onClick={() => {
          onChange([...value, spec.create()]);
          setOpen((prev) => new Set(prev).add(value.length));
        }}
      >
        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
        Add {spec.itemNoun}
      </button>
    </fieldset>
  );
}

/**
 * "Home Page Sections": every section of the public home page. Staff show or hide sections, reorder the body
 * sections, and edit every text, list entry and image. Sample entries are badged and stay hidden on the live
 * site until they are replaced with facts and published.
 */
export default function HomeSectionsTab({ role }: { role?: string }) {
  const canEdit = canManageSiteContent(role);
  const [sections, setSections] = useState<HomeSection[]>([]);
  const [selected, setSelected] = useState<HomeSectionKey>('hero');
  const [drafts, setDrafts] = useState<Partial<Record<HomeSectionKey, Obj>>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setSections(sectionsFrom(await adminFetch('/cms/admin/home/sections')));
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The home page sections could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (view: HomeSection) => setSections((prev) => prev.map((s) => (s.key === view.key ? view : s)));
  const fail = (err: unknown, what: string) => {
    if (isSessionExpiredError(err)) return;
    setError(isStepUpCancelledError(err) ? err.message : `${what} ${errorMessage(err, 'Please try again.')}`);
  };

  const toggleSection = async (section: HomeSection, enabled: boolean) => {
    setBusy(`toggle:${section.key}`);
    setSuccess(null);
    setError(null);
    try {
      replace(await adminFetch(`/cms/admin/home/sections/${section.key}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }));
      setSuccess(`"${section.label}" is now ${enabled ? 'shown' : 'hidden'} on the home page. The public site updates within about 30 seconds.`);
    } catch (err) {
      fail(err, `"${section.label}" could not be ${enabled ? 'shown' : 'hidden'}.`);
    } finally {
      setBusy(null);
    }
  };

  const moveTo = async (key: HomeSectionKey, direction: -1 | 1) => {
    const next = moveSection(sections, key, direction);
    if (!next) return;
    const previous = sections;
    // Optimistic: pinned sections keep their place, the body follows the new order
    setSections([...sections.filter((s) => s.key === 'hero' || s.key === 'ticker'), ...next, ...sections.filter((s) => s.key === 'footer')]);
    setBusy('order');
    setSuccess(null);
    setError(null);
    try {
      setSections(sectionsFrom(await adminFetch('/cms/admin/home/sections/order', { method: 'PUT', body: JSON.stringify({ keys: next.map((s) => s.key) }) })));
    } catch (err) {
      setSections(previous);
      fail(err, 'The new order could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const current = sections.find((s) => s.key === selected) ?? sections[0];
  const draft = current ? drafts[current.key] : undefined;
  const content = current ? draft ?? current.content : {};
  const isDirty = !!draft && !!current && JSON.stringify(draft) !== JSON.stringify(current.content);

  const save = async () => {
    if (!current || !draft) return;
    setBusy('save');
    setSuccess(null);
    setError(null);
    try {
      const view: HomeSection = await adminFetch(`/cms/admin/home/sections/${current.key}`, { method: 'PATCH', body: JSON.stringify({ content: draft }) });
      replace(view);
      setDrafts((prev) => ({ ...prev, [current.key]: undefined }));
      setSuccess(`"${current.label}" has been saved. The public site updates within about 30 seconds.`);
    } catch (err) {
      fail(err, `"${current.label}" could not be saved.`);
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!current) return;
    setBusy('reset');
    setSuccess(null);
    setError(null);
    try {
      replace(await adminFetch(`/cms/admin/home/sections/${current.key}/reset`, { method: 'POST' }));
      setDrafts((prev) => ({ ...prev, [current.key]: undefined }));
      setSuccess(`"${current.label}" has been restored to the original content.`);
    } catch (err) {
      fail(err, `"${current.label}" could not be restored.`);
    } finally {
      setBusy(null);
      setConfirmReset(false);
    }
  };

  if (isLoading && sections.length === 0) {
    return (
      <div className={CARD_CLASS} aria-busy="true">
        <LoadingAnnouncement label="Loading the home page sections." />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const disabled = !canEdit || busy !== null;
  const body = sections.filter((s) => !s.pinned);
  const spec = current ? HOME_SECTION_SPECS[current.key] : null;
  const samples = countSamples(content);

  return (
    <div className="space-y-6">
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      {!canEdit && <Notice tone="info" message="Your role can view the home page sections but cannot change them." />}

      <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-6 items-start">
        <section className={`${CARD_CLASS} xl:sticky xl:top-28`} aria-labelledby="home-sections-heading">
          <SectionHeading
            id="home-sections-heading"
            title="Sections"
            icon={LayoutList}
            description="Switch a section off to hide it from the home page and from the navigation. Use the arrows to change the order."
          />
          <ul className="space-y-1.5">
            {sections.map((section) => {
              const bodyIndex = body.findIndex((s) => s.key === section.key);
              const active = current?.key === section.key;
              const unsaved = !!drafts[section.key];
              return (
                <li
                  key={section.key}
                  className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors ${
                    active ? 'border-[#22C55E]/60 bg-[#22C55E]/5' : 'border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelected(section.key)}
                    aria-current={active ? 'true' : undefined}
                    className="flex-1 min-w-0 text-left px-1 py-1 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#22C55E]"
                  >
                    <span className={`block truncate text-xs font-bold ${section.enabled ? 'text-white' : 'text-slate-400 line-through'}`}>{section.label}</span>
                    <span className="flex flex-wrap items-center gap-1 mt-0.5 text-[10px] text-slate-400">
                      {section.pinned && (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="w-3 h-3" aria-hidden="true" />
                          Fixed position
                        </span>
                      )}
                      {!section.enabled && (
                        <span className="inline-flex items-center gap-1 text-amber-200">
                          <EyeOff className="w-3 h-3" aria-hidden="true" />
                          Hidden
                        </span>
                      )}
                      {countSamples(drafts[section.key] ?? section.content) > 0 && <span className="text-amber-200">Has samples</span>}
                      {unsaved && <span className="text-sky-300">Unsaved changes</span>}
                    </span>
                  </button>
                  {!section.pinned && (
                    <ReorderButtons
                      label={section.label}
                      disabled={disabled}
                      canMoveUp={bodyIndex > 0}
                      canMoveDown={bodyIndex < body.length - 1}
                      onMove={(d) => void moveTo(section.key, d)}
                    />
                  )}
                  {section.canDisable ? (
                    <Toggle compact checked={section.enabled} disabled={disabled} label={`Show ${section.label}`} onChange={(checked) => void toggleSection(section, checked)} />
                  ) : (
                    <span className="text-[10px] text-slate-400 w-9 text-center" title="Always shown">
                      <Lock className="w-3.5 h-3.5 inline" aria-label="Always shown" />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {current && spec && (
          <section className={CARD_CLASS} aria-labelledby="home-section-editor-heading">
            <SectionHeading id="home-section-editor-heading" title={current.label} description={spec.description} />
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className={`${BADGE} ${current.enabled ? 'border-[#22C55E]/40 text-[#4ADE80]' : 'border-amber-400/40 text-amber-200'}`}>
                {current.enabled ? 'Shown on the home page' : 'Hidden from the home page'}
              </span>
              {samples > 0 && (
                <span className={`${BADGE} border-amber-400/40 bg-amber-400/10 text-amber-200`}>
                  {samples} sample {samples === 1 ? 'entry' : 'entries'}, hidden on the live site
                </span>
              )}
              <span className={`${BADGE} border-slate-700 text-slate-400`}>
                {current.isDefault || !current.updatedAt || !current.updatedBy
                  ? 'Original content'
                  : `Last saved ${new Date(current.updatedAt).toLocaleString('en-IN')}${current.updatedBy ? ` by ${current.updatedBy}` : ''}`}
              </span>
            </div>

            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="space-y-6"
            >
              <FieldsEditor
                fields={spec.fields}
                value={content}
                onChange={(next) => setDrafts((prev) => ({ ...prev, [current.key]: next }))}
                root={content}
                disabled={disabled}
                onUploadingChange={(uploading) => setUploads((n) => Math.max(0, n + (uploading ? 1 : -1)))}
              />

              {canEdit && (
                <div className="flex flex-wrap gap-3 justify-end border-t border-slate-800 pt-4">
                  <button type="button" className={`${BUTTON_SECONDARY} flex items-center gap-2 mr-auto`} disabled={busy !== null} onClick={() => setConfirmReset(true)}>
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    Restore Original Content
                  </button>
                  <button
                    type="button"
                    className={BUTTON_SECONDARY}
                    disabled={!draft || busy !== null}
                    onClick={() => {
                      setDrafts((prev) => ({ ...prev, [current.key]: undefined }));
                      setError(null);
                    }}
                  >
                    Discard Changes
                  </button>
                  <button type="submit" className={BUTTON_PRIMARY} disabled={!isDirty || busy !== null || uploads > 0}>
                    {busy === 'save' ? 'Saving…' : 'Save Section'}
                  </button>
                </div>
              )}
            </form>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Restore the original content?"
        message={`The content of "${current?.label ?? ''}" is replaced with the original text, including its sample entries. Whether the section is shown and its position are kept. You will be asked to confirm your identity.`}
        confirmLabel="Restore"
        tone="danger"
        busy={busy === 'reset'}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
