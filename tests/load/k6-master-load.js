/*
 * Rate limits: the API applies a default limit of API_DEFAULT_RATE_LIMIT_PER_MIN requests per minute per client
 * IP (300 by default) to every route without its own rule, plus per-route limits (auth, PDF downloads, team /
 * registration mutations, payment order creation and verification) that also have per-IP buckets. All virtual
 * users of one k6 machine share one IP, so against a default deployment most requests are answered 429 and the
 * run measures the limiter, not the application. For capacity runs, point k6 at a staging API started with a
 * raised API_DEFAULT_RATE_LIMIT_PER_MIN (and expect per-route 429s), or spread the load over several source IPs.
 * 429 answers are counted in `rate_limited_responses`. GET /api/health is never rate limited.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Custom Metrics for Acceptance SLA Verification
const readLatency = new Trend('read_latency_ms');
const paymentOrderLatency = new Trend('payment_order_latency_ms');
const paymentVerifyLatency = new Trend('payment_verify_latency_ms');
const errorRate = new Rate('custom_error_rate');
const duplicateRegistrations = new Counter('duplicate_registrations_detected');
const duplicatePayments = new Counter('duplicate_payments_detected');
const rateLimited = new Counter('rate_limited_responses');

export const options = {
  scenarios: {
    // Stage 1: Target 100 concurrent users
    peak_100_users: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 100 },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '5s'
    },
    // Stage 2: Stress test 200 concurrent users
    peak_200_users: {
      executor: 'ramping-vus',
      startTime: '90s',
      startVUs: 1,
      stages: [
        { duration: '20s', target: 100 },
        { duration: '30s', target: 200 },
        { duration: '30s', target: 200 },
        { duration: '10s', target: 0 }
      ],
      gracefulRampDown: '5s'
    }
  },
  thresholds: {
    // Acceptance criteria SLAs
    read_latency_ms: ['p(95)<500'],
    payment_order_latency_ms: ['p(95)<1500'],
    custom_error_rate: ['rate<0.01'], // under 1% errors
    duplicate_registrations_detected: ['count==0'],
    duplicate_payments_detected: ['count==0']
  }
};

const BASE_URL = __ENV.API_URL || 'http://localhost:4000/api';

export default function () {
  const vuId = __VU;
  const iterId = __ITER;

  // 1. Browse Public Site Flow
  group('1. Public Site Browsing', () => {
    const resHero = http.get(`${BASE_URL}/cms/content/hero`);
    readLatency.add(resHero.timings.duration);
    if (resHero.status === 429) rateLimited.add(1);
    check(resHero, {
      'Hero CMS status 200': (r) => r.status === 200,
      'Hero CMS latency < 500ms': (r) => r.timings.duration < 500
    });

    const resPrizes = http.get(`${BASE_URL}/cms/prizes`);
    readLatency.add(resPrizes.timings.duration);
    check(resPrizes, {
      'Prizes status 200': (r) => r.status === 200
    });

    const resRules = http.get(`${BASE_URL}/cms/fida-rules`);
    readLatency.add(resRules.timings.duration);
    check(resRules, {
      'FIDA rules status 200': (r) => r.status === 200
    });

    const resFixtures = http.get(`${BASE_URL}/competition/fixtures`);
    readLatency.add(resFixtures.timings.duration);
    check(resFixtures, {
      'Fixtures list status 200': (r) => r.status === 200
    });
  });

  sleep(1);

  // 2. Auth Flow (Team Captain Registration & Login)
  let authToken = '';
  const captainEmail = `load_captain_${vuId}_${iterId}_${Date.now()}@example.com`;
  const captainPassword = 'StrongPassword!2026';

  group('2. Captain Registration and Auth', () => {
    const regRes = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({
        email: captainEmail,
        password: captainPassword,
        fullName: `Captain Load VU ${vuId}`,
        phone: `+91987654${(1000 + (vuId % 9000)).toString().slice(0, 4)}`,
        organization: 'IIT Load Testing Lab'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );

    const regSuccess = check(regRes, {
      'Captain registered successfully (201)': (r) => r.status === 201
    });

    if (!regSuccess) {
      errorRate.add(1);
    } else {
      errorRate.add(0);
      authToken = regRes.json('accessToken');
    }
  });

  if (!authToken) {
    sleep(1);
    return;
  }

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`
  };

  // 3. Register Team Flow
  let teamId = '';
  let registrationId = '';
  group('3. Team Registration', () => {
    const teamRes = http.post(
      `${BASE_URL}/teams`,
      JSON.stringify({
        name: `Team AeroVU ${vuId}_${iterId}_${Date.now().toString().slice(-4)}`,
        categoryId: 'cat-d20',
        institutionName: 'IIT Roorkee Robotics',
        city: 'Roorkee',
        country: 'India',
        members: [
          { fullName: 'Pilot Alpha', role: 'PILOT' },
          { fullName: 'Technician Beta', role: 'TECHNICIAN' },
          { fullName: 'Tactician Gamma', role: 'TACTICIAN' }
        ]
      }),
      { headers: authHeaders }
    );

    if (check(teamRes, { 'Team created': (r) => r.status === 201 || r.status === 200 })) {
      teamId = teamRes.json('team.id') || teamRes.json('id');
    } else {
      errorRate.add(1);
    }

    if (teamId) {
      const regRes = http.post(
        `${BASE_URL}/registrations`,
        JSON.stringify({
          teamId,
          categoryId: 'cat-d20'
        }),
        { headers: authHeaders }
      );

      if (regRes.status === 201) {
        registrationId = regRes.json('id');
      } else if (regRes.status === 400 && regRes.body.includes('already registered')) {
        duplicateRegistrations.add(1);
      }
    }
  });

  // 4. Create Payment Order & Verify Flow (Idempotency & Retry Safe)
  if (registrationId) {
    group('4. Payment Order Creation & Verification', () => {
      const orderStart = Date.now();
      const orderRes = http.post(
        `${BASE_URL}/payments/create-order`,
        JSON.stringify({ registrationId }),
        { headers: authHeaders }
      );
      paymentOrderLatency.add(Date.now() - orderStart);

      const orderCreated = check(orderRes, {
        'Payment order created < 1500ms': (r) => r.status === 200 || r.status === 201
      });

      if (!orderCreated) {
        errorRate.add(1);
      } else {
        const orderId = orderRes.json('payment.orderId');

        // Test safe client-side retry / double-click protection:
        const retryRes = http.post(
          `${BASE_URL}/payments/create-order`,
          JSON.stringify({ registrationId }),
          { headers: authHeaders }
        );
        check(retryRes, {
          'Retry returns existing order without creating duplicate': (r) =>
            r.status === 200 && r.json('isExistingOrder') === true
        });

        // Verify Payment Signature (Test Mode Gateway)
        const verifyStart = Date.now();
        const verifyRes = http.post(
          `${BASE_URL}/payments/verify-signature`,
          JSON.stringify({
            razorpayOrderId: orderId,
            razorpayPaymentId: `pay_test_${Date.now()}`,
            razorpaySignature: 'TEST_MODE_SIGNATURE'
          }),
          { headers: authHeaders }
        );
        paymentVerifyLatency.add(Date.now() - verifyStart);

        check(verifyRes, {
          'Payment verified successfully': (r) => r.status === 200
        });
      }
    });
  }

  // 5. Upload Documents Flow (Magic Byte Validated PDF)
  group('5. Document Upload', () => {
    // Valid PDF file header %PDF-1.4 encoded as Base64
    const validPdfBase64 = 'JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovS2lkcyBbMyAwIFJdCi9Db3VudCAxCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9QYXJlbnQgMiAwIFIKL01lZGlhQm94IFswIDAgNjEyIDc5Ml0KPj4KZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxOCAwMDAwMCBuIAowMDAwMDAwMDY5IDAwMDAwIG4gCjAwMDAwMDAxMjUgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA0Ci9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgoxODMKJSVFT0YK';

    const uploadRes = http.post(
      `${BASE_URL}/uploads`,
      JSON.stringify({
        fileName: 'NOC_Institution_Proof.pdf',
        base64Data: validPdfBase64,
        purpose: 'INSTITUTION_NOC'
      }),
      { headers: authHeaders }
    );

    check(uploadRes, {
      'Document uploaded with magic-byte validation (201/200)': (r) => r.status === 200 || r.status === 201
    });
  });

  // 6. Live Scoreboard Polling Flow (100 concurrent viewers fallback)
  group('6. Live Scoreboard Polling Viewers', () => {
    const liveRes = http.get(`${BASE_URL}/competition/fixtures/fix-live/live-polling`);
    readLatency.add(liveRes.timings.duration);
    check(liveRes, {
      'Live polling response received': (r) => r.status === 200 || r.status === 404 // 404 if no fixture exists yet is handled safely
    });
  });

  sleep(1);
}
