import { PrismaClient } from '@prisma/client';
import {
  SITE_SETTING_KEYS,
  defaultGallerySection,
  defaultSiteInfo,
  defaultSponsorsSection
} from '../src/cms/site-content.defaults';
import { HOME_SECTION_KEYS, defaultHomeSectionContent, defaultHomeSortOrder } from '../src/cms/home-content.defaults';

const prisma = new PrismaClient();

async function main() {
  console.log('[GCDIS Data Seeder] Initializing canonical production baseline (purely additive & idempotent)...');

  // 1. Canonical Prizes (Source of truth: Rulebook & Directorate instructions)
  // Total Pool: 100,000 INR. D40 1st: 31,000; D40 2nd: 21,000; D20 1st: 21,000; D20 2nd: 11,000.
  // Remaining 16,000 is marked unconfirmed: "Needs input"
  const canonicalPrizes = [
    {
      category: 'D40',
      rank: 1,
      title: 'D40 First Place (Champion)',
      amount: 31000,
      currency: 'INR',
      isConfirmed: true,
      notes: 'Official Directorate Allocation'
    },
    {
      category: 'D40',
      rank: 2,
      title: 'D40 Second Place (Runner-up)',
      amount: 21000,
      currency: 'INR',
      isConfirmed: true,
      notes: 'Official Directorate Allocation'
    },
    {
      category: 'D20',
      rank: 1,
      title: 'D20 First Place (Champion)',
      amount: 21000,
      currency: 'INR',
      isConfirmed: true,
      notes: 'Official Directorate Allocation'
    },
    {
      category: 'D20',
      rank: 2,
      title: 'D20 Second Place (Runner-up)',
      amount: 11000,
      currency: 'INR',
      isConfirmed: true,
      notes: 'Official Directorate Allocation'
    },
    {
      category: 'UNALLOCATED',
      rank: null,
      title: 'Unallocated Prize Pool Remainder',
      amount: 16000,
      currency: 'INR',
      isConfirmed: false,
      notes: 'Needs input: Remaining prize pool allocation to be configured in Admin Console'
    }
  ];

  for (const prize of canonicalPrizes) {
    const existing = await prisma.prize.findFirst({
      where: {
        category: prize.category,
        rank: prize.rank
      }
    });

    if (existing) {
      await prisma.prize.update({
        where: { id: existing.id },
        data: {
          title: prize.title,
          amount: prize.amount,
          isConfirmed: prize.isConfirmed,
          notes: prize.notes
        }
      });
    } else {
      await prisma.prize.create({ data: prize });
    }
  }
  console.log('[GCDIS Data Seeder] Seeded canonical prizes (Total pool: 100,000 INR; 16,000 flagged Needs input).');

  // 2. Official Event and Categories (FIDA Canonical Truth)
  const event = await prisma.event.upsert({
    where: { slug: 'drone-soccer-2026' },
    update: {
      title: 'GCDIS National Drone Soccer Championship 2026',
      subtitle: 'Official Championship for Categories D20 and D40',
      description: 'Official National Drone Soccer Championship governed by FIDA technical regulations.'
    },
    create: {
      slug: 'drone-soccer-2026',
      title: 'GCDIS National Drone Soccer Championship 2026',
      subtitle: 'Official Championship for Categories D20 and D40',
      description: 'Official National Drone Soccer Championship governed by FIDA technical regulations.',
      startDate: new Date('2026-12-01T03:30:00Z'), // 1 Dec 2026, 09:00 IST
      endDate: new Date('2026-12-02T12:30:00Z'), // 2 Dec 2026, 18:00 IST
      venueName: 'Needs input',
      venueAddress: 'Needs input',
      status: 'UPCOMING'
    }
  });

  await prisma.category.upsert({
    where: { eventId_slug: { eventId: event.id, slug: 'd20' } },
    update: {
      name: 'Class 20 (D20) Drone Soccer',
      maxTeamSize: 7,
      rulesPdfUrl: 'https://dronesoccer.org/static/files/Rule-book-2.pdf',
      technicalSpecsSchema: {
        rulebook: 'FIDA Class 20 Rulebook, 5th Revision (1 October 2025)',
        rulebookUrl: 'https://dronesoccer.org/static/files/Rule-book-2.pdf',
        ballDiameter: '20 cm ± 1 cm',
        maxWeightGrams: 110,
        playersPerTeam: 5,
        droneBallsPerTeam: 5,
        strikersPerTeam: 2,
        maxRosterSize: 7,
        matchFormat: '3 sets of 3 minutes',
        scoringRule: 'A goal is scored only when a Striker passes completely through the opponent goal from front to back'
      }
    },
    create: {
      eventId: event.id,
      slug: 'd20',
      name: 'Class 20 (D20) Drone Soccer',
      minTeamSize: 5,
      maxTeamSize: 7,
      entryFee: 1500, // INR, GST-inclusive
      currency: 'INR',
      rulesPdfUrl: 'https://dronesoccer.org/static/files/Rule-book-2.pdf',
      isActive: true,
      technicalSpecsSchema: {
        rulebook: 'FIDA Class 20 Rulebook, 5th Revision (1 October 2025)',
        rulebookUrl: 'https://dronesoccer.org/static/files/Rule-book-2.pdf',
        ballDiameter: '20 cm ± 1 cm',
        maxWeightGrams: 110,
        playersPerTeam: 5,
        droneBallsPerTeam: 5,
        strikersPerTeam: 2,
        maxRosterSize: 7,
        matchFormat: '3 sets of 3 minutes',
        scoringRule: 'A goal is scored only when a Striker passes completely through the opponent goal from front to back'
      }
    }
  });

  await prisma.category.upsert({
    where: { eventId_slug: { eventId: event.id, slug: 'd40' } },
    update: {
      name: 'Class 40 (D40) Drone Soccer',
      maxTeamSize: 7,
      rulesPdfUrl: 'https://dronesoccer.org/static/files/Rule-book-1.pdf',
      technicalSpecsSchema: {
        rulebook: 'FIDA Class 40 Rulebook, 5th Revision (1 October 2025)',
        rulebookUrl: 'https://dronesoccer.org/static/files/Rule-book-1.pdf',
        ballDiameter: '40 cm ± 2 cm',
        maxWeightGrams: 1100,
        playersPerTeam: 5,
        droneBallsPerTeam: 5,
        strikersPerTeam: 1,
        maxRosterSize: 7,
        matchFormat: '3 sets of 3 minutes',
        scoringRule: 'A goal is scored only when the Striker passes completely through the opponent goal from front to back'
      }
    },
    create: {
      eventId: event.id,
      slug: 'd40',
      name: 'Class 40 (D40) Drone Soccer',
      minTeamSize: 5,
      maxTeamSize: 7,
      entryFee: 3500, // INR, GST-inclusive
      currency: 'INR',
      rulesPdfUrl: 'https://dronesoccer.org/static/files/Rule-book-1.pdf',
      isActive: true,
      technicalSpecsSchema: {
        rulebook: 'FIDA Class 40 Rulebook, 5th Revision (1 October 2025)',
        rulebookUrl: 'https://dronesoccer.org/static/files/Rule-book-1.pdf',
        ballDiameter: '40 cm ± 2 cm',
        maxWeightGrams: 1100,
        playersPerTeam: 5,
        droneBallsPerTeam: 5,
        strikersPerTeam: 1,
        maxRosterSize: 7,
        matchFormat: '3 sets of 3 minutes',
        scoringRule: 'A goal is scored only when the Striker passes completely through the opponent goal from front to back'
      }
    }
  });

  await prisma.arena.upsert({
    where: { code: 'ARENA-A' },
    update: {},
    create: {
      eventId: event.id,
      name: 'Arena Alpha (Net Enclosure 1)',
      code: 'ARENA-A',
      description: 'Netted arena, 12 m x 6 m x 5 m (within the FIDA Class 40 field range)'
    }
  });

  await prisma.arena.upsert({
    where: { code: 'ARENA-B' },
    update: {},
    create: {
      eventId: event.id,
      name: 'Arena Beta (Net Enclosure 2)',
      code: 'ARENA-B',
      description: 'Netted arena, 12 m x 6 m x 5 m (within the FIDA Class 40 field range)'
    }
  });
  console.log('[GCDIS Data Seeder] Seeded canonical event, categories (D20, D40), and competition arenas.');

  // 3. Official FIDA Rules Facts & Site Settings (No placeholder data)
  const settings = [
    {
      key: 'prize_pool_total',
      value: { amount: 100000, currency: 'INR' },
      description: 'Total Championship Prize Pool'
    },
    {
      key: 'fida_rules_d40',
      value: {
        category: 'D40',
        edition: 'Class 40 Rulebook, 5th Revision (1 October 2025)',
        source: 'Federation of International Dronesoccer Association (FIDA)',
        officialUrl: 'https://dronesoccer.org/static/files/Rule-book-1.pdf',
        ballDiameter: '40 cm ± 2 cm',
        teamComposition: '5 players and 5 drone balls per team; one Striker; roster of up to 7 including up to 3 coaches',
        matchFormat: '3 sets of 3 minutes',
        scoringRule: 'A goal is scored only when the Striker passes completely through the opponent goal from front to back'
      },
      description: 'FIDA Official Class 40 (D40) Rules Summary'
    },
    {
      key: 'fida_rules_d20',
      value: {
        category: 'D20',
        edition: 'Class 20 Rulebook, 5th Revision (1 October 2025)',
        source: 'Federation of International Dronesoccer Association (FIDA)',
        officialUrl: 'https://dronesoccer.org/static/files/Rule-book-2.pdf',
        ballDiameter: '20 cm ± 1 cm',
        maxWeightGrams: 110,
        teamComposition: '5 players and 5 drone balls per team; two Strikers; roster of up to 7 including up to 3 coaches',
        matchFormat: '3 sets of 3 minutes',
        scoringRule: 'A goal is scored only when a Striker passes completely through the opponent goal from front to back'
      },
      description: 'FIDA Official Class 20 (D20) Rules Summary'
    },
    {
      key: 'event_config_checklist',
      value: {
        eventDates: 'Needs input',
        venueName: 'Needs input',
        venueAddress: 'Needs input',
        entryFeeD20: 'INR 1,500 (incl. GST)',
        entryFeeD40: 'INR 3,500 (incl. GST)',
        gstPercentage: 18,
        sponsorsConfigured: false
      },
      description: 'Pre-flight operational readiness checklist'
    }
  ];

  for (const s of settings) {
    await prisma.siteSetting.upsert({
      where: { key: s.key },
      update: { value: s.value, description: s.description },
      create: { key: s.key, value: s.value, description: s.description }
    });
  }
  console.log('[GCDIS Data Seeder] Seeded FIDA official rulebook facts and site settings.');

  // 3b. Public site content settings (site information, sponsors and gallery sections).
  // Create-only: values edited in the staff console are never overwritten by re-seeding.
  const siteContentSettings = [
    {
      key: SITE_SETTING_KEYS.siteInfo,
      value: defaultSiteInfo(),
      description: 'Public site organisation and contact information'
    },
    {
      key: SITE_SETTING_KEYS.sponsorsSection,
      value: defaultSponsorsSection(),
      description: 'Sponsors section display settings'
    },
    {
      key: SITE_SETTING_KEYS.gallerySection,
      value: defaultGallerySection(),
      description: 'Gallery section display settings'
    }
  ];
  for (const s of siteContentSettings) {
    await prisma.siteSetting.upsert({
      where: { key: s.key },
      update: {},
      create: { key: s.key, value: s.value as any, description: s.description }
    });
  }
  console.log('[GCDIS Data Seeder] Ensured site information, sponsors and gallery section settings.');

  // 3c. Home page sections (content of the public home page, edited under "Home Page Sections").
  // Create-only: sections edited in the staff console are never overwritten by re-seeding. Sample entries
  // carry `placeholder: true` and are hidden in production until replaced with facts.
  for (const key of HOME_SECTION_KEYS) {
    await prisma.homeSection.upsert({
      where: { key },
      update: {},
      create: { key, enabled: true, sortOrder: defaultHomeSortOrder(key), content: defaultHomeSectionContent(key) as any }
    });
  }
  console.log('[GCDIS Data Seeder] Ensured home page sections.');

  // 4. Default Hero Content Section with No-Code Customization Controls
  await prisma.contentSection.upsert({
    where: { key: 'hero' },
    update: {},
    create: {
      key: 'hero',
      title: "BUILDING INDIA'S NEXT GENERATION OF DRONE INNOVATORS",
      subtitle: 'INNOVATION • TECHNOLOGY • EXCELLENCE',
      data: {
        headline: "BUILDING INDIA'S NEXT GENERATION OF DRONE INNOVATORS",
        tagline: 'INNOVATION • TECHNOLOGY • EXCELLENCE',
        description: 'The Galgotias Centre for Drone Intelligence & Simulation (GCDIS) at Galgotias University supports research and training in autonomous aerial robotics and flight simulation, and organises the Drone Soccer Championship 2026.',
        announcementTitle: 'DOUBT SESSION 2 & DRONE SOCCER 2026',
        announcementDate: 'OCTOBER 05, 2026',
        announcementBody: 'Doubt Session 2 will be announced shortly. Registered teams may submit technical queries through the Doubt Session 2 section of the team dashboard. Registration for the Class 20 and Class 40 categories is open.',
        background: {
          mediaUrl: '',
          mediaType: 'color', // 'image' | 'video' | 'color'
          focusX: 50,
          focusY: 50,
          zoom: 100,
          overlayColor: '#111827',
          overlayOpacity: 0.85,
          blurPx: 0,
          brightnessPct: 100,
          parallaxEnabled: false,
          mobileCropFocusY: 50
        }
      },
      isPublished: true,
      publishedAt: new Date()
    }
  });

  console.log('[GCDIS Data Seeder] Purely additive & idempotent baseline seeding completed successfully.');
  console.log('[GCDIS Data Seeder] Notice: To provision the initial Super Admin, run: npm run db:bootstrap-admin');
}

main()
  .catch((e) => {
    console.error('[GCDIS Data Seeder Error]', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
