// Portable metadata and bytes for reviewed public tutorials. Draft artifacts stay outside the site.
import {createHash} from 'node:crypto';
import {readFile, lstat, mkdir, copyFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
export const VIDEO_IDS = new Set(['first-license','scan-license','scan-cme','import-cme','review-cme','locum-contract','locum-work','locum-invoice','locum-payment','reminders','get-help','backup-data','share-references','share-documents']);
export const VIDEO_FILES = Object.freeze({video:'tutorial.mp4',poster:'poster.jpg',captions:'captions.vtt',transcript:'transcript.txt'});
export const videoHref = (id, kind) => `/help/videos/${id}/${VIDEO_FILES[kind]}`;

export function validateVideoCatalog(catalog) {
  if (!catalog || catalog.schemaVersion !== 1 || catalog.status !== 'approved_for_publication' || !Array.isArray(catalog.tutorials) || !catalog.tutorials.length) throw Error('Video catalog must contain approved tutorials');
  const ids=new Set();
  for (const video of catalog.tutorials) {
    if (!VIDEO_IDS.has(video.id) || ids.has(video.id)) throw Error('Unknown or duplicate video ID');
    ids.add(video.id);
    if (video.status !== 'approved_for_publication' || video.review?.visual !== true || video.review?.playback !== true || !video.review.reviewedBy?.trim() || !/^\d{4}-\d{2}-\d{2}T/.test(video.review.reviewedAt) || !Number.isFinite(Date.parse(video.review.reviewedAt))) throw Error(`Missing video review: ${video.id}`);
    if (!video.title?.trim() || !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0 || video.durationSeconds > 90 || video.width !== 1920 || video.height !== 1080 || video.demoLabel !== true || typeof video.burnedCaptions !== 'boolean') throw Error(`Invalid video presentation: ${video.id}`);
    if (video.review.videoSHA256 !== video.files?.video?.sha256) throw Error(`Playback review does not match video bytes: ${video.id}`);
    if (!/^[a-f0-9]{8,40}$/.test(video.sourceRevision)) throw Error(`Missing source revision: ${video.id}`);
    if (Object.keys(video.files || {}).length !== 4 || Object.keys(video.files).some(kind=>!Object.hasOwn(VIDEO_FILES,kind))) throw Error(`Unexpected video assets: ${video.id}`);
    for (const [kind,file] of Object.entries(VIDEO_FILES)) {
      if (video.files?.[kind]?.file !== `${video.id}/${file}` || !/^[a-f0-9]{64}$/.test(video.files[kind].sha256)) throw Error(`Invalid ${kind} asset: ${video.id}`);
    }
  }
  return catalog;
}

export async function loadVideoCatalog(root) {
  const directory=resolve(root,'landing/help-videos');
  let raw;
  try {raw=await readFile(resolve(directory,'manifest.json'),'utf8');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const catalog=validateVideoCatalog(JSON.parse(raw));
  if (!(await lstat(directory)).isDirectory()) throw Error('Video directory must not be a symlink');
  for (const video of catalog.tutorials) {
    if (!(await lstat(resolve(directory,video.id))).isDirectory()) throw Error(`Video directory must not be a symlink: ${video.id}`);
    for (const [kind,entry] of Object.entries(video.files)) {
      if (!Object.hasOwn(VIDEO_FILES,kind)) throw Error(`Unexpected video asset: ${kind}`);
      const file=resolve(directory,entry.file);
      if (!(await lstat(file)).isFile()) throw Error(`Video asset must be a regular file: ${entry.file}`);
      const bytes=await readFile(file);
      if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error(`Video asset hash mismatch: ${entry.file}`);
      if (kind==='captions' && !/^WEBVTT(?:\r?\n|$)/.test(bytes.toString('utf8'))) throw Error(`Invalid WebVTT captions: ${video.id}`);
      if (kind==='transcript') {
        const transcriptText=bytes.toString('utf8');
        if (!transcriptText.trim()) throw Error(`Empty transcript: ${video.id}`);
        // Only verified file bytes supply page text; ignore any catalog-provided copy.
        video.transcriptText=transcriptText;
      }
    }
  }
  return catalog;
}

export async function copyVideoAssets(root, output, catalog) {
  if (!catalog) return;
  // Only the four approved public assets are copied; no narration sources,
  // captures, local paths, private review records, or draft player pages.
  for (const video of catalog.tutorials) for (const [kind,entry] of Object.entries(video.files)) {
    const target=resolve(output,`help/videos/${video.id}/${VIDEO_FILES[kind]}`);
    await mkdir(dirname(target),{recursive:true});
    await copyFile(resolve(root,'landing/help-videos',entry.file),target);
  }
}
