const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:3000';
const CREDENTIALS = {
  email: 'darrel.liew.jh@gmail.com',
  password: 'Darrel556'
};

async function captureScreenshots() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  console.log('Starting screenshot capture...\n');

  try {
    // 1. Login page (before logging in)
    console.log('1. Capturing login page...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshots/01-login-page.png', fullPage: false });
    console.log('   Saved: screenshots/01-login-page.png');

    // 2. Perform login
    console.log('\n2. Logging in...');
    await page.fill('input[type="email"]', CREDENTIALS.email);
    await page.fill('input[type="password"]', CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(admin|chat)/, { timeout: 15000 });
    await page.waitForTimeout(2000);
    console.log('   Login successful!');

    // 3. Admin Dashboard
    console.log('\n3. Capturing admin dashboard...');
    await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/02-admin-dashboard.png', fullPage: false });
    console.log('   Saved: screenshots/02-admin-dashboard.png');

    // Also capture full page version
    await page.screenshot({ path: 'screenshots/02-admin-dashboard-full.png', fullPage: true });
    console.log('   Saved: screenshots/02-admin-dashboard-full.png');

    // 4. Admin Documents
    console.log('\n4. Capturing admin documents page...');
    await page.goto(`${BASE_URL}/admin/documents`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/03-admin-documents.png', fullPage: false });
    console.log('   Saved: screenshots/03-admin-documents.png');

    // 5. Admin Users
    console.log('\n5. Capturing admin users page...');
    await page.goto(`${BASE_URL}/admin/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/04-admin-users.png', fullPage: false });
    console.log('   Saved: screenshots/04-admin-users.png');

    // 6. Admin Analytics
    console.log('\n6. Capturing admin analytics page...');
    await page.goto(`${BASE_URL}/admin/analytics`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); // Extra time for charts to render
    await page.screenshot({ path: 'screenshots/05-admin-analytics.png', fullPage: false });
    console.log('   Saved: screenshots/05-admin-analytics.png');

    // Full page analytics
    await page.screenshot({ path: 'screenshots/05-admin-analytics-full.png', fullPage: true });
    console.log('   Saved: screenshots/05-admin-analytics-full.png');

    // 7. Chat page
    console.log('\n7. Capturing chat page...');
    await page.goto(`${BASE_URL}/chat`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/06-chat-page.png', fullPage: false });
    console.log('   Saved: screenshots/06-chat-page.png');

    console.log('\n========================================');
    console.log('All screenshots captured successfully!');
    console.log('========================================\n');

  } catch (error) {
    console.error('Error capturing screenshots:', error);
  } finally {
    await browser.close();
  }
}

captureScreenshots();
