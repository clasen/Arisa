import test from "node:test";
import assert from "node:assert/strict";
import { parsePandaResults } from "../panda-results.js";

const tree = `120 heading '2 creators who cover games like The Isle Tide Hotel'
167 [i] image 'Atrioc VODs avatar'
170 'Atrioc VODs'
172 '@'
173 'atriocvods'
176 'YouTube'
178 [i] link 'The Isle Tide Hotel “ Atrioc Plays the Isle Tide Hotel ”'
186 '82.6K'
189 'subs'
192 '34.1K'
195 'avg views'
205 [i] button 'Find Email'
209 '7 days ago'
212 [i] link 'Open channel'
216 [i] image 'MDee14 avatar'
219 'MDee14'
221 '@'
222 'mdee14'
225 'YouTube'
227 [i] link 'The Isle Tide Hotel “ THE ISLE TIDE HOTEL Gameplay Walkthrough | FULL GAME | ”'
234 '2.2K'
237 'subs'
240 '1.2K'
243 'avg views'
256 [i] link 'creator@example.com'
260 '4 days ago'
263 [i] link 'Open channel'`;

const elements = [
  { backendNodeId: 10, name: "The Isle Tide Hotel “ Atrioc Plays the Isle Tide Hotel ”", href: "https://youtube.com/watch?v=one" },
  { backendNodeId: 11, name: "Find Email" },
  { backendNodeId: 12, name: "Open channel", href: "https://youtube.com/@atriocvods" },
  { backendNodeId: 20, name: "The Isle Tide Hotel “ THE ISLE TIDE HOTEL Gameplay Walkthrough | FULL GAME | ”", href: "https://youtube.com/watch?v=two" },
  { backendNodeId: 21, name: "creator@example.com", href: "mailto:creator@example.com" },
  { backendNodeId: 22, name: "Open channel", href: "https://youtube.com/@mdee14" }
];

test("parses bounded CreatorScout Lightpanda result rows", () => {
  const parsed = parsePandaResults(tree, elements);
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.rows[0], {
    name: "Atrioc VODs",
    handle: "@atriocvods",
    platform: "youtube",
    channelUrl: "https://youtube.com/@atriocvods",
    referenceTitle: "Atrioc Plays the Isle Tide Hotel",
    referenceUrl: "https://youtube.com/watch?v=one",
    subscribers: "82.6K",
    averageViews: "34.1K",
    match: null,
    lastActive: "7 days ago",
    email: null,
    findEmailNodeId: 11
  });
  assert.equal(parsed.rows[1].email, "creator@example.com");
  assert.equal(parsed.rows[1].referenceUrl, "https://youtube.com/watch?v=two");
});
