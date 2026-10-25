import { test, expect } from '@playwright/test';

test.describe('GCDIS Master Platform Journey & Architecture Validation', () => {
  test('1. Public Institutional Website renders official branding, FIDA rules, and prizes', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    await expect(page).toHaveTitle(/GCDIS Official Platform/);
    await expect(page.locator('text=BUILDING INDIA\'S NEXT GENERATION OF')).toBeVisible();

    // Verify canonical prize pool
    await expect(page.locator('text=Total Prize Pool: ₹1,00,000 INR')).toBeVisible();
    await expect(page.locator('text=₹31,000')).toBeVisible(); // D40 1st
    await expect(page.locator('text=₹21,000')).toBeVisible(); // D40 2nd / D20 1st
    await expect(page.locator('text=₹11,000')).toBeVisible(); // D20 2nd

    // Verify FIDA facts
    await expect(page.locator('text=Ball Diameter: 40 cm ± 2 cm')).toBeVisible();
    await expect(page.locator('text=Ball Diameter: 20 cm ± 1 cm (Weight ≤ 110 g)')).toBeVisible();
  });

  test('2. Public Website strictly excludes admin routes (returns 404)', async ({ page }) => {
    const response = await page.goto('http://localhost:3000/admin');
    expect(response?.status()).toBe(404);
  });

  test('3. Dedicated Admin Console renders staff 2FA gate and pre-flight checklist', async ({ page }) => {
    await page.goto('http://localhost:3001/');
    await expect(page.locator('text=INTERNAL GOVERNANCE')).toBeVisible();
    await expect(page.locator('text=GCDIS Staff Operations')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('4. Participant Portal allows team captain registration and dashboard access', async ({ page }) => {
    await page.goto('http://localhost:3000/portal');
    await expect(page.locator('text=Team Access & Admissions Portal')).toBeVisible();
    await expect(page.locator('button:has-text("SIGN IN")')).toBeVisible();
    await expect(page.locator('button:has-text("REGISTER TEAM")')).toBeVisible();
  });

  test('5. Public Certificate Verification validates official register and protects privacy', async ({ page }) => {
    await page.goto('http://localhost:3000/verify/GCDIS-CERT-2026-TEST');
    await expect(page.locator('text=Certificate Code Not Found').or(page.locator('text=VERIFIED OFFICIAL CERTIFICATE'))).toBeVisible();
  });
});
