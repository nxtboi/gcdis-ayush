/**
 * Home page content: hero details, ticker, body sections and footer.
 *
 * The live content is managed from the staff console ("Home Page Sections") and loaded on the server by
 * `lib/home-sections.ts` (GET /cms/public/home). `HOME_CONTENT` below is the bundled fallback used when the
 * API is unreachable; it mirrors the API defaults in apps/api/src/cms/home-content.defaults.ts.
 *
 * Placeholder rule
 * ----------------
 * Anything that still needs facts from the Centre (MoU partners, awards, visitor quotes, success stories,
 * programme durations and syllabi, unknown statistics, videos) is marked `placeholder: true`.
 * - Development (`NODE_ENV !== 'production'`) or `NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT=true`: placeholders are shown
 *   so the layout can be reviewed.
 * - Production: placeholder items are removed by `resolveHomeContent`, and a section whose items are all
 *   placeholders is not rendered at all.
 * To publish an item, replace its example text with the real facts and delete `placeholder: true`.
 * Statistics with an unknown value (`value: null`) are never shown, in any environment.
 *
 * Contact details (address, phones, email, social links) are not stored here: they come from the
 * console-managed site information (`lib/site-content.ts`).
 */
import { CHAMPIONSHIP_NAME, CHAMPIONSHIP_PATH, PRIZE_POOL_INR } from './championship';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PlaceholderFlag {
  /** Example content awaiting facts from the Centre: shown in development only. */
  placeholder?: boolean;
}

/**
 * Optional media of a section or entry (Home Page Sections in the staff console): an uploaded image and / or an
 * uploaded video (EVENT_VIDEO, MP4 / WebM). The video plays muted and looped with the image as its poster, only
 * while in view, and never with reduced motion or data saving; otherwise the image (or the default) is shown.
 */
export interface MediaFields {
  imageUrl?: string | null;
  videoUrl?: string | null;
  /** Screen-reader description of the image; empty = decorative. */
  imageAlt?: string;
}

export interface LinkItem {
  label: string;
  href: string;
}

/** Icons available to content entries (mapped to lucide icons in the components). */
export type HomeIconKey =
  | 'map'
  | 'scan'
  | 'wrench'
  | 'monitor'
  | 'sprout'
  | 'briefcase'
  | 'building'
  | 'target'
  | 'eye'
  | 'gem'
  | 'trophy'
  | 'ruler'
  | 'calendar'
  | 'layers'
  | 'graduation';

export interface StatItem extends PlaceholderFlag {
  id: string;
  /** Numeric value (counted up on scroll); `null` = unknown, the tile is omitted. */
  value: number | null;
  /** Text value used instead of a number (shown as is, for example "8 × 4 × 3 m"). */
  text?: string;
  /** `inr` renders "₹1,00,000". */
  format?: 'inr' | 'plain';
  /** Pad numbers to two digits ("05"). */
  pad?: boolean;
  label: string;
  /** Decorative ring fill, 0 to 100. */
  ring: number;
  icon: HomeIconKey;
}

export interface VideoTeaser extends PlaceholderFlag, MediaFields {
  title: string;
  meta: string;
  /** Link to the video (opens in a new tab); without one the card is informational. */
  url: string | null;
  /** Thumbnail uploaded in the console; the laboratory photograph when absent. */
  imageUrl?: string | null;
}

export interface MissionPoint {
  title: string;
  body: string;
}

export interface MissionTab extends MediaFields {
  id: string;
  label: string;
  heading: string;
  statement: string;
  points: MissionPoint[];
  icon: HomeIconKey;
  /** Show the roadmap progress bar with this tab. */
  showRoadmap?: boolean;
}

export interface Roadmap extends PlaceholderFlag {
  label: string;
  /** 0 to 100. */
  progress: number;
}

export interface Centre extends PlaceholderFlag, MediaFields {
  id: string;
  code: string;
  title: string;
  focus: string[];
  category: string;
  /** Photograph uploaded in the console; the laboratory photograph when absent. */
  imageUrl?: string | null;
  /** CSS object-position of the photograph crop. */
  imagePosition: string;
}

export interface ProgrammeDetails extends PlaceholderFlag {
  duration: string;
  award: string;
  level: string;
  syllabus: string[];
  syllabusUrl: string | null;
}

export interface Programme extends PlaceholderFlag, MediaFields {
  id: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  imageUrl?: string | null;
  imagePosition: string;
  details: ProgrammeDetails | null;
}

export interface Mou extends PlaceholderFlag, MediaFields {
  id: string;
  organisation: string;
  year: string;
  summary: string;
  documentUrl: string | null;
}

export interface ServiceHighlights extends PlaceholderFlag {
  items: string[];
}

export interface Service extends PlaceholderFlag, MediaFields {
  id: string;
  title: string;
  icon: HomeIconKey;
  bullets: string[];
  /** Card style in the bento grid. */
  tone: 'dark' | 'featured' | 'light' | 'lime';
  /** Featured card only: one-sentence description. */
  lead?: string;
  highlights?: ServiceHighlights | null;
}

export type NewsCategory = 'event' | 'workshop' | 'news' | 'visit';

export interface NewsItem extends PlaceholderFlag, MediaFields {
  id: string;
  category: NewsCategory;
  title: string;
  summary: string;
  /** ISO date (YYYY-MM-DD); omitted when there is no single date. */
  date?: string;
  /** Short status shown instead of a date (for example "Open"). */
  status?: string;
  href: string;
  imageUrl?: string | null;
  imagePosition: string;
}

export interface NextEvent {
  label: string;
  title: string;
  dates: string;
  /** Absolute instants with an explicit offset (IST). */
  startsAt: string;
  endsAt: string;
  register: LinkItem;
  live: LinkItem;
}

export interface Award extends PlaceholderFlag, MediaFields {
  id: string;
  title: string;
  detail: string;
  badge: string;
  /** Photograph uploaded in the console; otherwise a gallery image or the laboratory photograph. */
  imageUrl?: string | null;
}

export interface Testimonial extends PlaceholderFlag, MediaFields {
  id: string;
  quote: string;
  name: string;
  role: string;
}

export interface FooterLink extends LinkItem {
  highlight?: boolean;
}

export interface HeroFact {
  label: string;
  value: string;
  /** Optional link (site path, #anchor or https); the highlight tile becomes clickable. */
  url?: string | null;
}

export interface HomeContent {
  /** Hero copy around the console-managed background, description and announcement (cms/section/hero). */
  hero: MediaFields & {
    eyebrow: string;
    headlineLead: string;
    headlineHighlight: string;
    keywords: string[];
    primaryCta: LinkItem;
    secondaryCta: LinkItem;
    /** Optional third button beside the secondary one. */
    tertiaryCta?: LinkItem | null;
    facts: HeroFact[];
  };
  ticker: { items: string[] };
  partners: MediaFields & {
    title: string;
    fallbackTitle: string;
    fallbackBody: string;
  };
  /** Training areas band (scrolling lime marquee). */
  marquee: { items: string[] };
  about: MediaFields & {
    eyebrow: string;
    intro: string;
    /** Background photograph uploaded in the console; the laboratory photograph when absent. */
    imageUrl?: string | null;
    video: VideoTeaser | null;
    /** `null` when the linked section is hidden. */
    cta: LinkItem | null;
    stats: StatItem[];
  };
  mission: MediaFields & {
    tabs: MissionTab[];
    roadmap: Roadmap | null;
  };
  centres: MediaFields & {
    eyebrow: string;
    heading: string;
    filters: { id: string; label: string }[];
    enquiryLabel: string;
    items: Centre[];
  };
  programmes: MediaFields & {
    eyebrow: string;
    heading: string;
    categories: { id: string; label: string }[];
    items: Programme[];
  };
  mous: MediaFields & {
    heading: string;
    subheading: string;
    items: Mou[];
  };
  services: MediaFields & {
    eyebrow: string;
    heading: string;
    items: Service[];
    enquiry: { title: string; body: string };
  };
  news: MediaFields & {
    eyebrow: string;
    heading: string;
    /** Countdown banner; `null` hides it. */
    nextEvent: NextEvent | null;
    filters: { id: NewsCategory; label: string }[];
    items: NewsItem[];
  };
  awards: MediaFields & {
    eyebrow: string;
    heading: string;
    /** Eyebrow shown when the mosaic falls back to the gallery (no awards). */
    galleryEyebrow: string;
    items: Award[];
  };
  testimonials: MediaFields & {
    visitorsHeading: string;
    visitors: Testimonial[];
    storiesHeading: string;
    storyVideo: VideoTeaser | null;
    stories: Testimonial[];
  };
  footer: MediaFields & {
    subscribeTitle: string;
    subscribeBody: string;
    subscribeSubject: string;
    quickLinksTitle: string;
    quickLinks: FooterLink[];
    programmeLinksTitle: string;
    programmeLinks: FooterLink[];
  };
}

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

export const CHAMPIONSHIP_STARTS_AT = '2026-12-01T09:00:00+05:30';
export const CHAMPIONSHIP_ENDS_AT = '2026-12-02T18:00:00+05:30';

export const HOME_CONTENT: HomeContent = {
  hero: {
    eyebrow: 'Galgotias Centre for Drone Intelligence & Simulation',
    headlineLead: "Building India's Next Generation of",
    headlineHighlight: 'Drone Innovators',
    keywords: ['Innovation', 'Technology', 'Excellence'],
    primaryCta: { label: 'Explore Programmes', href: '#programmes' },
    secondaryCta: { label: 'Our Services', href: '#services' },
    tertiaryCta: { label: 'Events', href: '#news' },
    facts: [
      { label: 'Training', value: 'Programmes', url: '#programmes' },
      { label: 'Drone', value: 'Services', url: '#services' },
      { label: 'Centres of', value: 'Excellence', url: '#centres' }
    ]
  },

  ticker: {
    items: [
      'Drone Soccer Championship 2026: team registration is open for Class 20 (D20) and Class 40 (D40)',
      'Matches are conducted under the FIDA Dronesoccer Regulations, 5th Revision (1 October 2025)',
      'Total prize pool: ₹1,00,000 (Class 40 first place: ₹31,000; Class 20 first place: ₹21,000)',
      'Registered teams may sign in to the Team Portal to manage their entries'
    ]
  },

  partners: {
    title: 'Industry partners',
    fallbackTitle: 'Sponsorship opportunities',
    fallbackBody:
      'The Centre welcomes enquiries from organisations interested in supporting its programmes and the national championship. Details are available from the Secretariat.'
  },

  marquee: {
    items: [
      'Drone pilot training',
      'Robotics',
      'Drone manufacturing',
      'Simulation and autonomy',
      'Drone internship',
      'Survey and mapping',
      'Inspection and monitoring',
      CHAMPIONSHIP_NAME
    ]
  },

  about: {
    eyebrow: 'About us',
    intro:
      'GCDIS is the drone research and training centre of Galgotias University, Greater Noida. It brings together aerospace engineering, embedded systems, autonomy and flight simulation, and offers training, research and services for students, industry and institutions.',
    imageUrl: null,
    video: { placeholder: true, title: 'Take a tour of the laboratory', meta: 'Video · 02:14', url: null, imageUrl: null },
    cta: { label: 'Our mission and vision', href: '#mission' },
    stats: [
      { id: 'centres', value: 5, pad: true, label: 'Centres of excellence', ring: 100, icon: 'building' },
      { id: 'training-areas', value: 5, pad: true, label: 'Training areas', ring: 100, icon: 'graduation' },
      { id: 'arena', value: null, text: '8 × 4 × 3 m', label: 'Netted flight arena', ring: 70, icon: 'ruler' },
      { id: 'prize-pool', value: PRIZE_POOL_INR, format: 'inr', label: 'Championship prize pool', ring: 85, icon: 'trophy' },
      { id: 'classes', value: 2, pad: true, label: 'Championship classes, Class 20 and Class 40', ring: 50, icon: 'layers' },
      { id: 'days', value: 2, pad: true, label: 'Days of competition, 1 and 2 December 2026', ring: 50, icon: 'calendar' },
      // Owner to supply: set `value`, then delete `placeholder: true`. Unknown values are never shown.
      { id: 'students', value: null, placeholder: true, label: 'Students trained', ring: 78, icon: 'graduation' },
      { id: 'industry-partners', value: null, placeholder: true, label: 'Industry partners', ring: 60, icon: 'briefcase' },
      { id: 'mous', value: null, placeholder: true, label: 'MoUs signed', ring: 45, icon: 'briefcase' },
      { id: 'awards', value: null, placeholder: true, label: 'Awards won', ring: 35, icon: 'trophy' }
    ]
  },

  mission: {
    tabs: [
      {
        id: 'mission',
        label: 'Mission',
        heading: 'Our mission',
        statement: 'To develop skilled drone professionals through practical training, applied research and collaboration with industry.',
        icon: 'target',
        showRoadmap: false,
        points: [
          {
            title: 'Practical learning',
            body: 'Hands-on training in drone design, assembly, flight and simulation, delivered in dedicated laboratories by faculty and industry experts.'
          },
          {
            title: 'Applied research',
            body: 'Research in autonomy, flight control and simulation that addresses practical problems in aerial robotics.'
          },
          {
            title: 'Industry-ready skills',
            body: 'Programmes aligned with the skills that employers in the drone sector require, from manufacturing to operations.'
          },
          {
            title: 'Safe UAV operations',
            body: 'Training that places safety procedures and the applicable regulations at the centre of every flight.'
          }
        ]
      },
      {
        id: 'vision',
        label: 'Vision',
        heading: 'Our vision',
        statement: 'To become a national centre of excellence in autonomous systems, aerospace engineering and intelligent UAV development.',
        icon: 'eye',
        showRoadmap: true,
        points: [
          {
            title: 'Autonomous systems',
            body: 'Advancing autonomous flight, perception and navigation through simulation-first development.'
          },
          {
            title: 'Aerospace engineering',
            body: 'Strengthening design, prototyping and testing capability for unmanned aircraft.'
          },
          {
            title: 'National reach',
            body: 'Serving students, institutions and industry across India through training, services and competitions.'
          }
        ]
      },
      {
        id: 'values',
        label: 'Values',
        heading: 'Our values',
        statement: 'Safety, integrity and collaboration guide every programme, project and competition at the Centre.',
        icon: 'gem',
        showRoadmap: false,
        points: [
          { title: 'Safety', body: 'Every flight, test and competition follows documented safety procedures.' },
          { title: 'Integrity', body: 'Fair assessment, transparent rules and verifiable certificates.' },
          { title: 'Collaboration', body: 'Working with industry, institutions and students to share knowledge and facilities.' },
          { title: 'Excellence', body: 'High standards in teaching, engineering and research.' }
        ]
      }
    ],
    // Owner to confirm the roadmap year and progress before publishing.
    roadmap: { placeholder: true, label: 'Roadmap 2030', progress: 40 }
  },

  centres: {
    eyebrow: 'Infrastructure',
    heading: 'Centres of excellence',
    enquiryLabel: 'Enquire about this facility',
    filters: [
      { id: 'all', label: 'All' },
      { id: 'design', label: 'Design' },
      { id: 'simulation', label: 'Simulation' },
      { id: 'autonomy', label: 'Autonomy' },
      { id: 'flight', label: 'Flight' }
    ],
    items: [
      {
        id: 'uav-design',
        code: 'CoE 01',
        title: 'UAV design & prototyping',
        focus: ['Airframes', 'Propulsion', 'Fabrication'],
        category: 'design',
        imageUrl: null,
        imagePosition: '30% 70%'
      },
      {
        id: 'simulation',
        code: 'CoE 02',
        title: 'Simulation: ROS 2 · PX4 · Gazebo',
        focus: ['ROS 2', 'PX4', 'Gazebo'],
        category: 'simulation',
        imageUrl: null,
        imagePosition: '80% 40%'
      },
      {
        id: 'autonomy',
        code: 'CoE 03',
        title: 'Autonomous systems & AI/ML',
        focus: ['Autonomy', 'Perception', 'Machine learning'],
        category: 'autonomy',
        imageUrl: null,
        imagePosition: '55% 30%'
      },
      {
        id: 'flight-arena',
        code: 'CoE 04',
        title: 'Drone flight arena',
        focus: ['Netted 8 × 4 × 3 m arena'],
        category: 'flight',
        imageUrl: null,
        imagePosition: '60% 90%'
      },
      {
        id: 'robotics',
        code: 'CoE 05',
        title: 'Robotics, vision & navigation',
        focus: ['Robotics', 'Machine vision', 'Navigation'],
        category: 'autonomy',
        imageUrl: null,
        imagePosition: '10% 50%'
      }
    ]
  },

  programmes: {
    eyebrow: 'Skill development',
    heading: 'Training programmes',
    categories: [
      { id: 'all', label: 'All' },
      { id: 'drones', label: 'Drones' },
      { id: 'robotics', label: 'Robotics' },
      { id: 'manufacturing', label: 'Manufacturing' },
      { id: 'simulation', label: 'Simulation' },
      { id: 'internship', label: 'Internship' }
    ],
    items: [
      {
        id: 'pilot-training',
        title: 'Drone pilot training',
        category: 'drones',
        summary: 'Flight fundamentals, safety procedures and simulator practice, leading to supervised manual and assisted flight.',
        tags: ['Flight', 'Safety', 'Simulator'],
        imageUrl: null,
        imagePosition: '50% 65%',
        // Owner to supply: duration, certificate, level and syllabus.
        details: {
          placeholder: true,
          duration: '4 weeks',
          award: 'Certificate',
          level: 'Beginner to advanced',
          syllabus: [
            'Week 1 · Flight fundamentals and safety',
            'Week 2 · Simulator hours (PX4 SITL)',
            'Week 3 · Manual and assisted flight',
            'Week 4 · Regulations and assessment'
          ],
          syllabusUrl: null
        }
      },
      {
        id: 'manufacturing',
        title: 'Drone manufacturing',
        category: 'manufacturing',
        summary: 'Assembly, wiring, integration and quality checks of multirotor drones in the fabrication laboratory.',
        tags: ['Assembly', 'Wiring', 'Quality'],
        imageUrl: null,
        imagePosition: '15% 80%',
        details: { placeholder: true, duration: '8 weeks', award: 'Certificate', level: 'Intermediate', syllabus: [], syllabusUrl: null }
      },
      {
        id: 'robotics',
        title: 'Robotics',
        category: 'robotics',
        summary: 'Robot design, embedded control and sensing for autonomous machines.',
        tags: ['Embedded control', 'Sensing'],
        imageUrl: null,
        imagePosition: '90% 30%',
        details: null
      },
      {
        id: 'simulation-autonomy',
        title: 'Simulation & autonomy',
        category: 'simulation',
        summary: 'Autonomous flight development with ROS 2, PX4 and Gazebo, from simulation to the flight arena.',
        tags: ['ROS 2', 'PX4', 'Gazebo'],
        imageUrl: null,
        imagePosition: '70% 45%',
        details: null
      },
      {
        id: 'internship',
        title: 'Drone internship',
        category: 'internship',
        summary: 'Project-based internship in the laboratories of the Centre.',
        tags: ['Projects', 'Laboratories'],
        imageUrl: null,
        imagePosition: '35% 55%',
        details: { placeholder: true, duration: '6 months', award: 'Internship certificate', level: 'Advanced', syllabus: [], syllabusUrl: null }
      }
    ]
  },

  mous: {
    heading: 'Associate partners & MoUs',
    subheading: 'Signed memoranda of understanding',
    // Owner to supply: organisation, year, scope and (optionally) a link to the MoU document.
    items: [
      { id: 'mou-1', placeholder: true, organisation: 'Organisation name', year: '2026', summary: 'Training, internships and placements for GCDIS students.', documentUrl: null },
      { id: 'mou-2', placeholder: true, organisation: 'Organisation name', year: '2026', summary: 'Joint research and access to facilities.', documentUrl: null },
      { id: 'mou-3', placeholder: true, organisation: 'Institution name', year: '2025', summary: 'Academic collaboration and faculty exchange.', documentUrl: null },
      { id: 'mou-4', placeholder: true, organisation: 'Organisation name', year: '2025', summary: 'Industry projects for student teams.', documentUrl: null }
    ]
  },

  services: {
    eyebrow: 'For industry and institutions',
    heading: 'Our services',
    items: [
      {
        id: 'survey-mapping',
        title: 'Survey & mapping',
        icon: 'map',
        tone: 'dark',
        bullets: ['Aerial photogrammetry', 'Orthomosaics and contours', '3D site models']
      },
      {
        id: 'inspection-monitoring',
        title: 'Inspection & monitoring',
        icon: 'scan',
        tone: 'featured',
        lead: 'Visual and thermal inspection of structures, solar arrays and facilities.',
        bullets: ['Structures and facilities', 'Solar arrays', 'Visual and thermal imaging'],
        // Owner to confirm turnaround and deliverables.
        highlights: { placeholder: true, items: ['Turnaround: 3–5 days', 'Report: PDF and data'] }
      },
      {
        id: 'design-manufacturing',
        title: 'Design & manufacturing',
        icon: 'wrench',
        tone: 'dark',
        bullets: ['Custom airframes', 'Payload integration', '3D printing and prototyping']
      },
      {
        id: 'simulation-testing',
        title: 'Simulation & testing',
        icon: 'monitor',
        tone: 'light',
        bullets: ['Software-in-the-loop', 'Hardware-in-the-loop', 'Flight data analysis']
      },
      {
        id: 'agricultural-drones',
        title: 'Agricultural drones',
        icon: 'sprout',
        tone: 'dark',
        bullets: ['Crop health monitoring', 'Precision spraying trials', 'Farmer awareness programmes']
      },
      {
        id: 'consultancy',
        title: 'Consultancy',
        icon: 'briefcase',
        tone: 'lime',
        bullets: ['Drone programme planning', 'Laboratory set-up guidance', 'Training needs assessment']
      }
    ],
    enquiry: {
      title: 'Quick enquiry',
      body: 'Choose a service and submit: your email application opens with an enquiry addressed to the Centre.'
    }
  },

  news: {
    eyebrow: 'Latest',
    heading: 'Recent news & events',
    nextEvent: {
      label: 'Next event',
      title: CHAMPIONSHIP_NAME,
      dates: '1–2 December 2026',
      startsAt: CHAMPIONSHIP_STARTS_AT,
      endsAt: CHAMPIONSHIP_ENDS_AT,
      register: { label: 'Register', href: '/portal' },
      live: { label: 'Live scores', href: `${CHAMPIONSHIP_PATH}#scoring` }
    },
    filters: [
      { id: 'event', label: 'Events' },
      { id: 'workshop', label: 'Workshops' },
      { id: 'news', label: 'News' },
      { id: 'visit', label: 'Visits' }
    ],
    items: [
      {
        id: 'championship-2026',
        category: 'event',
        title: CHAMPIONSHIP_NAME,
        summary: 'National competition in Class 20 (D20) and Class 40 (D40) with a total prize pool of ₹1,00,000.',
        date: '2026-12-01',
        href: CHAMPIONSHIP_PATH,
        imageUrl: null,
        imagePosition: '50% 60%'
      },
      {
        id: 'registration-open',
        category: 'news',
        title: 'Team registration is open',
        summary: 'Teams may register for the Class 20 (D20) and Class 40 (D40) categories through the Team Portal.',
        status: 'Open',
        href: '/portal',
        imageUrl: null,
        imagePosition: '20% 80%'
      },
      {
        id: 'fida-regulations',
        category: 'news',
        title: 'Matches under the FIDA regulations',
        summary: 'The championship is conducted under the FIDA Dronesoccer Regulations, 5th Revision (1 October 2025).',
        date: '2025-10-01',
        href: `${CHAMPIONSHIP_PATH}#rules`,
        imageUrl: null,
        imagePosition: '85% 35%'
      },
      {
        id: 'assembly-workshop',
        placeholder: true,
        category: 'workshop',
        title: 'Hands-on drone assembly workshop',
        summary: 'Students built and test-flew training quadcopters.',
        date: '2026-10-24',
        href: '#news',
        imageUrl: null,
        imagePosition: '20% 80%'
      },
      {
        id: 'industry-visit',
        placeholder: true,
        category: 'visit',
        title: 'Industry visit to a drone manufacturer',
        summary: 'Students observed production and testing lines.',
        date: '2026-09-18',
        href: '#news',
        imageUrl: null,
        imagePosition: '65% 50%'
      }
    ]
  },

  awards: {
    eyebrow: 'Achievements',
    heading: 'Awards & recognition',
    galleryEyebrow: 'Gallery',
    // Owner to supply: verified awards, placements and recognitions.
    items: [
      { id: 'award-1', placeholder: true, badge: 'Award · Year', title: 'Award or placement title', detail: 'Event and organiser, shown once verified', imageUrl: null },
      { id: 'award-2', placeholder: true, badge: 'Competition · Year', title: 'Competition title', detail: 'Placement and team', imageUrl: null },
      { id: 'award-3', placeholder: true, badge: 'Recognition · Year', title: 'Recognition title', detail: 'Photo and citation', imageUrl: null },
      { id: 'award-4', placeholder: true, badge: 'Research · Year', title: 'Research or patent recognition', detail: 'Title and inventors', imageUrl: null }
    ]
  },

  testimonials: {
    visitorsHeading: 'Visitors speak',
    // Owner to supply: comments published with the visitor's permission.
    visitors: [
      { id: 'visitor-1', placeholder: true, quote: 'Visitor’s comment on the Centre, its facilities and its students, published with permission.', name: 'Visitor name', role: 'Designation, Organisation' },
      { id: 'visitor-2', placeholder: true, quote: 'A second visitor’s comment on the laboratories and the flight arena.', name: 'Visitor name', role: 'Designation, Organisation' },
      { id: 'visitor-3', placeholder: true, quote: 'A third visitor’s comment on training and research at the Centre.', name: 'Visitor name', role: 'Designation, Organisation' }
    ],
    storiesHeading: 'Success stories',
    storyVideo: { placeholder: true, title: 'Student name · UAV Engineer', meta: 'Video story · 01:42', url: null, imageUrl: null },
    stories: [
      { id: 'story-1', placeholder: true, quote: 'My final-year autonomy project at GCDIS led to an internship and a full-time role.', name: 'Student name', role: 'Robotics Engineer · Company name' },
      { id: 'story-2', placeholder: true, quote: 'Training in the simulation laboratory prepared our team for national competitions.', name: 'Student name', role: 'Programme · Year' }
    ]
  },

  footer: {
    subscribeTitle: 'Stay updated',
    subscribeBody: 'News, events and programme announcements from GCDIS.',
    subscribeSubject: 'Request to receive GCDIS updates',
    quickLinksTitle: 'Quick links',
    quickLinks: [
      { label: 'About us', href: '#about' },
      { label: 'Centres of excellence', href: '#centres', highlight: true },
      { label: 'Training programmes', href: '#programmes' },
      { label: 'Our services', href: '#services' },
      { label: 'News & events', href: '#news' },
      { label: 'Verify a certificate', href: '/verify' }
    ],
    programmeLinksTitle: 'Programmes',
    programmeLinks: [
      { label: 'Drone pilot training', href: '#programmes' },
      { label: 'Drone manufacturing', href: '#programmes' },
      { label: 'Robotics', href: '#programmes' },
      { label: 'Simulation & autonomy', href: '#programmes' },
      { label: 'Championship 2026', href: CHAMPIONSHIP_PATH, highlight: true }
    ]
  }
};

/* ------------------------------------------------------------------ */
/* Placeholder filtering                                               */
/* ------------------------------------------------------------------ */

/**
 * Whether placeholder content is rendered: always outside production, and in production only with
 * NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT=true (for a review deployment).
 */
export function showPlaceholderContent(
  env: { NODE_ENV?: string; NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT?: string } = {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT: process.env.NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT
  }
): boolean {
  return env.NODE_ENV !== 'production' || env.NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT === 'true';
}

/** Items that may be rendered: placeholders are removed unless `showPlaceholders`. */
export function visibleItems<T extends PlaceholderFlag>(items: readonly T[], showPlaceholders: boolean): T[] {
  return items.filter((item) => showPlaceholders || !item.placeholder);
}

/** A single optional block (video, roadmap, details): `null` when it is a hidden placeholder. */
export function visibleBlock<T extends PlaceholderFlag>(block: T | null | undefined, showPlaceholders: boolean): T | null {
  if (!block) return null;
  return showPlaceholders || !block.placeholder ? block : null;
}

/** Statistics with a known value (number or text) that may be rendered. Unknown counts are always omitted. */
export function visibleStats(stats: readonly StatItem[], showPlaceholders: boolean): StatItem[] {
  return visibleItems(stats, showPlaceholders).filter((s) => s.value !== null || Boolean(s.text));
}

/**
 * Home content with placeholders applied. Every list may come back empty; the page hides a section whose
 * content is empty (see `components/home-bento/HomeBento.tsx`).
 */
export function resolveHomeContent(showPlaceholders: boolean, source: HomeContent = HOME_CONTENT): HomeContent {
  const show = showPlaceholders;
  return {
    ...source,
    about: {
      ...source.about,
      video: visibleBlock(source.about.video, show),
      stats: visibleStats(source.about.stats, show)
    },
    mission: { ...source.mission, roadmap: visibleBlock(source.mission.roadmap, show) },
    centres: { ...source.centres, items: visibleItems(source.centres.items, show) },
    programmes: {
      ...source.programmes,
      items: visibleItems(source.programmes.items, show).map((p) => ({ ...p, details: visibleBlock(p.details, show) }))
    },
    mous: { ...source.mous, items: visibleItems(source.mous.items, show) },
    services: {
      ...source.services,
      items: visibleItems(source.services.items, show).map((s) => ({ ...s, highlights: visibleBlock(s.highlights, show) }))
    },
    news: { ...source.news, items: visibleItems(source.news.items, show) },
    awards: { ...source.awards, items: visibleItems(source.awards.items, show) },
    testimonials: {
      ...source.testimonials,
      visitors: visibleItems(source.testimonials.visitors, show),
      storyVideo: visibleBlock(source.testimonials.storyVideo, show),
      stories: visibleItems(source.testimonials.stories, show)
    }
  };
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "2026-11-12" -> { month: "Nov", day: "12" } without Date parsing (no time-zone or locale dependence). */
export function splitIsoDate(iso: string | undefined): { month: string; day: string; year: string } | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? { month, day: m[3], year: m[1] } : null;
}

/** Display value of a statistic ("05", "₹1,00,000", "8 × 4 × 3 m"); `null` when it has no value. */
export function statDisplay(stat: StatItem): string | null {
  if (stat.text) return stat.text;
  if (stat.value === null) return null;
  if (stat.format === 'inr') return `₹${Math.round(stat.value).toLocaleString('en-IN')}`;
  const n = String(Math.round(stat.value));
  return stat.pad ? n.padStart(2, '0') : n;
}
