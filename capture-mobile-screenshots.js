const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const CREDENTIALS = {
  email: 'darrel.liew.jh@gmail.com',
  password: 'Darrel556'
};

// Common mobile viewport sizes
const MOBILE_VIEWPORT = { width: 390, height: 844 }; // iPhone 14 Pro

async function captureMobileScreenshots() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  console.log('Starting MOBILE screenshot capture...\n');
  console.log(`Viewport: ${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height} (iPhone 14 Pro)\n`);

  try {
    // 1. Login page (before logging in)
    console.log('1. Capturing login page (mobile)...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshots/mobile-01-login.png', fullPage: false });
    console.log('   Saved: screenshots/mobile-01-login.png');

    // 2. Perform login
    console.log('\n2. Logging in...');
    await page.fill('input[type="email"]', CREDENTIALS.email);
    await page.fill('input[type="password"]', CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(admin|chat)/, { timeout: 15000 });
    await page.waitForTimeout(2000);
    console.log('   Login successful!');

    // 3. Admin Dashboard
    console.log('\n3. Capturing admin dashboard (mobile)...');
    await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/mobile-02-admin-dashboard.png', fullPage: false });
    console.log('   Saved: screenshots/mobile-02-admin-dashboard.png');

    // 4. Admin Documents
    console.log('\n4. Capturing admin documents page (mobile)...');
    await page.goto(`${BASE_URL}/admin/documents`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/mobile-03-admin-documents.png', fullPage: false });
    console.log('   Saved: screenshots/mobile-03-admin-documents.png');

    // 5. Admin Users
    console.log('\n5. Capturing admin users page (mobile)...');
    await page.goto(`${BASE_URL}/admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/mobile-04-admin-users.png', fullPage: false });
    console.log('   Saved: screenshots/mobile-04-admin-users.png');

    // 6. Admin Analytics
    console.log('\n6. Capturing admin analytics page (mobile)...');
    await page.goto(`${BASE_URL}/admin/analytics`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/mobile-05-admin-analytics.png', fullPage: false });
    console.log('   Saved: screenshots/mobile-05-admin-analytics.png');

    // 7. Chat page
    console.log('\n7. Capturing chat page (mobile)...');
    await page.goto(`${BASE_URL}/chat`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/mobile-06-chat.png', fullPage: false });
    console.log('   Saved: screenshots/mobile-06-chat.png');

    console.log('\n========================================');
    console.log('All MOBILE screenshots captured!');
    console.log('========================================\n');

  } catch (error) {
    console.error('Error capturing screenshots:', error);
  } finally {
    await browser.close();
  }
}

captureMobileScreenshots();
