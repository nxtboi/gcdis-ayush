'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Eye, ImageIcon, Mail, MapPin, Phone, Plus, RotateCcw, Share2, Trash2 } from 'lucide-react';
import { adminFetch, isSessionExpiredError, isStepUpCancelledError } from '../../lib/api-client';
import { errorMessage } from '../../lib/messages';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from './Modal';
import { LoadingAnnouncement, Notice, Skeleton } from './motion';
import { CARD_CLASS, Field, INPUT_CLASS, SectionHeading } from './ContentUi';
import ImageUploadField from './ImageUploadField';
import ApiImage from './ApiImage';
import {
  EMPTY_SITE_INFO,
  MAX_ADDRESS_LINES,
  MAX_PHONES,
  SOCIAL_LABELS,
  SOCIAL_NETWORKS,
  canManageSiteContent,
  siteInfoFrom,
  siteInfoPayload,
  validateSiteInfo,
  type SiteInfo
} from './contentTypes';

const ADD_BUTTON =
  'px-3 py-1.5 rounded-lg border border-slate-700 text-[11px] font-bold text-slate-200 hover:bg-slate-800 transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed';
const REMOVE_BUTTON = 'p-2 rounded-lg text-rose-300 hover:bg-rose-500/10 transition-colors disabled:opacity-40 shrink-0';

export default function SiteInfoTab({ role }: { role?: string }) {
  const canEdit = canManageSiteContent(role);
  const [info, setInfo] = useState<SiteInfo>(EMPTY_SITE_INFO);
  const [saved, setSaved] = useState<SiteInfo | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await adminFetch('/cms/admin/settings/site-info');
      const next = siteInfoFrom(data);
      if (next.addressLines.length === 0) next.addressLines = [''];
      if (next.phones.length === 0) next.phones = [{ display: '', tel: '' }];
      setInfo(next);
      setSaved(next);
    } catch (err) {
      if (!isSessionExpiredError(err)) setError(`The site information could not be loaded. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof SiteInfo>(key: K, value: SiteInfo[K]) => setInfo((prev) => ({ ...prev, [key]: value }));
  const isDirty = saved !== null && JSON.stringify(siteInfoPayload(info)) !== JSON.stringify(siteInfoPayload(saved));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(null);
    const found = validateSiteInfo(info);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setError(`Please correct the ${Object.keys(found).length === 1 ? 'highlighted field' : `${Object.keys(found).length} highlighted fields`} before saving.`);
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const result = await adminFetch('/cms/admin/settings/site-info', { method: 'PUT', body: JSON.stringify(siteInfoPayload(info)) });
      const next = result ? siteInfoFrom(result) : siteInfoPayload(info);
      if (next.addressLines.length === 0) next.addressLines = [''];
      if (next.phones.length === 0) next.phones = [{ display: '', tel: '' }];
      setInfo(next);
      setSaved(next);
      setSuccess('The site information has been saved. The public site shows the new details.');
    } catch (err) {
      if (isSessionExpiredError(err)) return;
      setError(isStepUpCancelledError(err) ? err.message : `The site information could not be saved. ${errorMessage(err, 'Please try again.')}`);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading && !saved) {
    return (
      <div className={CARD_CLASS} aria-busy="true">
        <LoadingAnnouncement label="Loading site information." />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  const disabled = !canEdit || isSaving;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <Notice tone="success" message={success} onDismiss={() => setSuccess(null)} />
      <Notice tone="error" message={error} onDismiss={() => setError(null)} />
      {!canEdit && <Notice tone="info" message="Your role can view the site information but cannot change it." />}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <section className={CARD_CLASS} aria-labelledby="site-org-heading">
            <SectionHeading
              id="site-org-heading"
              title="Organisation"
              icon={Building2}
              description="Names shown in the header, footer and contact section of the public site."
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Organisation Name" required error={errors.organisationName} className="md:col-span-2">
                {(props) => (
                  <input {...props} type="text" maxLength={160} disabled={disabled} value={info.organisationName} onChange={(e) => set('organisationName', e.target.value)} className={INPUT_CLASS} />
                )}
              </Field>
              <Field label="Short Name" required error={errors.shortName} hint="For example GCDIS.">
                {(props) => (
                  <input {...props} type="text" maxLength={40} disabled={disabled} value={info.shortName} onChange={(e) => set('shortName', e.target.value)} className={INPUT_CLASS} />
                )}
              </Field>
              <Field label="University Name" required error={errors.universityName}>
                {(props) => (
                  <input {...props} type="text" maxLength={160} disabled={disabled} value={info.universityName} onChange={(e) => set('universityName', e.target.value)} className={INPUT_CLASS} />
                )}
              </Field>
            </div>
          </section>

          <section className={CARD_CLASS} aria-labelledby="site-contact-heading">
            <SectionHeading id="site-contact-heading" title="Address and Contact Details" icon={MapPin} />
            <fieldset className="space-y-2">
              <legend className="text-xs font-bold text-slate-300 mb-1.5">
                Postal Address <span className="font-normal text-slate-400">(up to {MAX_ADDRESS_LINES} lines)</span>
              </legend>
              {info.addressLines.map((line, index) => (
                <div key={index} className="flex items-center gap-2">
                  <label htmlFor={`site-address-${index}`} className="sr-only">
                    Address line {index + 1}
                  </label>
                  <input
                    id={`site-address-${index}`}
                    type="text"
                    maxLength={200}
                    disabled={disabled}
                    value={line}
                    placeholder={`Address line ${index + 1}`}
                    onChange={(e) => set('addressLines', info.addressLines.map((l, i) => (i === index ? e.target.value : l)))}
                    className={INPUT_CLASS}
                  />
                  <button
                    type="button"
                    disabled={disabled || info.addressLines.length <= 1}
                    onClick={() => set('addressLines', info.addressLines.filter((_, i) => i !== index))}
                    aria-label={`Remove address line ${index + 1}`}
                    className={REMOVE_BUTTON}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {errors.addressLines && <p className="text-[11px] text-rose-300">{errors.addressLines}</p>}
              <button
                type="button"
                className={ADD_BUTTON}
                disabled={disabled || info.addressLines.length >= MAX_ADDRESS_LINES}
                onClick={() => set('addressLines', [...info.addressLines, ''])}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                Add Address Line
              </button>
            </fieldset>

            <fieldset className="space-y-2 pt-2">
              <legend className="text-xs font-bold text-slate-300 mb-1.5">
                Telephone Numbers <span className="font-normal text-slate-400">(up to {MAX_PHONES})</span>
              </legend>
              {info.phones.map((phone, index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-start">
                  <Field label={`Number ${index + 1} as Displayed`} error={errors[`phones.${index}.display`]}>
                    {(props) => (
                      <input
                        {...props}
                        type="text"
                        maxLength={40}
                        disabled={disabled}
                        placeholder="0120-4806827"
                        value={phone.display}
                        onChange={(e) => set('phones', info.phones.map((p, i) => (i === index ? { ...p, display: e.target.value } : p)))}
                        className={INPUT_CLASS}
                      />
                    )}
                  </Field>
                  <Field label={`Number ${index + 1} for Dialling`} error={errors[`phones.${index}.tel`]}>
                    {(props) => (
                      <input
                        {...props}
                        type="tel"
                        maxLength={16}
                        disabled={disabled}
                        placeholder="+911204806827"
                        value={phone.tel}
                        onChange={(e) => set('phones', info.phones.map((p, i) => (i === index ? { ...p, tel: e.target.value } : p)))}
                        className={`${INPUT_CLASS} font-mono`}
                      />
                    )}
                  </Field>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => set('phones', info.phones.filter((_, i) => i !== index))}
                    aria-label={`Remove telephone number ${index + 1}`}
                    className={`${REMOVE_BUTTON} mt-6`}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {errors.phones && <p className="text-[11px] text-rose-300">{errors.phones}</p>}
              <p className="text-[10px] text-slate-400">The dialling number uses digits only, optionally starting with +, for example +911204806827.</p>
              <button
                type="button"
                className={ADD_BUTTON}
                disabled={disabled || info.phones.length >= MAX_PHONES}
                onClick={() => set('phones', [...info.phones, { display: '', tel: '' }])}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                Add Telephone Number
              </button>
            </fieldset>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <Field label="Email Address" required error={errors.email}>
                {(props) => (
                  <input {...props} type="email" maxLength={254} disabled={disabled} value={info.email} onChange={(e) => set('email', e.target.value)} className={INPUT_CLASS} />
                )}
              </Field>
              <Field label="Map Link" error={errors.mapUrl} hint="Optional. A https:// link to the location on a map.">
                {(props) => (
                  <input {...props} type="url" inputMode="url" maxLength={500} disabled={disabled} value={info.mapUrl ?? ''} onChange={(e) => set('mapUrl', e.target.value)} className={INPUT_CLASS} />
                )}
              </Field>
            </div>
          </section>

          <section className={CARD_CLASS} aria-labelledby="site-social-heading">
            <SectionHeading id="site-social-heading" title="Social Media" icon={Share2} description="Optional. Leave a field empty to hide that network. Links must begin with https://." />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {SOCIAL_NETWORKS.map((network) => (
                <Field key={network} label={SOCIAL_LABELS[network]} error={errors[`social.${network}`]}>
                  {(props) => (
                    <input
                      {...props}
                      type="url"
                      inputMode="url"
                      maxLength={300}
                      disabled={disabled}
                      placeholder="https://"
                      value={info.social[network] ?? ''}
                      onChange={(e) => set('social', { ...info.social, [network]: e.target.value })}
                      className={INPUT_CLASS}
                    />
                  )}
                </Field>
              ))}
            </div>
          </section>

          <section className={CARD_CLASS} aria-labelledby="site-about-heading" id="about-image">
            <SectionHeading
              id="site-about-heading"
              title="About Section Image"
              icon={ImageIcon}
              description="The photograph shown beside the About text on the home page. The hero background is managed under Home Page Hero; the About section itself under Home Page Sections."
            />
            <ImageUploadField
              label="About Image"
              purpose="SITE_IMAGE"
              allowRemove
              disabled={disabled}
              value={info.aboutImageUrl}
              previewAlt={info.aboutImageAlt ?? ''}
              onChange={(url) => set('aboutImageUrl', url)}
              onUploadingChange={setIsUploading}
            />
            <Field label="Alternative Text" required={!!info.aboutImageUrl} error={errors.aboutImageAlt} hint="Describe what the image shows for visitors who use screen readers.">
              {(props) => (
                <input {...props} type="text" maxLength={300} disabled={disabled} value={info.aboutImageAlt ?? ''} onChange={(e) => set('aboutImageAlt', e.target.value)} className={INPUT_CLASS} />
              )}
            </Field>
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-28" aria-labelledby="site-preview-heading">
          <section className={CARD_CLASS}>
            <SectionHeading id="site-preview-heading" title="Preview" icon={Eye} description="The footer contact block with the current values." />
            <ContactPreview info={info} />
          </section>
          {canEdit && (
            <div className="flex flex-wrap gap-3 justify-end">
              <button
                type="button"
                className={`${BUTTON_SECONDARY} flex items-center gap-2`}
                disabled={!isDirty || isSaving}
                onClick={() => {
                  if (saved) setInfo(saved);
                  setErrors({});
                  setError(null);
                }}
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                Discard Changes
              </button>
              <button type="submit" className={BUTTON_PRIMARY} disabled={isSaving || isUploading || !isDirty}>
                {isSaving ? 'Saving…' : 'Save Site Information'}
              </button>
            </div>
          )}
          {canEdit && <p className="text-[10px] text-slate-400 text-right">Saving asks you to confirm your identity with an authentication code.</p>}
        </aside>
      </div>
    </form>
  );
}

function ContactPreview({ info }: { info: SiteInfo }) {
  const payload = siteInfoPayload(info);
  const socials = SOCIAL_NETWORKS.filter((n) => payload.social[n]);
  return (
    <div className="rounded-xl bg-[#060912] border border-slate-800 p-4 space-y-3 text-[11px] text-slate-300">
      <div>
        <div className="text-sm font-black text-white">{payload.shortName || 'Short Name'}</div>
        <div className="text-slate-400">{payload.organisationName || 'Organisation name'}</div>
      </div>
      <div className="flex gap-2">
        <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#22C55E]" aria-hidden="true" />
        <address className="not-italic leading-relaxed">
          {payload.addressLines.length > 0 ? payload.addressLines.map((line, i) => <div key={i}>{line}</div>) : <span className="text-slate-400">No address</span>}
        </address>
      </div>
      {payload.phones.length > 0 && (
        <div className="flex gap-2">
          <Phone className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#22C55E]" aria-hidden="true" />
          <div>
            {payload.phones.map((p, i) => (
              <div key={i}>
                {p.display || p.tel} <span className="text-slate-400 font-mono">({p.tel || 'no dialling number'})</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <Mail className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[#22C55E]" aria-hidden="true" />
        <span className="break-all">{payload.email || 'No email address'}</span>
      </div>
      {payload.mapUrl && <div className="text-sky-300 underline truncate">View on map</div>}
      {socials.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {socials.map((n) => (
            <span key={n} className="px-2 py-0.5 rounded-full border border-slate-700 text-[10px]">
              {SOCIAL_LABELS[n]}
            </span>
          ))}
        </div>
      )}
      <div className="pt-2 border-t border-slate-800 text-[10px] text-slate-400">Hosted by {payload.universityName || 'University name'}</div>
      {payload.aboutImageUrl && (
        <div className="pt-2 border-t border-slate-800 space-y-1">
          <div className="text-[10px] text-slate-400">About image</div>
          <ApiImage src={payload.aboutImageUrl} alt={payload.aboutImageAlt ?? ''} className="w-full h-28 object-cover rounded-lg" />
        </div>
      )}
    </div>
  );
}
