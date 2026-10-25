/**
 * Editor specification of every home page section (fields, list items and their limits). The limits mirror
 * the API schemas in apps/api/src/cms/dto/home-content.schema.ts, which remain authoritative.
 */

export type HomeSectionKey =
  | 'hero'
  | 'ticker'
  | 'partners'
  | 'about'
  | 'mission'
  | 'centres'
  | 'programmes'
  | 'marquee'
  | 'mous'
  | 'services'
  | 'news'
  | 'awards'
  | 'testimonials'
  | 'footer';

export interface HomeSection {
  key: HomeSectionKey;
  label: string;
  anchor: string | null;
  enabled: boolean;
  sortOrder: number;
  pinned: boolean;
  canDisable: boolean;
  content: Record<string, unknown>;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

type Obj = Record<string, unknown>;

export interface Option {
  value: string;
  label: string;
}

export type FieldSpec =
  | { kind: 'text'; key: string; label: string; max: number; required?: boolean; multiline?: boolean; rows?: number; hint?: string }
  | { kind: 'link'; key: string; label: string; required?: boolean; hint?: string }
  | { kind: 'image'; key: string; label: string; hint?: string }
  /**
   * Image + video of the object it sits in (its `imageUrl`, `videoUrl` and `imageAlt` fields), edited with
   * MediaUploadField. `key` is only an identifier (MEDIA_KEY); the three fields live on the object itself.
   */
  | { kind: 'media'; key: string; label: string; hint?: string; imageLabel?: string; videoLabel?: string }
  | { kind: 'number'; key: string; label: string; min: number; max: number; nullable?: boolean; hint?: string }
  | { kind: 'select'; key: string; label: string; options?: readonly Option[]; optionsFrom?: (root: Obj) => Option[]; hint?: string }
  | { kind: 'checkbox'; key: string; label: string; hint?: string }
  | { kind: 'date'; key: string; label: string; hint?: string }
  | { kind: 'datetime'; key: string; label: string; hint?: string }
  | { kind: 'slug'; key: string; label: string; hint?: string }
  | { kind: 'textList'; key: string; label: string; max: number; maxItems: number; itemLabel: string; hint?: string }
  | {
      kind: 'group';
      key: string;
      label: string;
      fields: FieldSpec[];
      /** Optional block: can be removed (null) and added again. */
      optional?: { addLabel: string; create: () => Obj };
      /** Carries the placeholder ("sample") flag. */
      sample?: boolean;
      hint?: string;
    }
  | {
      kind: 'list';
      key: string;
      label: string;
      maxItems: number;
      itemNoun: string;
      fields: FieldSpec[];
      create: () => Obj;
      titleOf: (item: Obj, index: number) => string;
      /** Entries carry the placeholder ("sample") flag. */
      sample?: boolean;
      hint?: string;
    };

export const SAMPLE_BADGE = 'Sample — replace';

const ICONS: Option[] = [
  ['building', 'Building'],
  ['graduation', 'Graduation cap'],
  ['ruler', 'Ruler'],
  ['trophy', 'Trophy'],
  ['layers', 'Layers'],
  ['calendar', 'Calendar'],
  ['briefcase', 'Briefcase'],
  ['target', 'Target'],
  ['eye', 'Eye'],
  ['gem', 'Gem'],
  ['map', 'Map'],
  ['scan', 'Scan'],
  ['wrench', 'Wrench'],
  ['monitor', 'Monitor'],
  ['sprout', 'Sprout']
].map(([value, label]) => ({ value, label }));

const TONES: Option[] = [
  { value: 'dark', label: 'Dark card' },
  { value: 'featured', label: 'Featured (green, with lead text and quote button)' },
  { value: 'light', label: 'Light card' },
  { value: 'lime', label: 'Lime card' }
];

const NEWS_CATEGORIES: Option[] = [
  { value: 'event', label: 'Event' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'news', label: 'News' },
  { value: 'visit', label: 'Industry visit' }
];

/** Unique id for a new list entry (lowercase letters, digits and hyphens, as the API requires). */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const LINK_HINT = 'A site path such as /portal, an anchor such as #about, or a full https:// link.';
const POSITION_HINT = 'Crop of the photograph: horizontal and vertical percentages, for example 50% 60%.';
const IMAGE_HINT = 'Optional. Without an image the laboratory photograph is shown.';

/** Identifier of a media field spec (its values are the object's imageUrl / videoUrl / imageAlt). */
export const MEDIA_KEY = '$media';
/** Fields a media spec edits. */
export const MEDIA_FIELD_KEYS = ['imageUrl', 'videoUrl', 'imageAlt'] as const;
const SECTION_MEDIA_HINT = 'Optional. Shown as a wide image or video in this section; without one the section looks as it does now.';
const ITEM_MEDIA_HINT = 'Optional. The video plays muted and looped while on screen, with the image as its poster; without either the default picture is shown.';

/** Image and video control of a section or entry. */
const media = (label: string, hint: string = ITEM_MEDIA_HINT, extra: { imageLabel?: string; videoLabel?: string } = {}): FieldSpec => ({
  kind: 'media',
  key: MEDIA_KEY,
  label,
  hint,
  ...extra
});
const sectionMedia = (): FieldSpec => media('Section image and video', SECTION_MEDIA_HINT);

const linkGroup = (key: string, label: string): FieldSpec => ({
  kind: 'group',
  key,
  label,
  fields: [
    { kind: 'text', key: 'label', label: 'Label', max: 60, required: true },
    { kind: 'link', key: 'href', label: 'Link', required: true, hint: LINK_HINT }
  ]
});

const filterList = (key: string, label: string, noun: string, hint: string): FieldSpec => ({
  kind: 'list',
  key,
  label,
  maxItems: 12,
  itemNoun: noun,
  hint,
  create: () => ({ id: newId('filter'), label: '' }),
  titleOf: (item) => String(item.label || item.id || 'New filter'),
  fields: [
    { kind: 'slug', key: 'id', label: 'Identifier', hint: 'Lowercase letters, digits and hyphens. "all" is the "show everything" filter.' },
    { kind: 'text', key: 'label', label: 'Label', max: 30, required: true }
  ]
});

const categoryOptions = (listKey: string) => (root: Obj): Option[] => {
  const list = Array.isArray(root[listKey]) ? (root[listKey] as Obj[]) : [];
  return list.filter((f) => f.id !== 'all' && typeof f.id === 'string').map((f) => ({ value: String(f.id), label: String(f.label || f.id) }));
};

const video = (key: string, label: string): FieldSpec => ({
  kind: 'group',
  key,
  label,
  sample: true,
  optional: { addLabel: 'Add video card', create: () => ({ title: '', meta: '', url: null, imageUrl: null }) },
  fields: [
    { kind: 'text', key: 'title', label: 'Title', max: 120, required: true },
    { kind: 'text', key: 'meta', label: 'Details line', max: 60, hint: 'For example "Video · 02:14".' },
    { kind: 'link', key: 'url', label: 'Video link', hint: 'Optional. Without a link the card is informational.' },
    media('Thumbnail image and video', IMAGE_HINT + ' A video plays muted inside the thumbnail.')
  ]
});

const testimonialList = (key: string, label: string, prefix: string): FieldSpec => ({
  kind: 'list',
  key,
  label,
  maxItems: 12,
  itemNoun: 'entry',
  sample: true,
  create: () => ({ id: newId(prefix), quote: '', name: '', role: '' }),
  titleOf: (item) => String(item.name || 'New entry'),
  fields: [
    { kind: 'text', key: 'quote', label: 'Quotation', max: 1000, required: true, multiline: true, rows: 3, hint: 'Published with the permission of the person quoted.' },
    { kind: 'text', key: 'name', label: 'Name', max: 80, required: true },
    { kind: 'text', key: 'role', label: 'Designation and organisation', max: 120 },
    media('Photograph and video', 'Optional. Shown in the round portrait instead of the initials.')
  ]
});

const footerLinks = (key: string, label: string): FieldSpec => ({
  kind: 'list',
  key,
  label,
  maxItems: 12,
  itemNoun: 'link',
  create: () => ({ label: '', href: '' }),
  titleOf: (item) => String(item.label || 'New link'),
  hint: 'Links to a home page section that is hidden are left out automatically.',
  fields: [
    { kind: 'text', key: 'label', label: 'Label', max: 60, required: true },
    { kind: 'link', key: 'href', label: 'Link', required: true, hint: LINK_HINT },
    { kind: 'checkbox', key: 'highlight', label: 'Highlight in lime' }
  ]
});

export const HOME_SECTION_SPECS: Record<HomeSectionKey, { description: string; fields: FieldSpec[] }> = {
  hero: {
    description:
      'Text around the hero, and the hero background video. The background image, the description paragraph and the announcement are edited under Home Page Hero.',
    fields: [
      media(
        'Background video and poster',
        'Optional. The video plays muted and looped behind the hero, with the poster image shown first and instead of the video for visitors who prefer reduced motion or save data. Without a poster the Home Page Hero background image is used. Also editable under Home Page Hero.',
        { imageLabel: 'Poster image', videoLabel: 'Background video' }
      ),
      { kind: 'text', key: 'eyebrow', label: 'Label above the headline', max: 120, required: true },
      { kind: 'text', key: 'headlineLead', label: 'Headline, first line', max: 120, required: true },
      { kind: 'text', key: 'headlineHighlight', label: 'Headline, highlighted words', max: 60, required: true },
      { kind: 'textList', key: 'keywords', label: 'Keywords below the headline', max: 30, maxItems: 5, itemLabel: 'Keyword' },
      linkGroup('primaryCta', 'Primary button'),
      linkGroup('secondaryCta', 'Secondary button'),
      linkGroup('tertiaryCta', 'Third button'),
      {
        kind: 'list',
        key: 'facts',
        label: 'Highlights strip (below the buttons)',
        maxItems: 3,
        itemNoun: 'highlight',
        create: () => ({ label: '', value: '', url: '' }),
        titleOf: (item) => String([item.label, item.value].filter(Boolean).join(' ') || 'New highlight'),
        fields: [
          { kind: 'text', key: 'label', label: 'Small label (top line)', max: 40, required: true },
          { kind: 'text', key: 'value', label: 'Main text', max: 40, required: true },
          { kind: 'link', key: 'url', label: 'Link', hint: 'Optional: makes the tile clickable. ' + LINK_HINT }
        ]
      }
    ]
  },
  ticker: {
    description: 'The green scrolling bar below the hero.',
    fields: [{ kind: 'textList', key: 'items', label: 'Ticker messages', max: 200, maxItems: 12, itemLabel: 'Message' }]
  },
  partners: {
    description: 'Strip of HOME-placement sponsors (managed under Sponsors). When there are none, the sponsorship note is shown.',
    fields: [
      { kind: 'text', key: 'title', label: 'Heading', max: 80, required: true },
      { kind: 'text', key: 'fallbackTitle', label: 'Sponsorship note: title', max: 120, required: true },
      { kind: 'text', key: 'fallbackBody', label: 'Sponsorship note: text', max: 600, multiline: true },
      sectionMedia()
    ]
  },
  about: {
    description: 'The heading is the organisation name from Site Information.',
    fields: [
      { kind: 'text', key: 'eyebrow', label: 'Label above the heading', max: 60 },
      { kind: 'text', key: 'intro', label: 'Introduction', max: 1200, required: true, multiline: true, rows: 4 },
      media('Background photograph and video', IMAGE_HINT + ' A video plays muted behind the section.'),
      video('video', 'Video card'),
      linkGroup('cta', 'Button'),
      {
        kind: 'list',
        key: 'stats',
        label: 'Figures',
        maxItems: 12,
        itemNoun: 'figure',
        sample: true,
        hint: 'A figure without a number or text is never shown.',
        create: () => ({ id: newId('stat'), value: null, label: '', ring: 50, icon: 'building' }),
        titleOf: (item) => String(item.label || 'New figure'),
        fields: [
          { kind: 'number', key: 'value', label: 'Number', min: 0, max: 1_000_000_000_000, nullable: true, hint: 'Leave empty when the figure is text or not yet known.' },
          { kind: 'text', key: 'text', label: 'Text instead of a number', max: 40, hint: 'For example "8 × 4 × 3 m".' },
          {
            kind: 'select',
            key: 'format',
            label: 'Number format',
            options: [
              { value: 'plain', label: 'Plain number' },
              { value: 'inr', label: 'Indian rupees (₹1,00,000)' }
            ]
          },
          { kind: 'checkbox', key: 'pad', label: 'Show with two digits (05)' },
          { kind: 'text', key: 'label', label: 'Label', max: 120, required: true },
          { kind: 'number', key: 'ring', label: 'Ring fill (0 to 100)', min: 0, max: 100 },
          { kind: 'select', key: 'icon', label: 'Icon', options: ICONS }
        ]
      }
    ]
  },
  mission: {
    description: 'Tabs with a statement and expandable points each.',
    fields: [
      {
        kind: 'list',
        key: 'tabs',
        label: 'Tabs',
        maxItems: 6,
        itemNoun: 'tab',
        create: () => ({ id: newId('tab'), label: '', heading: '', statement: '', icon: 'target', showRoadmap: false, points: [] }),
        titleOf: (item) => String(item.label || 'New tab'),
        fields: [
          { kind: 'text', key: 'label', label: 'Tab label', max: 30, required: true },
          { kind: 'text', key: 'heading', label: 'Heading', max: 80, required: true },
          { kind: 'text', key: 'statement', label: 'Statement', max: 600, required: true, multiline: true },
          { kind: 'select', key: 'icon', label: 'Icon', options: ICONS },
          { kind: 'checkbox', key: 'showRoadmap', label: 'Show the roadmap bar with this tab' },
          media('Tab image and video', 'Optional. Shown below the heading while this tab is open.'),
          {
            kind: 'list',
            key: 'points',
            label: 'Points',
            maxItems: 10,
            itemNoun: 'point',
            create: () => ({ title: '', body: '' }),
            titleOf: (item) => String(item.title || 'New point'),
            fields: [
              { kind: 'text', key: 'title', label: 'Title', max: 100, required: true },
              { kind: 'text', key: 'body', label: 'Text', max: 600, required: true, multiline: true }
            ]
          }
        ]
      },
      {
        kind: 'group',
        key: 'roadmap',
        label: 'Roadmap bar',
        sample: true,
        optional: { addLabel: 'Add roadmap bar', create: () => ({ label: '', progress: 0 }) },
        fields: [
          { kind: 'text', key: 'label', label: 'Label', max: 60, required: true },
          { kind: 'number', key: 'progress', label: 'Progress (0 to 100)', min: 0, max: 100 }
        ]
      },
      sectionMedia()
    ]
  },
  centres: {
    description: 'Carousel of facilities with category filters.',
    fields: [
      { kind: 'text', key: 'eyebrow', label: 'Label above the heading', max: 60 },
      { kind: 'text', key: 'heading', label: 'Heading', max: 120, required: true },
      { kind: 'text', key: 'enquiryLabel', label: 'Enquiry button label', max: 60, required: true },
      sectionMedia(),
      filterList('filters', 'Filters', 'filter', 'Filters without any centre are not shown.'),
      {
        kind: 'list',
        key: 'items',
        label: 'Centres',
        maxItems: 24,
        itemNoun: 'centre',
        sample: true,
        create: () => ({ id: newId('centre'), code: '', title: '', focus: [], category: '', imageUrl: null, imagePosition: '50% 50%' }),
        titleOf: (item) => String(item.title || 'New centre'),
        fields: [
          { kind: 'text', key: 'code', label: 'Code', max: 20, hint: 'For example CoE 01.' },
          { kind: 'text', key: 'title', label: 'Title', max: 120, required: true },
          { kind: 'textList', key: 'focus', label: 'Focus areas', max: 60, maxItems: 8, itemLabel: 'Focus area' },
          { kind: 'select', key: 'category', label: 'Filter category', optionsFrom: categoryOptions('filters') },
          media('Photograph and video', IMAGE_HINT),
          { kind: 'text', key: 'imagePosition', label: 'Photograph crop', max: 9, required: true, hint: POSITION_HINT }
        ]
      }
    ]
  },
  programmes: {
    description: 'Programme cards with category tabs and search; the selected programme is shown large.',
    fields: [
      { kind: 'text', key: 'eyebrow', label: 'Label above the heading', max: 60 },
      { kind: 'text', key: 'heading', label: 'Heading', max: 120, required: true },
      filterList('categories', 'Categories', 'category', 'Categories without any programme are not shown.'),
      sectionMedia(),
      {
        kind: 'list',
        key: 'items',
        label: 'Programmes',
        maxItems: 24,
        itemNoun: 'programme',
        sample: true,
        create: () => ({ id: newId('programme'), title: '', category: '', summary: '', tags: [], imageUrl: null, imagePosition: '50% 50%', details: null }),
        titleOf: (item) => String(item.title || 'New programme'),
        fields: [
          { kind: 'text', key: 'title', label: 'Title', max: 120, required: true },
          { kind: 'select', key: 'category', label: 'Category', optionsFrom: categoryOptions('categories') },
          { kind: 'text', key: 'summary', label: 'Summary', max: 600, required: true, multiline: true },
          { kind: 'textList', key: 'tags', label: 'Tags', max: 40, maxItems: 8, itemLabel: 'Tag' },
          media('Photograph and video', IMAGE_HINT),
          { kind: 'text', key: 'imagePosition', label: 'Photograph crop', max: 9, required: true, hint: POSITION_HINT },
          {
            kind: 'group',
            key: 'details',
            label: 'Programme details',
            sample: true,
            optional: { addLabel: 'Add programme details', create: () => ({ duration: '', award: '', level: '', syllabus: [], syllabusUrl: null }) },
            fields: [
              { kind: 'text', key: 'duration', label: 'Duration', max: 60 },
              { kind: 'text', key: 'award', label: 'Award', max: 80 },
              { kind: 'text', key: 'level', label: 'Level', max: 60 },
              { kind: 'textList', key: 'syllabus', label: 'Syllabus', max: 160, maxItems: 20, itemLabel: 'Syllabus line' },
              { kind: 'link', key: 'syllabusUrl', label: 'Syllabus download link', hint: 'Optional. ' + LINK_HINT }
            ]
          }
        ]
      }
    ]
  },
  marquee: {
    description: 'The tilted lime band with training areas and services.',
    fields: [{ kind: 'textList', key: 'items', label: 'Entries', max: 80, maxItems: 20, itemLabel: 'Entry' }]
  },
  mous: {
    description: 'Memoranda of understanding. Hidden automatically when it has no entries.',
    fields: [
      { kind: 'text', key: 'heading', label: 'Heading', max: 120, required: true },
      { kind: 'text', key: 'subheading', label: 'Subheading', max: 200 },
      sectionMedia(),
      {
        kind: 'list',
        key: 'items',
        label: 'MoUs',
        maxItems: 24,
        itemNoun: 'MoU',
        sample: true,
        create: () => ({ id: newId('mou'), organisation: '', year: '', summary: '', documentUrl: null }),
        titleOf: (item) => String(item.organisation || 'New MoU'),
        fields: [
          { kind: 'text', key: 'organisation', label: 'Organisation', max: 120, required: true },
          { kind: 'text', key: 'year', label: 'Year', max: 20 },
          { kind: 'text', key: 'summary', label: 'Scope', max: 600, multiline: true },
          { kind: 'link', key: 'documentUrl', label: 'Document link', hint: 'Optional. ' + LINK_HINT },
          media('Logo, photograph or video', 'Optional. Shown at the top of the MoU card.')
        ]
      }
    ]
  },
  services: {
    description: 'Service cards and the quick enquiry form (which opens the visitor’s email application).',
    fields: [
      { kind: 'text', key: 'eyebrow', label: 'Label above the heading', max: 60 },
      { kind: 'text', key: 'heading', label: 'Heading', max: 120, required: true },
      {
        kind: 'list',
        key: 'items',
        label: 'Services',
        maxItems: 12,
        itemNoun: 'service',
        sample: true,
        create: () => ({ id: newId('service'), title: '', icon: 'briefcase', tone: 'dark', bullets: [] }),
        titleOf: (item) => String(item.title || 'New service'),
        fields: [
          { kind: 'text', key: 'title', label: 'Title', max: 80, required: true },
          { kind: 'select', key: 'icon', label: 'Icon', options: ICONS },
          { kind: 'select', key: 'tone', label: 'Card style', options: TONES },
          media('Image and video', 'Optional. Shown at the top of the service card.'),
          { kind: 'textList', key: 'bullets', label: 'Points', max: 120, maxItems: 10, itemLabel: 'Point' },
          { kind: 'text', key: 'lead', label: 'Lead sentence (featured card only)', max: 300 },
          {
            kind: 'group',
            key: 'highlights',
            label: 'Highlights (featured card only, shown instead of the points)',
            sample: true,
            optional: { addLabel: 'Add highlights', create: () => ({ items: [] }) },
            fields: [{ kind: 'textList', key: 'items', label: 'Highlights', max: 60, maxItems: 6, itemLabel: 'Highlight' }]
          }
        ]
      },
      sectionMedia(),
      {
        kind: 'group',
        key: 'enquiry',
        label: 'Quick enquiry',
        fields: [
          { kind: 'text', key: 'title', label: 'Title', max: 80, required: true },
          { kind: 'text', key: 'body', label: 'Text', max: 400, multiline: true }
        ]
      }
    ]
  },
  news: {
    description: 'Countdown banner and news cards. The announcement from Home Page Hero is added as a card.',
    fields: [
      { kind: 'text', key: 'eyebrow', label: 'Label above the heading', max: 60 },
      { kind: 'text', key: 'heading', label: 'Heading', max: 120, required: true },
      sectionMedia(),
      {
        kind: 'group',
        key: 'nextEvent',
        label: 'Next event countdown',
        hint: 'Disappears on its own once the event has ended.',
        optional: {
          addLabel: 'Add countdown',
          create: () => ({ label: 'Next event', title: '', dates: '', startsAt: '', endsAt: '', register: { label: 'Register', href: '/portal' }, live: { label: 'Live scores', href: '/' } })
        },
        fields: [
          { kind: 'text', key: 'label', label: 'Label', max: 40, required: true },
          { kind: 'text', key: 'title', label: 'Event', max: 120, required: true },
          { kind: 'text', key: 'dates', label: 'Dates as shown', max: 60, required: true },
          { kind: 'datetime', key: 'startsAt', label: 'Starts at', hint: 'Date, time and offset, for example 2026-12-01T09:00:00+05:30.' },
          { kind: 'datetime', key: 'endsAt', label: 'Ends at', hint: 'For example 2026-12-02T18:00:00+05:30.' },
          linkGroup('register', 'Button before the event'),
          linkGroup('live', 'Button during the event')
        ]
      },
      {
        kind: 'list',
        key: 'filters',
        label: 'Filter labels',
        maxItems: 4,
        itemNoun: 'filter',
        create: () => ({ id: 'news', label: '' }),
        titleOf: (item) => String(item.label || item.id),
        fields: [
          { kind: 'select', key: 'id', label: 'Category', options: NEWS_CATEGORIES },
          { kind: 'text', key: 'label', label: 'Label', max: 30, required: true }
        ]
      },
      {
        kind: 'list',
        key: 'items',
        label: 'News cards',
        maxItems: 30,
        itemNoun: 'card',
        sample: true,
        create: () => ({ id: newId('news'), category: 'news', title: '', summary: '', href: '#news', imageUrl: null, imagePosition: '50% 50%' }),
        titleOf: (item) => String(item.title || 'New card'),
        fields: [
          { kind: 'select', key: 'category', label: 'Category', options: NEWS_CATEGORIES },
          { kind: 'text', key: 'title', label: 'Title', max: 160, required: true },
          { kind: 'text', key: 'summary', label: 'Summary', max: 600, multiline: true },
          { kind: 'date', key: 'date', label: 'Date', hint: 'Optional. Leave empty to show the status instead.' },
          { kind: 'text', key: 'status', label: 'Status (when there is no date)', max: 30, hint: 'For example "Open".' },
          { kind: 'link', key: 'href', label: '"Read more" link', required: true, hint: LINK_HINT },
          media('Photograph and video', IMAGE_HINT),
          { kind: 'text', key: 'imagePosition', label: 'Photograph crop', max: 9, required: true, hint: POSITION_HINT }
        ]
      }
    ]
  },
  awards: {
    description:
      'Mosaic of up to four awards. Without awards it shows the first four gallery images (Gallery tab); with neither it is hidden.',
    fields: [
      { kind: 'text', key: 'eyebrow', label: 'Label above the heading', max: 60 },
      { kind: 'text', key: 'heading', label: 'Heading', max: 120, required: true },
      { kind: 'text', key: 'galleryEyebrow', label: 'Label above the heading when the gallery is shown', max: 60 },
      sectionMedia(),
      {
        kind: 'list',
        key: 'items',
        label: 'Awards',
        maxItems: 4,
        itemNoun: 'award',
        sample: true,
        create: () => ({ id: newId('award'), badge: '', title: '', detail: '', imageUrl: null }),
        titleOf: (item) => String(item.title || 'New award'),
        fields: [
          { kind: 'text', key: 'badge', label: 'Badge', max: 60, hint: 'For example "Award · 2026".' },
          { kind: 'text', key: 'title', label: 'Title', max: 120, required: true },
          { kind: 'text', key: 'detail', label: 'Detail', max: 300 },
          media('Photograph and video', 'Optional. Otherwise a gallery image or the laboratory photograph. A video plays muted in the tile.')
        ]
      }
    ]
  },
  testimonials: {
    description: 'Visitor comments and success stories. Hidden automatically when both are empty.',
    fields: [
      { kind: 'text', key: 'visitorsHeading', label: 'Visitors heading', max: 80, required: true },
      testimonialList('visitors', 'Visitor comments', 'visitor'),
      { kind: 'text', key: 'storiesHeading', label: 'Success stories heading', max: 80, required: true },
      video('storyVideo', 'Success story video card'),
      testimonialList('stories', 'Success stories', 'story'),
      sectionMedia()
    ]
  },
  footer: {
    description: 'Footer of the home page. Contact details and social links come from Site Information.',
    fields: [
      { kind: 'text', key: 'subscribeTitle', label: 'Subscription box: title', max: 80, required: true },
      { kind: 'text', key: 'subscribeBody', label: 'Subscription box: text', max: 300 },
      { kind: 'text', key: 'subscribeSubject', label: 'Subscription email subject', max: 120, required: true },
      { kind: 'text', key: 'quickLinksTitle', label: 'First link column: heading', max: 40, required: true },
      footerLinks('quickLinks', 'First link column'),
      { kind: 'text', key: 'programmeLinksTitle', label: 'Second link column: heading', max: 40, required: true },
      footerLinks('programmeLinks', 'Second link column'),
      sectionMedia()
    ]
  }
};

/** Number of sample ("placeholder") entries in a content value. */
export function countSamples(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countSamples(v), 0);
  if (value && typeof value === 'object') {
    const own = (value as Obj).placeholder === true ? 1 : 0;
    return own + Object.values(value as Obj).reduce((n: number, v) => n + countSamples(v), 0);
  }
  return 0;
}

/** Order of the orderable sections after moving one up or down; null when it cannot move. */
export function moveSection(list: HomeSection[], key: HomeSectionKey, direction: -1 | 1): HomeSection[] | null {
  const body = list.filter((s) => !s.pinned);
  const index = body.findIndex((s) => s.key === key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= body.length) return null;
  const next = [...body];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Flattens an API validation message ("items.0.title: must not be empty; ...") into a readable list. */
export function validationLines(message: string): string[] {
  return message
    .split(';')
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 8);
}
