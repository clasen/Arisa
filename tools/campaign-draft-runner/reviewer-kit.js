import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function clean(value) {
  return String(value || "").trim();
}

function requiredFact(facts, key) {
  const value = clean(facts?.[key]);
  if (!value) throw new Error(`Reviewer kit requires approved fact: ${key}`);
  return value;
}

function reviewerGuideMarkdown(profile, facts) {
  const publicUrl = requiredFact(facts, "publicUrl");
  const assets = profile.campaignAssets || {};
  const access = requiredFact(facts, "accessAndReview");
  const length = requiredFact(facts, "contentLength");
  const story = requiredFact(facts, "futureStoriesCharacters");
  const pricing = requiredFact(facts, "platformPricing");
  const requirements = requiredFact(facts, "mobileRequirements");
  const company = requiredFact(facts, "companyProfile");
  return `# Castle Bravo reviewer guide

## Quick facts

- Official site: ${publicUrl}
- Access: ${access}
- Price: ${pricing}
- Play time: ${length}
- Current story: ${story}
- Mobile requirements: ${requirements}
- Team: ${company}

## Suggested coverage formats

- A spoiler-light first impression
- A complete review after finishing the current game
- A mobile mystery or narrative-game recommendation
- A walkthrough or recorded playthrough with a spoiler warning
- A discussion of conspiracy fiction after completing the story

## Review access

No review key is required. Download the published iOS or Android app directly. The official site is the canonical campaign URL.

- App Store: ${clean(assets.appStore) || "Not supplied"}
- Google Play: ${clean(assets.googlePlay) || "Not supplied"}

## Downloadable press materials

- Press kit ZIP: ${clean(assets.presskitZip) || "Not supplied"}
- Key art: ${clean(assets.keyArt) || "Not supplied"}
- Screenshot gallery: ${Array.isArray(assets.screenshots) ? assets.screenshots.length : 0} official screenshots

## Spoiler guidance

Treat character outcomes, late-game revelations, and the connections between the conspiracy elements as spoilers. A general description may mention that the current game tells one conspiracy story with five characters.

## Available campaign facts

- The current game is free
- The complete currently available game lasts approximately three hours
- It is available on iOS and Android
- The current game contains one conspiracy story with five characters

## Media checklist

Available:

- Downloadable press kit ZIP
- Key art and logo
- Ten English screenshots
- Direct App Store and Google Play links

The campaign still needs owner-supplied source video before these files can be produced safely:

- 15–30 second vertical trailer
- Three spoiler-light clips
- Short gameplay GIF

Do not infer missing technical requirements, release plans, or media assets.
`;
}

async function writeReviewerGuide(tmpDir, profile, facts) {
  await mkdir(tmpDir, { recursive: true });
  const fileName = `${profile.name || "campaign"}-reviewer-guide.md`;
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, `\uFEFF${reviewerGuideMarkdown(profile, facts)}`, "utf8");
  return {
    text: "Generated the reviewer guide from owner-approved campaign facts.",
    filePath,
    fileName,
    kind: "document",
    mimeType: "text/markdown",
    delivery: { method: "document" }
  };
}

export { reviewerGuideMarkdown, writeReviewerGuide };
