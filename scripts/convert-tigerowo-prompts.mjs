import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ID = "tigerowo-gpt-image-2-prompts";
const HOMEPAGE = "https://github.com/tigerowo/awesome-gpt-image-2-prompts";
const RAW_BASE =
  "https://raw.githubusercontent.com/tigerowo/awesome-gpt-image-2-prompts/main/";
const CASE_FILES = [
  "cases/ad-creative.md",
  "cases/character.md",
  "cases/comparison.md",
  "cases/ecommerce.md",
  "cases/portrait.md",
  "cases/poster.md",
  "cases/ui.md",
];
const DEFAULT_OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../web/public/prompts/tigerowo-gpt-image-2-prompts.json",
);

async function fetchText(path) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(new URL(path, RAW_BASE), {
        headers: { "User-Agent": "infinite-canvas-prompt-converter" },
      });
      if (!response.ok)
        throw new Error(`${path} request failed: ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, attempt * 1000),
      );
    }
  }
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function absoluteUrl(file, value) {
  return value ? new URL(value, new URL(file, RAW_BASE)).toString() : "";
}

function extractImages(file, block) {
  const values = [];
  for (const pattern of [
    /<img[^>]+src=["']([^"']+)["']/gi,
    /!\[[^\]]*]\(([^)]+)\)/g,
  ]) {
    for (const match of block.matchAll(pattern))
      values.push(absoluteUrl(file, match[1]));
  }
  return unique(values);
}

function collectCases(file, markdown, cases) {
  const headings = [...markdown.matchAll(/^### Case\s+\d+:\s*(.+)$/gm)];
  headings.forEach((heading, index) => {
    const block = markdown.slice(
      heading.index,
      headings[index + 1]?.index ?? markdown.length,
    );
    const prompt =
      block
        .match(
          /\*\*Prompt:\*\*\s*\r?\n\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/i,
        )?.[1]
        ?.trim() || "";
    if (!prompt) return;
    const linkedTitle = heading[1].match(/^\[([^\]]+)]\(([^)]+)\)/);
    const images = extractImages(file, block);
    const imageDirs = unique(
      [...block.matchAll(/images\/[\w-]+_case\d+/g)].map((match) => match[0]),
    );
    const item = {
      title:
        linkedTitle?.[1]?.trim() ||
        heading[1].replace(/\s*\(by\s+.*$/i, "").trim(),
      sourceUrl: linkedTitle?.[2]?.trim() || "",
      prompt,
      images,
    };
    if (item.sourceUrl) cases.set(item.sourceUrl, item);
    imageDirs.forEach((imageDir) => cases.set(imageDir, item));
  });
}

function categoryTags(category) {
  const normalized = String(category || "").replace(/\s+Cases$/i, "");
  return unique([
    "gpt-image-2",
    ...normalized.split(/\s*(?:&|\band\b)\s*/i).map((tag) => tag.toLowerCase()),
  ]);
}

function promptId(record) {
  const identity =
    record.tweet_url ||
    record.image_dir ||
    `${record.title}|${record.added_at}`;
  return `${SOURCE_ID}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

async function main() {
  const output = resolve(process.argv[2] || DEFAULT_OUTPUT);
  const dataText = await fetchText("data/ingested_tweets.json");
  const markdownFiles = [];
  for (const file of CASE_FILES) markdownFiles.push(await fetchText(file));
  const data = JSON.parse(dataText);
  if (!Array.isArray(data.records))
    throw new Error(
      "data/ingested_tweets.json does not contain a records array",
    );

  const cases = new Map();
  markdownFiles.forEach((markdown, index) =>
    collectCases(CASE_FILES[index], markdown, cases),
  );
  const prompts = data.records.flatMap((record) => {
    const item = cases.get(record.tweet_url) || cases.get(record.image_dir);
    if (!item?.prompt) return [];
    const images = unique(item.images);
    const createdAt = String(record.added_at || "").trim();
    return [
      {
        id: promptId(record),
        title: String(record.title || item.title || "").trim(),
        prompt: item.prompt,
        description: String(record.category || "").trim(),
        coverUrl: images[0] || "",
        referenceImageUrls: images,
        tags: categoryTags(record.category),
        preview: images.map((image) => `![](${image})`).join("\n\n"),
        createdAt,
        updatedAt: createdAt,
        author: String(record.author_handle || "").trim(),
        sourceUrl: String(
          record.tweet_url || item.sourceUrl || HOMEPAGE,
        ).trim(),
        imageModel: "gpt-image-2",
      },
    ];
  });

  if (!prompts.length) throw new Error("No prompts were converted");
  const ids = new Set(prompts.map((item) => item.id));
  if (ids.size !== prompts.length)
    throw new Error("Converted prompt IDs are not unique");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(prompts, null, 4)}\n`, "utf8");
  console.log(
    `Converted ${prompts.length}/${data.records.length} prompts to ${output}`,
  );
}

await main();
