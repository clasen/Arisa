import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { refreshSessionOnBrowserClose } from "./session-store.js";
import { resolveStoredSession } from "./session-selection.js";

function playwrightSameSite(value) {
  if (value === "strict") return "Strict";
  if (value === "lax") return "Lax";
  if (value === "no_restriction") return "None";
  return undefined;
}

function toPlaywrightCookie(cookie) {
  const converted = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly)
  };
  const sameSite = playwrightSameSite(cookie.sameSite);
  if (sameSite) converted.sameSite = sameSite;
  if (Number.isFinite(cookie.expirationDate)) converted.expires = cookie.expirationDate;
  return converted;
}

function validateDashboardUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.hostname !== "chrome.google.com" || !url.pathname.startsWith("/webstore/devconsole/")) {
    throw new Error("A Chrome Web Store Developer Dashboard URL is required");
  }
  return url;
}

async function validateZip(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".zip") throw new Error("Chrome Web Store package must be a ZIP file");
  const details = await stat(filePath);
  if (!details.isFile() || details.size < 1 || details.size > 2_000_000_000) throw new Error("Invalid Chrome Web Store package size");
}

async function selectedStoredSession(stateDir, resourceId, deviceId) {
  const selected = await resolveStoredSession({ stateDir, resourceId, deviceId });
  try {
    return { ...selected, session: JSON.parse(await readFile(selected.sessionPath, "utf8")) };
  } catch (error) {
    throw new Error(`Stored ${resourceId} session is invalid: ${error.message || String(error)}`);
  }
}

async function readStoredSession(stateDir, resourceId) {
  return (await selectedStoredSession(stateDir, resourceId)).session;
}

async function chromeWebStoreCookies(stateDir, session, deviceId) {
  const cookies = new Map(session.cookies.map((cookie) => [`${cookie.domain}\n${cookie.path || "/"}\n${cookie.name}`, cookie]));
  for (const accountResource of ["accounts.google.com", "myaccount.google.com"]) {
    try {
      const accountSession = deviceId
        ? (await selectedStoredSession(stateDir, accountResource, deviceId)).session
        : await readStoredSession(stateDir, accountResource);
      for (const cookie of accountSession.cookies || []) {
        cookies.set(`${cookie.domain}\n${cookie.path || "/"}\n${cookie.name}`, cookie);
      }
    } catch (error) {
      if (!new RegExp(`ENOENT|No ${accountResource.replaceAll(".", "\\.")} session is stored`).test(String(error?.message || error))) throw error;
    }
  }
  return [...cookies.values()];
}

function chromeWebStoreTargetValidated(context) {
  return context.pages().some((page) => {
    try {
      const url = new URL(page.url());
      return url.protocol === "https:" && url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore/devconsole/");
    } catch {
      return false;
    }
  });
}

async function authenticatedContext(stateDir, resourceId, deviceId, browser) {
  if (resourceId !== "chrome.google.com") throw new Error("The chrome.google.com browser session is required");
  const selected = await selectedStoredSession(stateDir, resourceId, deviceId);
  if (!Array.isArray(selected.session.cookies) || !selected.session.cookies.length) throw new Error("Stored Chrome Web Store session has no cookies");
  const context = await browser.newContext();
  const cookies = await chromeWebStoreCookies(stateDir, selected.session, deviceId);
  await context.addCookies(cookies.map(toPlaywrightCookie));
  refreshSessionOnBrowserClose({
    browser,
    context,
    stateDir,
    session: selected.session,
    sessionPath: selected.sessionPath,
    shouldPersist: () => chromeWebStoreTargetValidated(context)
  });
  return context;
}

async function selectPackage(page, zipPath) {
  const input = page.locator('input[type="file"]');
  if (await input.count()) {
    await input.first().setInputFiles(zipPath);
    return;
  }
  const browse = await firstVisible([
    page.getByText(/upload new package|browse files|choose file|select file/i),
    page.getByRole("button", { name: /upload new package|browse files|choose file|select file/i })
  ]);
  if (!browse) throw new Error("Chrome Web Store package upload control was not found");
  await browse.click();
  await page.waitForTimeout(500);
  const revealedInput = page.locator('input[type="file"]');
  if (await revealedInput.count()) {
    await revealedInput.last().setInputFiles(zipPath);
    return;
  }
  const revealedBrowse = await firstVisible([
    page.getByText(/browse files|choose file|select file/i),
    page.getByRole("button", { name: /browse files|choose file|select file/i })
  ]);
  if (!revealedBrowse) throw new Error("Chrome Web Store package file control was not found");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    revealedBrowse.click()
  ]);
  await chooser.setFiles(zipPath);
}

function itemIdentifier(url) {
  const match = url.pathname.match(/\/items\/([a-z]{32})(?:\/|$)/i);
  return match?.[1] || null;
}

export async function createChromeWebStoreAssets({ extensionDir, outputDir }) {
  await mkdir(outputDir, { recursive: true });
  const iconPath = path.join(outputDir, "store-icon-128.png");
  const screenshotPath = path.join(outputDir, "store-screenshot-1280x800.png");
  await copyFile(path.join(extensionDir, "icons", "icon-128.png"), iconPath);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(path.join(extensionDir, "popup.html")).href, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      document.querySelector("#setup")?.classList.add("hidden");
      document.querySelector("#connected")?.classList.remove("hidden");
      const label = document.querySelector("#device-label");
      const site = document.querySelector("#site");
      const status = document.querySelector("#status");
      if (label) label.textContent = "bridge.arisa.sh";
      if (site) site.textContent = "current site: chrome.google.com";
      if (status) { status.textContent = "session ready to send"; status.className = "success"; }
    });
    await page.addStyleTag({ content: "html,body{width:1280px!important;height:800px!important}body{display:grid!important;place-items:center!important}main{width:380px!important;border:1px solid #44475a!important;box-shadow:0 24px 80px rgba(0,0,0,.38)!important}" });
    await page.screenshot({ path: screenshotPath, type: "png", omitBackground: false });
  } finally {
    await browser.close();
  }
  return { iconPath, screenshotPath };
}

async function firstVisible(locators) {
  for (const locator of locators) {
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) return candidate;
    }
  }
  return null;
}

async function chooseStoreOption(page, placeholder, option) {
  const trigger = await firstVisible([
    page.getByLabel(placeholder, { exact: true }),
    page.getByText(placeholder, { exact: true })
  ]);
  if (!trigger) {
    const selected = await firstVisible([page.getByText(option, { exact: true })]);
    if (selected) return;
    throw new Error(`Chrome Web Store selector not found: ${placeholder}`);
  }
  await trigger.click();
  await page.waitForTimeout(250);
  const exact = await firstVisible([page.getByRole("option", { name: option, exact: true })]);
  if (!exact) throw new Error(`Chrome Web Store option not found: ${option}`);
  await exact.click();
}

export async function fillChromeWebStoreListing({ stateDir, resourceId = "chrome.google.com", deviceId, draftUrl, description, category, language, homepageUrl, supportUrl, iconPath, screenshotPath }) {
  const url = validateDashboardUrl(draftUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    await page.locator("textarea").first().fill(description);
    await chooseStoreOption(page, "Select a category", category);
    await chooseStoreOption(page, "Select a language", language);
    const files = page.locator('input[type="file"]');
    if ((await files.count()) < 2) throw new Error("Chrome Web Store asset controls were not found");
    await files.nth(0).setInputFiles(iconPath);
    await page.waitForTimeout(800);
    await files.nth(1).setInputFiles(screenshotPath);
    await page.getByPlaceholder("Homepage URL").fill(homepageUrl);
    await page.getByPlaceholder("Support URL").fill(supportUrl);
    await page.getByText("Save draft", { exact: true }).click();
    await page.waitForTimeout(2500);
    return {
      saved: true,
      submittedForReview: false,
      url: page.url(),
      descriptionLength: (await page.locator("textarea").first().inputValue()).length,
      category,
      language,
      iconUploaded: true,
      screenshotUploaded: true,
      homepageUrl: await page.getByPlaceholder("Homepage URL").inputValue(),
      supportUrl: await page.getByPlaceholder("Support URL").inputValue(),
      visibleText: (await page.locator("body").innerText()).slice(0, 8000)
    };
  } finally {
    await browser.close();
  }
}

export async function fillChromeWebStorePrivacy({ stateDir, resourceId = "chrome.google.com", deviceId, privacyUrl, fields }) {
  const url = validateDashboardUrl(privacyUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    const textareas = page.locator("textarea");
    if ((await textareas.count()) < 5) throw new Error("Chrome Web Store privacy controls were not found");
    await textareas.nth(0).fill(fields.singlePurpose);
    await textareas.nth(1).fill(fields.activeTab);
    await textareas.nth(2).fill(fields.cookies);
    await textareas.nth(3).fill(fields.storage);
    await page.locator('input[type="radio"]').first().check();
    for (const label of fields.dataTypes) await page.getByLabel(label, { exact: true }).check();
    await page.getByLabel(/I do not sell or transfer user data/i).check();
    await page.getByLabel(/I do not use or transfer user data for purposes/i).check();
    await page.getByLabel(/I do not use or transfer user data to determine creditworthiness/i).check();
    await page.locator('input[type="text"]').last().fill(fields.privacyPolicyUrl);
    await page.getByText("Save draft", { exact: true }).click();
    await page.waitForTimeout(2500);
    return {
      saved: true,
      submittedForReview: false,
      url: page.url(),
      remoteCode: false,
      dataTypes: fields.dataTypes,
      privacyPolicyUrl: await page.locator('input[type="text"]').last().inputValue(),
      visibleText: (await page.locator("body").innerText()).slice(0, 8000)
    };
  } finally {
    await browser.close();
  }
}

export async function fillChromeWebStorePublisherContact({ stateDir, resourceId = "chrome.google.com", deviceId, settingsUrl, contactEmail }) {
  const url = validateDashboardUrl(settingsUrl);
  const email = String(contactEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid publisher contact email is required");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    await page.getByText("Add email", { exact: true }).click();
    const dialog = page.getByRole("dialog").last();
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    const emailInput = dialog.locator('input[type="email"], input[type="text"]').first();
    await emailInput.fill(email);
    const submit = dialog.getByRole("button", { name: /add email|send verification|verify|save/i }).last();
    if (!(await submit.count())) throw new Error("Chrome Web Store contact-email confirmation control was not found");
    await submit.click();
    await page.waitForTimeout(2500);
    const body = (await page.locator("body").innerText()).trim();
    const verificationStarted = /verify|verification/i.test(body) && body.toLowerCase().includes(email);
    if (!body.toLowerCase().includes(email)) throw new Error("Chrome Web Store did not retain the publisher contact email");
    return {
      saved: true,
      submittedForReview: false,
      contactEmail: email,
      verificationStarted,
      url: page.url(),
      visibleText: body.slice(0, 8000)
    };
  } finally {
    await browser.close();
  }
}

export async function fillChromeWebStoreDistribution({ stateDir, resourceId = "chrome.google.com", deviceId, distributionUrl }) {
  const url = validateDashboardUrl(distributionUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    const radios = page.locator('input[type="radio"]');
    if ((await radios.count()) < 5) throw new Error("Chrome Web Store distribution controls were not found");
    await radios.nth(0).check();
    await radios.nth(2).check();
    const allRegions = page.getByRole("option", { name: "All regions", exact: true });
    const regionCheckbox = allRegions.locator('input[type="checkbox"]');
    if (await regionCheckbox.count()) await regionCheckbox.check();
    else await page.locator('input[type="checkbox"]').first().check();
    await page.getByText("Save draft", { exact: true }).click();
    await page.waitForTimeout(2500);
    return {
      saved: true,
      submittedForReview: false,
      payment: "free",
      visibility: "public",
      regions: "all",
      url: page.url(),
      visibleText: (await page.locator("body").innerText()).slice(0, 6000)
    };
  } finally {
    await browser.close();
  }
}

export async function inspectChromeWebStoreDraft({ stateDir, resourceId = "chrome.google.com", deviceId, draftUrl }) {
  const url = validateDashboardUrl(draftUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const controls = await page.locator("input, textarea, select, button, [role=combobox], [role=option]").evaluateAll((elements) => elements.map((element, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      ariaLabel: element.getAttribute("aria-label"),
      placeholder: element.getAttribute("placeholder"),
      accept: element.getAttribute("accept"),
      role: element.getAttribute("role"),
      disabled: element.getAttribute("aria-disabled"),
      value: element.getAttribute("data-value"),
      text: element.textContent?.trim().slice(0, 120) || null
    })));
    const links = await page.locator("a").evaluateAll((elements) => elements
      .map((element) => ({ text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 120), href: element.href }))
      .filter((item) => item.href.startsWith("https://chrome.google.com/webstore/devconsole") || /Access|Test instructions|Privacy|Distribution|Store listing|Settings/i.test(item.text || ""))
      .slice(0, 100));
    return { url: page.url(), title: await page.title(), controls, links };
  } finally {
    await browser.close();
  }
}

export async function fillChromeWebStoreTestInstructions({ stateDir, resourceId = "chrome.google.com", deviceId, testInstructionsUrl, instructions }) {
  const url = validateDashboardUrl(testInstructionsUrl);
  const text = String(instructions || "").trim();
  if (!text || text.length > 500) throw new Error("Chrome Web Store test instructions must be 1 to 500 characters");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    const textarea = page.locator("textarea").last();
    await textarea.fill(text);
    await page.getByText("Save changes", { exact: true }).click();
    await page.waitForTimeout(2000);
    if ((await textarea.inputValue()) !== text) throw new Error("Chrome Web Store did not retain the test instructions");
    return { saved: true, submittedForReview: false, instructionLength: text.length, url: page.url() };
  } finally {
    await browser.close();
  }
}

export async function replaceChromeWebStorePackage({ stateDir, resourceId = "chrome.google.com", deviceId, packageUrl, zipPath }) {
  const url = validateDashboardUrl(packageUrl);
  await validateZip(zipPath);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    const before = await page.locator("body").innerText();
    if (!/Status:\s*Draft/i.test(before)) throw new Error("Chrome Web Store item must be a draft before replacing its package");
    await selectPackage(page, zipPath);
    await page.waitForTimeout(6000);
    const body = await page.locator("body").innerText();
    if (/error|failed|invalid package/i.test(body)) throw new Error(body.match(/(?:error|failed|invalid package)[^\n]{0,300}/i)?.[0] || "Chrome Web Store package replacement failed");
    return { uploaded: true, submittedForReview: false, url: page.url(), visibleText: body.slice(0, 8000) };
  } finally {
    await browser.close();
  }
}

export async function withdrawChromeWebStoreReview({ stateDir, resourceId = "chrome.google.com", deviceId, itemUrl }) {
  const url = validateDashboardUrl(itemUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (page.url().includes("accounts.google.com")) throw new Error("Chrome Web Store session is not authenticated");
    const initialText = await page.locator("body").innerText();
    if (!/Status:\s*Pending review/i.test(initialText)) {
      if (/Status:\s*Draft/i.test(initialText)) return { withdrawn: false, alreadyDraft: true, status: "Draft", url: page.url() };
      throw new Error("Chrome Web Store item is not pending review");
    }
    await page.getByLabel("View more menu options", { exact: true }).click();
    const withdraw = await firstVisible([
      page.getByRole("menuitem", { name: /cancel submission|withdraw from review|cancel review/i }),
      page.getByText(/cancel submission|withdraw from review|cancel review/i)
    ]);
    if (!withdraw) throw new Error("Chrome Web Store review withdrawal control was not found");
    await withdraw.click();
    await page.waitForTimeout(500);
    const dialog = page.getByRole("dialog").last();
    if (await dialog.isVisible().catch(() => false)) {
      const confirm = await firstVisible([
        dialog.getByRole("button", { name: /withdraw|cancel submission|cancel review|confirm/i }),
        dialog.getByText(/withdraw|cancel submission|cancel review|confirm/i)
      ]);
      if (!confirm) throw new Error(`Chrome Web Store review withdrawal confirmation was not found: ${(await dialog.innerText()).trim().slice(0, 500)}`);
      await confirm.click();
    }
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText();
    if (!/Status:\s*Draft/i.test(body)) throw Object.assign(new Error("Chrome Web Store review withdrawal result is uncertain"), { uncertain: true });
    return { withdrawn: true, alreadyDraft: false, status: "Draft", url: page.url() };
  } finally {
    await browser.close();
  }
}

export async function uploadChromeWebStoreDraft({ stateDir, resourceId = "chrome.google.com", deviceId, dashboardUrl, zipPath }) {
  const url = validateDashboardUrl(dashboardUrl);
  await validateZip(zipPath);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await authenticatedContext(stateDir, resourceId, deviceId, browser);
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    if (!/Chrome Web Store Developer Dashboard/i.test(await page.title())) throw new Error("Chrome Web Store session is not authenticated");
    if (!/There are no items yet|New item/i.test(await page.locator("body").innerText())) throw new Error("Could not verify the publisher item list");

    await page.getByText("New item", { exact: true }).last().click();
    await page.waitForTimeout(700);
    await selectPackage(page, zipPath);
    await page.waitForTimeout(5000);

    const body = (await page.locator("body").innerText()).trim();
    const itemId = itemIdentifier(new URL(page.url()));
    const accepted = Boolean(itemId) || /store listing|package|privacy practices|distribution/i.test(body);
    if (!accepted) {
      const visibleError = body.match(/(?:error|failed|invalid)[^\n]{0,300}/i)?.[0];
      throw Object.assign(new Error(visibleError || "Package upload result is uncertain; inspect the dashboard before retrying"), { uncertain: true });
    }
    return {
      uploaded: true,
      submittedForReview: false,
      itemId,
      url: page.url(),
      title: await page.title(),
      visibleText: body.slice(0, 12000)
    };
  } finally {
    await browser.close();
  }
}
