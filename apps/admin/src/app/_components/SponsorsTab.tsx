'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, Eye, Handshake, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, ConfirmDialog, Modal } from './Modal';
import { EASE_OUT, LoadingAnnouncement, Notice, Skeleton } from './motion';
import { CARD_CLASS, Field, INPUT_CLASS, ReorderButtons, SectionHeading, Toggle } from './ContentUi';
import ImageUploadField from './ImageUploadField';
import ApiImage from './ApiImage';
import {
  DEFAULT_SPONSORS_SECTION,
  SPONSOR_PLACEMENTS,
  SPONSOR_PLACEMENT_LABELS,
  SPONSOR_TIERS,
  SPONSOR_TIER_LABELS,
  canDeleteSiteContent,
  canManageSiteContent,
  moveSponsor,
  sortSponsors,
  sponsorTierLabel,
  sponsorsForPlacement,
  validateSponsor,
  type Sponsor,
  type SponsorInput,
  type SponsorPlacement,
  type SponsorsSection
} from './contentTypes';

const EMPTY_FORM: SponsorInput = {
  name: '',
  tier: 'PARTNER',
  logoUrl: null,
  websiteUrl: '',
  description: '',
  placements: ['HOME', 'EVENT'],
  isActive: true
};

function sectionFrom(data: unknown): SponsorsSection {
  const record = data && typeof data === 'object' ? (data as Partial<SponsorsSection>) : {};
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_SPONSORS_SECTION.enabled,
    title: typeof record.title === 'string' ? record.title : DEFAULT_SPONSORS_SECTION.title,
    subtitle: typeof record.subtitle === 'string' ? record.subtitle : DEFAULT_SPONSORS_SECTION.subtitle,
    showOn: { ...DEFAULT_SPONSORS_SECTION.showOn, ...(record.showOn ?? {}) }
  };
}

const SHOW_ON_KEYS: { key: keyof SponsorsSection['showOn']; placement: SponsorPlacement }[] = [
  { key: 'home', placement: 'HOME' },
  { key: 'event', placement: 'EVENT' },
  { key: 'footer', placement: 'FOOTER' }
];

export default function SponsorsTab({ role }: { role?: string }) {
  const canEdit = canManageSiteContent(role);
  const canDelete = canDeleteSiteContent(role);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [section, setSection] = useState<SponsorsSection>(DEFAULT_SPONSORS_SECTION);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSavingSection, setIsSavingSection] = useState(false);
  const [isReordering, setIsReordering] = useState(false);
  const [editing, setEditing] = useState<{ sponsor: Sponsor | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Sponsor | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [previewPlacement, setPreviewPlacement] = useState<SponsorPlacement>('HOME');

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [list, settings] = await Promise.all([
        adminFetch<Sponsor[] | { items?: Sponsor[] }>('/cms/admin/sponsors'),
        adminFetch<SponsorsSection>('/cms/admin/settings/sponsors-section').catch((err: unknown) => {
          if (isSessionExpiredError(err)) throw err;
          return null;
        })
      ]);
      const items = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : [];
      setSponsors(sortSponsors(items));
      setSection(sectionFrom(settings));
    } catch (err) {
      if (!isSessionExpiredError(err)) setLoadError(`The sponsors could not be loaded. ${errorMessage(err, 'Please try again.')}`);
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

  const handleToggleActive = async (sponsor: Sponsor, isActive: boolean) => {
    setError(null);
    setSponsors((prev) => prev.map((s) => (s.id === sponsor.id ? { ...s, isActive } : s)));
    try {
      await adminFetch(`/cms/admin/sponsors/${sponsor.id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
      setSuccess(`${sponsor.name} is now ${isActive ? 'shown on' : 'hidden from'} the public site.`);
    } catch (err) {
      setSponsors((prev) => prev.map((s) => (s.id === sponsor.id ? { ...s, isActive: !isActive } : s)));
      report(err, `The status of ${sponsor.name} could not be changed.`);
    }
  };

  const handleMove = async (sponsor: Sponsor, direction: -1 | 1) => {
    const next = moveSponsor(sponsors, sponsor.id, direction);
    if (!next) return;
    const previous = sponsors;
    setSponsors(next);
    setIsReordering(true);
    setError(null);
    try {
      await adminFetch('/cms/admin/sponsors/order', { method: 'PUT', body: JSON.stringify({ ids: next.map((s) => s.id) }) });
      setSuccess('The sponsor order has been saved.');
    } catch (err) {
      setSponsors(previous);
      report(err, 'The new order could not be saved.');
    } finally {
      setIsReordering(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await adminFetch(`/cms/admin/sponsors/${pendingDelete.id}`, { method: 'DELETE' });
      setSponsors((prev) => prev.filter((s) => s.id !== pendingDelete.id));
      setSuccess(`${pendingDelete.name} has been deleted.`);
      setError(null);
    } catch (err) {
      report(err, `${pendingDelete.name} could not be deleted.`);
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
    setError(null);
    try {
      const saved = await adminFetch<SponsorsSection>('/cms/admin/settings/sponsors-section', {
        method: 'PUT',
        body: JSON.stringify({ ...section, title: section.title.trim(), subtitle: section.subtitle.trim() })
      });
      if (saved) setSection(sectionFrom(saved));
      setSuccess('The sponsor section settings have been saved.');
    } catch (err) {
      report(err, 'The section settings could not be saved.');
    } finally {
      setIsSavingSection(false);
    }
  };

  const onSaved = (saved: Sponsor, isNew: boolean) => {
    setSponsors((prev) => sortSponsors(isNew ? [...prev, saved] : prev.map((s) => (s.id === saved.id ? saved : s))));
    setSuccess(isNew ? `${saved.name} has been added.` : `${saved.name} has been updated.`);
    setError(null);
    setEditing(null);
  };

  const ordered = sortSponsors(sponsors);

  return (
    <div className="space-y-6">
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error ?? loadError} onDismiss={() => (error ? setError(null) : setLoadError(null))} />

      <section className={CARD_CLASS} aria-labelledby="sponsors-heading" aria-busy={isLoading}>
        <SectionHeading
          id="sponsors-heading"
          title="Sponsors and Partners"
          icon={Handshake}
          description="Inactive sponsors are kept here but are not shown on the public site. The public order is by tier, then by the order set here."
          actions={
            canEdit ? (
              <button type="button" className={`${BUTTON_PRIMARY} flex items-center gap-2`} onClick={() => setEditing({ sponsor: null })}>
                <Plus className="w-4 h-4" aria-hidden="true" />
                Add Sponsor
              </button>
            ) : undefined
          }
        />
        {isLoading && <LoadingAnnouncement label="Loading sponsors." />}
        {isLoading && sponsors.length === 0 ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : ordered.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
            No sponsors have been added.{canEdit ? ' Select Add Sponsor to create the first entry.' : ''}
          </div>
        ) : (
          <ul className="space-y-2" aria-label="Sponsors in public order">
            <AnimatePresence initial={false}>
              {ordered.map((sponsor, index) => {
                const prev = ordered[index - 1];
                const next = ordered[index + 1];
                return (
                  <motion.li
                    key={sponsor.id}
                    layout="position"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT, delay: Math.min(index, 12) * 0.03 } }}
                    exit={{ opacity: 0, transition: { duration: 0.15 } }}
                    className={`flex flex-wrap md:flex-nowrap items-center gap-3 p-3 rounded-xl border border-slate-800 bg-[#182035]/60 ${
                      sponsor.isActive ? '' : 'opacity-70'
                    }`}
                  >
                    {canEdit && (
                      <ReorderButtons
                        label={sponsor.name}
                        canMoveUp={!!prev && prev.tier === sponsor.tier}
                        canMoveDown={!!next && next.tier === sponsor.tier}
                        disabled={isReordering}
                        onMove={(direction) => void handleMove(sponsor, direction)}
                      />
                    )}
                    <div className="w-20 h-12 shrink-0 rounded-lg bg-white flex items-center justify-center overflow-hidden">
                      {sponsor.logoUrl ? (
                        // Decorative: the sponsor name is shown next to the logo
                        <ApiImage src={sponsor.logoUrl} alt="" className="max-w-full max-h-full object-contain p-1.5" />
                      ) : (
                        <span className="text-[10px] font-bold text-slate-700 px-1 text-center leading-tight">No logo</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-white truncate">{sponsor.name}</div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 text-[10px] font-bold">{sponsorTierLabel(sponsor.tier)}</span>
                        {sponsor.placements.map((p) => (
                          <span key={p} className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">
                            {SPONSOR_PLACEMENT_LABELS[p] ?? p}
                          </span>
                        ))}
                        {sponsor.websiteUrl && (
                          <a
                            href={sponsor.websiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-sky-300 hover:text-sky-200 inline-flex items-center gap-1 underline"
                          >
                            Website
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 ml-auto">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold ${sponsor.isActive ? 'text-emerald-300' : 'text-slate-400'}`}>
                          {sponsor.isActive ? 'Active' : 'Inactive'}
                        </span>
                        <Toggle
                          compact
                          label={`Show ${sponsor.name} on the public site`}
                          checked={sponsor.isActive}
                          disabled={!canEdit}
                          onChange={(value) => void handleToggleActive(sponsor, value)}
                        />
                      </div>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => setEditing({ sponsor })}
                          aria-label={`Edit ${sponsor.name}`}
                          title="Edit"
                          className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                        >
                          <Pencil className="w-4 h-4" aria-hidden="true" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => setPendingDelete(sponsor)}
                          aria-label={`Delete ${sponsor.name}`}
                          title="Delete"
                          className="p-2 rounded-lg text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <form className={CARD_CLASS} aria-labelledby="sponsor-settings-heading" onSubmit={handleSaveSection} noValidate>
          <SectionHeading
            id="sponsor-settings-heading"
            title="Section Settings"
            icon={Settings2}
            description="Controls whether and where the sponsor strip appears on the public site."
          />
          <Toggle
            label="Show the Sponsor Section"
            description="When disabled, no sponsors are shown anywhere on the public site."
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
          <fieldset className="space-y-3">
            <legend className="text-xs font-bold text-slate-300 mb-2">Show On</legend>
            {SHOW_ON_KEYS.map(({ key, placement }) => (
              <Toggle
                key={key}
                label={`${SPONSOR_PLACEMENT_LABELS[placement]} Page`}
                checked={section.showOn[key]}
                disabled={!canEdit || !section.enabled}
                onChange={(value) => setSection((prev) => ({ ...prev, showOn: { ...prev.showOn, [key]: value } }))}
              />
            ))}
          </fieldset>
          {canEdit && (
            <div className="flex justify-end">
              <button type="submit" className={BUTTON_PRIMARY} disabled={isSavingSection || isLoading}>
                {isSavingSection ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          )}
        </form>

        <section className={CARD_CLASS} aria-labelledby="sponsor-preview-heading">
          <SectionHeading
            id="sponsor-preview-heading"
            title="Preview"
            icon={Eye}
            description="An approximation of the public sponsor strip, using the current list and settings."
          />
          <div role="group" aria-label="Preview placement" className="inline-flex p-1 rounded-xl bg-[#0B0F19] border border-slate-800">
            {SPONSOR_PLACEMENTS.map((placement) => (
              <button
                key={placement}
                type="button"
                aria-pressed={previewPlacement === placement}
                onClick={() => setPreviewPlacement(placement)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors ${
                  previewPlacement === placement ? 'bg-[#22C55E] text-slate-950' : 'text-slate-300 hover:text-white'
                }`}
              >
                {SPONSOR_PLACEMENT_LABELS[placement]}
              </button>
            ))}
          </div>
          <SponsorStripPreview sponsors={sponsors} section={section} placement={previewPlacement} />
        </section>
      </div>

      {editing && (
        <SponsorDialog
          sponsor={editing.sponsor}
          nextOrder={sponsors.length}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete Sponsor"
        message={`Delete ${pendingDelete?.name ?? 'this sponsor'}? It will be removed from the public site immediately. This cannot be undone. To hide a sponsor temporarily, mark it as inactive instead.`}
        confirmLabel="Delete Sponsor"
        tone="danger"
        busy={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function SponsorStripPreview({ sponsors, section, placement }: { sponsors: Sponsor[]; section: SponsorsSection; placement: SponsorPlacement }) {
  const showOnKey = SHOW_ON_KEYS.find((item) => item.placement === placement)?.key ?? 'home';
  const visible = sponsorsForPlacement(sponsors, placement);
  if (!section.enabled || !section.showOn[showOnKey]) {
    return (
      <div className="p-6 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
        The sponsor section is not shown on the {SPONSOR_PLACEMENT_LABELS[placement].toLowerCase()} page with the current settings.
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-xl">
        No active sponsors are assigned to the {SPONSOR_PLACEMENT_LABELS[placement].toLowerCase()} placement.
      </div>
    );
  }
  const compact = placement === 'FOOTER';
  const tiers = SPONSOR_TIERS.filter((tier) => visible.some((s) => s.tier === tier));
  return (
    <div className={`rounded-xl border border-slate-800 ${compact ? 'bg-[#0B0F19] p-4' : 'bg-white p-6'} space-y-4`} aria-label="Sponsor strip preview">
      <div className={compact ? '' : 'text-center'}>
        <div className={`font-black ${compact ? 'text-[11px] uppercase tracking-widest text-slate-300' : 'text-base text-slate-900'}`}>{section.title}</div>
        {section.subtitle && !compact && <div className="text-xs text-slate-600 mt-1">{section.subtitle}</div>}
      </div>
      {tiers.map((tier) => (
        <div key={tier} className="space-y-2">
          {!compact && <div className="text-[10px] font-bold uppercase tracking-widest text-slate-600 text-center">{SPONSOR_TIER_LABELS[tier]}</div>}
          <div className={`flex flex-wrap items-center ${compact ? 'gap-3' : 'justify-center gap-4'}`}>
            {visible
              .filter((s) => s.tier === tier)
              .map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center justify-center rounded-lg bg-white ${
                    compact ? 'h-8 w-20 p-1' : tier === 'TITLE' ? 'h-20 w-44 p-3 border border-slate-200' : 'h-14 w-32 p-2 border border-slate-200'
                  }`}
                  title={s.name}
                >
                  {s.logoUrl ? (
                    <ApiImage src={s.logoUrl} alt={s.name} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[10px] font-bold text-slate-700 text-center leading-tight">{s.name}</span>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SponsorDialog({
  sponsor,
  nextOrder,
  onClose,
  onSaved
}: {
  sponsor: Sponsor | null;
  nextOrder: number;
  onClose: () => void;
  onSaved: (saved: Sponsor, isNew: boolean) => void;
}) {
  const [form, setForm] = useState<SponsorInput>(
    sponsor
      ? {
          name: sponsor.name,
          tier: sponsor.tier,
          logoUrl: sponsor.logoUrl,
          websiteUrl: sponsor.websiteUrl ?? '',
          description: sponsor.description ?? '',
          placements: [...sponsor.placements],
          isActive: sponsor.isActive
        }
      : EMPTY_FORM
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const set = <K extends keyof SponsorInput>(key: K, value: SponsorInput[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: SponsorInput = {
      ...form,
      name: form.name.trim(),
      websiteUrl: form.websiteUrl?.trim() || null,
      description: form.description?.trim() || null,
      logoUrl: form.logoUrl || null
    };
    const found = validateSponsor(body);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = sponsor
        ? await adminFetch<Sponsor>(`/cms/admin/sponsors/${sponsor.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await adminFetch<Sponsor>('/cms/admin/sponsors', { method: 'POST', body: JSON.stringify({ ...body, displayOrder: nextOrder }) });
      onSaved(saved ?? ({ ...(sponsor as Sponsor), ...body } as Sponsor), !sponsor);
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setSaveError(isStepUpCancelledError(err) ? err.message : `The sponsor could not be saved. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open title={sponsor ? 'Edit Sponsor' : 'Add Sponsor'} description="Fields marked with an asterisk are required." onClose={onClose} busy={isSaving} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Sponsor Name" required error={errors.name}>
            {(props) => (
              <input {...props} data-autofocus type="text" maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} className={INPUT_CLASS} />
            )}
          </Field>
          <Field label="Tier" required error={errors.tier}>
            {(props) => (
              <select {...props} value={form.tier} onChange={(e) => set('tier', e.target.value as SponsorInput['tier'])} className={INPUT_CLASS}>
                {SPONSOR_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {SPONSOR_TIER_LABELS[tier]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Website Address" hint="Optional. Must begin with https://." error={errors.websiteUrl} className="md:col-span-2">
            {(props) => (
              <input
                {...props}
                type="url"
                inputMode="url"
                placeholder="https://www.example.com"
                value={form.websiteUrl ?? ''}
                onChange={(e) => set('websiteUrl', e.target.value)}
                className={INPUT_CLASS}
              />
            )}
          </Field>
          <Field label="Description" hint="Optional. Up to 1,000 characters." error={errors.description} className="md:col-span-2">
            {(props) => (
              <textarea
                {...props}
                rows={3}
                maxLength={1000}
                value={form.description ?? ''}
                onChange={(e) => set('description', e.target.value)}
                className={`${INPUT_CLASS} resize-y`}
              />
            )}
          </Field>
        </div>

        <ImageUploadField
          label="Logo"
          purpose="SPONSOR_LOGO"
          variant="logo"
          allowRemove
          value={form.logoUrl}
          previewAlt={form.name ? `${form.name} logo` : 'Sponsor logo'}
          onChange={(url) => set('logoUrl', url)}
          onUploadingChange={setIsUploading}
        />

        <fieldset aria-describedby={errors.placements ? 'sponsor-placements-error' : undefined}>
          <legend className="text-xs font-bold text-slate-300 mb-2">
            Show On <span className="text-rose-300" aria-hidden="true">*</span>
          </legend>
          <div className="flex flex-wrap gap-4">
            {SPONSOR_PLACEMENTS.map((placement) => {
              const id = `sponsor-placement-${placement}`;
              return (
                <div key={placement} className="flex items-center gap-2">
                  <input
                    id={id}
                    type="checkbox"
                    className="w-4 h-4 accent-[#22C55E]"
                    checked={form.placements.includes(placement)}
                    onChange={(e) =>
                      set(
                        'placements',
                        e.target.checked ? SPONSOR_PLACEMENTS.filter((p) => p === placement || form.placements.includes(p)) : form.placements.filter((p) => p !== placement)
                      )
                    }
                  />
                  <label htmlFor={id} className="text-xs text-slate-200">
                    {SPONSOR_PLACEMENT_LABELS[placement]}
                  </label>
                </div>
              );
            })}
          </div>
          {errors.placements && (
            <p id="sponsor-placements-error" className="mt-1 text-[11px] text-rose-300">
              {errors.placements}
            </p>
          )}
        </fieldset>

        <Toggle
          label="Active"
          description="Inactive sponsors are not shown on the public site."
          checked={form.isActive !== false}
          onChange={(value) => set('isActive', value)}
        />

        <Notice tone="error" message={saveError} />

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={isSaving} className={BUTTON_SECONDARY}>
            Cancel
          </button>
          <button type="submit" disabled={isSaving || isUploading} className={BUTTON_PRIMARY}>
            {isSaving ? 'Saving…' : sponsor ? 'Save Changes' : 'Add Sponsor'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
