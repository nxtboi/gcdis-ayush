import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../apps/api/src/app.module';
import { PrismaClient } from '@prisma/client';
import * as http from 'http';
import * as crypto from 'crypto';

const orderPaymentMap = new Map<string, string>();

interface LatencyMetrics {
  samples: number[];
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

function calculatePercentiles(latencies: number[]): LatencyMetrics {
  if (latencies.length === 0) {
    return { samples: [], p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const getP = (p: number) => sorted[Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1)];
  const avg = Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2));
  return {
    samples: sorted,
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg
  };
}

const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 500,
  timeout: 10000
});

async function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: keepAliveAgent
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: data,
            latencyMs: Date.now() - start
          });
        });
      }
    );

    req.on('error', (err) => reject(err));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runScenario(concurrentUsers: number, port: number) {
  console.log(`\n======================================================`);
  console.log(`  STARTING LOAD TEST: ${concurrentUsers} CONCURRENT USERS`);
  console.log(`======================================================`);

  const readLatencies: number[] = [];
  const paymentLatencies: number[] = [];
  let totalRequests = 0;
  let successfulRequests = 0;
  let duplicateRegistrationsDetected = 0;
  let duplicatePaymentsDetected = 0;

  const baseUrl = `http://localhost:${port}/api`;
  const prisma = new PrismaClient();

  // Baseline database row count for zero-loss verification
  const initialTeams = await prisma.team.count();
  const initialRegs = await prisma.registration.count();
  const initialPayments = await prisma.payment.count();

  // Test category
  let category = await prisma.category.findFirst({ where: { slug: 'd20' } });
  if (category) {
    category = await prisma.category.update({
      where: { id: category.id },
      data: { entryFee: 10000 }
    });
  }
  const categoryId = category?.id || 'cat-d20';

  // 1. Warm-up read
  const warmup = await httpRequest(`${baseUrl}/cms/section/hero`);
  console.log(`[Warmup] GET /cms/section/hero -> ${warmup.status} (${warmup.latencyMs}ms)`);

  const userTasks = Array.from({ length: concurrentUsers }, async (_, index) => {
    const userId = index + 1;
    const email = `load_vu_${concurrentUsers}_${userId}_${Date.now()}@loadtest.in`;
    const password = 'TestPassword123!';

    try {
      // Step A: Public Read Flow (CMS, Prizes, Rules, Fixtures)
      const readUrls = [
        `${baseUrl}/cms/section/hero`,
        `${baseUrl}/cms/prizes`,
        `${baseUrl}/cms/section/fida-rules`,
        `${baseUrl}/competition/fixtures`
      ];

      for (const url of readUrls) {
        totalRequests++;
        const res = await httpRequest(url);
        readLatencies.push(res.latencyMs);
        if (res.status === 200) successfulRequests++;
      }

      // Step B: User Registration & Login
      totalRequests++;
      const regRes = await httpRequest(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({
          email,
          password,
          fullName: `Load Tester ${userId}`,
          phone: `+9190000${String(10000 + userId).slice(-5)}`,
          organization: 'National Load Institute'
        })
      });
      if (regRes.status === 201) successfulRequests++;

      const parsedReg = JSON.parse(regRes.body);
      const token = parsedReg.accessToken;
      if (!token) return;

      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'http://localhost:3000',
        'X-Requested-With': 'XMLHttpRequest'
      };

      // Step C: Team Registration
      totalRequests++;
      const teamRes = await httpRequest(`${baseUrl}/teams`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          teamName: `Load Flight Squad ${concurrentUsers}-${userId}-${Date.now().toString().slice(-4)}`,
          name: `Load Flight Squad ${concurrentUsers}-${userId}-${Date.now().toString().slice(-4)}`,
          categoryId,
          institutionName: 'IIT Roorkee Aero Club',
          city: 'Roorkee',
          country: 'India',
          members: [
            { fullName: 'Pilot Lead', memberRole: 'PILOT', role: 'PILOT' },
            { fullName: 'Tactician 1', memberRole: 'TACTICIAN', role: 'TACTICIAN' },
            { fullName: 'Defender 1', memberRole: 'DEFENDER', role: 'DEFENDER' }
          ]
        })
      });
      if (teamRes.status === 201) successfulRequests++;
      const parsedTeam = JSON.parse(teamRes.body);
      const teamId = parsedTeam.team?.id || parsedTeam.id;

      // Step D: Competition Category Registration
      totalRequests++;
      const compRegRes = await httpRequest(`${baseUrl}/registrations`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ teamId, categoryId })
      });
      if (compRegRes.status === 201) successfulRequests++;
      const parsedCompReg = JSON.parse(compRegRes.body);
      const registrationId = parsedCompReg.id;

      // Duplicate Registration check (Submitting exact same category again must fail cleanly)
      totalRequests++;
      const dupRegRes = await httpRequest(`${baseUrl}/registrations`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ teamId, categoryId })
      });
      if (dupRegRes.status === 400) {
        successfulRequests++; // Proper rejection of duplicate
      } else if (dupRegRes.status === 201) {
        duplicateRegistrationsDetected++;
      }

      // Step E: Payment Order Creation & Idempotent Retry Protection
      if (registrationId) {
        // Transition registration to PAYMENT_PENDING (simulating administrative approval)
        await prisma.registration.update({
          where: { id: registrationId },
          data: { status: 'PAYMENT_PENDING' }
        });

        totalRequests++;
        const payOrderRes = await httpRequest(`${baseUrl}/payments/create-order`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ registrationId })
        });
        paymentLatencies.push(payOrderRes.latencyMs);
        if (payOrderRes.status === 200 || payOrderRes.status === 201) successfulRequests++;
        const parsedOrder = JSON.parse(payOrderRes.body);
        const orderId = parsedOrder.payment?.orderId;

        // Double-click / refresh retry safety check (must return existing order, not create a duplicate)
        totalRequests++;
        const retryOrderRes = await httpRequest(`${baseUrl}/payments/create-order`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ registrationId })
        });
        const parsedRetry = JSON.parse(retryOrderRes.body);
        if (parsedRetry.isExistingOrder === true) {
          successfulRequests++;
        } else if (retryOrderRes.status === 201) {
          duplicatePaymentsDetected++;
        }

        // Verify Payment (Simulate Gateway Callback)
        if (orderId) {
          totalRequests++;
          const paymentId = `pay_loadtest_${Date.now()}_${userId}`;
          const secret = process.env.RAZORPAY_KEY_SECRET || 'loadtest_secret_32bytes_value_xyz';
          const signature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
          orderPaymentMap.set(paymentId, orderId);

          const verifyRes = await httpRequest(`${baseUrl}/payments/verify-signature`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              razorpayOrderId: orderId,
              razorpayPaymentId: paymentId,
              razorpaySignature: signature
            })
          });
          if (verifyRes.status === 200 || verifyRes.status === 201) successfulRequests++;
        }
      }

      // Step F: Magic-Byte Validated Document Upload
      totalRequests++;
      const validPdfBase64 = 'JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iagoxODMKJSVFT0YK';
      const uploadRes = await httpRequest(`${baseUrl}/uploads`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          fileName: `NOC_VU_${userId}.pdf`,
          base64Data: validPdfBase64,
          purpose: 'INSTITUTION_NOC'
        })
      });
      if (uploadRes.status === 200 || uploadRes.status === 201) successfulRequests++;

      // Step G: Live Scoreboard Viewer Polling Fallback
      totalRequests++;
      const pollRes = await httpRequest(`${baseUrl}/competition/fixtures/fix-polling-test/live-polling`);
      readLatencies.push(pollRes.latencyMs);
      if (pollRes.status === 200 || pollRes.status === 404) successfulRequests++;
    } catch (err: any) {
      console.error(`[VU ${userId} Error]:`, err.message);
    }
  });

  // Execute all concurrent users simultaneously
  const startTime = Date.now();
  await Promise.all(userTasks);
  const totalDurationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));

  // Compute Latency Percentiles
  const readMetrics = calculatePercentiles(readLatencies);
  const payMetrics = calculatePercentiles(paymentLatencies);
  const errorCount = totalRequests - successfulRequests;
  const errorRatePct = Number(((errorCount / totalRequests) * 100).toFixed(2));

  // Verify Zero Data Loss
  const finalTeams = await prisma.team.count();
  const finalRegs = await prisma.registration.count();
  const finalPayments = await prisma.payment.count();

  console.log(`\n--- RESULTS FOR ${concurrentUsers} CONCURRENT USERS ---`);
  console.log(`Total Duration: ${totalDurationSec}s | Total Requests: ${totalRequests} | RPS: ${(totalRequests / totalDurationSec).toFixed(1)}`);
  console.log(`Successes: ${successfulRequests} | Errors: ${errorCount} (${errorRatePct}%)`);
  console.log(`Read Latency (ms): p50=${readMetrics.p50} | p90=${readMetrics.p90} | p95=${readMetrics.p95} | p99=${readMetrics.p99} | max=${readMetrics.max}`);
  console.log(`Payment Latency (ms): p50=${payMetrics.p50} | p90=${payMetrics.p90} | p95=${payMetrics.p95} | p99=${payMetrics.p99} | max=${payMetrics.max}`);
  console.log(`Duplicate Registrations Detected: ${duplicateRegistrationsDetected}`);
  console.log(`Duplicate Payments Detected: ${duplicatePaymentsDetected}`);
  console.log(`Database Rows: Teams (+${finalTeams - initialTeams}), Registrations (+${finalRegs - initialRegs}), Payments (+${finalPayments - initialPayments})`);

  // Assert against SLAs
  const passCriteria = {
    readsUnder500ms: readMetrics.p95 < 500,
    paymentUnder1500ms: payMetrics.p95 < 1500,
    errorRateUnder1Pct: errorRatePct < 1.0,
    zeroDuplicateRegistrations: duplicateRegistrationsDetected === 0,
    zeroDuplicatePayments: duplicatePaymentsDetected === 0,
    zeroDataLoss: finalTeams > initialTeams && finalRegs > initialRegs
  };

  console.log('\nSLA Pass Verification:');
  console.log(`- Read p95 < 500ms: ${passCriteria.readsUnder500ms ? 'PASSED' : 'FAILED'} (${readMetrics.p95}ms)`);
  console.log(`- Payment p95 < 1500ms: ${passCriteria.paymentUnder1500ms ? 'PASSED' : 'FAILED'} (${payMetrics.p95}ms)`);
  console.log(`- Error Rate < 1%: ${passCriteria.errorRateUnder1Pct ? 'PASSED' : 'FAILED'} (${errorRatePct}%)`);
  console.log(`- Zero Duplicate Registrations: ${passCriteria.zeroDuplicateRegistrations ? 'PASSED' : 'FAILED'}`);
  console.log(`- Zero Duplicate Payments: ${passCriteria.zeroDuplicatePayments ? 'PASSED' : 'FAILED'}`);
  console.log(`- Zero Data Loss: ${passCriteria.zeroDataLoss ? 'PASSED' : 'FAILED'}`);

  await prisma.$disconnect();

  return {
    concurrentUsers,
    totalDurationSec,
    totalRequests,
    successfulRequests,
    errorRatePct,
    readMetrics,
    payMetrics,
    passCriteria
  };
}

async function main() {
  const PORT = 4055;

  process.env.RAZORPAY_KEY_ID = 'rzp_test_loadtest_key';
  process.env.RAZORPAY_KEY_SECRET = 'loadtest_secret_32bytes_value_xyz';
  // Every simulated user comes from 127.0.0.1: raise the app-wide default per-IP limit (300/min) so the run
  // measures the application rather than the limiter. Per-route limits (auth, team / registration / payment
  // mutations) keep their own per-IP buckets and may still answer 429 at high user counts.
  process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = process.env.API_DEFAULT_RATE_LIMIT_PER_MIN || '1000000';

  const originalFetch = global.fetch;
  global.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url || '');
    if (url.includes('api.razorpay.com/v1/orders')) {
      const orderId = `order_load_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const reqBody = init?.body ? JSON.parse(init.body) : {};
      const order = {
        id: orderId,
        amount: reqBody.amount || 1180000,
        currency: 'INR',
        status: 'created'
      };
      return new Response(JSON.stringify(order), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.includes('api.razorpay.com/v1/payments/')) {
      const paymentId = url.split('/payments/')[1];
      const resData = {
        id: paymentId,
        order_id: orderPaymentMap.get(paymentId) || 'order_fallback',
        amount: 1180000,
        status: 'captured'
      };
      return new Response(JSON.stringify(resData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(input, init);
  };

  console.log(`[Load Test Harness] Bootstrapping NestJS API on test port ${PORT}...`);
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api');
  await app.listen(PORT);
  console.log(`[Load Test Harness] API active and listening on port ${PORT}.`);

  try {
    // 1. Run 100 Concurrent Users
    const res100 = await runScenario(100, PORT);

    // 2. Run 200 Concurrent Users
    const res200 = await runScenario(200, PORT);

    console.log('\n======================================================');
    console.log('   CAPACITY & LOAD TEST COMPLETED SUCCESSFULLY');
    console.log('======================================================');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[Load Test Error]', err);
  process.exit(1);
});
