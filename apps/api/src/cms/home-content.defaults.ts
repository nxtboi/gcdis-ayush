/**
 * Home page sections: keys, labels and the default content (no Nest / Prisma imports: also used by
 * prisma/seed.ts and the tests).
 *
 * The defaults mirror `HOME_CONTENT` in apps/web/src/lib/home-content.ts (the web app's offline fallback) plus
 * the hero details and ticker that used to be hard-coded in components/home/PublicHomePage.tsx. Entries marked
 * `placeholder: true` are examples awaiting facts from the Centre: they are shown outside production only and
 * are badged "Sample — replace" in the staff console. No fact is invented here.
 */

/** Every home page section, in the default page order. */
export const HOME_SECTION_KEYS = [
  'hero',
  'ticker',
  'partners',
  'about',
  'mission',
  'centres',
  'programmes',
  'marquee',
  'mous',
  'services',
  'news',
  'awards',
  'testimonials',
  'footer'
] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

/**
 * Sections fixed in place: the hero and its ticker always open the page and the footer always closes it.
 * The hero and the footer cannot be hidden either (the ticker can).
 */
export const PINNED_HOME_SECTIONS: readonly HomeSectionKey[] = ['hero', 'ticker', 'footer'];
export const ALWAYS_ENABLED_HOME_SECTIONS: readonly HomeSectionKey[] = ['hero', 'footer'];
/** Sections staff can reorder (the body of the page between the ticker and the footer). */
export const ORDERABLE_HOME_SECTIONS: readonly HomeSectionKey[] = HOME_SECTION_KEYS.filter(
  (k) => !PINNED_HOME_SECTIONS.includes(k)
);

export const HOME_SECTION_LABELS: Readonly<Record<HomeSectionKey, string>> = Object.freeze({
  hero: 'Hero details',
  ticker: 'News ticker',
  partners: 'Industry partners strip',
  about: 'About us',
  mission: 'Mission, vision and values',
  centres: 'Centres of excellence',
  programmes: 'Training programmes',
  marquee: 'Training areas band',
  mous: 'MoUs and associate partners',
  services: 'Services',
  news: 'News and events',
  awards: 'Awards and gallery mosaic',
  testimonials: 'Visitors and success stories',
  footer: 'Footer'
});

/** Element id of each section on the page (navbar and footer anchors); null when it has none. */
export const HOME_SECTION_ANCHORS: Readonly<Record<HomeSectionKey, string | null>> = Object.freeze({
  hero: null,
  ticker: null,
  partners: 'partners',
  about: 'about',
  mission: 'mission',
  centres: 'centres',
  programmes: 'programmes',
  marquee: null,
  mous: 'mous',
  services: 'services',
  news: 'news',
  awards: 'awards',
  testimonials: 'testimonials',
  footer: 'contact'
});

/** Icons available to content entries (mapped to lucide icons by the web app). */
export const HOME_ICON_KEYS = [
  'map',
  'scan',
  'wrench',
  'monitor',
  'sprout',
  'briefcase',
  'building',
  'target',
  'eye',
  'gem',
  'trophy',
  'ruler',
  'calendar',
  'layers',
  'graduation'
] as const;

export const SERVICE_TONES = ['dark', 'featured', 'light', 'lime'] as const;
export const NEWS_CATEGORIES = ['event', 'workshop', 'news', 'visit'] as const;

const CHAMPIONSHIP_NAME = 'Drone Soccer Championship 2026';
const CHAMPIONSHIP_PATH = '/events/drone-soccer-2026';

export const DEFAULT_HOME_CONTENT: Readonly<Record<HomeSectionKey, Record<string, unknown>>> = Object.freeze({
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
      { id: 'prize-pool', value: 100000, format: 'inr', label: 'Championship prize pool', ring: 85, icon: 'trophy' },
      { id: 'classes', value: 2, pad: true, label: 'Championship classes, Class 20 and Class 40', ring: 50, icon: 'layers' },
      { id: 'days', value: 2, pad: true, label: 'Days of competition, 1 and 2 December 2026', ring: 50, icon: 'calendar' },
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
          { title: 'Autonomous systems', body: 'Advancing autonomous flight, perception and navigation through simulation-first development.' },
          { title: 'Aerospace engineering', body: 'Strengthening design, prototyping and testing capability for unmanned aircraft.' },
          { title: 'National reach', body: 'Serving students, institutions and industry across India through training, services and competitions.' }
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
      { id: 'uav-design', code: 'CoE 01', title: 'UAV design & prototyping', focus: ['Airframes', 'Propulsion', 'Fabrication'], category: 'design', imageUrl: null, imagePosition: '30% 70%' },
      { id: 'simulation', code: 'CoE 02', title: 'Simulation: ROS 2 · PX4 · Gazebo', focus: ['ROS 2', 'PX4', 'Gazebo'], category: 'simulation', imageUrl: null, imagePosition: '80% 40%' },
      { id: 'autonomy', code: 'CoE 03', title: 'Autonomous systems & AI/ML', focus: ['Autonomy', 'Perception', 'Machine learning'], category: 'autonomy', imageUrl: null, imagePosition: '55% 30%' },
      { id: 'flight-arena', code: 'CoE 04', title: 'Drone flight arena', focus: ['Netted 8 × 4 × 3 m arena'], category: 'flight', imageUrl: null, imagePosition: '60% 90%' },
      { id: 'robotics', code: 'CoE 05', title: 'Robotics, vision & navigation', focus: ['Robotics', 'Machine vision', 'Navigation'], category: 'autonomy', imageUrl: null, imagePosition: '10% 50%' }
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

  mous: {
    heading: 'Associate partners & MoUs',
    subheading: 'Signed memoranda of understanding',
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
      { id: 'survey-mapping', title: 'Survey & mapping', icon: 'map', tone: 'dark', bullets: ['Aerial photogrammetry', 'Orthomosaics and contours', '3D site models'] },
      {
        id: 'inspection-monitoring',
        title: 'Inspection & monitoring',
        icon: 'scan',
        tone: 'featured',
        lead: 'Visual and thermal inspection of structures, solar arrays and facilities.',
        bullets: ['Structures and facilities', 'Solar arrays', 'Visual and thermal imaging'],
        highlights: { placeholder: true, items: ['Turnaround: 3–5 days', 'Report: PDF and data'] }
      },
      { id: 'design-manufacturing', title: 'Design & manufacturing', icon: 'wrench', tone: 'dark', bullets: ['Custom airframes', 'Payload integration', '3D printing and prototyping'] },
      { id: 'simulation-testing', title: 'Simulation & testing', icon: 'monitor', tone: 'light', bullets: ['Software-in-the-loop', 'Hardware-in-the-loop', 'Flight data analysis'] },
      { id: 'agricultural-drones', title: 'Agricultural drones', icon: 'sprout', tone: 'dark', bullets: ['Crop health monitoring', 'Precision spraying trials', 'Farmer awareness programmes'] },
      { id: 'consultancy', title: 'Consultancy', icon: 'briefcase', tone: 'lime', bullets: ['Drone programme planning', 'Laboratory set-up guidance', 'Training needs assessment'] }
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
      startsAt: '2026-12-01T09:00:00+05:30',
      endsAt: '2026-12-02T18:00:00+05:30',
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
    items: [
      { id: 'award-1', placeholder: true, badge: 'Award · Year', title: 'Award or placement title', detail: 'Event and organiser, shown once verified', imageUrl: null },
      { id: 'award-2', placeholder: true, badge: 'Competition · Year', title: 'Competition title', detail: 'Placement and team', imageUrl: null },
      { id: 'award-3', placeholder: true, badge: 'Recognition · Year', title: 'Recognition title', detail: 'Photo and citation', imageUrl: null },
      { id: 'award-4', placeholder: true, badge: 'Research · Year', title: 'Research or patent recognition', detail: 'Title and inventors', imageUrl: null }
    ]
  },

  testimonials: {
    visitorsHeading: 'Visitors speak',
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
});

/** Fresh deep copy of one section's default content (callers may mutate). */
export function defaultHomeSectionContent(key: HomeSectionKey): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_HOME_CONTENT[key]));
}

/** Default sortOrder of each section (its position in HOME_SECTION_KEYS, in steps of 10). */
export function defaultHomeSortOrder(key: HomeSectionKey): number {
  return HOME_SECTION_KEYS.indexOf(key) * 10;
}

export function isHomeSectionKey(value: unknown): value is HomeSectionKey {
  return typeof value === 'string' && (HOME_SECTION_KEYS as readonly string[]).includes(value);
}
