import { test, expect } from '@playwright/test';

test.describe('Staking', () => {
  test('should display staking interface', async ({ page }) => {
    await page.goto('/staking');
    await expect(page).toHaveTitle(/BACKit/i);
  });

  test('should navigate to staking page', async ({ page }) => {
    await page.goto('/');
    await page.goto('/staking');
    expect(page.url()).toContain('/staking');
  });
});